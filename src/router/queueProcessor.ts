import type Database from "better-sqlite3";
import type { ClientId } from "../db/clients.js";
import { isClientOnline } from "../db/clients.js";
import {
  dequeueMessages,
  removeFromQueue,
  incrementAttempts,
  clearExhaustedMessages,
  type QueuedMessage,
} from "../db/message_queue.js";
import { getMessage, updateMessageStatus } from "../db/messages.js";

const CLIENTS: ClientId[] = ["claude", "codex"];

export class QueueProcessor {
  private db: Database.Database;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, pollIntervalMs: number = 5000) {
    this.db = db;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start the background queue processing loop.
   * Runs every pollIntervalMs to check for deliverable messages.
   */
  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.processQueue().catch((err) => {
        console.error("[QueueProcessor] Error processing queue:", err);
      });
    }, this.pollIntervalMs);

    // Cleanup exhausted messages every 5 minutes
    this.cleanupIntervalId = setInterval(() => {
      const cleared = clearExhaustedMessages(this.db);
      if (cleared > 0) {
        console.log(`[QueueProcessor] Cleared ${cleared} exhausted messages`);
      }
    }, 5 * 60 * 1000);

    console.log(`[QueueProcessor] Started with ${this.pollIntervalMs}ms interval`);
  }

  /**
   * Stop the background queue processing loop.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    console.log("[QueueProcessor] Stopped");
  }

  /**
   * Process the queue for all clients.
   */
  async processQueue(): Promise<void> {
    for (const target of CLIENTS) {
      await this.processQueueForTarget(target);
    }
  }

  /**
   * Process queued messages for a specific target client.
   * Only delivers if the target is currently online.
   * Uses exponential backoff for failed delivery attempts.
   */
  async processQueueForTarget(target: ClientId): Promise<void> {
    if (!isClientOnline(this.db, target)) {
      return;
    }

    const queued = dequeueMessages(this.db, target, 10);
    if (queued.length === 0) return;

    let delivered = 0;
    let retried = 0;

    for (const item of queued) {
      try {
        const result = await this.attemptDelivery(target, item);
        if (result === "delivered") {
          delivered++;
        } else if (result === "retry") {
          retried++;
        }
        // "removed" means message was deleted, no action needed
      } catch (err) {
        // Unexpected error - schedule retry with backoff
        console.error(`[QueueProcessor] Error delivering message ${item.message_id}:`, err);
        this.scheduleRetry(item);
        retried++;
      }
    }

    if (delivered > 0 || retried > 0) {
      console.log(`[QueueProcessor] ${target}: delivered=${delivered}, retried=${retried}`);
    }
  }

  /**
   * Attempt to deliver a single queued message.
   * Returns: "delivered" | "retry" | "removed"
   */
  private async attemptDelivery(
    target: ClientId,
    item: QueuedMessage
  ): Promise<"delivered" | "retry" | "removed"> {
    const message = getMessage(this.db, item.message_id);
    if (!message) {
      // Message was deleted, remove from queue
      removeFromQueue(this.db, item.message_id);
      return "removed";
    }

    // Double-check target is still online (could have disconnected mid-loop)
    if (!isClientOnline(this.db, target)) {
      // Client went offline - schedule retry
      this.scheduleRetry(item);
      return "retry";
    }

    // Mark as delivered and remove from queue
    updateMessageStatus(this.db, message.id, "delivered");
    removeFromQueue(this.db, item.message_id);
    return "delivered";
  }

  /**
   * Schedule a retry with exponential backoff.
   * Delay doubles with each attempt: 30s, 60s, 120s, 240s, ...
   */
  private scheduleRetry(item: QueuedMessage): void {
    const baseDelay = 30; // seconds
    const backoffDelay = baseDelay * Math.pow(2, item.attempts);
    const maxDelay = 3600; // 1 hour max
    const delay = Math.min(backoffDelay, maxDelay);

    incrementAttempts(this.db, item.id, delay);
    console.log(
      `[QueueProcessor] Scheduled retry for message ${item.message_id} ` +
      `(attempt ${item.attempts + 1}, delay ${delay}s)`
    );
  }

  /**
   * Called when a client comes online - immediately drain their queue.
   * This provides faster delivery than waiting for the next poll interval.
   */
  async onClientOnline(clientId: ClientId): Promise<void> {
    console.log(`[QueueProcessor] Client ${clientId} came online, draining queue`);
    await this.processQueueForTarget(clientId);
  }
}
