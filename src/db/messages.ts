import type Database from "better-sqlite3";
import type { ClientId } from "./clients.js";
import { randomUUID } from "node:crypto";

export type MessageType =
  | "message"
  | "research_request"
  | "research_response"
  | "review_request"
  | "review_response"
  | "context_share"
  | "system";

export type MessagePriority = "normal" | "high" | "urgent";
export type MessageStatus = "pending" | "delivered" | "read" | "responded";

export interface Message {
  id: string;
  conversation_id: string;
  sender: ClientId;
  target: ClientId;
  content: string;
  message_type: MessageType;
  priority: MessagePriority;
  status: MessageStatus;
  response_to_id: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  metadata: string | null;
}

export interface CreateMessageInput {
  conversation_id: string;
  sender: ClientId;
  target: ClientId;
  content: string;
  message_type?: MessageType;
  priority?: MessagePriority;
  response_to_id?: string;
  metadata?: Record<string, unknown>;
}

export function createMessage(
  db: Database.Database,
  input: CreateMessageInput
): Message {
  const id = randomUUID();
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender, target, content, message_type, priority, response_to_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversation_id,
    input.sender,
    input.target,
    input.content,
    input.message_type ?? "message",
    input.priority ?? "normal",
    input.response_to_id ?? null,
    metadata
  );

  // Update conversation updated_at
  db.prepare(`
    UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
  `).run(input.conversation_id);

  return getMessage(db, id)!;
}

export function getMessage(db: Database.Database, id: string): Message | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Message | undefined;
  return row ?? null;
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: string,
  opts: { limit?: number; offset?: number } = {}
): Message[] {
  const { limit = 50, offset = 0 } = opts;

  return db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `).all(conversationId, limit, offset) as Message[];
}

export function updateMessageStatus(
  db: Database.Database,
  id: string,
  status: MessageStatus
): void {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  let extraSet = "";

  if (status === "delivered") {
    extraSet = `, delivered_at = ${now}`;
  } else if (status === "read") {
    extraSet = `, read_at = ${now}`;
  }

  db.prepare(`UPDATE messages SET status = ?${extraSet} WHERE id = ?`).run(status, id);
}

export function getPendingMessagesForTarget(
  db: Database.Database,
  target: ClientId,
  limit: number = 10
): Message[] {
  return db.prepare(`
    SELECT * FROM messages
    WHERE target = ? AND status = 'pending'
    ORDER BY
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        ELSE 2
      END,
      created_at ASC
    LIMIT ?
  `).all(target, limit) as Message[];
}

export function searchMessages(
  db: Database.Database,
  query: string,
  opts: { conversationId?: string; limit?: number } = {}
): Message[] {
  const { conversationId, limit = 50 } = opts;

  let sql = `
    SELECT m.* FROM messages m
    JOIN messages_fts fts ON m.rowid = fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (conversationId) {
    sql += ` AND m.conversation_id = ?`;
    params.push(conversationId);
  }

  sql += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Message[];
}

export function getResponseToMessage(
  db: Database.Database,
  messageId: string
): Message | null {
  const row = db.prepare(`
    SELECT * FROM messages WHERE response_to_id = ? ORDER BY created_at ASC LIMIT 1
  `).get(messageId) as Message | undefined;
  return row ?? null;
}
