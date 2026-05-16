// src/play/lessonGenerator.ts
//
// Online + offline lesson generation entry point used by PlayBuildScreen.
//
// Routing decision is the caller's responsibility — they call
// `router.resolveRoute('play_lesson_gen')` (or check NetInfo directly) and
// then dispatch to the appropriate path here.
//
//   Online path:  delegates to playApi.createLesson — backend handles
//                 OCR cleanup, dedup, validation, persistence.
//   Offline path: drives Gemma 4 (E2B) via litert.generateResponse in
//                 batches of 10, applies the same dedup + clamp rules
//                 the backend uses, persists progress incrementally to
//                 AsyncStorage so a backgrounded app can resume.
//
// Both paths produce the same shape: { questions, count }. The PlayBuild
// screen is responsible for actually persisting the offline result via
// playApi.createLesson once back online (or via the offline mutation
// queue when still offline).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateResponse } from '../services/litert';
import { track, trackError } from '../services/analytics';
import {
  dedupQuestions,
  positionRandomizeCorrect,
  truncateToWordBoundary,
} from './dedup';
import type { PlayQuestion } from './types';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Hard target — every saved lesson lands here exactly. The PlayBuild
 *  progress screen errors out if the on-device generator can't reach it. */
export const TARGET_QUESTION_COUNT = 100;

/** Per-batch size. Gemma 4 (E2B) reliably emits 8-12 well-formed MCQs in a
 *  single call without context-window pressure. 10 keeps each request short
 *  enough to run within the on-device latency budget. */
const BATCH_SIZE = 10;

/** How many consecutive low-yield batches we tolerate before escalating to
 *  the next tier. A "low-yield" batch is one that produces <2 unique new
 *  questions after dedup. */
const MAX_STALL_BATCHES_PER_TIER = 3;

/** How many consecutive zero-yield batches we tolerate at the top tier
 *  before giving up. Zero-yield = literally nothing parsed or every row
 *  rejected by dedup. */
const MAX_ZERO_BATCHES_AT_TOP_TIER = 4;

/** Cap on total batches to keep wall-clock bounded on slow phones. */
const MAX_TOTAL_BATCHES = 30;

const TIER_GROUNDED = 0;
const TIER_EXPAND = 1;
const TIER_FUNDAMENTALS = 2;

const PROMPT_MAX_CHARS = 80;
const OPTION_MAX_CHARS = 25;

/** AsyncStorage key prefix for in-progress offline generations. The taskId
 *  suffix is a UUID-ish string the caller mints (so it survives navigation
 *  and an app background). */
export const OFFLINE_GEN_STORAGE_PREFIX = 'neriah_play_offline_gen_';

// ── Public API ───────────────────────────────────────────────────────────────

export interface OfflineGenOptions {
  title: string;
  subject?: string;
  grade?: string;
  source_content: string;
  /** Already-generated questions (e.g. from a resumed task). Dedup uses
   *  these as the starting set. */
  existingQuestions?: PlayQuestion[];
  /** Stable identifier for the offline-generation task. Used as the
   *  AsyncStorage key suffix so progress survives an app background or a
   *  brief crash. Caller mints + reuses on resume. */
  taskId?: string;
  /** Called every time the cumulative count grows. */
  onProgress?: (count: number) => void;
  /** Called every batch with a hint about whether the model is stalling
   *  (so the UI can soften the target from 100 → 70 if needed). */
  onStallHint?: (consecutiveStalls: number) => void;
  /** Caller-controlled abort signal. We read aborted on every batch
   *  boundary; partial results are still saved to AsyncStorage. */
  signal?: AbortSignal;
}

export interface OfflineGenResult {
  questions: PlayQuestion[];
  count: number;
  /** True when we hit the configured stall ceiling rather than the
   *  TARGET_QUESTION_COUNT. */
  stalled: boolean;
  /** True when the generator auto-augmented broader-topic batches because
   *  the supplied notes were too sparse. Mirrors the backend
   *  `was_expanded` field so the preview surface can show a single notice. */
  wasExpanded: boolean;
}

/**
 * Generate a lesson on-device using Gemma 4. Persists incremental progress
 * to AsyncStorage so the screen can rehydrate a partial run after a
 * background → foreground cycle.
 *
 * Stops when:
 *   - cumulative unique question count reaches TARGET_QUESTION_COUNT, OR
 *   - MAX_STALL_BATCHES consecutive batches yield <2 new uniques, OR
 *   - the caller aborts via `signal`.
 *
 * Throws when the LiteRT call itself errors (no fallback to text). The
 * caller is responsible for surfacing that to the user.
 */
export async function generateLessonOnDevice(
  opts: OfflineGenOptions,
): Promise<OfflineGenResult> {
  const startedAt = Date.now();
  track(
    'play.lesson.create.start',
    {
      path: 'on-device',
      target: TARGET_QUESTION_COUNT,
      source_chars: opts.source_content.length,
    },
    { surface: 'play' },
  );

  const seed = opts.existingQuestions ?? [];
  // Defensive copy — we mutate `accumulated` as new batches land, but
  // never the caller's array.
  const accumulated: PlayQuestion[] = [...seed];

  let consecutiveStalls = 0;
  let consecutiveZero = 0;
  let batchIndex = 0;
  let tier = TIER_GROUNDED;
  let countWhenExpandStarted: number | null = null;

  while (accumulated.length < TARGET_QUESTION_COUNT && batchIndex < MAX_TOTAL_BATCHES) {
    if (opts.signal?.aborted) {
      track('play.lesson.create.cancelled', { path: 'on-device', count: accumulated.length });
      break;
    }

    if (consecutiveStalls >= MAX_STALL_BATCHES_PER_TIER) {
      if (tier < TIER_FUNDAMENTALS) {
        // Climb to the next tier. The fundamentals tier draws on
        // topic + level alone, so it can keep producing material until
        // we hit the question target. One generation = one finished
        // lesson — we never punt to a separate "not enough" screen.
        tier += 1;
        if (tier === TIER_EXPAND && countWhenExpandStarted === null) {
          countWhenExpandStarted = accumulated.length;
        }
        consecutiveStalls = 0;
        track('play.lesson.create.tier_escalate', {
          path: 'on-device',
          to_tier: tier,
          have: accumulated.length,
          target: TARGET_QUESTION_COUNT,
        });
      } else if (consecutiveZero >= MAX_ZERO_BATCHES_AT_TOP_TIER) {
        // At the top tier and the model is producing literally nothing.
        // Stop here — caller still has whatever we accumulated.
        break;
      }
    }

    let batch: PlayQuestion[];
    try {
      batch = await generateBatch({
        title: opts.title,
        subject: opts.subject,
        grade: opts.grade,
        source_content: opts.source_content,
        existing: accumulated,
        batchIndex,
        tier,
      });
    } catch (err) {
      trackError('play.lesson.create.failed', err, {
        path: 'on-device',
        count: accumulated.length,
        batch_index: batchIndex,
      });
      // First batch failure means the model is unusable — surface it.
      if (batchIndex === 0) throw err;
      // Later failures: count as a stall, keep going. Partial results
      // are already saved.
      consecutiveStalls += 1;
      opts.onStallHint?.(consecutiveStalls);
      batchIndex += 1;
      continue;
    }

    const newOnes = dedupQuestions(batch, accumulated);
    if (newOnes.length === 0) {
      consecutiveZero += 1;
    } else {
      consecutiveZero = 0;
    }
    if (newOnes.length < 2) {
      consecutiveStalls += 1;
      opts.onStallHint?.(consecutiveStalls);
    } else {
      consecutiveStalls = 0;
    }

    accumulated.push(...newOnes);

    // Persist progress so a backgrounded app can resume from here.
    if (opts.taskId) {
      const key = `${OFFLINE_GEN_STORAGE_PREFIX}${opts.taskId}`;
      AsyncStorage.setItem(
        key,
        JSON.stringify({
          taskId: opts.taskId,
          updated_at: new Date().toISOString(),
          questions: accumulated,
          input: {
            title: opts.title,
            subject: opts.subject ?? null,
            grade: opts.grade ?? null,
            source_content: opts.source_content,
          },
        }),
      ).catch(() => {
        // Best-effort persistence — never block generation on storage errors.
      });
    }

    opts.onProgress?.(accumulated.length);
    batchIndex += 1;
  }

  // Final sanitation pass — clamp lengths and randomise the correct slot.
  const finalised = positionRandomizeCorrect(
    accumulated.slice(0, TARGET_QUESTION_COUNT).map(sanitiseQuestion),
  );

  const stalled = batchIndex >= MAX_TOTAL_BATCHES && finalised.length < TARGET_QUESTION_COUNT;
  const wasExpanded =
    countWhenExpandStarted !== null && finalised.length > countWhenExpandStarted;

  track(
    'play.lesson.create.success',
    {
      path: 'on-device',
      count: finalised.length,
      stalled,
      was_expanded: wasExpanded,
      latency_ms: Date.now() - startedAt,
    },
    { surface: 'play' },
  );

  return { questions: finalised, count: finalised.length, stalled, wasExpanded };
}

// ── Internal: rehydrate a previously-persisted run ───────────────────────────

export interface PersistedProgress {
  taskId: string;
  updated_at: string;
  questions: PlayQuestion[];
  input: {
    title: string;
    subject: string | null;
    grade: string | null;
    source_content: string;
  };
}

/** Read previously-persisted offline-generation progress for a task id. */
export async function readPersistedProgress(
  taskId: string,
): Promise<PersistedProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(`${OFFLINE_GEN_STORAGE_PREFIX}${taskId}`);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedProgress;
  } catch {
    return null;
  }
}

/** Clear persisted progress for a task id (called on cancel + on completion). */
export async function clearPersistedProgress(taskId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${OFFLINE_GEN_STORAGE_PREFIX}${taskId}`);
  } catch {
    /* ignore */
  }
}

// ── Internal: prompt + parse helpers ─────────────────────────────────────────

interface BatchInput {
  title: string;
  subject?: string;
  grade?: string;
  source_content: string;
  existing: PlayQuestion[];
  batchIndex: number;
  /** Escalation tier that controls how the prompt scopes generation:
   *    0 (grounded)     — strictly within the source notes
   *    1 (expand)       — broader related concepts of the same topic
   *    2 (fundamentals) — open-ended review at the student's level */
  tier: number;
}

/**
 * Build a strict JSON-output prompt for one batch. Caps the source content
 * at 4000 chars so we don't blow the on-device context window when the
 * student dumped a long photo OCR transcript.
 */
function buildBatchPrompt(input: BatchInput): string {
  const sourceCapped = input.source_content.slice(0, 4000);
  const trailing = input.source_content.length > 4000 ? '\n[...content truncated]' : '';

  // Keep the avoid-duplicates sample short — we just need the model to
  // not regurgitate the previous batch's exact prompts. Send the last 8
  // prompts; the dedup pass on the JS side catches the rest.
  const recent = input.existing.slice(-8).map((q) => `- ${q.prompt}`).join('\n');
  const avoidBlock = recent
    ? `Avoid repeating these prompts (paraphrase or pick a different angle):\n${recent}\n\n`
    : '';

  const subjectLine = input.subject ? `Subject: ${input.subject}` : '';
  const gradeLine = input.grade ? `Level: ${input.grade}` : '';

  // Use the first sentence of the source as the topic anchor for tier-2.
  // Students often supply gibberish titles ("Bzbs", "Test"); the title
  // alone makes Gemma generate questions about nothing.
  const firstSentence = (() => {
    const s = (input.source_content || '').split('.', 1)[0].trim();
    return s.length > 140 ? `${s.slice(0, 140).trim()}…` : s;
  })();
  const topicAnchor = firstSentence || input.title;

  let scopeLine: string;
  if (input.tier >= TIER_FUNDAMENTALS) {
    scopeLine =
      `You MUST output ${BATCH_SIZE} review questions on this topic: "${topicAnchor}". ` +
      'Cover core definitions, worked examples, applications, and common ' +
      'misconceptions a student at this level would meet. The notes below are flavour ' +
      'only — do not limit yourself to them. Stay at the implied level.';
  } else if (input.tier >= TIER_EXPAND) {
    scopeLine =
      'The notes below have been exhausted. Generate broader related-concept ' +
      'questions on the SAME topic and level — real-world applications, common ' +
      'misconceptions, related sub-topics.';
  } else {
    scopeLine = 'Generate questions grounded in the source notes below.';
  }

  return [
    'You generate multiple-choice quiz questions for African school students.',
    subjectLine,
    gradeLine,
    '',
    scopeLine,
    '',
    'Source notes:',
    sourceCapped + trailing,
    '',
    avoidBlock,
    `Output ${BATCH_SIZE} fresh, distinct multiple-choice questions as STRICT JSON:`,
    '[',
    '  { "prompt": "<question, max 80 chars>",',
    '    "options": ["<opt A, max 25 chars>", "<opt B>", "<opt C>", "<opt D>"],',
    '    "correct": <index 0..3> }',
    ']',
    '',
    'Rules:',
    '- Return ONLY the JSON array, no surrounding prose, no code fences.',
    '- Exactly 4 options per question.',
    '- "correct" is a 0-based index into the options array.',
    '- Keep each question prompt under 80 characters.',
    '- Keep each option under 25 characters.',
  ].filter(Boolean).join('\n');
}

async function generateBatch(input: BatchInput): Promise<PlayQuestion[]> {
  const prompt = buildBatchPrompt(input);
  const raw = await generateResponse(prompt);

  // Strip optional code-fence wrappers Gemma sometimes adds.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to slice out the first JSON array if there's leading text.
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      return [];
    }
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: PlayQuestion[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const prompt = typeof r.prompt === 'string' ? r.prompt : '';
    const options = Array.isArray(r.options) ? (r.options as unknown[]) : [];
    const correct = typeof r.correct === 'number' ? r.correct : Number(r.correct);
    if (!prompt || options.length !== 4) continue;
    if (Number.isNaN(correct) || correct < 0 || correct > 3) continue;
    const optionStrs = options.map((o) => (typeof o === 'string' ? o : String(o ?? '')));
    if (optionStrs.some((o) => !o.trim())) continue;
    out.push({
      prompt,
      options: optionStrs,
      correct,
    });
  }
  return out;
}

function sanitiseQuestion(q: PlayQuestion): PlayQuestion {
  return {
    prompt: truncateToWordBoundary(q.prompt, PROMPT_MAX_CHARS),
    options: q.options.map((o) => truncateToWordBoundary(o, OPTION_MAX_CHARS)),
    correct: Math.max(0, Math.min(3, q.correct)),
  };
}
