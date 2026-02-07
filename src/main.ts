import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { installSecurity } from "./security.js";
import { registerMcpRoutes } from "./mcp/http.js";
import { createMcpServer } from "./mcp/server.js";
import type { ClientId } from "./db/clients.js";
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
const CODEX_MODEL = process.env.TULAYNGMAMAMO_CODEX_MODEL ?? "gpt-5.3-codex";
const CODEX_REASONING_EFFORT =
  process.env.TULAYNGMAMAMO_CODEX_REASONING_EFFORT ?? "xhigh";
// Optional: Override the default critical architect persona
const CODEX_BASE_INSTRUCTIONS = process.env.TULAYNGMAMAMO_CODEX_BASE_INSTRUCTIONS;

function parseClientId(value: string | undefined): ClientId | undefined {
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

function getArgValue(flag: string): string | undefined {
  const arg = process.argv.find((item) => item.startsWith(`${flag}=`));
  if (arg) return arg.slice(`${flag}=`.length);
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function inferClientIdFromParentProcess(): ClientId | undefined {
  const parseCommand = (cmd: string): ClientId | undefined => {
    const lower = cmd.toLowerCase();
    if (lower.includes("codex")) return "codex";
    if (lower.includes("claude")) return "claude";
    return undefined;
  };

  try {
    const cmdline = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8");
    const inferred = parseCommand(cmdline.replace(/\u0000/g, " "));
    if (inferred) return inferred;
  } catch {
    // Ignore and fall back to ps lookup below.
  }

  try {
    const command = execFileSync(
      "ps",
      ["-o", "command=", "-p", String(process.ppid)],
      { encoding: "utf8" }
    );
    return parseCommand(command.trim());
  } catch {
    return undefined;
  }
}

function resolveStdioClientId(): ClientId {
  return (
    parseClientId(getArgValue("--client-id")) ??
    parseClientId(getArgValue("--client")) ??
    parseClientId(process.env.TULAYNGMAMAMO_CLIENT_ID) ??
    parseClientId(process.env.MCP_CLIENT_ID) ??
    inferClientIdFromParentProcess() ??
    "claude"
  );
}

async function runStdioMode(): Promise<void> {
  const db = openDb();
  migrate(db);
  const clientId = resolveStdioClientId();

  const server = createMcpServer(db, {
    clientId,
    codexMcpEnabled: CODEX_MCP_ENABLED,
    codexMcpClientOpts: {
      codexPath: CODEX_PATH,
      sandbox: CODEX_SANDBOX,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      model: CODEX_MODEL,
      modelReasoningEffort: CODEX_REASONING_EFFORT,
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
      model: CODEX_MODEL,
      modelReasoningEffort: CODEX_REASONING_EFFORT,
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
    console.log(
      `codex MCP server integration: enabled (path: ${CODEX_PATH}, sandbox: ${CODEX_SANDBOX}, model: ${CODEX_MODEL}, reasoning: ${CODEX_REASONING_EFFORT})`
    );
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
