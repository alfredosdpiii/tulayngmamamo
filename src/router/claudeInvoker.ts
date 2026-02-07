import { execa, type ExecaError } from "execa";
import type Database from "better-sqlite3";
import type { Message } from "../db/messages.js";
import {
  createInvocation,
  updateInvocation,
  getInvocationByMessageId,
  type Invocation,
} from "../db/invocations.js";

export { getInvocationByMessageId };
export type { Invocation };

const DEFAULT_CLAUDE_MODEL =
  process.env.TULAYNGMAMAMO_CLAUDE_MODEL ?? "sonnet";

interface ClaudeJsonOutput {
  type: string;
  subtype: string;
  cost_usd: number;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
}

export interface InvocationResult {
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  response?: string;
}

function extractClaudeResponse(stdout: string): string | undefined {
  try {
    const parsed: ClaudeJsonOutput = JSON.parse(stdout);
    if (parsed.is_error) return undefined;
    return parsed.result || undefined;
  } catch {
    // If JSON parsing fails, try to use raw stdout
    return stdout.length > 0 ? stdout : undefined;
  }
}

function buildClaudePrompt(message: Message, conversationContext?: string): string {
  let prompt = "";

  if (conversationContext) {
    prompt += "You are participating in a conversation with Codex CLI.\n\n";
    prompt += `Previous context:\n${conversationContext}\n\n`;
  }

  prompt += "You have received a message from Codex:\n\n";
  prompt += `---\n${message.content}\n---\n\n`;

  if (message.message_type === "research_request") {
    prompt += "This is a research request. Investigate this topic and provide your findings.\n";
  } else if (message.message_type === "review_request") {
    prompt += "This is a code review request. Review the provided code and give detailed feedback.\n";
  } else {
    prompt += "Please respond with your analysis, insights, or answer.\n";
  }

  prompt += "\nBe efficient and thorough. Provide a clear conclusion.";

  return prompt;
}

export interface InvokeClaudeOptions {
  timeoutMs?: number;
}

const MAX_RESPONSE_SIZE = 50000;

export async function invokeClaudeExec(
  db: Database.Database,
  message: Message,
  conversationContext?: string,
  options: InvokeClaudeOptions = {}
): Promise<InvocationResult> {
  const { timeoutMs = 300000 } = options;
  const prompt = buildClaudePrompt(message, conversationContext);

  const args = [
    "-p",
    "--output-format", "json",
    "--model", DEFAULT_CLAUDE_MODEL,
    "--dangerously-skip-permissions",
    // Prevent recursion: don't load any MCP servers in the subprocess
    "--strict-mcp-config",
    // Prompt must be last (positional argument)
    prompt,
  ];

  const commandInfo = JSON.stringify({
    executable: "claude",
    args: args.filter((a) => a !== prompt),
    promptLength: prompt.length,
    promptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
  });

  const invocation = createInvocation(db, {
    target: "claude",
    message_id: message.id,
    invocation_type: "claude_exec",
    command: commandInfo,
  });

  updateInvocation(db, invocation.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  try {
    const result = await execa("claude", args, {
      timeout: timeoutMs,
      reject: false,
    });

    const success = result.exitCode === 0;

    updateInvocation(db, invocation.id, {
      status: success ? "completed" : "failed",
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode ?? null,
      completed_at: new Date().toISOString(),
    });

    let response = extractClaudeResponse(result.stdout);

    if (!response && result.stdout) {
      response =
        result.stdout.length > MAX_RESPONSE_SIZE
          ? result.stdout.slice(0, MAX_RESPONSE_SIZE) +
            "\n\n[Response truncated - exceeded 50KB]"
          : result.stdout;
    }

    return {
      id: invocation.id,
      success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? null,
      response,
    };
  } catch (err) {
    const execaErr = err as ExecaError;
    const isTimeout = execaErr.timedOut;

    updateInvocation(db, invocation.id, {
      status: isTimeout ? "timeout" : "failed",
      stderr: execaErr.message,
      completed_at: new Date().toISOString(),
    });

    return {
      id: invocation.id,
      success: false,
      stdout: "",
      stderr: execaErr.message,
      exitCode: null,
    };
  }
}
