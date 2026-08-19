/**
 * The pg-backed side of a dream run.
 *
 * Everything here is I/O; every decision lives in the pure modules this wires
 * together. Both transports build their port from this factory, so MCP and REST
 * cannot drift apart — the rules bind on whichever port the client picked.
 */

import type pg from "pg";

import { getTopicVocabulary } from "../capture/vocabulary.js";
import {
  archiveThought,
  insertMergedThought,
  insertProposal,
  listCandidatesSince,
  loadProposal,
  lockDreamState,
  mergeThoughtMetadata,
  saveDreamState,
  searchThoughts,
  setProposalStatus,
  setSupersedes,
  insertThought,
  type ThoughtRow,
} from "../db/queries.js";
import type { Embedder } from "../embedder/types.js";
import type { CandidateRow } from "./candidates.js";
import type { DreamPort } from "./index.js";
import type { CanonicalThought } from "./ops/merge.js";
import { buildSynthesisMetadata } from "./ops/synthesis.js";
import type { VocabularyChange } from "./ops/vocabulary.js";
import type { ApplyPort, ProposalItem, StoredProposal } from "./proposal.js";
import type { ProposalStatus } from "./constants.js";

const EPOCH = new Date(0);

export function createDreamPort(pool: pg.Pool, embedder: Embedder, ttlHours: number): DreamPort {
  return {
    async loadWatermark(project) {
      const client = await pool.connect();
      try {
        const state = await lockDreamState(client, project, EPOCH);
        return state.watermark;
      } finally {
        client.release();
      }
    },

    listCandidates: (watermark, project) => listCandidatesSince(pool, watermark, project),

    async neighbours(row: CandidateRow, threshold) {
      const embedding = await embedder.generateEmbedding(row.content);
      // project is passed only because the CALLER's row carries one; never a default.
      const found = await searchThoughts(pool, embedding, 6, threshold, {}, row.project ?? undefined, false, undefined);
      return found.filter((neighbour) => neighbour.id !== row.id);
    },

    knownTopics: (project) => getTopicVocabulary(pool, project === "" ? undefined : project),

    async applyVocabulary(change: VocabularyChange) {
      const patch: Record<string, unknown> = {};
      if (change.topics) patch.topics = change.topics;
      if (change.people) patch.people = change.people;
      await mergeThoughtMetadata(pool, change.id, patch);
    },

    async applyMerge(canonical: CanonicalThought, sources: ThoughtRow[]) {
      // Re-embed: the merged content is new text, and a stale vector would make
      // the canonical row unfindable by the search that produced its cluster.
      const embedding = await embedder.generateEmbedding(canonical.content);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await insertMergedThought(
          client,
          canonical.content,
          embedding,
          canonical.metadata,
          canonical.project,
          canonical.created_by,
          canonical.supersedes,
          sources.map((row) => row.id),
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async saveProposal(project, items: ProposalItem[]) {
      const row = await insertProposal(pool, project, items, ttlHours);
      return row.id;
    },

    async saveWatermark(project, watermark, stats) {
      const client = await pool.connect();
      try {
        await saveDreamState(client, project, watermark, stats);
      } finally {
        client.release();
      }
    },
  };
}

export function createApplyPort(pool: pg.Pool, embedder: Embedder): ApplyPort {
  return {
    async load(id): Promise<StoredProposal | undefined> {
      const row = await loadProposal(pool, id);
      if (!row) return undefined;
      return {
        id: row.id,
        status: row.status,
        expires_at: row.expires_at,
        items: row.items as ProposalItem[],
      };
    },

    async archiveThought(id) {
      const client = await pool.connect();
      try {
        await archiveThought(client, id);
      } finally {
        client.release();
      }
    },

    async setSupersedes(winner, loser) {
      const client = await pool.connect();
      try {
        await setSupersedes(client, winner, loser);
      } finally {
        client.release();
      }
    },

    async insertSynthesis(content, sources) {
      const embedding = await embedder.generateEmbedding(content);
      const written = await insertThought(
        pool,
        content,
        embedding,
        buildSynthesisMetadata(sources, new Date().toISOString()) as ThoughtRow["metadata"],
        undefined,
        undefined,
        "dream",
      );
      console.error(`[dream] synthesis written id=${written.id} sources=${sources.join(",")}`);
    },

    async setStatus(id, status: ProposalStatus) {
      const client = await pool.connect();
      try {
        await setProposalStatus(client, id, status);
      } finally {
        client.release();
      }
    },
  };
}
