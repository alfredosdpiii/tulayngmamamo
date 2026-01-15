import type Database from "better-sqlite3";
import type { ClientId } from "./clients.js";
import { randomUUID } from "node:crypto";

export type InvocationType = "codex_exec" | "claude_mcp";
export type InvocationStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export interface Invocation {
  id: string;
  target: ClientId;
  message_id: string;
  invocation_type: InvocationType;
  status: InvocationStatus;
  command: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CreateInvocationInput {
  target: ClientId;
  message_id: string;
  invocation_type: InvocationType;
  command?: string;
}

export interface ListInvocationsOpts {
  limit?: number;
  offset?: number;
}

export function createInvocation(
  db: Database.Database,
  input: CreateInvocationInput
): Invocation {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO invocations (id, target, message_id, invocation_type, command)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.target, input.message_id, input.invocation_type, input.command ?? null);

  return getInvocation(db, id)!;
}

export function getInvocation(
  db: Database.Database,
  id: string
): Invocation | null {
  const row = db.prepare(`SELECT * FROM invocations WHERE id = ?`).get(id) as Invocation | undefined;
  return row ?? null;
}

export function getInvocationByMessageId(
  db: Database.Database,
  messageId: string
): Invocation | null {
  const row = db.prepare(`
    SELECT * FROM invocations WHERE message_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(messageId) as Invocation | undefined;
  return row ?? null;
}

export function listInvocationsByStatus(
  db: Database.Database,
  status: InvocationStatus,
  opts: ListInvocationsOpts = {}
): Invocation[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM invocations
    WHERE status = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(status, limit, offset) as Invocation[];
}

export function listInvocationsByTarget(
  db: Database.Database,
  target: ClientId,
  opts: ListInvocationsOpts = {}
): Invocation[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM invocations
    WHERE target = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(target, limit, offset) as Invocation[];
}

export function updateInvocation(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<Invocation, "status" | "command" | "stdout" | "stderr" | "exit_code" | "started_at" | "completed_at">>
): Invocation | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (sets.length === 0) return getInvocation(db, id);

  params.push(id);
  db.prepare(`UPDATE invocations SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getInvocation(db, id);
}
