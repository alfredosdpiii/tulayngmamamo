import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type TulayngmamamoMcpServer } from "./server.js";
import { InMemoryEventStore } from "./eventStore.js";
import { identifyClient } from "./identity.js";
import { updateClientStatus, setClientOffline, type ClientId } from "../db/clients.js";
import type { QueueProcessor } from "../router/queueProcessor.js";
import type { ClientRegistry } from "./clientRegistry.js";
import type { CodexMcpClientOpts } from "../router/codexMcpClient.js";

type SessionInfo = {
  transport: StreamableHTTPServerTransport;
  server: TulayngmamamoMcpServer;
  clientId: ClientId | null;
};

type RegisterMcpRoutesOpts = {
  db: Database.Database;
  queueProcessor?: QueueProcessor;
  clientRegistry?: ClientRegistry;
  codexMcpEnabled?: boolean;
  codexMcpClientOpts?: CodexMcpClientOpts;
};

export function registerMcpRoutes(
  app: FastifyInstance,
  opts: RegisterMcpRoutesOpts
): void {
  const sessions = new Map<string, SessionInfo>();

  app.post("/mcp", async (req, reply) => {
    const body = req.body as unknown;
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          reply.code(400);
          return {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Unknown mcp-session-id" },
            id: null,
          };
        }

        reply.hijack();
        await session.transport.handleRequest(req.raw, reply.raw, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        reply.code(400);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: missing mcp-session-id and not an initialize request",
          },
          id: null,
        };
      }

      const eventStore = new InMemoryEventStore({
        ttlMs: 15 * 60 * 1000,
        maxEventsPerStream: 5000,
      });

      let sessionInfo: SessionInfo;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => {
          sessions.set(sid, sessionInfo);

          // Update client status if identified
          if (sessionInfo.clientId) {
            // Update in-memory registry first (authoritative source)
            opts.clientRegistry?.setOnline(sessionInfo.clientId, sid);
            // Then sync to database for persistence
            updateClientStatus(opts.db, sessionInfo.clientId, "online", sid);
            // Drain queued messages for this client
            opts.queueProcessor?.onClientOnline(sessionInfo.clientId);
          }
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          const session = sessions.get(sid);
          if (session?.clientId) {
            // Update in-memory registry first (authoritative source)
            opts.clientRegistry?.setOffline(session.clientId);
            // Then sync to database
            setClientOffline(opts.db, session.clientId);
          }
          sessions.delete(sid);
        }
      };

      // Identify the client from the request
      const clientId = identifyClient(req);

      // Create the MCP server with client identity and registry
      const server = createMcpServer(opts.db, {
        clientId: clientId ?? undefined,
        clientRegistry: opts.clientRegistry,
        codexMcpEnabled: opts.codexMcpEnabled,
        codexMcpClientOpts: opts.codexMcpClientOpts,
      });

      sessionInfo = {
        transport,
        server,
        clientId,
      };

      await server.connect(transport);

      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, body);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      req.log.error({ err }, "Error handling /mcp POST");
      if (!reply.sent) reply.code(status).send({ error: "mcp_post_failed" });
    }
  });

  app.get("/mcp", async (req, reply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  });

  app.delete("/mcp", async (req, reply) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      reply.code(400).send("Invalid or missing mcp-session-id");
      return;
    }

    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  });

  // Status endpoint for debugging
  app.get("/status", async () => {
    const sessionList = Array.from(sessions.entries()).map(([id, info]) => ({
      id,
      clientId: info.clientId,
    }));

    return {
      sessions: sessionList,
      sessionCount: sessions.size,
    };
  });

  app.addHook("onClose", async () => {
    for (const [, session] of sessions) {
      try {
        if (session.clientId) {
          opts.clientRegistry?.setOffline(session.clientId);
          setClientOffline(opts.db, session.clientId);
        }
        await session.transport.close();
      } catch {
        // ignore
      }
    }
    sessions.clear();
    opts.clientRegistry?.clear();
  });
}
