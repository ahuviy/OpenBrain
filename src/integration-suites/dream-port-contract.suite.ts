/**
 * The contract every DreamPort implementation must satisfy.
 *
 * Exported as a function taking a driver so the SAME assertions run against the
 * in-memory fake the unit tests use and against the real pg-backed port. That is
 * the point: a fake that drifts from the database turns every unit test above it
 * into a test of a fiction. Anything asserted here is a promise both make.
 *
 * The suite owns no fixtures of its own beyond what the driver seeds, and it
 * never imports a consumer — each consumer supplies its driver.
 */

import { describe, it, expect, beforeEach } from "vitest";

import type { DreamPort } from "../dream/index.js";
import type { CandidateRow } from "../dream/candidates.js";
import type { ThoughtRow } from "../db/queries.js";

export interface SeededThought {
  id: string;
  content: string;
  project: string | null;
  metadata?: Record<string, unknown>;
  archived?: boolean;
}

export interface DreamPortDriver {
  setup(): Promise<void>;
  port(): DreamPort;
  /** Insert a thought and return its id. */
  seed(thought: Omit<SeededThought, "id">): Promise<string>;
  /** Read a thought back, or undefined when it no longer exists. */
  read(id: string): Promise<(ThoughtRow & { archived: boolean }) | undefined>;
  cleanup(): Promise<void>;
}

export default function dreamPortContractTests(driver: DreamPortDriver): void {
  describe("dream port contract", () => {
    let port: DreamPort;

    beforeEach(async () => {
      await driver.setup();
      port = driver.port();
    });

    describe("watermark", () => {
      it("starts an unseen project at the epoch", async () => {
        const watermark = await port.loadWatermark("never-dreamed");

        expect(watermark.getTime()).toBe(0);
      });

      it("returns what was last saved", async () => {
        const saved = new Date("2026-08-17T00:00:00.000Z");
        await port.loadWatermark("markets");

        await port.saveWatermark("markets", saved, { merge: 1 });

        expect((await port.loadWatermark("markets")).toISOString()).toBe(saved.toISOString());
      });

      it("keeps projects independent", async () => {
        await port.loadWatermark("a");
        await port.loadWatermark("b");

        await port.saveWatermark("a", new Date("2026-08-17T00:00:00.000Z"), {});

        expect((await port.loadWatermark("b")).getTime()).toBe(0);
      });
    });

    describe("candidates", () => {
      it("returns thoughts in the requested project only", async () => {
        await driver.seed({ content: "in scope", project: "markets" });
        await driver.seed({ content: "out of scope", project: "personal" });

        const rows = await port.listCandidates(new Date(0), "markets");

        expect(rows.map((row: CandidateRow) => row.content)).toEqual(["in scope"]);
      });

      it("treats a null project as the empty-string bucket", async () => {
        await driver.seed({ content: "unfiled", project: null });

        const rows = await port.listCandidates(new Date(0), "");

        expect(rows.map((row: CandidateRow) => row.content)).toEqual(["unfiled"]);
      });

      it("excludes archived thoughts", async () => {
        await driver.seed({ content: "live", project: "markets" });
        await driver.seed({ content: "archived", project: "markets", archived: true });

        const rows = await port.listCandidates(new Date(0), "markets");

        expect(rows.map((row: CandidateRow) => row.content)).toEqual(["live"]);
      });

      it("exposes updated_at, which the watermark depends on", async () => {
        await driver.seed({ content: "one", project: "markets" });

        const rows = await port.listCandidates(new Date(0), "markets");

        expect(rows[0]?.updated_at).toBeInstanceOf(Date);
      });

      it("returns nothing when the watermark is in the future", async () => {
        await driver.seed({ content: "one", project: "markets" });

        const rows = await port.listCandidates(new Date("2099-01-01T00:00:00Z"), "markets");

        expect(rows).toEqual([]);
      });
    });

    describe("vocabulary", () => {
      it("rewrites the listed keys without clobbering the rest of metadata", async () => {
        const id = await driver.seed({
          content: "gold",
          project: "markets",
          metadata: { topics: ["fx"], type: "observation", source: "notion" },
        });

        await port.applyVocabulary({ id, topics: ["forex"] });

        const row = await driver.read(id);
        const metadata = row?.metadata as Record<string, unknown>;
        expect(metadata.topics).toEqual(["forex"]);
        expect(metadata.type).toBe("observation");
        expect(metadata.source).toBe("notion");
      });
    });

    describe("merge", () => {
      it("writes the canonical thought and archives every source", async () => {
        const first = await driver.seed({ content: "gold up", project: "markets" });
        const second = await driver.seed({ content: "gold up on volume", project: "markets" });
        const sources = [await driver.read(first), await driver.read(second)].filter(
          (row): row is ThoughtRow & { archived: boolean } => !!row,
        );

        await port.applyMerge(
          {
            content: "gold up on volume",
            metadata: { topics: ["gold"] },
            project: "markets",
            created_by: "ahuvi",
            supersedes: first,
            merged_from: [first, second],
          },
          sources,
        );

        expect((await driver.read(first))?.archived).toBe(true);
        expect((await driver.read(second))?.archived).toBe(true);

        const live = await port.listCandidates(new Date(0), "markets");
        expect(live).toHaveLength(1);
        expect(live[0]?.content).toBe("gold up on volume");
      });
    });

    describe("vocabulary sweep", () => {
      it("counts each topic and person across the project's live thoughts", async () => {
        await driver.seed({ content: "one", project: "markets", metadata: { topics: ["markets"], people: ["Dohmen"] } });
        await driver.seed({ content: "two", project: "markets", metadata: { topics: ["markets"], people: ["Bert Dohmen"] } });

        const counts = await port.vocabularyCounts("markets");

        expect(counts.topics.markets).toBe(2);
        expect(counts.people).toEqual({ Dohmen: 1, "Bert Dohmen": 1 });
      });

      it("counts one project's vocabulary, not another's", async () => {
        await driver.seed({ content: "one", project: "markets", metadata: { topics: ["markets"] } });
        await driver.seed({ content: "two", project: "other", metadata: { topics: ["markets"] } });

        expect((await port.vocabularyCounts("markets")).topics.markets).toBe(1);
      });

      it("ignores archived thoughts, which nobody searches", async () => {
        await driver.seed({ content: "one", project: "markets", metadata: { topics: ["markets"] }, archived: true });

        expect(await port.vocabularyCounts("markets")).toEqual({ topics: {}, people: {} });
      });

      it("tolerates thoughts with no topics or people at all", async () => {
        await driver.seed({ content: "one", project: "markets" });

        expect(await port.vocabularyCounts("markets")).toEqual({ topics: {}, people: {} });
      });

      it("finds thoughts by tag regardless of the watermark", async () => {
        // The whole point: an alias inferred today must reach the rows that
        // predate it, which are exactly the rows the watermark excludes.
        const id = await driver.seed({
          content: "one",
          project: "markets",
          metadata: { people: ["Bert Dohmen"] },
        });

        const found = await port.listTagged("people", ["Bert Dohmen"], "markets");

        expect(found.map((row) => row.id)).toEqual([id]);
      });

      it("matches any of the tags asked for, and none of the others", async () => {
        await driver.seed({ content: "one", project: "markets", metadata: { topics: ["forex"] } });
        const wanted = await driver.seed({ content: "two", project: "markets", metadata: { topics: ["markets"] } });

        const found = await port.listTagged("topics", ["markets", "absent"], "markets");

        expect(found.map((row) => row.id)).toEqual([wanted]);
      });

      it("returns nothing for an empty tag list", async () => {
        await driver.seed({ content: "one", project: "markets", metadata: { topics: ["markets"] } });

        expect(await port.listTagged("topics", [], "markets")).toEqual([]);
      });
    });

    describe("proposals", () => {
      it("returns an id for a saved proposal", async () => {
        const id = await port.saveProposal("markets", [
          { kind: "synthesis", content: "a summary", sources: ["x", "y", "z"] },
        ]);

        expect(id).toBeTruthy();
      });

      it("allows only one open proposal per project", async () => {
        const first = await port.saveProposal("markets", [
          { kind: "synthesis", content: "first", sources: ["x", "y", "z"] },
        ]);
        const second = await port.saveProposal("markets", [
          { kind: "synthesis", content: "second", sources: ["x", "y", "z"] },
        ]);

        expect(second).not.toBe(first);
      });
    });
  });
}
