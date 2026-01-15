import Fastify from "fastify";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { installSecurity } from "./security.js";
import { registerMcpRoutes } from "./mcp/http.js";
import { createMcpServer } from "./mcp/server.js";
import { ClientRegistry } from "./mcp/clientRegistry.js";
import { isAvailable as isMemorantadoAvailable } from "./integrations/memorantado.js";
import { QueueProcessor } from "./router/queueProcessor.js";

const PORT = Number(process.env.TULAYNGMAMAMO_PORT ?? 3790);
const HOST = "127.0.0.1";
const STDIO_MODE = process.argv.includes("--stdio");

// Codex MCP server integration configuration
const CODEX_MCP_ENABLED = process.env.TULAYNGMAMAMO_CODEX_MCP_ENABLED !== "false";
const CODEX_PATH = process.env.TULAYNGMAMAMO_CODEX_PATH ?? "codex";
const CODEX_SANDBOX = process.env.TULAYNGMAMAMO_CODEX_SANDBOX ?? "workspace-read";
const CODEX_APPROVAL_POLICY = process.env.TULAYNGMAMAMO_CODEX_APPROVAL_POLICY ?? "never";
// Optional: Override the default critical architect persona
const CODEX_BASE_INSTRUCTIONS = process.env.TULAYNGMAMAMO_CODEX_BASE_INSTRUCTIONS;

async function runStdioMode(): Promise<void> {
  const db = openDb();
  migrate(db);

  const server = createMcpServer(db, {
    clientId: "claude",
    codexMcpEnabled: CODEX_MCP_ENABLED,
    codexMcpClientOpts: {
      codexPath: CODEX_PATH,
      sandbox: CODEX_SANDBOX,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      baseInstructions: CODEX_BASE_INSTRUCTIONS,
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttpMode(): Promise<void> {
  const app = Fastify({
    logger: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  const db = openDb();
  migrate(db);

  // Create client registry for real-time online status tracking
  const clientRegistry = new ClientRegistry();

  // Start background queue processor for offline message delivery
  const queueProcessor = new QueueProcessor(db);
  queueProcessor.start();

  installSecurity(app, { port: PORT });
  registerMcpRoutes(app, {
    db,
    queueProcessor,
    clientRegistry,
    codexMcpEnabled: CODEX_MCP_ENABLED,
    codexMcpClientOpts: {
      codexPath: CODEX_PATH,
      sandbox: CODEX_SANDBOX,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      baseInstructions: CODEX_BASE_INSTRUCTIONS,
    },
  });

  // Stop queue processor on shutdown
  app.addHook("onClose", async () => {
    queueProcessor.stop();
  });

  // Health check endpoint
  app.get("/health", async () => {
    const memorantadoAvailable = await isMemorantadoAvailable();
    return {
      status: "ok",
      memorantado: memorantadoAvailable ? "available" : "unavailable",
    };
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`tulayngmamamo running at http://${HOST}:${PORT}`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);

  // Check memorantado availability
  const memorantadoAvailable = await isMemorantadoAvailable();
  if (memorantadoAvailable) {
    console.log("memorantado integration: available");
  } else {
    console.log("memorantado integration: unavailable (start memorantado on port 3789 to enable)");
  }

  // Log Codex MCP server integration status
  if (CODEX_MCP_ENABLED) {
    console.log(`codex MCP server integration: enabled (path: ${CODEX_PATH}, sandbox: ${CODEX_SANDBOX})`);
  } else {
    console.log("codex MCP server integration: disabled");
  }
}

async function main(): Promise<void> {
  if (STDIO_MODE) {
    await runStdioMode();
  } else {
    await runHttpMode();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
