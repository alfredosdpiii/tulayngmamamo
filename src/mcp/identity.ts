import type { FastifyRequest } from "fastify";
import type { ClientId } from "../db/clients.js";

export function identifyClient(req: FastifyRequest): ClientId | null {
  // 1. Check custom header (preferred)
  const header = req.headers["x-client-id"] as string | undefined;
  if (header === "claude" || header === "codex") return header;

  // 2. Check User-Agent patterns
  const ua = req.headers["user-agent"] || "";
  if (ua.includes("claude-code") || ua.includes("Claude")) return "claude";
  if (ua.includes("codex") || ua.includes("Codex")) return "codex";

  // 3. Check query parameter (for testing)
  const query = req.query as { client?: string };
  if (query.client === "claude" || query.client === "codex") return query.client;

  return null;
}

export function getOtherClient(clientId: ClientId): ClientId {
  return clientId === "claude" ? "codex" : "claude";
}
