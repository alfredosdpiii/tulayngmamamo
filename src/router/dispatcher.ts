import type Database from "better-sqlite3";
import type { ClientId } from "../db/clients.js";
import {
  createMessage,
  getMessage,
  getConversationMessages,
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
import { selectAgent, getAgent, type AgentName } from "../agents/index.js";

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

    return result;
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
