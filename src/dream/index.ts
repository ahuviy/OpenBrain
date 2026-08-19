/**
 * The dream run.
 *
 * Data access sits behind `DreamPort` so the tiering decision — what applies
 * now, what waits for review — is testable without a database or a provider.
 * The pg-backed port lives in `port.ts`; both transports share this entry point,
 * so a client cannot skip the rules by choosing a different port.
 */

import { normaliseTopic } from "../capture/discipline.js";
import { clusterByEdges, type SimilarityEdge } from "./cluster.js";
import { DREAM_OPS, type DreamOp } from "./constants.js";
import { holdBackWatermark, nextWatermark, type CandidateRow } from "./candidates.js";
import { buildCanonical, canMerge, type CanonicalThought } from "./ops/merge.js";
import { planVocabularyChange, type VocabularyChange, type VocabularyConfig } from "./ops/vocabulary.js";
import { inferAliases, mergeAliases, staleSpellings, type VocabularyCounts } from "./ops/aliases.js";
import { screenMergeClusters } from "./ops/merge-guard.js";
import { dropConflictingItems } from "./consistency.js";
import { planContradictionItems, type JudgePair } from "./ops/contradiction.js";
import { planSynthesisItems, type Synthesise } from "./ops/synthesis.js";
import type { ProposalItem } from "./proposal.js";
import {
  mergeAudit,
  referencedThoughtIds,
  reviewItems,
  vocabularyAudit,
  type AppliedItem,
  type ReviewItem,
} from "./review.js";
import type { DreamRunRecord, DreamRunRow, TagField, ThoughtRow } from "../db/queries.js";

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
  recordRun(run: DreamRunRecord): Promise<void>;
  listRuns(project: string | undefined, limit: number): Promise<DreamRunRow[]>;
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
  /**
   * Re-examine everything changed since this instant, instead of since the
   * stored watermark. `1970-01-01` is a full-corpus pass.
   *
   * Without it every consolidation improvement is forward-only: the thoughts
   * that accumulated the mess sit behind the watermark and are never considered
   * again, which is most of a brain and the part most likely to need the work.
   */
  since?: string | Date;
  /** Where the run came from, for reading the history back: mcp, rest, schedule. */
  trigger?: string;
}

/**
 * One thing a run did, or refused to do.
 *
 * The counts answer "how much"; a retro asks "which, and why" — why those two
 * thoughts were merged, which pair keeps failing to judge. Refusals are logged
 * as deliberately as changes: an operation that quietly does nothing is the
 * hardest kind to notice going wrong.
 */
export type DreamAction =
  | { kind: "vocabulary"; id: string; topics?: string[]; people?: string[] }
  | { kind: "merge"; sources: string[] }
  | { kind: "merge_blocked"; a: string; b: string; reason: string; detail: string }
  | { kind: "proposed"; key: string; item_kind: string };

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
  /** Every change and every refusal, in the order they happened. */
  actions: DreamAction[];
  watermark: { from: string; to: string };
  candidates: number;
  clusters: number;
  skipped: Record<string, number>;
}

/**
 * A `since` that cannot be parsed must not become the epoch: silently scanning
 * the whole corpus is a lot of embedding calls nobody asked for.
 */
function parseSince(since: string | Date | undefined): Date | undefined {
  if (since === undefined) return undefined;

  const parsed = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`dream: since is not a valid timestamp: ${String(since)}`);
  }

  return parsed;
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

  const actions: DreamAction[] = [];
  const appliedItems: AppliedItem[] = [];
  const applied: Record<string, number> = {};
  const proposed: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  // The stored watermark is loaded even for a backfill: the call takes the
  // per-project lock, and it is the floor the saved watermark cannot go below.
  const stored = await port.loadWatermark(project);
  const watermark = parseSince(options.since) ?? stored;
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
    const counts = await port.vocabularyCounts(project);
    const inferred = inferAliases(counts);

    // Merged rather than spread: config is authoritative, and an inferred alias
    // that rewrites a configured canonical back the other way makes the two
    // churn the same rows on every run. See mergeAliases.
    const effective: VocabularyConfig = {
      topicAliases: mergeAliases(inferred.topicAliases, config.topicAliases),
      personAliases: mergeAliases(inferred.personAliases, config.personAliases),
      selfNames: config.selfNames,
    };

    // The rows carrying an old spelling are old rows — exactly what the
    // watermark excludes — so an inferred alias has to reach past it, or the two
    // spellings survive the pass named for unifying them.
    const sweep = new Map<string, ThoughtRow>(candidates.map((row) => [row.id, row]));
    for (const [field, variants] of [
      ["topics", staleSpellings(counts.topics, effective.topicAliases, normaliseTopic)],
      ["people", staleSpellings(counts.people, effective.personAliases, (v) => v.trim().toLowerCase())],
    ] as const) {
      for (const row of await port.listTagged(field, variants, project)) {
        if (!sweep.has(row.id)) sweep.set(row.id, row);
      }
    }

    for (const row of sweep.values()) {
      const change = planVocabularyChange(row, knownTopics, effective);
      if (!change) continue;
      bump(applied, "vocabulary");
      appliedItems.push(vocabularyAudit(change.id, row.metadata as Record<string, unknown>, change));
      actions.push({
        kind: "vocabulary",
        id: change.id,
        ...(change.topics ? { topics: change.topics } : {}),
        ...(change.people ? { people: change.people } : {}),
      });
      if (!dryRun) await port.applyVocabulary(change);
    }
  }

  const mergeClusters = clusterByEdges(edges, thresholds.merge);
  const mergedIds = new Set<string>();
  const items: ProposalItem[] = [];

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
    // cluster before anything is archived.
    const screen = await screenMergeClusters(compatible, judge);
    if (screen.blocked.length > 0) skipped.merge_unscreened = screen.blocked.length;
    for (const pair of screen.blocked) {
      actions.push({ kind: "merge_blocked", a: pair.a, b: pair.b, reason: pair.reason, detail: pair.detail });
    }

    for (const item of screen.contradictions) {
      // Refusing the merge is the half that prevents data loss, and it happens
      // either way. Whether the finding becomes a PROPOSAL follows `ops`: a
      // caller who did not ask for contradiction is not reviewing proposals,
      // and an unreviewed one pins the watermark behind those thoughts forever
      // while the run re-judges the same pair on every pass. Counted, not
      // silently dropped — the notification carries `skipped`.
      if (ops.includes("contradiction")) {
        items.push(item);
        bump(proposed, "contradiction");
      } else {
        bump(skipped, "merge_contradicts");
        actions.push({
          kind: "merge_blocked",
          a: item.a,
          b: item.b,
          reason: "contradiction",
          detail: item.reason,
        });
      }
      mergedIds.add(item.a);
      mergedIds.add(item.b);
    }

    for (const sources of screen.mergeable) {
      bump(applied, "merge");
      appliedItems.push(mergeAudit(sources));
      actions.push({ kind: "merge", sources: sources.map((row) => row.id) });
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

  // Judged pairwise, items can contradict each other: a thought obsolete in one
  // and the survivor in another. Accepting both archives the thought the second
  // relies on, and a reviewer working item by item cannot see it.
  const consistent = dropConflictingItems(items);
  if (consistent.dropped.length > 0) {
    skipped.proposal_conflict = consistent.dropped.length;
    for (const dropped of consistent.dropped) {
      actions.push({
        kind: "merge_blocked",
        a: dropped.kind === "contradiction" ? dropped.a : "",
        b: dropped.kind === "contradiction" ? dropped.b : "",
        reason: "proposal_conflict",
        detail: "another item in this proposal depends on a thought this one would archive",
      });
    }
  }
  items.length = 0;
  items.push(...consistent.items);

  let proposalId: string | null = null;
  if (items.length > 0 && !dryRun) {
    proposalId = await port.saveProposal(project, items);
  }

  const reviewable = reviewItems(items, [...byId.values()]);
  for (const item of reviewable) {
    actions.push({ kind: "proposed", key: item.key, item_kind: item.kind });
  }

  // `stored`, not `watermark`: a backfill re-reads old rows, and passing its
  // window here would rewind the watermark and make every later run re-examine
  // the whole corpus.
  const advanced = nextWatermark(candidates, stored, runStartedAt, thresholds.watermarkSlackMs);
  // Thoughts left in a proposal are not settled: marking them so would stop the
  // next run selecting them, and nothing could then regenerate the items.
  const heldIds = new Set(referencedThoughtIds(items));
  const held = candidates.filter((row) => heldIds.has(row.id));
  const settled = holdBackWatermark(advanced, held, stored);
  if (!dryRun) {
    await port.saveWatermark(project, settled, { applied, proposed, skipped });
  }

  // Written whether or not the run changed anything, and after the writes it
  // describes: a history missing its no-op runs cannot tell a quiet corpus from
  // a schedule that stopped firing.
  await port.recordRun({
    project,
    status: "ok",
    dry_run: dryRun,
    trigger: options.trigger ?? "unknown",
    applied,
    proposed,
    skipped,
    actions,
    candidates: candidates.length,
    clusters: mergeClusters.length,
    proposal_id: proposalId,
    error: null,
    started_at: runStartedAt,
  });

  return {
    applied,
    proposed,
    proposal_id: proposalId,
    // byId holds every row this run clustered, which is exactly the set the
    // items refer to — no second fetch, and none of it is re-embedded.
    items: reviewable,
    applied_items: appliedItems,
    actions,
    watermark: { from: watermark.toISOString(), to: settled.toISOString() },
    candidates: candidates.length,
    clusters: mergeClusters.length,
    skipped,
  };
}
