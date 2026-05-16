// src/services/mutationQueue.ts
// Generic offline mutation queue for actions that change existing
// server-side state (approve / delete / edit). Complements the
// scan-grade queue in offlineQueue.ts, which handles new-submission
// uploads.
//
// Contract:
//   1. When a mutation is performed online, the API call goes through
//      normally and nothing touches this queue.
//   2. When a mutation is performed offline, it is enqueued here AND
//      the read cache is patched so the UI immediately reflects the
//      new state ("offline takes precedence" — the teacher sees their
//      change as if it had happened).
//   3. On the next offline → online transition, replayMutationQueue()
//      walks the queue in order, replaying each mutation against the
//      backend. Successful replays are removed; permanent client
//      errors (4xx) are moved to dead-letter; transient errors (5xx
//      / network) increment retry_count and stay in the queue.
//
// Operations covered today:
//   - approve_submission       POST   /api/submissions/{id}/approve
//   - delete_submission        DELETE /api/submissions/{id}
//   - delete_mark              DELETE /api/marks/{mark_id}
//   - update_mark              PUT    /api/marks/{mark_id}
//
// To add a new op: extend the MutationOp union, add a replay branch,
// and add an optimistic cache-mutator. Keep the patch deterministic so
// re-running it twice produces the same state (idempotent replays
// matter — network blips can cause retries).

import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = 'neriah_mutation_queue';
const DEAD_LETTER_KEY = 'neriah_mutation_dead_letter';
const MAX_RETRIES = 5;

export type MutationOp =
  | { type: 'approve_submission'; submission_id: string }
  | { type: 'delete_submission'; submission_id: string }
  | { type: 'delete_mark'; mark_id: string }
  | {
      type: 'update_mark';
      mark_id: string;
      payload: {
        score?: number;
        max_score?: number;
        feedback?: string;
        verdicts?: Array<Record<string, unknown>>;
        approved?: boolean;
        manually_edited?: boolean;
      };
    };

export interface QueuedMutation {
  id: string;
  op: MutationOp;
  queued_at: string;
  retry_count: number;
}

// ── Storage helpers ──────────────────────────────────────────────────────────

export async function getMutationQueue(): Promise<QueuedMutation[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedMutation[]) : [];
  } catch {
    return [];
  }
}

async function _saveQueue(queue: QueuedMutation[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function getMutationQueueLength(): Promise<number> {
  return (await getMutationQueue()).length;
}

export async function clearMutationQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
  await AsyncStorage.removeItem(DEAD_LETTER_KEY);
}

async function _moveToDeadLetter(item: QueuedMutation, reason: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
    const dead: Array<QueuedMutation & { failed_at: string; reason: string }> = raw
      ? JSON.parse(raw)
      : [];
    dead.push({ ...item, failed_at: new Date().toISOString(), reason });
    await AsyncStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead));
  } catch {
    // Best-effort
  }
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export async function enqueueMutation(op: MutationOp): Promise<QueuedMutation> {
  const item: QueuedMutation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    op,
    queued_at: new Date().toISOString(),
    retry_count: 0,
  };
  const queue = await getMutationQueue();
  queue.push(item);
  await _saveQueue(queue);
  // Apply optimistic cache patch so the UI shows the offline state
  // the moment the action returns.
  await applyOptimisticCachePatch(op);
  return item;
}

// ── Optimistic cache patching ───────────────────────────────────────────────
//
// We rewrite the cached read responses to reflect the queued change.
// This is what gives the teacher the "WhatsApp" feel: tap Approve while
// offline → the row immediately shows as approved, even before any
// network call ever happens.

const CACHE_PREFIX = 'cache:';

async function listCacheKeys(prefix: string): Promise<string[]> {
  const all = await AsyncStorage.getAllKeys();
  return all.filter((k) => k.startsWith(`${CACHE_PREFIX}${prefix}`));
}

async function readJson<T>(storageKey: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(storageKey).catch(() => null);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(storageKey: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(storageKey, JSON.stringify(value)).catch(() => {});
}

async function applyOptimisticCachePatch(op: MutationOp): Promise<void> {
  switch (op.type) {
    case 'approve_submission': {
      // Flip status → 'approved' on every cached submissions:* slot
      // that contains this submission, and on any cache:mark:<mark_id>
      // entry linked to it.
      const subKeys = await listCacheKeys('submissions:');
      await Promise.all(
        subKeys.map(async (k) => {
          const subs = await readJson<Array<Record<string, unknown>>>(k);
          if (!subs) return;
          let changed = false;
          const patched = subs.map((s) => {
            if (s.id === op.submission_id) {
              changed = true;
              return { ...s, status: 'approved' };
            }
            return s;
          });
          if (changed) await writeJson(k, patched);
        }),
      );
      break;
    }

    case 'delete_submission': {
      const subKeys = await listCacheKeys('submissions:');
      await Promise.all(
        subKeys.map(async (k) => {
          const subs = await readJson<Array<{ id: string; mark_id?: string }>>(k);
          if (!subs) return;
          const dropped = subs.filter((s) => s.id !== op.submission_id);
          if (dropped.length !== subs.length) await writeJson(k, dropped);
        }),
      );
      break;
    }

    case 'delete_mark': {
      // Remove from per-mark cache.
      await AsyncStorage.removeItem(`${CACHE_PREFIX}mark:${op.mark_id}`).catch(() => {});
      // Also drop any submission referencing this mark — backend
      // cascades the same way, so the local view should match.
      const subKeys = await listCacheKeys('submissions:');
      await Promise.all(
        subKeys.map(async (k) => {
          const subs = await readJson<Array<{ mark_id?: string }>>(k);
          if (!subs) return;
          const dropped = subs.filter((s) => s.mark_id !== op.mark_id);
          if (dropped.length !== subs.length) await writeJson(k, dropped);
        }),
      );
      break;
    }

    case 'update_mark': {
      const key = `${CACHE_PREFIX}mark:${op.mark_id}`;
      const current = await readJson<Record<string, unknown>>(key);
      if (current) {
        await writeJson(key, { ...current, ...op.payload });
      }
      // Also reflect the score change in any submissions:* lists that
      // surface a `score` summary for this mark.
      if (op.payload.score != null || op.payload.approved != null) {
        const subKeys = await listCacheKeys('submissions:');
        await Promise.all(
          subKeys.map(async (k) => {
            const subs = await readJson<Array<Record<string, unknown>>>(k);
            if (!subs) return;
            let changed = false;
            const patched = subs.map((s) => {
              if (s.mark_id === op.mark_id) {
                changed = true;
                const next: Record<string, unknown> = { ...s };
                if (op.payload.score != null) next.score = op.payload.score;
                if (op.payload.max_score != null) next.max_score = op.payload.max_score;
                if (op.payload.approved != null) {
                  next.status = op.payload.approved ? 'approved' : next.status;
                }
                return next;
              }
              return s;
            });
            if (changed) await writeJson(k, patched);
          }),
        );
      }
      break;
    }
  }
}

// ── Replay ───────────────────────────────────────────────────────────────────

// Lazy import of api functions to avoid a circular import (api.ts
// imports from this file for the offline-fallback path).
let _replayApi:
  | {
      approveSubmission: (id: string) => Promise<void>;
      deleteSubmission: (id: string) => Promise<{ deleted: boolean } & Record<string, unknown>>;
      deleteMark: (id: string) => Promise<{ deleted: boolean } & Record<string, unknown>>;
      updateMark: (
        id: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  | null = null;

export function _registerReplayApi(api: NonNullable<typeof _replayApi>): void {
  _replayApi = api;
}

export async function replayMutationQueue(): Promise<{ applied: number; failed: number }> {
  if (!_replayApi) return { applied: 0, failed: 0 };

  const queue = await getMutationQueue();
  if (queue.length === 0) return { applied: 0, failed: 0 };

  let applied = 0;
  let failed = 0;
  const remaining: QueuedMutation[] = [];

  for (const item of queue) {
    if (item.retry_count >= MAX_RETRIES) {
      await _moveToDeadLetter(item, 'Max retries exceeded');
      failed++;
      continue;
    }

    try {
      await _replay(item.op);
      applied++;
    } catch (err: unknown) {
      const status: number = (err as { status?: number })?.status ?? 0;
      // 4xx (other than 401) is a permanent error — the resource is
      // gone, the user lost permission, the request was malformed.
      // Retrying won't help. 401 is a transient auth issue handled by
      // the global interceptor; keep it in the queue so the next
      // logged-in session retries.
      if (status >= 400 && status < 500 && status !== 401) {
        await _moveToDeadLetter(item, `Client error ${status}`);
        failed++;
      } else {
        remaining.push({ ...item, retry_count: item.retry_count + 1 });
      }
    }
  }

  await _saveQueue(remaining);
  return { applied, failed };
}

async function _replay(op: MutationOp): Promise<void> {
  if (!_replayApi) throw new Error('mutationQueue: api not registered');
  switch (op.type) {
    case 'approve_submission':
      await _replayApi.approveSubmission(op.submission_id);
      return;
    case 'delete_submission':
      await _replayApi.deleteSubmission(op.submission_id);
      return;
    case 'delete_mark':
      await _replayApi.deleteMark(op.mark_id);
      return;
    case 'update_mark':
      await _replayApi.updateMark(op.mark_id, op.payload);
      return;
  }
}
