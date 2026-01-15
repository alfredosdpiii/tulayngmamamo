/**
 * Agent persona types for the multi-agent system.
 * Inspired by oh-my-opencode's agent architecture.
 */

export type AgentCategory = "advisor" | "exploration" | "specialist";

export interface AgentPersona {
  /** Unique identifier for the agent */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category for grouping agents */
  category: AgentCategory;
  /** System prompt/instructions for this agent persona */
  baseInstructions: string;
  /** Keywords that trigger this agent when present in message content */
  triggers: string[];
  /** Override default sandbox mode for this agent */
  sandbox?: string;
}

/** Currently supported agent names */
export type AgentName = "architect" | "oracle";
