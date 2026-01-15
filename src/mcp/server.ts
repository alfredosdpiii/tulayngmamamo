import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ClientId } from "../db/clients.js";
import { MessageDispatcher } from "../router/dispatcher.js";
import type { ClientRegistry } from "./clientRegistry.js";
import type { CodexMcpClientOpts } from "../router/codexMcpClient.js";
import { listAgentNames } from "../agents/index.js";
import {
  createConversation,
  listConversations,
  closeConversation,
  getConversation,
} from "../db/conversations.js";
import { getConversationMessages, getMessage, updateMessageStatus } from "../db/messages.js";
import {
  createSharedContext,
  getSharedContext,
  listSharedContextByConversation,
  listSharedContextByType,
  listAllSharedContext,
  type SharedContext,
} from "../db/shared_context.js";
import {
  syncConversationSummary,
  syncResearchFindings,
  syncCodeReview,
} from "../integrations/memorantado.js";

type CreateMcpServerOpts = {
  clientId?: ClientId;
  clientRegistry?: ClientRegistry;
  codexMcpEnabled?: boolean;
  codexMcpClientOpts?: CodexMcpClientOpts;
};

export function createMcpServer(
  db: Database.Database,
  opts: CreateMcpServerOpts = {}
): McpServer {
  let currentClientId: ClientId | null = opts.clientId ?? null;

  const getClientId = (): ClientId | null => currentClientId;
  const setClientId = (id: ClientId | null) => {
    currentClientId = id;
  };

  const server = new McpServer({
    name: "tulayngmamamo",
    version: "0.1.0",
  });

  const dispatcher = new MessageDispatcher(db, {
    clientRegistry: opts.clientRegistry,
    codexMcpEnabled: opts.codexMcpEnabled,
    codexMcpClientOpts: opts.codexMcpClientOpts,
  });

  // who_am_i
  server.tool("who_am_i", {}, async () => {
    const clientId = getClientId();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          client_id: clientId ?? "unknown",
          description: clientId === "claude"
            ? "Claude Code CLI"
            : clientId === "codex"
              ? "OpenAI Codex CLI"
              : "Unknown client",
        }, null, 2),
      }],
    };
  });

  // send_message
  server.tool(
    "send_message",
    {
      conversation_id: z.string().uuid().optional(),
      target: z.enum(["claude", "codex"]),
      content: z.string().min(1),
      priority: z.enum(["normal", "high", "urgent"]).default("normal"),
      wait_for_response: z.boolean().default(true),
      timeout_ms: z.number().int().positive().max(300000).default(60000),
      agent: z.enum(["architect", "oracle"] as const).optional(),
    },
    async (input) => {
      const sender = getClientId();
      if (!sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }
      if (input.target === sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot send message to self" }) }], isError: true };
      }

      try {
        const result = await dispatcher.sendMessage({
          conversationId: input.conversation_id,
          sender,
          target: input.target,
          content: input.content,
          priority: input.priority,
          waitForResponse: input.wait_for_response,
          timeoutMs: input.timeout_ms,
          agent: input.agent,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conversation_id: result.conversation.id,
              message_id: result.message.id,
              status: result.message.status,
              invoked: result.invoked ?? false,
              invocation_error: result.invocationError ?? null,
              selected_agent: result.selectedAgent ?? null,
              response: result.response ? {
                id: result.response.id,
                content: result.response.content,
                created_at: result.response.created_at,
              } : null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // get_response
  server.tool(
    "get_response",
    {
      message_id: z.string().uuid(),
      timeout_ms: z.number().int().positive().max(300000).default(30000),
    },
    async (input) => {
      try {
        const response = await dispatcher.waitForResponse(input.message_id, input.timeout_ms);
        if (!response) {
          return { content: [{ type: "text", text: JSON.stringify({ response: null, timeout: true }) }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              response: {
                id: response.id,
                sender: response.sender,
                content: response.content,
                message_type: response.message_type,
                created_at: response.created_at,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // get_history
  server.tool(
    "get_history",
    {
      conversation_id: z.string().uuid(),
      limit: z.number().int().positive().max(500).default(50),
      offset: z.number().int().nonnegative().default(0),
    },
    async (input) => {
      try {
        const messages = getConversationMessages(db, input.conversation_id, {
          limit: input.limit,
          offset: input.offset,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conversation_id: input.conversation_id,
              messages: messages.map((m) => ({
                id: m.id,
                sender: m.sender,
                target: m.target,
                content: m.content,
                message_type: m.message_type,
                status: m.status,
                created_at: m.created_at,
              })),
              count: messages.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // create_conversation
  server.tool(
    "create_conversation",
    {
      title: z.string().optional(),
      project: z.string().optional(),
    },
    async (input) => {
      const clientId = getClientId();
      if (!clientId) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }
      try {
        const conversation = createConversation(db, {
          title: input.title,
          project: input.project,
          created_by: clientId,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: conversation.id,
              title: conversation.title,
              project: conversation.project,
              status: conversation.status,
              created_at: conversation.created_at,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // list_conversations
  server.tool(
    "list_conversations",
    {
      status: z.enum(["active", "completed", "all"]).default("active"),
      limit: z.number().int().positive().max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
    },
    async (input) => {
      try {
        const conversations = listConversations(db, {
          status: input.status === "all" ? "all" : input.status,
          limit: input.limit,
          offset: input.offset,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conversations: conversations.map((c) => ({
                id: c.id,
                title: c.title,
                project: c.project,
                status: c.status,
                created_by: c.created_by,
                created_at: c.created_at,
                updated_at: c.updated_at,
              })),
              count: conversations.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // close_conversation
  server.tool(
    "close_conversation",
    {
      conversation_id: z.string().uuid(),
      summary: z.string().optional(),
      sync_to_memorantado: z.boolean().default(true),
    },
    async (input) => {
      try {
        const conversation = closeConversation(db, input.conversation_id, input.summary);
        if (!conversation) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Conversation not found" }) }], isError: true };
        }
        if (input.sync_to_memorantado && input.summary) {
          await syncConversationSummary(
            conversation.id,
            conversation.title ?? "Untitled conversation",
            input.summary,
            conversation.project ?? "tulayngmamamo"
          );
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: conversation.id,
              status: conversation.status,
              summary: conversation.summary,
              closed_at: conversation.closed_at,
              synced_to_memorantado: input.sync_to_memorantado && !!input.summary,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // get_conversation
  server.tool(
    "get_conversation",
    {
      conversation_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const conversation = getConversation(db, input.conversation_id);
        if (!conversation) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Conversation not found" }) }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: conversation.id,
              title: conversation.title,
              project: conversation.project,
              status: conversation.status,
              created_by: conversation.created_by,
              created_at: conversation.created_at,
              updated_at: conversation.updated_at,
              closed_at: conversation.closed_at,
              summary: conversation.summary,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // delegate_research
  server.tool(
    "delegate_research",
    {
      target: z.enum(["claude", "codex"]),
      topic: z.string().min(1),
      context: z.string().optional(),
      depth: z.enum(["shallow", "medium", "deep"]).default("medium"),
      conversation_id: z.string().uuid().optional(),
      sync_to_memorantado: z.boolean().default(true),
    },
    async (input) => {
      const sender = getClientId();
      if (!sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }
      if (input.target === sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot delegate research to self" }) }], isError: true };
      }

      try {
        let prompt = `Please research the following topic thoroughly:\n\n${input.topic}`;
        if (input.context) prompt += `\n\nAdditional context:\n${input.context}`;
        if (input.depth === "shallow") {
          prompt += "\n\nProvide a brief overview and key points.";
        } else if (input.depth === "deep") {
          prompt += "\n\nProvide an in-depth analysis with examples, code snippets if relevant, pros/cons, and recommendations.";
        } else {
          prompt += "\n\nProvide a comprehensive analysis with key findings and practical insights.";
        }

        // Timeout based on depth: shallow=2min, medium=5min, deep=10min
        const timeoutMs = input.depth === "shallow" ? 120000 : input.depth === "deep" ? 600000 : 300000;

        const result = await dispatcher.sendMessage({
          conversationId: input.conversation_id,
          sender,
          target: input.target,
          content: prompt,
          messageType: "research_request",
          priority: "normal",
          waitForResponse: true,
          timeoutMs,
          useOutputSchema: true, // Force structured completion
          metadata: { topic: input.topic, depth: input.depth },
        });

        if (input.sync_to_memorantado && result.response) {
          await syncResearchFindings(
            result.conversation.id,
            input.topic,
            result.response.content,
            result.conversation.project ?? "tulayngmamamo"
          );
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conversation_id: result.conversation.id,
              message_id: result.message.id,
              topic: input.topic,
              depth: input.depth,
              findings: result.response ? {
                id: result.response.id,
                content: result.response.content,
                synced_to_memorantado: input.sync_to_memorantado,
              } : null,
              status: result.response ? "completed" : "pending",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // request_review
  server.tool(
    "request_review",
    {
      target: z.enum(["claude", "codex"]),
      content: z.string().min(1),
      review_type: z.enum(["code", "architecture", "security", "performance", "general"]),
      context: z.string().optional(),
      conversation_id: z.string().uuid().optional(),
      sync_to_memorantado: z.boolean().default(true),
    },
    async (input) => {
      const sender = getClientId();
      if (!sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }
      if (input.target === sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot request review from self" }) }], isError: true };
      }

      try {
        let prompt = `Please review the following ${input.review_type === "code" ? "code" : "content"} from a ${input.review_type} perspective:\n\n\`\`\`\n${input.content}\n\`\`\``;
        if (input.context) prompt += `\n\nAdditional context:\n${input.context}`;
        switch (input.review_type) {
          case "security":
            prompt += "\n\nFocus on: potential vulnerabilities, injection risks, authentication/authorization issues, data exposure.";
            break;
          case "performance":
            prompt += "\n\nFocus on: time complexity, space complexity, potential bottlenecks, optimization opportunities.";
            break;
          case "architecture":
            prompt += "\n\nFocus on: design patterns, modularity, coupling, cohesion, scalability concerns.";
            break;
          case "code":
            prompt += "\n\nFocus on: code quality, readability, maintainability, best practices, potential bugs.";
            break;
          default:
            prompt += "\n\nProvide a general review covering quality, correctness, and potential improvements.";
        }

        const result = await dispatcher.sendMessage({
          conversationId: input.conversation_id,
          sender,
          target: input.target,
          content: prompt,
          messageType: "review_request",
          priority: "normal",
          waitForResponse: true,
          timeoutMs: 120000,
          metadata: { review_type: input.review_type },
        });

        if (input.sync_to_memorantado && result.response) {
          await syncCodeReview(
            result.conversation.id,
            input.review_type,
            result.response.content,
            result.conversation.project ?? "tulayngmamamo"
          );
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              conversation_id: result.conversation.id,
              message_id: result.message.id,
              review_type: input.review_type,
              review: result.response ? {
                id: result.response.id,
                content: result.response.content,
                synced_to_memorantado: input.sync_to_memorantado,
              } : null,
              status: result.response ? "completed" : "pending",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // share_context
  server.tool(
    "share_context",
    {
      conversation_id: z.string().uuid().optional(),
      context_type: z.enum(["file", "snippet", "entity", "memory_item", "url"]),
      content: z.string().min(1),
      description: z.string().optional(),
    },
    async (input) => {
      const sender = getClientId();
      if (!sender) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }

      try {
        const context = createSharedContext(db, {
          conversation_id: input.conversation_id,
          context_type: input.context_type,
          content: input.content,
          description: input.description,
          shared_by: sender,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: context.id,
              context_type: context.context_type,
              conversation_id: context.conversation_id,
              shared_by: context.shared_by,
              description: context.description,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // get_shared_context
  server.tool(
    "get_shared_context",
    {
      context_id: z.string().uuid(),
    },
    async (input) => {
      try {
        const context = getSharedContext(db, input.context_id);
        if (!context) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Shared context not found" }) }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: context.id,
              conversation_id: context.conversation_id,
              context_type: context.context_type,
              content: context.content,
              description: context.description,
              shared_by: context.shared_by,
              memorantado_id: context.memorantado_id,
              created_at: context.created_at,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // list_shared_context
  server.tool(
    "list_shared_context",
    {
      conversation_id: z.string().uuid().optional(),
      context_type: z.enum(["file", "snippet", "entity", "memory_item", "url"]).optional(),
      limit: z.number().int().positive().max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    },
    async (input) => {
      try {
        let contexts: SharedContext[];

        if (input.conversation_id) {
          contexts = listSharedContextByConversation(db, input.conversation_id, {
            limit: input.limit,
            offset: input.offset,
          });
        } else if (input.context_type) {
          contexts = listSharedContextByType(db, input.context_type, {
            limit: input.limit,
            offset: input.offset,
          });
        } else {
          contexts = listAllSharedContext(db, {
            limit: input.limit,
            offset: input.offset,
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              contexts: contexts.map((c) => ({
                id: c.id,
                conversation_id: c.conversation_id,
                context_type: c.context_type,
                description: c.description,
                shared_by: c.shared_by,
                created_at: c.created_at,
              })),
              count: contexts.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  // mark_message_read
  server.tool(
    "mark_message_read",
    {
      message_id: z.string().uuid(),
    },
    async (input) => {
      const clientId = getClientId();
      if (!clientId) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Unknown client" }) }], isError: true };
      }

      try {
        const message = getMessage(db, input.message_id);
        if (!message) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Message not found" }) }], isError: true };
        }

        // Only the target of a message can mark it as read
        if (message.target !== clientId) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot mark message as read: not the target" }) }], isError: true };
        }

        updateMessageStatus(db, input.message_id, "read");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message_id: input.message_id,
              status: "read",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  return Object.assign(server, { setClientId });
}

export type TulayngmamamoMcpServer = ReturnType<typeof createMcpServer>;
