/**
 * The dream run.
 *
 * Data access sits behind `DreamPort` so the tiering decision — what applies
 * now, what waits for review — is testable without a database or a provider.
 * The pg-backed port lives in `port.ts`; both transports share this entry point,
 * so a client cannot skip the rules by choosing a different port.
 */

import { clusterByEdges, type SimilarityEdge } from "./cluster.js";
import { DREAM_OPS, type DreamOp } from "./constants.js";
import { holdBackWatermark, nextWatermark, type CandidateRow } from "./candidates.js";
import { buildCanonical, canMerge, type CanonicalThought } from "./ops/merge.js";
import { planVocabularyChange, type VocabularyChange, type VocabularyConfig } from "./ops/vocabulary.js";
import { inferAliases, type VocabularyCounts } from "./ops/aliases.js";
import { screenMergeClusters } from "./ops/merge-guard.js";
import { planContradictionItems, type JudgePair } from "./ops/contradiction.js";
import { planSynthesisItems, type Synthesise } from "./ops/synthesis.js";
import type { ProposalItem } from "./proposal.js";
import { mergeAudit, referencedThoughtIds, reviewItems, type AppliedItem, type ReviewItem } from "./review.js";
import type { TagField, ThoughtRow } from "../db/queries.js";

export interface DreamPort {
  loadWatermark(project: string): Promise<Date>;
  listCandidates(watermark: Date, project: string): Promise<CandidateRow[]>;
  neighbours(row: CandidateRow, threshold: number): Promise<Array<ThoughtRow & { similarity: number }>>;
  knownTopics(project: string): Promise<string[]>;
  vocabularyCounts(project: string): Promise<VocabularyCounts>;
  listTagged(field: TagField, values: string[], project: string): Promise<ThoughtRow[]>;
  applyVocabulary(change: VocabularyChange): Promise<void>;
  applyMerge(canonical: CanonicalThought, sources: ThoughtRow[]): Promise<void>;
  saveProposal(project: string, items: ProposalItem[]): Promise<string>;
  saveWatermark(project: string, watermark: Date, stats: Record<string, unknown>): Promise<void>;
}

export interface DreamThresholds {
  neighbour: number;
  merge: number;
  contradictionFloor: number;
  minSynthesisCluster: number;
  watermarkSlackMs: number;
}

export interface DreamOptions {
  project?: string | null;
  ops?: DreamOp[];
  dry_run?: boolean;
}

export interface DreamResult {
  applied: Record<string, number>;
  proposed: Record<string, number>;
  proposal_id: string | null;
  /**
   * The proposed items in full, keyed as dream_apply takes them. Counts alone
   * left a caller two moves, both bad: accept thoughts it had never read, or
   * reject them by omission — a proposal is reviewed exactly once.
   */
  items: ReviewItem[];
  /** What the immediately-applied operations did — merges, which archive rows. */
  applied_items: AppliedItem[];
  watermark: { from: string; to: string };
  candidates: number;
  clusters: number;
  skipped: Record<string, number>;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export async function runDream(
  port: DreamPort,
  judge: JudgePair,
  synthesise: Synthesise,
  config: VocabularyConfig,
  thresholds: DreamThresholds,
  options: DreamOptions,
  now: () => Date,
): Promise<DreamResult> {
  const runStartedAt = now();
  const project = options.project ?? "";
  const ops = options.ops ?? [...DREAM_OPS];
  const dryRun = options.dry_run === true;

  const applied: Record<string, number> = {};
  const proposed: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  const watermark = await port.loadWatermark(project);
  const candidates = await port.listCandidates(watermark, project);

  const byId = new Map<string, ThoughtRow>();
  for (const row of candidates) byId.set(row.id, row);

  const edges: SimilarityEdge[] = [];
  for (const row of candidates) {
    for (const neighbour of await port.neighbours(row, thresholds.neighbour)) {
      if (neighbour.id === row.id) continue;
      byId.set(neighbour.id, neighbour);
      edges.push({ a: row.id, b: neighbour.id, similarity: neighbour.similarity });
    }
  }

  if (ops.includes("vocabulary")) {
    const knownTopics = await port.knownTopics(project);

    // Aliases are inferred from the whole project's vocabulary, not from the
    // run's candidates: the spelling to keep is the one the brain already uses
    // most, and the candidates are a recent slice that says nothing about that.
    const inferred = inferAliases(await port.vocabularyCounts(project));

    // Config last: an alias someone wrote down is a decision, while inference is
    // a rule of thumb about spelling.
    const effective: VocabularyConfig = {
      topicAliases: { ...inferred.topicAliases, ...config.topicAliases },
      personAliases: { ...inferred.personAliases, ...config.personAliases },
      selfNames: config.selfNames,
    };

    // The rows carrying an old spelling are old rows — exactly what the
    // watermark excludes — so an inferred alias has to reach past it, or the two
    // spellings survive the pass named for unifying them.
    const sweep = new Map<string, ThoughtRow>(candidates.map((row) => [row.id, row]));
    for (const [field, variants] of [
      ["topics", inferred.variants.topics],
      ["people", inferred.variants.people],
    ] as const) {
      for (const row of await port.listTagged(field, variants, project)) {
        if (!sweep.has(row.id)) sweep.set(row.id, row);
      }
    }

    for (const row of sweep.values()) {
      const change = planVocabularyChange(row, knownTopics, effective);
      if (!change) continue;
      bump(applied, "vocabulary");
      if (!dryRun) await port.applyVocabulary(change);
    }
  }

  const mergeClusters = clusterByEdges(edges, thresholds.merge);
  const mergedIds = new Set<string>();
  const items: ProposalItem[] = [];
  const appliedItems: AppliedItem[] = [];

  if (ops.includes("merge")) {
    const compatible: ThoughtRow[][] = [];
    for (const ids of mergeClusters) {
      const sources = ids.map((id) => byId.get(id)).filter((row): row is ThoughtRow => !!row);
      if (sources.length < 2) continue;
      if (!canMerge(sources)) {
        bump(skipped, "merge_incompatible_sources");
        continue;
      }
      compatible.push(sources);
    }

    // Similarity cannot tell agreement from negation, so the judge sees every
    // cluster before anything is archived. What it refuses is proposed, not
    // dropped — even when `ops` did not ask for contradiction, because the
    // alternative is discarding the finding that stopped the merge.
    const screen = await screenMergeClusters(compatible, judge);
    if (screen.blocked > 0) skipped.merge_unscreened = screen.blocked;

    for (const item of screen.contradictions) {
      items.push(item);
      bump(proposed, "contradiction");
      mergedIds.add(item.a);
      mergedIds.add(item.b);
    }

    for (const sources of screen.mergeable) {
      bump(applied, "merge");
      appliedItems.push(mergeAudit(sources));
      for (const row of sources) mergedIds.add(row.id);
      if (!dryRun) await port.applyMerge(buildCanonical(sources, runStartedAt.toISOString()), sources);
    }
  }

  if (ops.includes("contradiction")) {
    const pairs: Array<[ThoughtRow, ThoughtRow]> = [];
    for (const edge of edges) {
      if (edge.similarity >= thresholds.merge) continue;
      if (edge.similarity < thresholds.contradictionFloor) continue;
      if (mergedIds.has(edge.a) || mergedIds.has(edge.b)) continue;
      const a = byId.get(edge.a);
      const b = byId.get(edge.b);
      if (a && b) pairs.push([a, b]);
    }
    const found = await planContradictionItems(pairs, judge);
    for (const item of found) {
      items.push(item);
      bump(proposed, "contradiction");
    }
  }

  if (ops.includes("synthesis")) {
    const clusters = clusterByEdges(edges, thresholds.contradictionFloor)
      .filter((ids) => !ids.some((id) => mergedIds.has(id)))
      .map((ids) => ids.map((id) => byId.get(id)).filter((row): row is ThoughtRow => !!row));
    const found = await planSynthesisItems(clusters, synthesise, thresholds.minSynthesisCluster);
    for (const item of found) {
      items.push(item);
      bump(proposed, "synthesis");
    }
  }

  let proposalId: string | null = null;
  if (items.length > 0 && !dryRun) {
    proposalId = await port.saveProposal(project, items);
  }

  const advanced = nextWatermark(candidates, watermark, runStartedAt, thresholds.watermarkSlackMs);
  // Thoughts left in a proposal are not settled: marking them so would stop the
  // next run selecting them, and nothing could then regenerate the items.
  const heldIds = new Set(referencedThoughtIds(items));
  const held = candidates.filter((row) => heldIds.has(row.id));
  const settled = holdBackWatermark(advanced, held, watermark);
  if (!dryRun) {
    await port.saveWatermark(project, settled, { applied, proposed, skipped });
  }

  return {
    applied,
    proposed,
    proposal_id: proposalId,
    // byId holds every row this run clustered, which is exactly the set the
    // items refer to — no second fetch, and none of it is re-embedded.
    items: reviewItems(items, [...byId.values()]),
    applied_items: appliedItems,
    watermark: { from: watermark.toISOString(), to: settled.toISOString() },
    candidates: candidates.length,
    clusters: mergeClusters.length,
    skipped,
  };
}
