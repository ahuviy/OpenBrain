/**
 * In-memory DreamPort.
 *
 * Lives next to the unit tests but is exercised by the shared contract suite, so
 * it cannot quietly drift from the database it stands in for. Every behaviour it
 * fakes — the empty-string project bucket, archived exclusion, metadata merge
 * rather than replace, one open proposal per project — is asserted against real
 * Postgres by the same suite.
 */

import type { DreamPort } from "../index.js";
import type { CandidateRow } from "../candidates.js";
import type { ThoughtRow } from "../../db/queries.js";
import type { ProposalItem } from "../proposal.js";

interface FakeThought extends CandidateRow {
  archived: boolean;
}

export interface FakeDreamStore {
  port: DreamPort;
  seed(thought: {
    content: string;
    project: string | null;
    metadata?: Record<string, unknown>;
    archived?: boolean;
  }): Promise<string>;
  read(id: string): Promise<(ThoughtRow & { archived: boolean }) | undefined>;
  reset(): void;
}

export function fakeDreamStore(now: () => Date = () => new Date()): FakeDreamStore {
  let sequence = 0;
  let thoughts: FakeThought[] = [];
  let watermarks = new Map<string, Date>();
  let openProposals = new Map<string, string>();
  let proposalSequence = 0;

  const bucket = (project: string | null | undefined) => project ?? "";

  const port: DreamPort = {
    async loadWatermark(project) {
      return watermarks.get(project) ?? new Date(0);
    },

    async listCandidates(watermark, project) {
      return thoughts.filter(
        (row) =>
          !row.archived &&
          bucket(row.project) === project &&
          row.updated_at.getTime() > watermark.getTime(),
      );
    },

    async neighbours() {
      return [];
    },

    async knownTopics() {
      return [];
    },

    async applyVocabulary(change) {
      const row = thoughts.find((candidate) => candidate.id === change.id);
      if (!row) return;
      // Merge, never replace: the database does `metadata || patch`.
      const metadata = { ...(row.metadata as Record<string, unknown>) };
      if (change.topics) metadata.topics = change.topics;
      if (change.people) metadata.people = change.people;
      row.metadata = metadata as ThoughtRow["metadata"];
      row.updated_at = now();
    },

    async applyMerge(canonical, sources) {
      const ids = new Set(sources.map((source) => source.id));
      for (const row of thoughts) if (ids.has(row.id)) row.archived = true;

      sequence += 1;
      thoughts.push({
        id: `fake-${sequence}`,
        content: canonical.content,
        metadata: canonical.metadata as ThoughtRow["metadata"],
        project: canonical.project,
        created_by: canonical.created_by,
        archived: false,
        supersedes: canonical.supersedes,
        created_at: now(),
        updated_at: now(),
      } as FakeThought);
    },

    async saveProposal(project, _items: ProposalItem[]) {
      proposalSequence += 1;
      const id = `proposal-${proposalSequence}`;
      // One open proposal per project: the partial UNIQUE index in migration 006.
      openProposals.set(project, id);
      return id;
    },

    async saveWatermark(project, watermark) {
      watermarks.set(project, watermark);
    },
  };

  return {
    port,
    async seed(thought) {
      sequence += 1;
      const id = `fake-${sequence}`;
      thoughts.push({
        id,
        content: thought.content,
        metadata: (thought.metadata ?? {}) as ThoughtRow["metadata"],
        project: thought.project,
        created_by: "ahuvi",
        archived: thought.archived ?? false,
        supersedes: null,
        created_at: now(),
        updated_at: now(),
      } as FakeThought);
      return id;
    },
    async read(id) {
      return thoughts.find((row) => row.id === id);
    },
    reset() {
      sequence = 0;
      proposalSequence = 0;
      thoughts = [];
      watermarks = new Map();
      openProposals = new Map();
    },
  };
}
