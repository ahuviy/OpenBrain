/**
 * Azure OpenAI embedder — uses Azure-hosted OpenAI models.
 * For cloud deployments where Ollama is not available.
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

export class AzureOpenAIEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly embedDeployment: string;
  private readonly llmDeployment: string;
  private readonly apiVersion: string;

  constructor() {
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? "";
    this.apiKey = process.env.AZURE_OPENAI_KEY ?? "";
    this.embedDeployment =
      process.env.AZURE_OPENAI_EMBED_DEPLOYMENT ?? "text-embedding-3-small";
    this.llmDeployment =
      process.env.AZURE_OPENAI_LLM_DEPLOYMENT ?? "gpt-4o-mini";
    this.apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-06-01";

    if (!this.endpoint) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT is required when using azure-openai provider"
      );
    }
    if (!this.apiKey) {
      throw new Error(
        "AZURE_OPENAI_KEY is required when using azure-openai provider"
      );
    }

    console.log(
      `[embedder] Azure OpenAI (embed: ${this.embedDeployment}, llm: ${this.llmDeployment}, endpoint: ${this.endpoint})`
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const url = `${this.endpoint}/openai/deployments/${this.embedDeployment}/embeddings?api-version=${this.apiVersion}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: text }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Azure OpenAI embed failed: ${response.status} ${response.statusText} — ${body}`
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    const embedding = data.data[0]?.embedding;

    if (!embedding) {
      throw new Error("Azure OpenAI returned empty embedding");
    }

    return embedding;
  }

  async extractMetadata(content: string): Promise<ThoughtMetadataExtracted> {
    const url = `${this.endpoint}/openai/deployments/${this.llmDeployment}/chat/completions?api-version=${this.apiVersion}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: METADATA_PROMPT },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
        // Extraction reads what is already in the text; it is not creative
        // work. At the default temperature the same input yields different
        // action items on different calls, which makes the metadata uncheckable.
        temperature: 0,
      }),
    });

    if (!response.ok) {
      console.warn(
        `[embedder] Azure OpenAI metadata extraction failed: ${response.status}`
      );
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
    const url = `${this.endpoint}/openai/deployments/${this.llmDeployment}/chat/completions?api-version=${this.apiVersion}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(json ? { response_format: { type: "json_object" } } : {}),
        // Judging and summarising are decisions about given text, not writing.
        temperature: 0,
      }),
    });

    if (!response.ok) {
      throw new Error(`Azure OpenAI chat failed: ${response.status}`);
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
