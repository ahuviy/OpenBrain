/**
 * Tests for server-side capture discipline: type / people / topics / project.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  applyCaptureDiscipline,
  CaptureDisciplineError,
  DEFAULT_DISCIPLINE_CONFIG,
  formatDisciplineNotes,
  getDisciplineConfig,
  normaliseTopic,
  resetDisciplineConfig,
  resolvePeople,
  resolveTopics,
  resolveType,
  type DisciplineConfig,
} from "../discipline.js";

function config(overrides: Partial<DisciplineConfig> = {}): DisciplineConfig {
  return { ...DEFAULT_DISCIPLINE_CONFIG, ...overrides };
}

describe("resolveType", () => {
  it("keeps an explicit type over the extracted one", () => {
    expect(resolveType("observation", "decision", true)).toBe("decision");
  });

  it("rejects an explicit type that is not a known thought type", () => {
    expect(() => resolveType("observation", "musing", true)).toThrow(CaptureDisciplineError);
  });

  it("rejects a capture that fell back to observation without opt-in", () => {
    expect(() => resolveType("observation", undefined, true)).toThrow(/catch-all/);
  });

  it("accepts observation when the caller asks for it explicitly", () => {
    expect(resolveType("observation", "observation", true)).toBe("observation");
  });

  it("accepts a specific extracted type without an explicit one", () => {
    expect(resolveType("bug", undefined, true)).toBe("bug");
  });

  it("allows the fallback when the rule is switched off", () => {
    expect(resolveType("observation", undefined, false)).toBe("observation");
  });

  it("treats a missing extracted type as the fallback", () => {
    expect(() => resolveType(undefined, undefined, true)).toThrow(CaptureDisciplineError);
  });
});

describe("normaliseTopic", () => {
  it("lowercases, hyphenates and strips punctuation", () => {
    expect(normaliseTopic("  Market Analysis! ")).toBe("market-analysis");
  });

  it("collapses underscores and repeated separators", () => {
    expect(normaliseTopic("investment__strategy")).toBe("investment-strategy");
  });
});

describe("resolveTopics", () => {
  it("normalises tag shape", () => {
    const result = resolveTopics(["Market Analysis"], ["market-analysis"], {});
    expect(result.topics).toEqual(["market-analysis"]);
    expect(result.unknown).toEqual([]);
  });

  it("applies the alias map", () => {
    const result = resolveTopics(["stocks"], ["market-analysis"], { stocks: "market-analysis" });
    expect(result.topics).toEqual(["market-analysis"]);
    expect(result.notes.some((n) => n.action === "canonicalised")).toBe(true);
  });

  it("snaps a plural onto an existing singular tag", () => {
    const result = resolveTopics(["markets"], ["market"], {});
    expect(result.topics).toEqual(["market"]);
    expect(result.unknown).toEqual([]);
  });

  it("snaps a singular onto an existing plural tag", () => {
    const result = resolveTopics(["stock"], ["stocks"], {});
    expect(result.topics).toEqual(["stocks"]);
  });

  it("reports a tag the brain has never seen", () => {
    const result = resolveTopics(["quantum-tunnelling"], ["market-analysis"], {});
    expect(result.unknown).toEqual(["quantum-tunnelling"]);
    expect(result.notes.some((n) => n.action === "new_topic")).toBe(true);
  });

  it("deduplicates tags that collapse onto the same canonical form", () => {
    const result = resolveTopics(["Markets", "markets", "market"], ["market"], {});
    expect(result.topics).toEqual(["market"]);
  });

  it("drops tags that normalise to nothing", () => {
    expect(resolveTopics(["---", "  "], [], {}).topics).toEqual([]);
  });
});

describe("resolvePeople", () => {
  it("collapses an alias onto the canonical name", () => {
    const result = resolvePeople(["Dohmen"], { dohmen: "Bert Dohmen" }, []);
    expect(result.people).toEqual(["Bert Dohmen"]);
    expect(result.notes[0]?.action).toBe("canonicalised");
  });

  it("drops the brain owner", () => {
    const result = resolvePeople(["Ahuvi", "Chris Weber"], {}, ["Ahuvi"]);
    expect(result.people).toEqual(["Chris Weber"]);
    expect(result.notes.some((n) => n.action === "dropped")).toBe(true);
  });

  it("drops the owner even when reached through an alias", () => {
    const result = resolvePeople(["ahuviy"], { ahuviy: "Ahuvi" }, ["Ahuvi"]);
    expect(result.people).toEqual([]);
  });

  it("deduplicates names that resolve to the same person", () => {
    const result = resolvePeople(["Dohmen", "Bert Dohmen"], { dohmen: "Bert Dohmen" }, []);
    expect(result.people).toEqual(["Bert Dohmen"]);
  });

  it("leaves unknown names untouched", () => {
    expect(resolvePeople(["Gady"], {}, []).people).toEqual(["Gady"]);
  });
});

describe("applyCaptureDiscipline", () => {
  const base = {
    extracted: { type: "decision", topics: ["markets"], people: ["Dohmen"] },
    callerMetadata: {},
    vocabulary: ["market"],
  };

  it("normalises every field in one pass", () => {
    const result = applyCaptureDiscipline({
      ...base,
      config: config({ personAliases: { dohmen: "Bert Dohmen" }, selfNames: ["Ahuvi"] }),
    });

    expect(result.type).toBe("decision");
    expect(result.topics).toEqual(["market"]);
    expect(result.people).toEqual(["Bert Dohmen"]);
  });

  it("lets caller metadata override the extractor", () => {
    const result = applyCaptureDiscipline({
      ...base,
      callerMetadata: { type: "bug", topics: ["market"] },
      config: config(),
    });
    expect(result.type).toBe("bug");
    expect(result.topics).toEqual(["market"]);
  });

  it("prefers the explicit type parameter over caller metadata", () => {
    const result = applyCaptureDiscipline({
      ...base,
      callerMetadata: { type: "bug" },
      explicitType: "postmortem",
      config: config(),
    });
    expect(result.type).toBe("postmortem");
  });

  it("files a capture with no project under the default namespace", () => {
    const result = applyCaptureDiscipline({ ...base, config: config({ defaultProject: "personal" }) });
    expect(result.project).toBe("personal");
    expect(result.notes.some((n) => n.action === "defaulted")).toBe(true);
  });

  it("keeps an explicit project untouched", () => {
    const result = applyCaptureDiscipline({ ...base, project: "mono", config: config() });
    expect(result.project).toBe("mono");
  });

  it("rejects a missing project when the namespace is mandatory", () => {
    expect(() => applyCaptureDiscipline({ ...base, config: config({ requireProject: true }) })).toThrow(
      /project is required/,
    );
  });

  it("rejects an unseen topic when the vocabulary is gated", () => {
    expect(() =>
      applyCaptureDiscipline({
        ...base,
        extracted: { ...base.extracted, topics: ["brand-new-thing"] },
        config: config({ requireKnownTopics: true }),
      }),
    ).toThrow(/new_topics: true/);
  });

  it("mints an unseen topic when the caller opts in", () => {
    const result = applyCaptureDiscipline({
      ...base,
      extracted: { ...base.extracted, topics: ["brand-new-thing"] },
      allowNewTopics: true,
      config: config({ requireKnownTopics: true }),
    });
    expect(result.topics).toEqual(["brand-new-thing"]);
  });

  it("rejects a capture that fell back to the catch-all type", () => {
    expect(() =>
      applyCaptureDiscipline({
        ...base,
        extracted: { ...base.extracted, type: "observation" },
        config: config(),
      }),
    ).toThrow(CaptureDisciplineError);
  });
});

describe("formatDisciplineNotes", () => {
  it("renders nothing when there is nothing to report", () => {
    expect(formatDisciplineNotes([])).toBe("");
  });

  it("renders one line per note", () => {
    const text = formatDisciplineNotes([
      { field: "people", action: "dropped", message: "person 'Ahuvi' dropped" },
      { field: "project", action: "defaulted", message: "filed under 'personal'" },
    ]);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("[people/dropped]");
  });
});

describe("getDisciplineConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetDisciplineConfig();
    process.env.OPENBRAIN_DISCIPLINE_CONFIG = "/nonexistent/discipline.json";
  });

  afterEach(() => {
    process.env = { ...saved };
    resetDisciplineConfig();
  });

  it("falls back to defaults when no config file exists", () => {
    expect(getDisciplineConfig().defaultProject).toBe("personal");
  });

  it("lets the environment override a rule", () => {
    process.env.OPENBRAIN_REQUIRE_SPECIFIC_TYPE = "false";
    process.env.OPENBRAIN_DEDUPE_THRESHOLD = "0.95";
    expect(getDisciplineConfig().requireSpecificType).toBe(false);
    expect(getDisciplineConfig().dedupeThreshold).toBe(0.95);
  });

  it("memoises until reset", () => {
    const first = getDisciplineConfig();
    process.env.OPENBRAIN_DEFAULT_PROJECT = "other";
    expect(getDisciplineConfig()).toBe(first);
    resetDisciplineConfig();
    expect(getDisciplineConfig().defaultProject).toBe("other");
  });
});
