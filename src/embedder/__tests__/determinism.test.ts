/**
 * Every LLM call this system makes must be deterministic.
 *
 * None of these are creative work: extraction reads what is already in the
 * text, the judge decides whether two thoughts conflict, and synthesis
 * summarises a cluster. At the provider's default temperature the same fixture
 * captured twice produced `["Enforce deployment rules for staging"]` once and
 * `[]` the other time, and invented an action item from a line that only said a
 * fixture was safe to delete. A memory system that returns different metadata
 * for identical input is one nobody can check.
 *
 * Asserted per provider rather than in one place, because each builds its own
 * request body and a missing field is silent — the call succeeds and the
 * sampling comes back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { OpenRouterEmbedder } from "../openrouter.js";
import { OllamaEmbedder } from "../ollama.js";
import { AzureOpenAIEmbedder } from "../azure-openai.js";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const OPENROUTER_REPLY = {
  choices: [
    { message: { content: JSON.stringify({ verdict: "independent", reason: "stub", type: "observation" }) } },
  ],
};

// Ollama's /api/chat shape, which is what this embedder calls.
const OLLAMA_REPLY = {
  message: { content: JSON.stringify({ verdict: "independent", reason: "stub", type: "observation" }) },
};

describe("temperature", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-a-secret");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function bodiesOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return mock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  }

  it("openrouter pins every LLM call to 0", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(OPENROUTER_REPLY));
    const embedder = new OpenRouterEmbedder();

    await embedder.extractMetadata("some text");
    await embedder.judgeContradiction({ id: "a", content: "x" }, { id: "b", content: "y" });
    await embedder.synthesise(["one", "two"]);

    const bodies = bodiesOf(fetchMock);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.temperature).toBe(0);
    }
  });

  it("ollama pins every LLM call to 0", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(OLLAMA_REPLY));
    const embedder = new OllamaEmbedder();

    await embedder.extractMetadata("some text");
    await embedder.judgeContradiction({ id: "a", content: "x" }, { id: "b", content: "y" });
    await embedder.synthesise(["one", "two"]);

    for (const body of bodiesOf(fetchMock)) {
      expect((body.options as Record<string, unknown>).temperature).toBe(0);
    }
  });

  it("azure openai pins every LLM call to 0", async () => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    vi.stubEnv("AZURE_OPENAI_KEY", "test-key-not-a-secret");
    fetchMock.mockImplementation(async () => jsonResponse(OPENROUTER_REPLY));
    const embedder = new AzureOpenAIEmbedder();

    await embedder.extractMetadata("some text");
    await embedder.judgeContradiction({ id: "a", content: "x" }, { id: "b", content: "y" });
    await embedder.synthesise(["one", "two"]);

    for (const body of bodiesOf(fetchMock)) {
      expect(body.temperature).toBe(0);
    }
  });
});
