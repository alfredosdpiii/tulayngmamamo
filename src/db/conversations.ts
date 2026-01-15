import type Database from "better-sqlite3";
import type { ClientId } from "./clients.js";
import { randomUUID } from "node:crypto";

export type ConversationStatus = "active" | "pending" | "completed" | "archived";

export interface Conversation {
  id: string;
  title: string | null;
  project: string | null;
  status: ConversationStatus;
  created_by: ClientId;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  summary: string | null;
  metadata: string | null;
}

export interface CreateConversationInput {
  title?: string;
  project?: string;
  created_by: ClientId;
  metadata?: Record<string, unknown>;
}

export function createConversation(
  db: Database.Database,
  input: CreateConversationInput
): Conversation {
  const id = randomUUID();
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  db.prepare(`
    INSERT INTO conversations (id, title, project, created_by, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.title ?? null, input.project ?? null, input.created_by, metadata);

  return getConversation(db, id)!;
}

export function getConversation(db: Database.Database, id: string): Conversation | null {
  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Conversation | undefined;
  return row ?? null;
}

export function listConversations(
  db: Database.Database,
  opts: {
    status?: ConversationStatus | "all";
    participant?: ClientId;
    limit?: number;
    offset?: number;
  } = {}
): Conversation[] {
  const { status = "active", participant, limit = 20, offset = 0 } = opts;

  const conditions: string[] = [];
  const params: unknown[] = [];

  let query: string;

  if (participant) {
    // Filter conversations where participant is sender or target of any message
    query = `SELECT DISTINCT c.* FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE (m.sender = ? OR m.target = ?)`;
    params.push(participant, participant);

    if (status !== "all") {
      conditions.push("c.status = ?");
      params.push(status);
    }

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(" AND ")}`;
    }
  } else {
    query = `SELECT * FROM conversations c`;

    if (status !== "all") {
      conditions.push("c.status = ?");
      params.push(status);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
  }

  query += ` ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params) as Conversation[];
}

export function updateConversation(
  db: Database.Database,
  id: string,
  updates: {
    title?: string;
    status?: ConversationStatus;
    summary?: string;
  }
): Conversation | null {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    sets.push("title = ?");
    params.push(updates.title);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
    if (updates.status === "completed" || updates.status === "archived") {
      sets.push("closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    }
  }
  if (updates.summary !== undefined) {
    sets.push("summary = ?");
    params.push(updates.summary);
  }

  params.push(id);

  db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getConversation(db, id);
}

export function closeConversation(
  db: Database.Database,
  id: string,
  summary?: string
): Conversation | null {
  return updateConversation(db, id, {
    status: "completed",
    summary,
  });
}
