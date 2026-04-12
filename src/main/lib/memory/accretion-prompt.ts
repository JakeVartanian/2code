/**
 * Prompt template for memory extraction via Haiku.
 * Instructs the model to identify decisions, mistakes, patterns,
 * conventions, and rejected approaches from a session transcript.
 */

export const ACCRETION_SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to analyze a coding session transcript and extract durable knowledge worth remembering for future sessions on this project.

Extract ONLY information that would be valuable in future sessions — skip trivial exchanges, greetings, and task-specific details that won't generalize.

Return a JSON array of memory entries. Each entry must have:
- "category": one of "architecture-decision", "rejected-approach", "convention", "debugging-pattern", "operational-knowledge", "project-identity"
- "confidence": "low", "medium", or "high"
- "tags": array of short keyword strings
- "title": a concise title (under 80 chars)
- "body": markdown body with structured content appropriate to the category

Category guidelines:
- "architecture-decision": Include Context, Decision, Rejected alternatives, Rationale
- "rejected-approach": Include What was attempted, Why it failed, What was done instead
- "convention": Include the pattern/rule and examples
- "debugging-pattern": Include Symptom, Root cause, Fix
- "operational-knowledge": Include the setup, gotcha, or environment-specific detail
- "project-identity": Include high-level project description, tech stack, key constraints

If the session contains no extractable knowledge, return an empty array: []

Respond with ONLY the JSON array, no other text.`

export function buildAccretionUserPrompt(messages: string): string {
  return `Analyze this session transcript and extract durable project knowledge:\n\n${messages}`
}
