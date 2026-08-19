/**
 * Structural alias inference.
 *
 * The vocabulary pass applied only the CONFIGURED alias table, so a brain that
 * had accumulated `Dohmen` and `Bert Dohmen`, or `market` and `markets`, kept
 * both forever: the operation named for unifying vocabulary unified nothing
 * nobody had already written down by hand.
 *
 * Everything here is structural — same words, different spelling. Nothing here
 * is semantic. `markets` and `market-analysis` are related and are NOT folded:
 * one is a subject and the other an activity, and collapsing them rewrites
 * metadata on a guess. Judgment calls belong in a proposal, not in a pass that
 * applies immediately.
 *
 * The canonical form is the one the brain already uses most, so the smallest
 * number of rows change. Ties break differently by kind, and deliberately:
 * shorter for topics, because a tag is a handle and the plain form is the
 * better handle; longer for people, because a full name disambiguates and a
 * bare surname does not.
 */

import { normaliseTopic } from "../../capture/discipline.js";

const SEPARATORS = /[\s_-]+/g;

/** Spelling-insensitive key: case, separators, and a trailing plural. */
function topicKey(topic: string): string {
  const flattened = topic.trim().toLowerCase().replace(SEPARATORS, "-");
  return flattened.replace(/(?:ies|es|s)$/, (match) =>
    match === "ies" ? "y" : "",
  );
}

/** Whole words, lowercased — "Bert Dohmen" and "bert dohmen" are one person. */
function words(name: string): string[] {
  return name.trim().toLowerCase().split(SEPARATORS).filter(Boolean);
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const bucket = groups.get(key(value));
    if (bucket) bucket.push(value);
    else groups.set(key(value), [value]);
  }
  return groups;
}

/**
 * Picks the form the brain uses most; `tieBreak` decides between equal counts.
 * Never returns undefined for a non-empty group.
 */
function canonicalOf(
  members: string[],
  counts: Record<string, number>,
  tieBreak: (a: string, b: string) => number,
): string {
  return [...members].sort((a, b) => {
    const byCount = (counts[b] ?? 0) - (counts[a] ?? 0);
    return byCount !== 0 ? byCount : tieBreak(a, b);
  })[0]!;
}

function aliasesFor(
  groups: Map<string, string[]>,
  counts: Record<string, number>,
  tieBreak: (a: string, b: string) => number,
): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const canonical = canonicalOf(members, counts, tieBreak);
    for (const member of members) {
      if (member !== canonical) aliases[member] = canonical;
    }
  }
  return aliases;
}

const shorterFirst = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
const longerFirst = (a: string, b: string) => b.length - a.length || a.localeCompare(b);

export function inferTopicAliases(counts: Record<string, number>): Record<string, string> {
  return aliasesFor(groupBy(Object.keys(counts), topicKey), counts, shorterFirst);
}

/**
 * Folds a name whose words are all contained in another name's, as whole words:
 * "Dohmen" into "Bert Dohmen", never "Ann" into "Anna". Two names that merely
 * share a first name ("Bert Dohmen", "Bert Schmidt") are different people and
 * neither contains the other.
 */
export function inferPersonAliases(counts: Record<string, number>): Record<string, string> {
  const names = Object.keys(counts);
  const parent = new Map<string, string>(names.map((name) => [name, name]));

  const find = (name: string): string => {
    let root = parent.get(name) ?? name;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    return root;
  };

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = words(names[i]!);
      const b = words(names[j]!);
      const contained =
        a.every((word) => b.includes(word)) || b.every((word) => a.includes(word));
      if (!contained) continue;
      const rootA = find(names[i]!);
      const rootB = find(names[j]!);
      if (rootA !== rootB) parent.set(rootB, rootA);
    }
  }

  const groups = groupBy(names, find);
  return aliasesFor(groups, counts, longerFirst);
}

export interface VocabularyCounts {
  topics: Record<string, number>;
  people: Record<string, number>;
}

/**
 * Alias maps keyed the way the write-path resolvers look them up — topics by
 * `normaliseTopic`, people lowercased. A map keyed by the stored spelling type
 * checks and then silently never matches, which is the failure mode worth one
 * function rather than two call sites remembering.
 */
export interface InferredAliases {
  topicAliases: Record<string, string>;
  personAliases: Record<string, string>;
  /**
   * The stored spellings that need rewriting, as written.
   *
   * The alias maps above are keyed for the resolvers, which normalise before
   * looking up. Finding the ROWS to rewrite is a different question: the tag
   * lookup compares stored spellings exactly, so a normalised key matches
   * nothing and the sweep quietly does no work.
   */
  variants: { topics: string[]; people: string[] };
}

export function inferAliases(counts: VocabularyCounts): InferredAliases {
  const topicAliases: Record<string, string> = {};
  const topicVariants: string[] = [];
  for (const [variant, canonical] of Object.entries(inferTopicAliases(counts.topics))) {
    topicVariants.push(variant);
    const key = normaliseTopic(variant);
    const value = normaliseTopic(canonical);
    if (key.length > 0 && value.length > 0) topicAliases[key] = value;
  }

  const personAliases: Record<string, string> = {};
  const personVariants: string[] = [];
  for (const [variant, canonical] of Object.entries(inferPersonAliases(counts.people))) {
    personAliases[variant.trim().toLowerCase()] = canonical;
    personVariants.push(variant);
  }

  return {
    topicAliases,
    personAliases,
    variants: { topics: topicVariants, people: personVariants },
  };
}
