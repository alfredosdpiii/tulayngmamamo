import type Database from "better-sqlite3";
import type { ClientId } from "./clients.js";

export interface QueuedMessage {
  id: number;
  message_id: string;
  target: ClientId;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_attempt: string;
  created_at: string;
}

export interface CreateQueuedMessageInput {
  message_id: string;
  target: ClientId;
  priority?: number;
  max_attempts?: number;
}

export interface QueueStats {
  target: ClientId;
  pending: number;
  ready: number;
  exhausted: number;
}

export function enqueueMessage(
  db: Database.Database,
  input: CreateQueuedMessageInput
): QueuedMessage {
  const result = db.prepare(`
    INSERT INTO message_queue (message_id, target, priority, max_attempts)
    VALUES (?, ?, ?, ?)
  `).run(
    input.message_id,
    input.target,
    input.priority ?? 0,
    input.max_attempts ?? 3
  );

  return db.prepare(`SELECT * FROM message_queue WHERE id = ?`).get(result.lastInsertRowid) as QueuedMessage;
}

export function getQueuedMessage(
  db: Database.Database,
  messageId: string
): QueuedMessage | null {
  const row = db.prepare(`SELECT * FROM message_queue WHERE message_id = ?`).get(messageId) as QueuedMessage | undefined;
  return row ?? null;
}

export function dequeueMessages(
  db: Database.Database,
  target: ClientId,
  limit: number = 10
): QueuedMessage[] {
  // Get messages that are ready (next_attempt <= now) and haven't exceeded max_attempts
  return db.prepare(`
    SELECT * FROM message_queue
    WHERE target = ?
      AND next_attempt <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND attempts < max_attempts
    ORDER BY priority DESC, next_attempt ASC
    LIMIT ?
  `).all(target, limit) as QueuedMessage[];
}

export function incrementAttempts(
  db: Database.Database,
  id: number,
  delaySeconds: number = 30
): void {
  // Increment attempts and set next_attempt to now + delay (exponential backoff built into delay param)
  db.prepare(`
    UPDATE message_queue
    SET attempts = attempts + 1,
        next_attempt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
    WHERE id = ?
  `).run(delaySeconds, id);
}

export function removeFromQueue(
  db: Database.Database,
  messageId: string
): boolean {
  const result = db.prepare(`DELETE FROM message_queue WHERE message_id = ?`).run(messageId);
  return result.changes > 0;
}

export function getQueueStats(db: Database.Database): QueueStats[] {
  return db.prepare(`
    SELECT
      target,
      COUNT(*) as pending,
      SUM(CASE WHEN next_attempt <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND attempts < max_attempts THEN 1 ELSE 0 END) as ready,
      SUM(CASE WHEN attempts >= max_attempts THEN 1 ELSE 0 END) as exhausted
    FROM message_queue
    GROUP BY target
  `).all() as QueueStats[];
}

export function getQueueLength(
  db: Database.Database,
  target?: ClientId
): number {
  if (target) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM message_queue WHERE target = ?`).get(target) as { count: number };
    return row.count;
  }
  const row = db.prepare(`SELECT COUNT(*) as count FROM message_queue`).get() as { count: number };
  return row.count;
}

export function clearExhaustedMessages(db: Database.Database): number {
  const result = db.prepare(`
    DELETE FROM message_queue WHERE attempts >= max_attempts
  `).run();
  return result.changes;
}
