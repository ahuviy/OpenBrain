/**
 * Cached topic vocabulary.
 *
 * The new-tag gate needs to know every tag the brain already uses, on every
 * capture. That is one `GROUP BY` over a JSONB array expansion — cheap, but not
 * cheap enough to pay per write from a phone on cellular. A short TTL keeps the
 * gate accurate (a tag minted a minute ago counts as known) without putting the
 * query on the hot path.
 */

import type pg from "pg";

import { listDistinctTopics } from "../db/queries.js";

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  topics: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function ttlMs(): number {
  const raw = process.env.OPENBRAIN_VOCAB_TTL_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_TTL_MS;
}

/** Drop every cached vocabulary. Used by tests and after a bulk import. */
export function resetVocabularyCache(): void {
  cache.clear();
}

/**
 * Topic tags in use, refreshed at most once per TTL. Never throws: a brain that
 * cannot answer the vocabulary query still accepts writes, it just cannot gate
 * new tags on that request.
 */
export async function getTopicVocabulary(
  pool: pg.Pool,
  project?: string,
  now: number = Date.now(),
): Promise<string[]> {
  const key = project ?? "*";
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.topics;

  try {
    const topics = await listDistinctTopics(pool, project);
    cache.set(key, { topics, expiresAt: now + ttlMs() });
    return topics;
  } catch (err) {
    console.warn(`[discipline] Topic vocabulary lookup failed: ${String(err)}`);
    return hit?.topics ?? [];
  }
}

/** Fold freshly-written tags into the cache so back-to-back captures agree. */
export function rememberTopics(topics: string[], project?: string): void {
  const key = project ?? "*";
  const hit = cache.get(key);
  if (!hit) return;
  for (const topic of topics) {
    if (!hit.topics.includes(topic)) hit.topics.push(topic);
  }
}
