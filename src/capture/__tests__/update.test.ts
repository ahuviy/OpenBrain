import { describe, it, expect } from "vitest";

import {
  CaptureDisciplineError,
  DEFAULT_DISCIPLINE_CONFIG,
  type DisciplineConfig,
} from "../discipline.js";
import { resolveUpdateMetadata } from "../update.js";
import type { ThoughtMetadataExtracted } from "../../embedder/types.js";

function config(overrides: Partial<DisciplineConfig> = {}): DisciplineConfig {
  return { ...DEFAULT_DISCIPLINE_CONFIG, ...overrides };
}

/** What the extractor makes of the edited content — never authoritative here. */
function extracted(overrides: Partial<ThoughtMetadataExtracted> = {}): ThoughtMetadataExtracted {
  return {
    type: "observation",
    topics: ["rental-issue", "tire-safety", "georgia-trip"],
    people: ["dohmen"],
    action_items: ["chase the refund"],
    dates: ["2026-08-25"],
    ...overrides,
  };
}

/** Over the 6000-byte default the embedder can index. */
const OVERSIZED = "a".repeat(6001);

describe("resolveUpdateMetadata embedding coverage", () => {
  it("warns when an edit pushes content past what the embedder indexes", () => {
    const { warnings, patch } = resolveUpdateMetadata({
      content: OVERSIZED,
      extracted: extracted(),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toBe("embedding_truncated");
    expect(patch.embedding_truncated).toBe(true);
    expect(patch.embedding_indexed_bytes).toBe(6000);
    expect(patch.content_bytes).toBe(6001);
  });

  it("clears stale truncation flags when an edit shortens the content", () => {
    const { warnings, drop, patch } = resolveUpdateMetadata({
      content: "short again",
      extracted: extracted(),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(warnings).toHaveLength(0);
    expect(drop).toEqual(
      expect.arrayContaining(["embedding_truncated", "embedding_indexed_bytes", "content_bytes"])
    );
    expect(patch).not.toHaveProperty("embedding_truncated");
  });

  it("drops nothing when the edit is itself truncated", () => {
    const { drop } = resolveUpdateMetadata({
      content: OVERSIZED,
      extracted: extracted(),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(drop).toEqual([]);
  });
});

describe("resolveUpdateMetadata", () => {
  it("omits topics when the caller supplies none, so curated tags survive the edit", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(patch).not.toHaveProperty("topics");
  });

  it("omits type and people when the caller supplies none", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(patch).not.toHaveProperty("type");
    expect(patch).not.toHaveProperty("people");
  });

  it("never patches source, so provenance is not rewritten by an edit", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { topics: ["car-rental"], type: "task", people: ["Bert Dohmen"] },
      vocabulary: ["car-rental"],
      config: config(),
    });

    expect(patch).not.toHaveProperty("source");
    expect(patch).not.toHaveProperty("provenance");
  });

  it("refreshes the fields re-derived from content", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted({ action_items: ["call the agency"], dates: ["2026-09-01"] }),
      caller: {},
      vocabulary: [],
      config: config(),
    });

    expect(patch.action_items).toEqual(["call the agency"]);
    expect(patch.dates).toEqual(["2026-09-01"]);
  });

  it("takes caller topics through the same normalisation capture uses", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { topics: ["Car Rental", "GEORGIA"] },
      vocabulary: ["car-rental", "georgia"],
      config: config(),
    });

    expect(patch.topics).toEqual(["car-rental", "georgia"]);
  });

  it("applies the topic alias map on the update path too", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { topics: ["georgia-trip"] },
      vocabulary: ["georgia"],
      config: config({ topicAliases: { "georgia-trip": "georgia" } }),
    });

    expect(patch.topics).toEqual(["georgia"]);
  });

  it("gates a brand-new topic when the brain requires known tags", () => {
    expect(() =>
      resolveUpdateMetadata({
        content: "a thought",
        extracted: extracted(),
        caller: { topics: ["freshly-minted"] },
        vocabulary: ["car-rental"],
        config: config({ requireKnownTopics: true }),
      })
    ).toThrow(CaptureDisciplineError);
  });

  it("mints a new topic when the caller asks for it deliberately", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { topics: ["freshly-minted"] },
      vocabulary: ["car-rental"],
      allowNewTopics: true,
      config: config({ requireKnownTopics: true }),
    });

    expect(patch.topics).toEqual(["freshly-minted"]);
  });

  it("canonicalises caller people and drops the brain owner", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { people: ["Dohmen", "Ahuvi"] },
      vocabulary: [],
      config: config({
        personAliases: { dohmen: "Bert Dohmen" },
        selfNames: ["Ahuvi"],
      }),
    });

    expect(patch.people).toEqual(["Bert Dohmen"]);
  });

  it("takes an explicit caller type", () => {
    const { patch } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { type: "bug" },
      vocabulary: [],
      config: config(),
    });

    expect(patch.type).toBe("bug");
  });

  it("rejects a type outside the known set", () => {
    expect(() =>
      resolveUpdateMetadata({
        content: "a thought",
        extracted: extracted(),
        caller: { type: "not-a-type" },
        vocabulary: [],
        config: config(),
      })
    ).toThrow(CaptureDisciplineError);
  });

  it("reports what it normalised, so the response can show it", () => {
    const { notes } = resolveUpdateMetadata({
      content: "a thought",
      extracted: extracted(),
      caller: { topics: ["Car Rental"] },
      vocabulary: ["car-rental"],
      config: config(),
    });

    expect(notes.some((n) => n.field === "topics" && n.action === "normalised")).toBe(true);
  });
});
