/**
 * Shared types and interface for embedding providers.
 */

export type ThoughtType =
  | "observation"
  | "task"
  | "idea"
  | "reference"
  | "person_note"
  | "decision"
  | "meeting"
  | "architecture"
  | "pattern"
  | "postmortem"
  | "requirement"
  | "bug"
  | "convention";

export interface ThoughtMetadataExtracted {
  type: ThoughtType;
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
}

export const DEFAULT_METADATA: ThoughtMetadataExtracted = {
  type: "observation",
  topics: [],
  people: [],
  action_items: [],
  dates: [],
};

export interface Embedder {
  /** Convert text to a vector embedding. */
  generateEmbedding(text: string): Promise<number[]>;

  /** Use an LLM to extract structured metadata from content. */
  extractMetadata(content: string): Promise<ThoughtMetadataExtracted>;

  /** Decide whether two similar thoughts actually disagree. Used by dream. */
  judgeContradiction(a: JudgeInput, b: JudgeInput): Promise<ContradictionJudgment>;

  /** Write one statement covering a cluster of related thoughts. Used by dream. */
  synthesise(contents: string[]): Promise<string>;
}

/** The only fields a judgment needs — keeps the embedder free of db types. */
export interface JudgeInput {
  id: string;
  content: string;
}

/**
 * Source of truth for the verdict set. The runtime array and the type are
 * derived from one another so a new verdict cannot type-check while still being
 * discarded by the runtime guard that reads this same array.
 */
export const CONTRADICTION_VERDICTS = ["contradicts", "supersedes", "independent"] as const;
export type ContradictionVerdictName = (typeof CONTRADICTION_VERDICTS)[number];

export interface ContradictionJudgment {
  verdict: ContradictionVerdictName;
  reason: string;
  /**
   * The thought to archive. Required for BOTH "contradicts" and "supersedes" —
   * the prompt asks for it in both cases, and a verdict naming no loser is not
   * actionable. Optional in the type only because a provider may omit it; the
   * caller discards such a judgment rather than guessing.
   */
  obsolete_id?: string;
}

export const METADATA_PROMPT = `Extract metadata from the following thought. Return JSON with:
- type: one of the following:
  - "observation" — General observations, notes, or musings
  - "task" — Action items, things to do
  - "idea" — Creative ideas, proposals, brainstorms
  - "reference" — Links, resources, documentation pointers
  - "person_note" — Notes about or from a specific person
  - "decision" — Choices made, options evaluated
  - "meeting" — Meeting notes, agendas, outcomes
  - "architecture" — System design decisions, layer choices, technology selection
  - "pattern" — Reusable code patterns, conventions, approaches
  - "postmortem" — Lessons learned, what went wrong, what to repeat
  - "requirement" — Functional or non-functional requirements
  - "bug" — Bug discoveries, root causes, fixes
  - "convention" — Naming, formatting, workflow conventions
- topics: array of 1-3 topic tags (lowercase, hyphenated)
- people: array of people mentioned (proper names)
- action_items: array of implied action items
- dates: array of dates mentioned (YYYY-MM-DD format)
Return ONLY valid JSON, no explanation.`;

export const CONTRADICTION_PROMPT = `Two thoughts from a personal knowledge base are similar. Decide their relationship. Return JSON with:
- verdict: one of
  - "contradicts" — they make incompatible claims about the same thing
  - "supersedes" — one is a later, corrected version of the other
  - "independent" — both can be true at once, or they are about different things
- reason: one short sentence
- obsolete_id: REQUIRED when verdict is "contradicts" or "supersedes" — the id of the thought that should be archived. Must be one of the two ids given.
Default to "independent" when unsure. Archiving a true thought is worse than keeping a redundant one.
Return ONLY valid JSON, no explanation.`;

export const SYNTHESIS_PROMPT = `Several thoughts from a personal knowledge base cover one subject. Write the single statement that ties them together — the thing the author would have written if they had seen all of these at once.
Rules:
- One paragraph, no preamble, no bullet list.
- Preserve every specific literal (numbers, names, ids, dates) that appears in the sources.
- Add no claim that is not supported by the sources.
Return ONLY the statement text.`;

/**
 * The judgment prompt asks the model to return one of the two ids. That is only
 * answerable if both ids are in the payload, so the formatting is not cosmetic.
 */
export function judgePayload(a: JudgeInput, b: JudgeInput): string {
  return [`id: ${a.id}`, a.content, "---", `id: ${b.id}`, b.content].join("\n");
}
