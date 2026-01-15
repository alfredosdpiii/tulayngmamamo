import { ARCHITECT } from "./personas/architect.js";
import { ORACLE } from "./personas/oracle.js";
import type { AgentPersona, AgentName } from "./types.js";

/**
 * Registry of all available agent personas.
 */
export const AGENT_PERSONAS: Record<AgentName, AgentPersona> = {
  architect: ARCHITECT,
  oracle: ORACLE,
};

/**
 * Default agent when no specific selection is made.
 */
export const DEFAULT_AGENT: AgentName = "architect";

/**
 * Get an agent persona by name.
 * Returns the default agent if name is not found.
 */
export function getAgent(name: string | undefined): AgentPersona {
  if (name && name in AGENT_PERSONAS) {
    return AGENT_PERSONAS[name as AgentName];
  }
  return AGENT_PERSONAS[DEFAULT_AGENT];
}

/**
 * Select the appropriate agent based on message content.
 * Uses keyword matching against agent triggers.
 *
 * Selection priority:
 * 1. Oracle - for debugging, investigation, root cause analysis
 * 2. Architect - default for everything else (code review, architecture)
 */
export function selectAgent(content: string): AgentPersona {
  const lower = content.toLowerCase();

  // Oracle triggers: debugging, investigation, root cause
  const oracleTriggers = [
    "why",
    "debug",
    "investigate",
    "root cause",
    "understand",
    "explain",
    "failing",
    "broken",
    "not working",
    "error",
    "bug",
  ];

  for (const trigger of oracleTriggers) {
    if (lower.includes(trigger)) {
      return ORACLE;
    }
  }

  // Default to architect for everything else
  return ARCHITECT;
}

/**
 * List all available agent names.
 */
export function listAgentNames(): AgentName[] {
  return Object.keys(AGENT_PERSONAS) as AgentName[];
}
