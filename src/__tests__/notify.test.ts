/**
 * Tests for src/notify.ts
 *
 * The scheduled dream run exits when it finishes, so its notification cannot be
 * fire-and-forget: an unawaited fetch races the process teardown and usually
 * loses. sendNotification is the awaited path, and it has to distinguish
 * "not configured" (fine) from "configured and broken" (worth logging).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { sendNotification } from "../notify.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response("", { status: 200 }));
}

describe("sendNotification", () => {
  it("is a no-op when no topic is configured", async () => {
    vi.stubEnv("NTFY_URL", "");
    const fetchImpl = okFetch();

    await expect(sendNotification({ title: "t", message: "m" }, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the title, priority and tags ntfy reads from headers", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/brain");
    const fetchImpl = okFetch();

    await sendNotification(
      { title: "Dream complete", message: "merged 2", priority: "urgent", tags: "sparkles" },
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/brain");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({
      Title: "Dream complete",
      Priority: "urgent",
      Tags: "sparkles",
    });
    expect(init!.body).toContain("merged 2");
  });

  it("strips a non-Latin-1 title, which undici would reject outright", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/brain");
    const fetchImpl = okFetch();

    await sendNotification({ title: "Dream ✅ done", message: "m" }, fetchImpl);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).Title).toBe("Dream  done");
    // The full title survives in the body, where encoding is not a constraint.
    expect(init!.body).toContain("✅");
  });

  it("throws when ntfy rejects the push, so a caller can log it", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/brain");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("nope", { status: 503 }));

    await expect(sendNotification({ title: "t", message: "m" }, fetchImpl)).rejects.toThrow("503");
  });

  it("truncates a long body rather than having ntfy reject it", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/brain");
    const fetchImpl = okFetch();

    await sendNotification({ title: "t", message: "x".repeat(5000) }, fetchImpl);

    expect(String(fetchImpl.mock.calls[0]![1]!.body)).toHaveLength(3000);
  });

  it("defaults priority and tags so a caller can pass only the text", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/brain");
    const fetchImpl = okFetch();

    await sendNotification({ title: "t", message: "m" }, fetchImpl);

    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ Priority: "default" });
  });
});
