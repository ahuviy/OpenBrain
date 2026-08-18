/**
 * Tests for the MCP argument reshaping that keeps the first-class capture
 * params (type/topics/people) off the validator's deprecated-top-level path.
 */

import { describe, it, expect } from "vitest";

import { toBatchBody, toCaptureBody } from "../server.js";

describe("toCaptureBody", () => {
  it("folds descriptive params into metadata", () => {
    const body = toCaptureBody({
      content: "Gold broke out",
      type: "observation",
      topics: ["markets"],
      people: ["Bert Dohmen"],
    });

    expect(body).toEqual({
      content: "Gold broke out",
      metadata: { type: "observation", topics: ["markets"], people: ["Bert Dohmen"] },
    });
  });

  it("drops control flags so they never reach the validator", () => {
    const body = toCaptureBody({ content: "x", force: true, new_topics: true });
    expect(body).toEqual({ content: "x" });
  });

  it("keeps caller metadata and lets the explicit params win", () => {
    const body = toCaptureBody({
      content: "x",
      type: "bug",
      metadata: { type: "idea", provenance: { origin: "phone" } },
    });
    expect(body.metadata).toEqual({ type: "bug", provenance: { origin: "phone" } });
  });

  it("passes through the fields the validator owns", () => {
    const body = toCaptureBody({
      content: "x",
      project: "mono",
      source: "mcp",
      created_by: "ahuvi",
      supersedes: "a1b2c3d4-1234-5678-9abc-def012345678",
    });
    expect(body).toEqual({
      content: "x",
      project: "mono",
      source: "mcp",
      created_by: "ahuvi",
      supersedes: "a1b2c3d4-1234-5678-9abc-def012345678",
    });
  });

  it("omits metadata entirely when there is none", () => {
    expect(toCaptureBody({ content: "x" })).toEqual({ content: "x" });
  });

  it("ignores a metadata value that is not an object", () => {
    expect(toCaptureBody({ content: "x", metadata: "nope" })).toEqual({ content: "x" });
  });
});

describe("toBatchBody", () => {
  it("reshapes every item as well as the envelope", () => {
    const body = toBatchBody({
      thoughts: [
        { content: "a", type: "bug" },
        { content: "b", topics: ["ci"] },
      ],
      project: "mono",
      force: true,
    });

    expect(body).toEqual({
      project: "mono",
      thoughts: [
        { content: "a", metadata: { type: "bug" } },
        { content: "b", metadata: { topics: ["ci"] } },
      ],
    });
  });

  it("leaves malformed items alone for the validator to reject", () => {
    const body = toBatchBody({ thoughts: ["not an object"] });
    expect(body.thoughts).toEqual(["not an object"]);
  });
});
