import type Database from "better-sqlite3";
import type { ClientId } from "./clients.js";
import { randomUUID } from "node:crypto";

export type ContextType = "file" | "snippet" | "entity" | "memory_item" | "url";

export interface SharedContext {
  id: string;
  conversation_id: string | null;
  context_type: ContextType;
  content: string;
  description: string | null;
  shared_by: ClientId;
  memorantado_id: number | null;
  created_at: string;
}

export interface CreateSharedContextInput {
  conversation_id?: string;
  context_type: ContextType;
  content: string;
  description?: string;
  shared_by: ClientId;
}

export interface ListSharedContextOpts {
  limit?: number;
  offset?: number;
}

export function createSharedContext(
  db: Database.Database,
  input: CreateSharedContextInput
): SharedContext {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO shared_context (id, conversation_id, context_type, content, description, shared_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversation_id ?? null,
    input.context_type,
    input.content,
    input.description ?? null,
    input.shared_by
  );

  return getSharedContext(db, id)!;
}

export function getSharedContext(
  db: Database.Database,
  id: string
): SharedContext | null {
  const row = db.prepare(`SELECT * FROM shared_context WHERE id = ?`).get(id) as SharedContext | undefined;
  return row ?? null;
}

export function listSharedContextByConversation(
  db: Database.Database,
  conversationId: string,
  opts: ListSharedContextOpts = {}
): SharedContext[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM shared_context
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(conversationId, limit, offset) as SharedContext[];
}

export function listSharedContextByType(
  db: Database.Database,
  contextType: ContextType,
  opts: ListSharedContextOpts = {}
): SharedContext[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM shared_context
    WHERE context_type = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(contextType, limit, offset) as SharedContext[];
}

export function listAllSharedContext(
  db: Database.Database,
  opts: ListSharedContextOpts = {}
): SharedContext[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM shared_context
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as SharedContext[];
}

export function updateSharedContext(
  db: Database.Database,
  id: string,
  updates: { memorantado_id?: number; description?: string }
): SharedContext | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.memorantado_id !== undefined) {
    sets.push("memorantado_id = ?");
    params.push(updates.memorantado_id);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }

  if (sets.length === 0) return getSharedContext(db, id);

  params.push(id);
  db.prepare(`UPDATE shared_context SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getSharedContext(db, id);
}

export function deleteSharedContext(
  db: Database.Database,
  id: string
): boolean {
  const result = db.prepare(`DELETE FROM shared_context WHERE id = ?`).run(id);
  return result.changes > 0;
}
