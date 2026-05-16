// src/play/dedup.ts
//
// Client-side dedup + sanitation helpers for the on-device lesson
// generator. Mirrors the server-side rules in functions/play.py so an
// offline-built lesson plays the same as a cloud-built one.
//
// Server uses SBERT cosine similarity for semantic dedup; the on-device
// path doesn't have embeddings wired up so we settle for hash-only
// (lowercase + strip punctuation). Acceptable trade-off — the model
// rarely emits two prompts that differ only in punctuation, and the
// generator's own batch loop trims the long tail by stopping after 3
// stalled batches.

import type { PlayQuestion } from './types';

/**
 * Normalise a prompt for hash-based dedup:
 *   - lowercase
 *   - collapse whitespace
 *   - strip non-alphanumerics so "What is 5+3?" and "What is 5 + 3" match
 */
export function normalisePrompt(p: string): string {
  return p
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dedupe `incoming` against the running `existing` set. Returns only the
 * `incoming` items whose normalised prompt is not already in `existing`.
 * Order is preserved.
 */
export function dedupQuestions(
  incoming: PlayQuestion[],
  existing: PlayQuestion[],
): PlayQuestion[] {
  const seen = new Set<string>(existing.map((q) => normalisePrompt(q.prompt)));
  const out: PlayQuestion[] = [];
  for (const q of incoming) {
    const key = normalisePrompt(q.prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Position-randomise the `correct` index across the question set so the
 * answer doesn't always sit in slot 0 just because the model emitted it
 * there. We rotate options around the picked index — the answer text
 * doesn't change, only its column.
 */
export function positionRandomizeCorrect(qs: PlayQuestion[]): PlayQuestion[] {
  return qs.map((q) => {
    if (!q.options || q.options.length !== 4) return q;
    const target = Math.floor(Math.random() * 4);
    if (target === q.correct) return q;
    const opts = [...q.options];
    const correctText = opts[q.correct];
    opts[q.correct] = opts[target];
    opts[target] = correctText;
    return { ...q, options: opts, correct: target };
  });
}

/**
 * Hard-cap a string at `max` chars, breaking at the last word boundary
 * before the limit. Returns the original string when shorter than max.
 *
 *   truncateToWordBoundary('the quick brown fox', 12) === 'the quick'
 */
export function truncateToWordBoundary(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  // Cut at word boundary when one exists past the half-mark, otherwise hard-cut.
  if (lastSpace > Math.floor(max * 0.5)) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}
