import type Database from "better-sqlite3";

export type ClientId = "claude" | "codex";
export type ClientStatus = "online" | "offline" | "busy";

export interface Client {
  id: ClientId;
  display_name: string;
  last_seen_at: string | null;
  session_id: string | null;
  status: ClientStatus;
  created_at: string;
}

export function getClient(db: Database.Database, id: ClientId): Client | null {
  const row = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(id) as Client | undefined;
  return row ?? null;
}

export function getAllClients(db: Database.Database): Client[] {
  return db.prepare(`SELECT * FROM clients`).all() as Client[];
}

export function updateClientStatus(
  db: Database.Database,
  id: ClientId,
  status: ClientStatus,
  sessionId?: string
): void {
  db.prepare(`
    UPDATE clients
    SET status = ?, session_id = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(status, sessionId ?? null, id);
}

export function setClientOffline(db: Database.Database, id: ClientId): void {
  db.prepare(`
    UPDATE clients
    SET status = 'offline', session_id = NULL
    WHERE id = ?
  `).run(id);
}

export function isClientOnline(db: Database.Database, id: ClientId): boolean {
  const client = getClient(db, id);
  return client?.status === "online";
}

export function getClientBySession(db: Database.Database, sessionId: string): Client | null {
  const row = db.prepare(`SELECT * FROM clients WHERE session_id = ?`).get(sessionId) as Client | undefined;
  return row ?? null;
}
