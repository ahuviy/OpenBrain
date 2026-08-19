/**
 * OpenRouter embedder — cloud-based, multi-model gateway.
 * Fallback option if Ollama is unavailable.
 */

import {
  CONTRADICTION_PROMPT,
  SYNTHESIS_PROMPT,
  judgePayload,
  type JudgeInput,
  type ContradictionJudgment,
  type Embedder,
  type ThoughtMetadataExtracted,
  DEFAULT_METADATA,
  METADATA_PROMPT,
} from "./types.js";

export class OpenRouterEmbedder implements Embedder {
  private readonly apiKey: string;
  private readonly embedModel: string;
  private readonly llmModel: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY ?? "";
    this.embedModel = process.env.OPENROUTER_EMBED_MODEL ?? "openai/text-embedding-3-small";
    this.llmModel = process.env.OPENROUTER_LLM_MODEL ?? "openai/gpt-4o-mini";

    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required when using openrouter provider");
    }

    console.log(
      `[embedder] OpenRouter (embed: ${this.embedModel}, llm: ${this.llmModel})`
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.embedModel, input: text }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    const embedding = data.data[0]?.embedding;

    if (!embedding) {
      throw new Error("OpenRouter returned empty embedding");
    }

    return embedding;
  }

  async extractMetadata(content: string): Promise<ThoughtMetadataExtracted> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [
          { role: "system", content: METADATA_PROMPT },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      console.warn(`[embedder] OpenRouter metadata extraction failed: ${response.status}`);
      return DEFAULT_METADATA;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    try {
      const raw = data.choices[0]?.message.content ?? "{}";
      const parsed = JSON.parse(raw) as ThoughtMetadataExtracted;
      return {
        type: parsed.type ?? "observation",
        topics: parsed.topics ?? [],
        people: parsed.people ?? [],
        action_items: parsed.action_items ?? [],
        dates: parsed.dates ?? [],
      };
    } catch (e) {
      console.warn("[embedder] Failed to parse metadata JSON:", e);
      return DEFAULT_METADATA;
    }
  }

  private async chat(system: string, user: string, json: boolean): Promise<string> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter chat failed: ${response.status}`);
    }

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return data?.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Unlike extractMetadata, a failure here THROWS rather than returning a
   * default. A default verdict is still a verdict, and dream would act on it —
   * the caller skips the pair instead when the provider cannot answer.
   */
  async judgeContradiction(a: JudgeInput, b: JudgeInput): Promise<ContradictionJudgment> {
    const raw = await this.chat(CONTRADICTION_PROMPT, judgePayload(a, b), true);
    if (raw.trim().length === 0) {
      throw new Error("contradiction judgment came back empty");
    }
    return JSON.parse(raw) as ContradictionJudgment;
  }

  async synthesise(contents: string[]): Promise<string> {
    return this.chat(SYNTHESIS_PROMPT, contents.join("\n\n---\n\n"), false);
  }
}
