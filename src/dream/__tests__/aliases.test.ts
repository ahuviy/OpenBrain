/**
 * Tests for structural alias inference.
 *
 * The vocabulary pass only ever applied the CONFIGURED alias table, so a brain
 * that had accumulated `Dohmen` (7) and `Bert Dohmen` (3) kept both forever —
 * the operation named for unifying vocabulary unified nothing nobody had already
 * written down.
 *
 * Inference here is structural, never semantic: same words, different spelling.
 * `markets` and `market-analysis` are RELATED but not variants, and unifying
 * them would rewrite metadata on a guess. Only a judge should make that call.
 */

import { describe, it, expect } from "vitest";

import { inferAliases, inferPersonAliases, inferTopicAliases } from "../ops/aliases.js";

describe("inferTopicAliases", () => {
  it("folds a plural into the singular the brain uses more", () => {
    expect(inferTopicAliases({ market: 5, markets: 2 })).toEqual({ markets: "market" });
  });

  it("keeps the spelling the brain uses most, even when it is the plural", () => {
    expect(inferTopicAliases({ market: 1, markets: 6 })).toEqual({ market: "markets" });
  });

  it("folds separator and case variants together", () => {
    expect(inferTopicAliases({ "market-analysis": 5, market_analysis: 2, "Market Analysis": 1 })).toEqual({
      market_analysis: "market-analysis",
      "Market Analysis": "market-analysis",
    });
  });

  it("leaves related-but-different topics alone", () => {
    // The pair from the report. Same prefix, different subject: `markets` is not
    // a spelling of `market-analysis`, and folding it would lose the distinction
    // between a subject and an activity.
    expect(inferTopicAliases({ "market-analysis": 5, markets: 3 })).toEqual({});
  });

  it("breaks a tie on the shorter spelling, not on map order", () => {
    expect(inferTopicAliases({ markets: 2, market: 2 })).toEqual({ markets: "market" });
  });

  it("returns nothing for a vocabulary with no variants", () => {
    expect(inferTopicAliases({ markets: 3, forex: 9 })).toEqual({});
  });
});

describe("inferPersonAliases", () => {
  it("folds a bare surname into the full name", () => {
    expect(inferPersonAliases({ Dohmen: 7, "Bert Dohmen": 3 })).toEqual({ "Bert Dohmen": "Dohmen" });
  });

  it("keeps the form the brain uses most", () => {
    expect(inferPersonAliases({ Dohmen: 2, "Bert Dohmen": 8 })).toEqual({ Dohmen: "Bert Dohmen" });
  });

  it("requires whole words, not substrings", () => {
    // "Ann" inside "Anna" is a different person, and a substring rule would
    // silently retag every thought about one of them.
    expect(inferPersonAliases({ Ann: 4, Anna: 2 })).toEqual({});
  });

  it("does not fold two people who merely share a first name", () => {
    expect(inferPersonAliases({ "Bert Dohmen": 4, "Bert Schmidt": 2 })).toEqual({});
  });

  it("breaks a tie on the longer, more specific name", () => {
    // Unlike topics: a full name disambiguates, a bare surname does not.
    expect(inferPersonAliases({ Dohmen: 3, "Bert Dohmen": 3 })).toEqual({ Dohmen: "Bert Dohmen" });
  });

  it("is case- and punctuation-insensitive about the match", () => {
    expect(inferPersonAliases({ "bert dohmen": 5, "Bert Dohmen": 1 })).toEqual({
      "Bert Dohmen": "bert dohmen",
    });
  });

  it("never maps a name onto itself", () => {
    const aliases = inferPersonAliases({ Dohmen: 7, "Bert Dohmen": 3 });

    for (const [variant, canonical] of Object.entries(aliases)) {
      expect(variant).not.toBe(canonical);
    }
  });
});

describe("inferAliases", () => {
  // The write-path resolvers look aliases up by a NORMALISED key — topics
  // lowercased and hyphenated, people lowercased — so a map keyed by the stored
  // spelling silently never matches.
  it("keys topic aliases the way resolveTopics looks them up", () => {
    const { topicAliases } = inferAliases({
      topics: { "market-analysis": 5, "Market Analysis": 2 },
      people: {},
    });

    expect(topicAliases).toEqual({ "market-analysis": "market-analysis" });
  });

  it("keys person aliases the way resolvePeople looks them up", () => {
    const { personAliases } = inferAliases({
      topics: {},
      people: { Dohmen: 7, "Bert Dohmen": 3 },
    });

    expect(personAliases).toEqual({ "bert dohmen": "Dohmen" });
  });

  it("is empty for a vocabulary with nothing to fold", () => {
    expect(inferAliases({ topics: { forex: 3 }, people: { Dohmen: 2 } })).toEqual({
      topicAliases: {},
      personAliases: {},
      variants: { topics: [], people: [] },
    });
  });
});

describe("inferAliases variants", () => {
  // The alias MAP is keyed for the resolvers, which look up normalised keys.
  // The lookup that finds the rows to rewrite is a different question: jsonb
  // `?|` compares stored spellings exactly, so it needs the spellings as
  // written. Returning only normalised keys means the sweep silently finds
  // nothing and the two spellings survive.
  it("reports the stored spellings that need rewriting", () => {
    const { variants } = inferAliases({
      topics: { "market-analysis": 5, "Market Analysis": 2 },
      people: { Dohmen: 7, "Bert Dohmen": 3 },
    });

    expect(variants.topics).toEqual(["Market Analysis"]);
    expect(variants.people).toEqual(["Bert Dohmen"]);
  });

  it("never lists the canonical spelling as needing a rewrite", () => {
    const { variants } = inferAliases({ topics: {}, people: { Dohmen: 7, "Bert Dohmen": 3 } });

    expect(variants.people).not.toContain("Dohmen");
  });

  it("has no variants when nothing folds", () => {
    expect(inferAliases({ topics: { forex: 3 }, people: {} }).variants).toEqual({
      topics: [],
      people: [],
    });
  });
});
