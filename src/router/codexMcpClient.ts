import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentPersona } from "../agents/types.js";

export interface CodexMcpClientOpts {
  /** Path to codex binary (default: "codex") */
  codexPath?: string;
  /** Working directory for codex process */
  cwd?: string;
  /** Sandbox mode: "workspace-read" | "workspace-write" | "none" */
  sandbox?: string;
  /** Approval policy: "never" | "auto-edit" | "full-auto" */
  approvalPolicy?: string;
  /** Base instructions to override Codex defaults */
  baseInstructions?: string;
}

/**
 * Default instructions that make Codex act as a critical architect.
 * Codex will examine the codebase and provide independent analysis,
 * pushing back on Claude's suggestions when appropriate.
 */
const DEFAULT_BASE_INSTRUCTIONS = `You are Codex, a CRITICAL ARCHITECT working alongside Claude (another AI assistant) through the tulayngmamamo bridge.

YOUR ROLE: Independent Technical Partner

CORE PRINCIPLES:
1. EXAMINE the codebase yourself - form your OWN opinion before responding
2. AGREE when Claude is right - but explain WHY you agree (don't just rubber-stamp)
3. DISAGREE when you see problems - provide specific alternatives
4. NEVER just go along to be agreeable - your value is independent analysis

WHEN REVIEWING CODE OR ARCHITECTURE:
- Look at the actual implementation, not just Claude's summary
- Consider: Does this fit the existing patterns? Are there edge cases?
- If Claude proposes a change, ask: Is there a simpler approach?
- Check for: security issues, performance concerns, maintainability

WHEN YOU DISAGREE:
- State your concern clearly and specifically
- Propose an alternative approach
- Explain the trade-offs between Claude's suggestion and yours

WHEN YOU AGREE:
- Confirm you've looked at the code yourself
- Add any additional considerations Claude may have missed
- Suggest improvements or extensions if appropriate

TONE: Collegial but direct. You're a senior architect doing code review - be honest, be specific, be helpful.

REMEMBER: Claude sent you this message because they want your technical judgment. Don't waste their time by just agreeing. Think critically.`;

export interface CodexCallResult {
  response: string;
  conversationId: string | null;
}

/**
 * MCP client for connecting to Codex running as an MCP server.
 * Spawns `codex mcp-server` on-demand and communicates via stdio transport.
 */
export class CodexMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private conversationIds: Map<string, string> = new Map(); // messageId -> conversationId
  private opts: Required<CodexMcpClientOpts>;

  constructor(opts: CodexMcpClientOpts = {}) {
    this.opts = {
      codexPath: opts.codexPath ?? "codex",
      cwd: opts.cwd ?? process.cwd(),
      sandbox: opts.sandbox ?? "workspace-read",
      approvalPolicy: opts.approvalPolicy ?? "never",
      baseInstructions: opts.baseInstructions ?? DEFAULT_BASE_INSTRUCTIONS,
    };
  }

  /**
   * Check if client is connected to Codex MCP server
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Connect to Codex MCP server by spawning the process
   */
  async connect(): Promise<boolean> {
    if (this.client) {
      return true; // Already connected
    }

    try {
      this.transport = new StdioClientTransport({
        command: this.opts.codexPath,
        args: ["mcp-server"],
        cwd: this.opts.cwd,
        stderr: "pipe", // Capture stderr for debugging
      });

      this.client = new Client(
        { name: "tulayngmamamo", version: "0.1.0" },
        { capabilities: {} }
      );

      await this.transport.start();
      await this.client.connect(this.transport);

      // Verify connection by listing tools
      const tools = await this.client.listTools();
      const toolNames = tools.tools.map((t) => t.name);

      if (!toolNames.includes("codex")) {
        throw new Error("Codex MCP server does not expose 'codex' tool");
      }

      return true;
    } catch (err) {
      await this.disconnect();
      console.error("[CodexMcpClient] Failed to connect:", err);
      return false;
    }
  }

  /**
   * Send a message to Codex using the MCP server.
   * Uses `codex` tool for new conversations, `codex-reply` for continuations.
   *
   * @param prompt - The message to send
   * @param messageId - Optional message ID for conversation tracking
   * @param persona - Optional agent persona to use (overrides default instructions)
   */
  async sendMessage(
    prompt: string,
    messageId?: string,
    persona?: AgentPersona
  ): Promise<CodexCallResult | null> {
    if (!this.client) {
      const connected = await this.connect();
      if (!connected) return null;
    }

    // Use persona's settings if provided, otherwise use defaults
    const baseInstructions = persona?.baseInstructions ?? this.opts.baseInstructions;
    const sandbox = persona?.sandbox ?? this.opts.sandbox;

    try {
      // Check if we have an existing conversation for follow-up
      const existingConversationId = messageId
        ? this.conversationIds.get(messageId)
        : null;

      let result;
      if (existingConversationId) {
        // Continue existing conversation
        result = await this.client!.callTool({
          name: "codex-reply",
          arguments: {
            conversationId: existingConversationId,
            prompt,
          },
        });
      } else {
        // Start new conversation with persona-specific instructions
        result = await this.client!.callTool({
          name: "codex",
          arguments: {
            prompt,
            "approval-policy": this.opts.approvalPolicy,
            sandbox,
            "base-instructions": baseInstructions,
          },
        });
      }

      // Extract response from result
      const response = this.extractResponse(result);
      const conversationId = this.extractConversationId(result);

      // Store conversation ID for future replies
      if (messageId && conversationId) {
        this.conversationIds.set(messageId, conversationId);
      }

      return {
        response: response ?? "",
        conversationId,
      };
    } catch (err) {
      console.error("[CodexMcpClient] Tool call failed:", err);
      // Connection might be broken, disconnect to allow reconnect
      await this.disconnect();
      return null;
    }
  }

  /**
   * Set conversation ID for a message (for continuing conversations)
   */
  setConversationId(messageId: string, conversationId: string): void {
    this.conversationIds.set(messageId, conversationId);
  }

  /**
   * Get conversation ID for a message
   */
  getConversationId(messageId: string): string | undefined {
    return this.conversationIds.get(messageId);
  }

  /**
   * Disconnect from Codex MCP server
   */
  async disconnect(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch {
      // Ignore close errors
    }
    this.client = null;
    this.transport = null;
  }

  /**
   * Extract text response from CallToolResult
   */
  private extractResponse(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;

    const r = result as Record<string, unknown>;

    // Check for content array (standard format)
    if (Array.isArray(r.content)) {
      for (const item of r.content) {
        if (
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item
        ) {
          return String(item.text);
        }
      }
    }

    // Check for toolResult (legacy format)
    if ("toolResult" in r && r.toolResult) {
      if (typeof r.toolResult === "string") {
        return r.toolResult;
      }
      if (typeof r.toolResult === "object" && "response" in (r.toolResult as object)) {
        return String((r.toolResult as { response: unknown }).response);
      }
    }

    // Try parsing as JSON in case response is stringified
    if (Array.isArray(r.content) && r.content[0]?.text) {
      try {
        const parsed = JSON.parse(r.content[0].text);
        if (parsed.response) return parsed.response;
      } catch {
        // Not JSON, return as-is
        return r.content[0].text;
      }
    }

    return null;
  }

  /**
   * Extract conversation ID from CallToolResult
   */
  private extractConversationId(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;

    const r = result as Record<string, unknown>;

    // Check content array for conversation ID in text
    if (Array.isArray(r.content)) {
      for (const item of r.content) {
        if (item?.type === "text" && item?.text) {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.conversationId) return parsed.conversationId;
          } catch {
            // Not JSON, skip
          }
        }
      }
    }

    // Check _meta
    if (r._meta && typeof r._meta === "object") {
      const meta = r._meta as Record<string, unknown>;
      if (meta.conversationId) return String(meta.conversationId);
    }

    return null;
  }
}
