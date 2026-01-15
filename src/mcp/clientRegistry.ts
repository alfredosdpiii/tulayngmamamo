import type { ClientId } from "../db/clients.js";

/**
 * In-memory registry of active client sessions.
 * Provides real-time, authoritative client online status
 * without relying on potentially-stale database state.
 */
export class ClientRegistry {
  private activeSessions = new Map<ClientId, string>(); // clientId -> sessionId

  /**
   * Register a client as online with their session ID
   */
  setOnline(clientId: ClientId, sessionId: string): void {
    this.activeSessions.set(clientId, sessionId);
  }

  /**
   * Mark a client as offline
   */
  setOffline(clientId: ClientId): void {
    this.activeSessions.delete(clientId);
  }

  /**
   * Check if a client currently has an active MCP session.
   * This is a real-time check against in-memory state.
   */
  isOnline(clientId: ClientId): boolean {
    return this.activeSessions.has(clientId);
  }

  /**
   * Get the session ID for an online client
   */
  getSessionId(clientId: ClientId): string | undefined {
    return this.activeSessions.get(clientId);
  }

  /**
   * Get all currently online clients
   */
  getOnlineClients(): ClientId[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Clear all sessions (used during shutdown)
   */
  clear(): void {
    this.activeSessions.clear();
  }
}
