/**
 * Retrospective vocabulary sweep.
 *
 * `discipline.ts` normalises topics and people on the way in, but only against
 * the alias table that existed at capture time. A row written before an alias
 * was minted keeps the old tag forever, and a filter on the canonical tag
 * silently misses it. This re-runs the write path's own resolvers over rows that
 * predate their aliases — dream can never disagree with capture, because it is
 * the same function.
 */

import { resolvePeople, resolveTopics } from "../../capture/discipline.js";
import type { ThoughtRow } from "../../db/queries.js";

export interface VocabularyConfig {
  topicAliases: Record<string, string>;
  personAliases: Record<string, string>;
  selfNames: readonly string[];
}

export interface VocabularyChange {
  id: string;
  topics?: string[];
  people?: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function differs(before: string[], after: string[]): boolean {
  return before.length !== after.length || before.some((entry, index) => entry !== after[index]);
}

export function planVocabularyChange(
  row: ThoughtRow,
  knownTopics: readonly string[],
  config: VocabularyConfig,
): VocabularyChange | undefined {
  const metadata = row.metadata as Record<string, unknown>;
  const storedTopics = stringList(metadata.topics);
  const storedPeople = stringList(metadata.people);

  const topics = resolveTopics(storedTopics, knownTopics, config.topicAliases).topics;
  const people = resolvePeople(storedPeople, config.personAliases, config.selfNames).people;

  const change: VocabularyChange = { id: row.id };
  if (differs(storedTopics, topics)) change.topics = topics;
  if (differs(storedPeople, people)) change.people = people;

  return change.topics || change.people ? change : undefined;
}
