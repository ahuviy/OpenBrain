/**
 * Tests for the contradiction payload handed to the LLM.
 */

import { describe, it, expect } from "vitest";

import { judgePayload } from "../types.js";

describe("judgePayload", () => {
  it("labels each thought with its id so the verdict can name one", () => {
    const payload = judgePayload(
      { id: "aaa", content: "Gold is breaking out" },
      { id: "bbb", content: "Gold has stalled" },
    );

    expect(payload).toContain("aaa");
    expect(payload).toContain("bbb");
    expect(payload).toContain("Gold is breaking out");
    expect(payload).toContain("Gold has stalled");
  });
});
