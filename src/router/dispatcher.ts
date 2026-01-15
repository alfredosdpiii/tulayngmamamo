import type Database from "better-sqlite3";
import type { ClientId } from "../db/clients.js";
import {
  createMessage,
  getMessage,
  getConversationMessages,
  updateMessageStatus,
  getResponseToMessage,
  type Message,
  type CreateMessageInput,
} from "../db/messages.js";
import {
  createConversation,
  getConversation,
  type Conversation,
} from "../db/conversations.js";
import { enqueueMessage } from "../db/message_queue.js";
import { invokeCodexExec } from "./invoker.js";
import type { ClientRegistry } from "../mcp/clientRegistry.js";
import { CodexMcpClient, type CodexMcpClientOpts } from "./codexMcpClient.js";
import { selectAgent, getAgent, type AgentPersona, type AgentName } from "../agents/index.js";

export interface SendMessageOpts {
  conversationId?: string;
  sender: ClientId;
  target: ClientId;
  content: string;
  messageType?: CreateMessageInput["message_type"];
  priority?: CreateMessageInput["priority"];
  waitForResponse?: boolean;
  timeoutMs?: number;
  useOutputSchema?: boolean;
  metadata?: Record<string, unknown>;
  /** Specific agent persona to use (e.g., "architect", "oracle"). Auto-selected if not provided. */
  agent?: AgentName;
}

export interface SendMessageResult {
  message: Message;
  conversation: Conversation;
  response?: Message;
  invoked?: boolean;
  invokedViaMcp?: boolean;
  invocationError?: string;
  /** The agent persona that was used for this message */
  selectedAgent?: string;
}

export interface MessageDispatcherOpts {
  clientRegistry?: ClientRegistry;
  codexMcpClientOpts?: CodexMcpClientOpts;
  /** Enable Codex MCP server integration (default: true) */
  codexMcpEnabled?: boolean;
}

export class MessageDispatcher {
  private codexMcpClient: CodexMcpClient | null = null;
  private codexMcpEnabled: boolean;

  constructor(
    private db: Database.Database,
    private opts: MessageDispatcherOpts = {}
  ) {
    this.codexMcpEnabled = opts.codexMcpEnabled ?? true;
    if (this.codexMcpEnabled) {
      this.codexMcpClient = new CodexMcpClient(opts.codexMcpClientOpts);
    }
  }

  /**
   * Access the client registry for online status checks
   */
  private get clientRegistry(): ClientRegistry | undefined {
    return this.opts.clientRegistry;
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendMessageResult> {
    // Get or create conversation
    let conversation: Conversation;
    if (opts.conversationId) {
      const existing = getConversation(this.db, opts.conversationId);
      if (!existing) {
        throw new Error(`Conversation not found: ${opts.conversationId}`);
      }
      conversation = existing;
    } else {
      conversation = createConversation(this.db, {
        created_by: opts.sender,
      });
    }

    // Create the message
    const message = createMessage(this.db, {
      conversation_id: conversation.id,
      sender: opts.sender,
      target: opts.target,
      content: opts.content,
      message_type: opts.messageType,
      priority: opts.priority,
      metadata: opts.metadata,
    });

    const result: SendMessageResult = {
      message,
      conversation,
    };

    // Check if target is online using in-memory registry (authoritative source)
    // This provides real-time detection of connected clients
    const targetOnline = this.clientRegistry?.isOnline(opts.target) ?? false;

    if (targetOnline) {
      // Target is connected, they'll receive the message when they poll
      updateMessageStatus(this.db, message.id, "delivered");
    } else if (opts.target === "codex") {
      // Target is offline - try MCP server first, then fall back to codex exec
      const conversationContext = this.buildConversationContext(conversation.id);

      // Select agent persona: explicit or auto-detect from content
      const persona = opts.agent
        ? getAgent(opts.agent)
        : selectAgent(opts.content);
      result.selectedAgent = persona.name;

      // Tier 2: Try Codex MCP server with selected persona
      const mcpResult = await this.tryCodexMcpServer(
        opts.content,
        conversationContext,
        message.id,
        persona
      );

      if (mcpResult) {
        // MCP server succeeded
        result.invoked = true;
        result.invokedViaMcp = true;

        const responseMessage = createMessage(this.db, {
          conversation_id: conversation.id,
          sender: opts.target,
          target: opts.sender,
          content: mcpResult,
          message_type: this.getResponseType(opts.messageType),
          response_to_id: message.id,
        });

        updateMessageStatus(this.db, message.id, "responded");
        result.response = responseMessage;
      } else {
        // Tier 3: Fall back to codex exec subprocess
        const invocationResult = await invokeCodexExec(
          this.db,
          message,
          conversationContext,
          {
            timeoutMs: opts.timeoutMs ?? 300000, // 5 min default for high reasoning
            useOutputSchema: opts.useOutputSchema ?? true,
          }
        );

        result.invoked = true;

        if (invocationResult.response) {
          // Create response message even if exit code was non-zero
          const responseMessage = createMessage(this.db, {
            conversation_id: conversation.id,
            sender: opts.target,
            target: opts.sender,
            content: invocationResult.response,
            message_type: this.getResponseType(opts.messageType),
            response_to_id: message.id,
          });

          updateMessageStatus(this.db, message.id, "responded");
          result.response = responseMessage;
        }

        // Surface invocation error if no response was captured
        if (!invocationResult.success && !invocationResult.response) {
          result.invocationError = invocationResult.stderr || "Invocation failed with no output";
        }
      }
    } else {
      // Target is offline and not codex - enqueue for later delivery
      const priorityMap: Record<string, number> = { urgent: 2, high: 1, normal: 0 };
      enqueueMessage(this.db, {
        message_id: message.id,
        target: opts.target,
        priority: priorityMap[opts.priority ?? "normal"],
        max_attempts: 5,
      });
    }

    // If waiting for response and no response yet, poll
    if (opts.waitForResponse && !result.response) {
      const response = await this.waitForResponse(
        message.id,
        opts.timeoutMs ?? 60000
      );
      if (response) {
        result.response = response;
      }
    }

    return result;
  }

  private buildConversationContext(conversationId: string): string {
    const messages = getConversationMessages(this.db, conversationId, { limit: 20 });
    if (messages.length === 0) return "";

    return messages
      .map((m) => `[${m.sender}]: ${m.content}`)
      .join("\n\n");
  }

  /**
   * Try to send message via Codex MCP server.
   * Returns response content on success, null on failure (fallback to exec).
   *
   * @param content - The message content
   * @param conversationContext - Previous messages in the conversation
   * @param messageId - The message ID for tracking
   * @param persona - The agent persona to use for this request
   */
  private async tryCodexMcpServer(
    content: string,
    conversationContext: string,
    messageId: string,
    persona: AgentPersona
  ): Promise<string | null> {
    if (!this.codexMcpEnabled || !this.codexMcpClient) {
      return null;
    }

    try {
      // Build prompt with conversation context
      const prompt = conversationContext
        ? `Previous conversation:\n${conversationContext}\n\nNew message:\n${content}`
        : content;

      const result = await this.codexMcpClient.sendMessage(prompt, messageId, persona);

      if (result && result.response) {
        return result.response;
      }

      return null;
    } catch (err) {
      console.error("[MessageDispatcher] Codex MCP server failed:", err);
      return null;
    }
  }

  private getResponseType(
    requestType?: CreateMessageInput["message_type"]
  ): CreateMessageInput["message_type"] {
    switch (requestType) {
      case "research_request":
        return "research_response";
      case "review_request":
        return "review_response";
      default:
        return "message";
    }
  }

  async waitForResponse(messageId: string, timeoutMs: number): Promise<Message | null> {
    const startTime = Date.now();
    // Adaptive polling: start fast (100ms), slow down to max 1000ms
    let pollInterval = 100;
    const maxPollInterval = 1000;
    const backoffFactor = 1.5;

    while (Date.now() - startTime < timeoutMs) {
      const response = getResponseToMessage(this.db, messageId);
      if (response) return response;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      // Exponential backoff up to max interval
      pollInterval = Math.min(pollInterval * backoffFactor, maxPollInterval);
    }

    return null;
  }

  getConversationHistory(
    conversationId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Message[] {
    return getConversationMessages(this.db, conversationId, opts);
  }

  getMessage(messageId: string): Message | null {
    return getMessage(this.db, messageId);
  }
}
