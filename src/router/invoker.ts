import { execa, type ExecaError } from "execa";
import type Database from "better-sqlite3";
import type { Message } from "../db/messages.js";
import {
  createInvocation,
  updateInvocation,
  getInvocationByMessageId,
  type Invocation,
} from "../db/invocations.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export { getInvocationByMessageId };
export type { Invocation };

// Resolve schema paths relative to this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, "..", "schemas");

function getSchemaPath(messageType: string | undefined): string {
  switch (messageType) {
    case "research_request":
      return join(SCHEMAS_DIR, "research-response.json");
    case "review_request":
      return join(SCHEMAS_DIR, "review-response.json");
    default:
      return join(SCHEMAS_DIR, "general-response.json");
  }
}

interface ResearchResponse {
  summary: string;
  findings: Array<{ title: string; description: string; code_references?: string[] }>;
  recommendations?: string[];
  concerns?: string[];
  code_snippets?: Array<{ file?: string; language?: string; code: string; explanation?: string }>;
}

interface ReviewResponse {
  summary: string;
  verdict: "approve" | "request_changes" | "comment";
  issues?: Array<{ severity: string; file?: string; line?: number; description: string; suggestion?: string }>;
  strengths?: string[];
  recommendations?: string[];
}

interface GeneralResponse {
  response: string;
  summary?: string;
  references?: string[];
}

/**
 * Format structured response into readable markdown
 */
function formatStructuredResponse(data: ResearchResponse | ReviewResponse | GeneralResponse, messageType: string | undefined): string {
  if ("verdict" in data) {
    // Review response
    const r = data as ReviewResponse;
    let output = `## Review: ${r.verdict.toUpperCase()}\n\n${r.summary}\n`;
    if (r.strengths?.length) {
      output += `\n### Strengths\n${r.strengths.map(s => `- ${s}`).join("\n")}\n`;
    }
    if (r.issues?.length) {
      output += `\n### Issues\n`;
      for (const issue of r.issues) {
        output += `- **[${issue.severity}]** ${issue.description}`;
        if (issue.file) output += ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`;
        if (issue.suggestion) output += `\n  - Suggestion: ${issue.suggestion}`;
        output += "\n";
      }
    }
    if (r.recommendations?.length) {
      output += `\n### Recommendations\n${r.recommendations.map(rec => `- ${rec}`).join("\n")}\n`;
    }
    return output;
  }

  if ("findings" in data) {
    // Research response
    const r = data as ResearchResponse;
    let output = `## Summary\n${r.summary}\n\n## Findings\n`;
    for (const finding of r.findings) {
      output += `### ${finding.title}\n${finding.description}\n`;
      if (finding.code_references?.length) {
        output += `\nReferences: ${finding.code_references.join(", ")}\n`;
      }
      output += "\n";
    }
    if (r.concerns?.length) {
      output += `## Concerns\n${r.concerns.map(c => `- ${c}`).join("\n")}\n\n`;
    }
    if (r.recommendations?.length) {
      output += `## Recommendations\n${r.recommendations.map(rec => `- ${rec}`).join("\n")}\n\n`;
    }
    if (r.code_snippets?.length) {
      output += `## Code Examples\n`;
      for (const snippet of r.code_snippets) {
        if (snippet.file) output += `**${snippet.file}**\n`;
        output += `\`\`\`${snippet.language || ""}\n${snippet.code}\n\`\`\`\n`;
        if (snippet.explanation) output += `${snippet.explanation}\n`;
        output += "\n";
      }
    }
    return output;
  }

  // General response
  const r = data as GeneralResponse;
  let output = r.response;
  if (r.summary && r.response.length > 500) {
    output = `## Summary\n${r.summary}\n\n## Details\n${r.response}`;
  }
  if (r.references?.length) {
    output += `\n\n## References\n${r.references.map(ref => `- ${ref}`).join("\n")}`;
  }
  return output;
}

export interface InvocationResult {
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  response?: string;
}

// Maximum response size before we try to extract/summarize
const MAX_RESPONSE_SIZE = 50000; // ~50KB

interface CodexEvent {
  type: string;
  item?: {
    type: string;
    text?: string;
    items?: Array<{ text: string; completed: boolean }>;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  response?: {
    output_text?: string;
  };
  thread_id?: string;
}

/**
 * Extract meaningful content from Codex NDJSON output.
 * Prioritizes: structured output > agent_message > reasoning summary > command outputs
 */
function extractCodexResponse(stdout: string, messageType?: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  const events: CodexEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip invalid JSON
    }
  }

  // 1. Look for structured output from --output-schema (response.completed or response.output_text)
  for (const event of [...events].reverse()) {
    // Check for response.completed with output_text
    if (event.type === "response.completed" && event.response?.output_text) {
      try {
        const structured = JSON.parse(event.response.output_text);
        return formatStructuredResponse(structured, messageType);
      } catch {
        return event.response.output_text;
      }
    }
    // Also check turn.completed which may contain the final output
    const raw = event as unknown as { type?: string; output_text?: string };
    if (raw.type === "turn.completed" && raw.output_text) {
      try {
        const structured = JSON.parse(raw.output_text);
        return formatStructuredResponse(structured, messageType);
      } catch {
        return raw.output_text;
      }
    }
  }

  // 2. Look for agent_message (final answer without schema)
  for (const event of [...events].reverse()) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      return event.item.text;
    }
    // Fallback: older format {"type":"message","role":"assistant","content":"..."}
    const raw = event as unknown as { type?: string; role?: string; content?: string };
    if (raw.type === "message" && raw.role === "assistant" && typeof raw.content === "string") {
      return raw.content;
    }
  }

  // 3. No structured output or agent_message - extract summary from reasoning and commands
  const reasoning: string[] = [];
  const commands: string[] = [];

  for (const event of events) {
    if (event.type === "item.completed" && event.item) {
      if (event.item.type === "reasoning" && event.item.text) {
        // Keep last 2 reasoning blocks (most recent thoughts)
        reasoning.push(event.item.text);
        if (reasoning.length > 2) reasoning.shift();
      }
      if (event.item.type === "command_execution" && event.item.command) {
        const output = event.item.aggregated_output || "";
        const exitCode = event.item.exit_code;
        // Keep last 3 command results
        commands.push(
          `$ ${event.item.command.replace(/^\/usr\/bin\/bash -lc /, "")}\n` +
          `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}` +
          `${exitCode !== 0 ? ` (exit: ${exitCode})` : ""}`
        );
        if (commands.length > 3) commands.shift();
      }
    }
  }

  if (reasoning.length === 0 && commands.length === 0) {
    return undefined;
  }

  let summary = "[Codex exploration - no final answer]\n\n";
  if (reasoning.length > 0) {
    summary += "## Latest Reasoning\n" + reasoning.join("\n\n") + "\n\n";
  }
  if (commands.length > 0) {
    summary += "## Recent Commands\n" + commands.join("\n\n");
  }

  return summary;
}

function buildCodexPrompt(message: Message, conversationContext?: string): string {
  let prompt = "";

  if (conversationContext) {
    prompt += `You are participating in a conversation with Claude Code CLI.\n\n`;
    prompt += `Previous context:\n${conversationContext}\n\n`;
  }

  prompt += `You have received a message from Claude:\n\n`;
  prompt += `---\n${message.content}\n---\n\n`;

  if (message.message_type === "research_request") {
    prompt += `This is a research request. Please investigate this topic and provide your findings.\n`;
    prompt += `IMPORTANT: After your research, you MUST write a final summary as your last action.\n`;
    prompt += `Do not end with just commands or exploration - conclude with a written response.\n`;
  } else if (message.message_type === "review_request") {
    prompt += `This is a code review request. Please review the provided code and give detailed feedback.\n`;
    prompt += `IMPORTANT: After your review, you MUST write a final summary with your recommendations.\n`;
  } else {
    prompt += `Please respond with your analysis, insights, or answer.\n`;
    prompt += `IMPORTANT: You MUST conclude with a written response summarizing your findings.\n`;
  }

  prompt += `\nBe efficient - limit exploration to what's necessary, then provide your conclusion.`;

  return prompt;
}

export interface InvokeCodexOptions {
  timeoutMs?: number;
  useOutputSchema?: boolean;
}

export async function invokeCodexExec(
  db: Database.Database,
  message: Message,
  conversationContext?: string,
  options: InvokeCodexOptions = {}
): Promise<InvocationResult> {
  // Default timeout: 5 minutes for high reasoning effort
  const { timeoutMs = 300000, useOutputSchema = true } = options;
  const prompt = buildCodexPrompt(message, conversationContext);

  // Build args array - use output schema to force structured completion
  const schemaPath = getSchemaPath(message.message_type);
  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
  ];

  // Add output schema to force Codex to produce a final structured response
  if (useOutputSchema) {
    args.push("--output-schema", schemaPath);
  }

  args.push(prompt);

  // Store structured command info for logging (NOT a shell command - we use safe array-based execa)
  const commandInfo = JSON.stringify({
    executable: "codex",
    args: args.slice(0, -1), // Exclude prompt from log
    schemaPath: useOutputSchema ? schemaPath : undefined,
    promptLength: prompt.length,
    promptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
  });

  const invocation = createInvocation(db, {
    target: "codex",
    message_id: message.id,
    invocation_type: "codex_exec",
    command: commandInfo,
  });

  updateInvocation(db, invocation.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  try {
    // Array-based execa() bypasses shell - safe from command injection
    const result = await execa("codex", args, {
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

    // Extract response from Codex NDJSON output
    // This handles: structured output > agent_message > reasoning summary > size limits
    let response = extractCodexResponse(result.stdout, message.message_type);

    // Final fallback to raw stdout if extraction failed
    if (!response && result.stdout) {
      response = result.stdout.length > MAX_RESPONSE_SIZE
        ? result.stdout.slice(0, MAX_RESPONSE_SIZE) + "\n\n[Response truncated - exceeded 50KB]"
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
