import type Database from "better-sqlite3";
import type { ClientId } from "../db/clients.js";
import {
  createMessage,
  getMessage,
  getConversationMessages,
  getResponseToMessage,
  type Message,
  type CreateMessageInput,
  type MessageType,
} from "../db/messages.js";
import {
  createConversation,
  getConversation,
  type Conversation,
} from "../db/conversations.js";
import { enqueueMessage } from "../db/message_queue.js";
import { selectAgent, getAgent, type AgentName } from "../agents/index.js";
import { invokeCodexExec } from "./invoker.js";
import { invokeClaudeExec } from "./claudeInvoker.js";

export interface SendMessageOpts {
  conversationId?: string;
  sender: ClientId;
  target: ClientId;
  content: string;
  messageType?: CreateMessageInput["message_type"];
  priority?: CreateMessageInput["priority"];
  /** Ignored in queue-first mode; all sends are asynchronous fire-and-forget. */
  waitForResponse?: boolean;
  /** Ignored in queue-first mode; use get_response for explicit polling. */
  timeoutMs?: number;
  /** Ignored in queue-first mode; retained for API compatibility. */
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

export class MessageDispatcher {
  constructor(private db: Database.Database) {}

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

    // Preserve persona selection metadata for codex-targeted messages.
    if (opts.target === "codex") {
      const persona = opts.agent ? getAgent(opts.agent) : selectAgent(opts.content);
      result.selectedAgent = persona.name;
    }

    // Queue-first delivery: all messages are asynchronously delivered by QueueProcessor.
    const priorityMap: Record<string, number> = { urgent: 2, high: 1, normal: 0 };
    enqueueMessage(this.db, {
      message_id: message.id,
      target: opts.target,
      priority: priorityMap[opts.priority ?? "normal"],
      max_attempts: 5,
    });

    // Always invoke the target directly as a fire-and-forget subprocess.
    // The response is stored as a reply message for get_response to pick up.
    if (opts.target === "codex") {
      this.fireCodexInvocation(message, conversation);
    } else if (opts.target === "claude") {
      this.fireClaudeInvocation(message, conversation);
    }

    return result;
  }

  private fireCodexInvocation(message: Message, conversation: Conversation): void {
    this.invokeCodexAndStoreReply(message, conversation).catch((err) => {
      console.error(`[dispatcher] codex invocation failed for message ${message.id}:`, err);
    });
  }

  private async invokeCodexAndStoreReply(
    message: Message,
    conversation: Conversation
  ): Promise<void> {
    // Build conversation context from recent messages (exclude the message we just sent)
    const recentMessages = getConversationMessages(this.db, conversation.id, { limit: 10 });
    const contextLines = recentMessages
      .filter((m) => m.id !== message.id)
      .map((m) => `[${m.sender}]: ${m.content}`);
    const context = contextLines.length > 0 ? contextLines.join("\n") : undefined;

    const result = await invokeCodexExec(this.db, message, context);

    if (result.response) {
      const responseTypeMap: Record<string, MessageType> = {
        research_request: "research_response",
        review_request: "review_response",
      };
      const responseType: MessageType = responseTypeMap[message.message_type] ?? "message";

      createMessage(this.db, {
        conversation_id: conversation.id,
        sender: "codex",
        target: message.sender,
        content: result.response,
        message_type: responseType,
        response_to_id: message.id,
        metadata: {
          invocation_id: result.id,
          exit_code: result.exitCode,
        },
      });
    }
  }

  private fireClaudeInvocation(message: Message, conversation: Conversation): void {
    this.invokeClaudeAndStoreReply(message, conversation).catch((err) => {
      console.error(`[dispatcher] claude invocation failed for message ${message.id}:`, err);
    });
  }

  private async invokeClaudeAndStoreReply(
    message: Message,
    conversation: Conversation
  ): Promise<void> {
    const recentMessages = getConversationMessages(this.db, conversation.id, { limit: 10 });
    const contextLines = recentMessages
      .filter((m) => m.id !== message.id)
      .map((m) => `[${m.sender}]: ${m.content}`);
    const context = contextLines.length > 0 ? contextLines.join("\n") : undefined;

    const result = await invokeClaudeExec(this.db, message, context);

    if (result.response) {
      const responseTypeMap: Record<string, MessageType> = {
        research_request: "research_response",
        review_request: "review_response",
      };
      const responseType: MessageType = responseTypeMap[message.message_type] ?? "message";

      createMessage(this.db, {
        conversation_id: conversation.id,
        sender: "claude",
        target: message.sender,
        content: result.response,
        message_type: responseType,
        response_to_id: message.id,
        metadata: {
          invocation_id: result.id,
          exit_code: result.exitCode,
        },
      });
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
