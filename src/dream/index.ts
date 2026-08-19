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
import { nextWatermark, type CandidateRow } from "./candidates.js";
import { buildCanonical, canMerge, type CanonicalThought } from "./ops/merge.js";
import { planVocabularyChange, type VocabularyChange, type VocabularyConfig } from "./ops/vocabulary.js";
import { planContradictionItems, type JudgePair } from "./ops/contradiction.js";
import { planSynthesisItems, type Synthesise } from "./ops/synthesis.js";
import type { ProposalItem } from "./proposal.js";
import type { ThoughtRow } from "../db/queries.js";

export interface DreamPort {
  loadWatermark(project: string): Promise<Date>;
  listCandidates(watermark: Date, project: string): Promise<CandidateRow[]>;
  neighbours(row: CandidateRow, threshold: number): Promise<Array<ThoughtRow & { similarity: number }>>;
  knownTopics(project: string): Promise<string[]>;
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
    for (const row of candidates) {
      const change = planVocabularyChange(row, knownTopics, config);
      if (!change) continue;
      bump(applied, "vocabulary");
      if (!dryRun) await port.applyVocabulary(change);
    }
  }

  const mergeClusters = clusterByEdges(edges, thresholds.merge);
  const mergedIds = new Set<string>();

  if (ops.includes("merge")) {
    for (const ids of mergeClusters) {
      const sources = ids.map((id) => byId.get(id)).filter((row): row is ThoughtRow => !!row);
      if (sources.length < 2) continue;
      if (!canMerge(sources)) {
        bump(skipped, "merge_incompatible_sources");
        continue;
      }
      bump(applied, "merge");
      for (const id of ids) mergedIds.add(id);
      if (!dryRun) await port.applyMerge(buildCanonical(sources, runStartedAt.toISOString()), sources);
    }
  }

  const items: ProposalItem[] = [];

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
  if (!dryRun) {
    await port.saveWatermark(project, advanced, { applied, proposed, skipped });
  }

  return {
    applied,
    proposed,
    proposal_id: proposalId,
    watermark: { from: watermark.toISOString(), to: advanced.toISOString() },
    candidates: candidates.length,
    clusters: mergeClusters.length,
    skipped,
  };
}
