// src/services/offlineQueue.ts
// Offline scan queue backed by AsyncStorage.
// When the device loses connectivity, scans are queued locally.
// When connectivity is restored, replayQueue() re-submits them.
//
// Queue schema v2 (2026-04-22): scans store an array of page URIs instead
// of a single image_uri, matching the multi-page /mark backend contract.
// Legacy v1 items (single image_uri) from pre-multi builds are FLUSHED on
// app startup by migrateQueueIfNeeded() — the scans are lost, teacher
// re-scans.

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import { submitTeacherScan } from './api';

const QUEUE_KEY = 'neriah_offline_queue';
const DEAD_LETTER_KEY = 'neriah_offline_dead_letter';
const QUEUE_VERSION_KEY = 'neriah_offline_queue_version';
const QUEUE_VERSION = 2;
const MAX_RETRIES = 3;
// Persistent directory under the app's documentDirectory. Captured page
// images get copied here at enqueue time so they survive iOS clearing
// /tmp and /Caches between app launches. Without this, a queued scan
// holds a stale file:// URI by morning and the teacher tap-to-review
// flow shows a blank "Submitted Work" panel.
const QUEUE_PAGES_ROOT = `${FileSystem.documentDirectory}neriah_offline_pages/`;

export interface QueuedScan {
  id: string;
  /** 1-5 page URIs in order. */
  pages: { uri: string }[];
  teacher_id: string;
  student_id: string;
  class_id: string;
  answer_key_id: string;
  education_level: string;
  queued_at: string;
  retry_count: number;
  /**
   * Pre-graded verdicts attached when the teacher graded this submission
   * offline on E2B. When present, replay sends them to /api/mark as
   * `pre_graded_verdicts` and the backend skips its own grading call —
   * the teacher's local verdicts become the canonical Mark.
   *
   * Absent for the queue-then-cloud-grade path (e.g. math-gated
   * submissions, OCR/grading failures, plain network errors during
   * online flow). In those cases the cloud grades from scratch.
   */
  pre_graded_verdicts?: Array<Record<string, unknown>>;
  /**
   * True when the teacher reviewed the on-device grade and tapped Approve
   * before the device went online. Replay forwards this to /api/mark so
   * the cloud creates the Mark with approved=True (no second teacher
   * review needed) and fires the student notification at sync time.
   */
  approved?: boolean;
}

/**
 * Flush the queue once on first launch of a build running schema v2.
 * v1 items (single image_uri) can't be safely upgraded — the file URIs
 * may no longer exist on disk, and the mental model is different. So we
 * drop them and log the count. Teacher re-scans.
 *
 * Call this once on app startup, before any replay.
 */
export const migrateQueueIfNeeded = async (): Promise<{ flushed: number }> => {
  let flushed = 0;
  try {
    const rawVersion = await AsyncStorage.getItem(QUEUE_VERSION_KEY);
    const currentVersion = rawVersion ? parseInt(rawVersion, 10) : 1;
    if (currentVersion >= QUEUE_VERSION) return { flushed: 0 };

    // Stored at v1 (or missing entirely) — count + drop.
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        flushed = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        // Corrupted — treat as drop-and-reset.
        flushed = 0;
      }
      await AsyncStorage.removeItem(QUEUE_KEY);
    }
    await AsyncStorage.setItem(QUEUE_VERSION_KEY, String(QUEUE_VERSION));
    if (flushed > 0) {
      // Visible in Flipper / adb logcat for post-deploy impact checks.
      console.warn(`[offlineQueue] v1→v2 migration flushed ${flushed} pre-multi queued scan(s)`);
    }
  } catch {
    // Best-effort — don't crash app startup over this.
  }
  return { flushed };
};

// ── Page persistence ──────────────────────────────────────────────────────────
//
// Camera + image-picker URIs land in iOS /tmp or /Caches, both of which the
// OS may clear between launches (and definitely clears under memory
// pressure). Copy each captured page into the app's documentDirectory at
// enqueue time so the URI survives across app restarts and tap-to-review
// in HomeworkDetail can still render the submitted work.
//
// Cleanup is best-effort: if the source file is already gone we keep the
// original URI on the queue item rather than block the enqueue (the
// teacher's local grade is still valid for replay even without the page
// images, since pre_graded_verdicts is independent of the file paths).

async function _persistPages(
  queueId: string,
  pages: { uri: string }[],
): Promise<{ uri: string }[]> {
  if (!pages || pages.length === 0) return [];
  const dir = `${QUEUE_PAGES_ROOT}${queueId}/`;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // Directory may already exist or the FS layer is unavailable.
    // Fall through and let copyAsync surface the real error per file.
  }
  const out: { uri: string }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const src = pages[i]?.uri;
    if (!src) continue;
    const ext = (src.match(/\.([a-zA-Z0-9]{2,5})(?:\?.*)?$/)?.[1] || 'jpg').toLowerCase();
    const dest = `${dir}page_${i}.${ext}`;
    try {
      await FileSystem.copyAsync({ from: src, to: dest });
      out.push({ uri: dest });
    } catch {
      // Source already missing or copy failed. Keep the original URI so
      // we don't lose the reference; rendering may show blank but the
      // queue item is still valid for replay.
      out.push({ uri: src });
    }
  }
  return out;
}

async function _cleanupPersistedPages(queueId: string): Promise<void> {
  const dir = `${QUEUE_PAGES_ROOT}${queueId}/`;
  try {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {
    // Best-effort. Stale dirs are harmless beyond a few KB of disk.
  }
}

// ── Queue operations ──────────────────────────────────────────────────────────

export const enqueue = async (
  scan: Omit<QueuedScan, 'id' | 'queued_at' | 'retry_count'>,
): Promise<string> => {
  const queue = await getQueue();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const persistedPages = await _persistPages(id, scan.pages ?? []);
  queue.push({
    ...scan,
    pages: persistedPages.length > 0 ? persistedPages : (scan.pages ?? []),
    id,
    queued_at: new Date().toISOString(),
    retry_count: 0,
  });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  return id;
};

/**
 * Update an already-queued scan in place. Used when the teacher reviewed
 * an on-device grade and tapped Approve before reconnecting — we replace
 * the queued pre_graded_verdicts with the teacher's final (possibly
 * edited) verdicts and set approved=true so replay carries the approval
 * into the cloud Mark in a single round trip.
 *
 * Silent no-op when the id is no longer in the queue (already replayed,
 * dead-lettered, or storage cleared) — the teacher's intent is preserved
 * locally via onDone({approved: true}) regardless.
 */
export const updateQueuedScan = async (
  id: string,
  updates: Partial<Pick<QueuedScan, 'pre_graded_verdicts' | 'approved'>>,
): Promise<boolean> => {
  const queue = await getQueue();
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return false;
  queue[idx] = { ...queue[idx], ...updates };
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  return true;
};

export const getQueue = async (): Promise<QueuedScan[]> => {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
  } catch {
    return [];
  }
};

export const getQueueLength = async (): Promise<number> => {
  const q = await getQueue();
  return q.length;
};

/**
 * Render the offline queue as TeacherSubmission-shaped rows so the teacher's
 * Submissions list can show locally-graded work before cloud sync lands.
 * Only items that carry pre_graded_verdicts surface — bare scans (queued
 * because cloud was unreachable but never graded locally) stay invisible
 * until the cloud actually grades them.
 *
 * The synthesised id is `local_q_<queueId>` so render keys stay stable; the
 * mark_id mirrors that. Score / max_score are derived from the verdicts
 * themselves (already clamped at grade time).
 *
 * Optional filter narrows by class + optional answer_key.
 */
export const getQueueAsSubmissions = async (filter?: {
  class_id?: string;
  answer_key_id?: string;
}): Promise<Array<{
  id: string;
  mark_id: string;
  student_id: string;
  class_id: string;
  answer_key_id: string;
  status: 'graded' | 'approved';
  approved?: boolean;
  submitted_at: string;
  graded_at?: string;
  score?: number;
  max_score?: number;
  marked_image_url?: string;
  source: string;
  pending_sync?: boolean;
}>> => {
  const queue = await getQueue();
  const out = [] as Array<ReturnType<typeof _itemToSubmission>>;
  for (const item of queue) {
    if (!item.pre_graded_verdicts || item.pre_graded_verdicts.length === 0) continue;
    if (filter?.class_id && item.class_id !== filter.class_id) continue;
    if (filter?.answer_key_id && item.answer_key_id !== filter.answer_key_id) continue;
    out.push(_itemToSubmission(item));
  }
  return out;
};

function _itemToSubmission(item: QueuedScan) {
  const score = (item.pre_graded_verdicts ?? [])
    .reduce((s, v) => s + Number((v as { awarded_marks?: unknown }).awarded_marks ?? 0), 0);
  const maxScore = (item.pre_graded_verdicts ?? [])
    .reduce((s, v) => s + Number((v as { max_marks?: unknown }).max_marks ?? 0), 0);
  return {
    id: `local_q_${item.id}`,
    mark_id: `local_q_${item.id}`,
    student_id: item.student_id,
    class_id: item.class_id,
    answer_key_id: item.answer_key_id,
    status: (item.approved ? 'approved' : 'graded') as 'graded' | 'approved',
    approved: !!item.approved,
    submitted_at: item.queued_at,
    graded_at: item.queued_at,
    score,
    max_score: maxScore,
    marked_image_url: item.pages?.[0]?.uri,
    source: 'teacher_scan_offline',
    pending_sync: true,
  };
}

const _saveQueue = (queue: QueuedScan[]) =>
  AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

export const removeFromQueue = async (id: string): Promise<void> => {
  const queue = await getQueue();
  await _saveQueue(queue.filter((item) => item.id !== id));
  // Drop the persisted page directory too so we don't leak a few MB of
  // image data per replayed/deleted scan in documentDirectory.
  await _cleanupPersistedPages(id);
};

export const clearQueue = async (): Promise<void> => {
  await AsyncStorage.removeItem(QUEUE_KEY);
};

export const clearDeadLetter = async (): Promise<void> => {
  await AsyncStorage.removeItem(DEAD_LETTER_KEY);
};

// ── Dead letter ───────────────────────────────────────────────────────────────

const _moveToDeadLetter = async (item: QueuedScan, reason: string): Promise<void> => {
  try {
    const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
    const dead: Array<QueuedScan & { failed_at: string; reason: string }> = raw
      ? JSON.parse(raw)
      : [];
    dead.push({ ...item, failed_at: new Date().toISOString(), reason });
    await AsyncStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead));
  } catch {
    // Best-effort
  }
};

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Attempt to re-submit all queued scans.
 * Called automatically when network connectivity is restored.
 * Items that fail permanently (retry_count >= MAX_RETRIES) are moved to dead letter.
 */
export const replayQueue = async (): Promise<{ submitted: number; failed: number }> => {
  const queue = await getQueue();
  if (queue.length === 0) return { submitted: 0, failed: 0 };

  let submitted = 0;
  let failed = 0;
  const remaining: QueuedScan[] = [];

  for (const item of queue) {
    if (item.retry_count >= MAX_RETRIES) {
      await _moveToDeadLetter(item, 'Max retries exceeded');
      await _cleanupPersistedPages(item.id);
      failed++;
      continue;
    }

    try {
      await submitTeacherScan({
        teacherId: item.teacher_id,
        studentId: item.student_id,
        classId: item.class_id,
        answerKeyId: item.answer_key_id,
        educationLevel: item.education_level,
        pages: item.pages,
        // Forward pre-graded verdicts when the queued item carries them.
        // Backend then skips its own grading call and persists ours.
        preGradedVerdicts: item.pre_graded_verdicts,
        // Forward the teacher's offline approval. When true, the cloud
        // Mark is created with approved=True and the student is notified
        // immediately on replay — no second review pass needed.
        approved: item.approved,
      });
      submitted++;
      // Successfully submitted — drop the persisted page dir so we
      // don't leak disk for items the cloud now owns.
      await _cleanupPersistedPages(item.id);
    } catch (err: any) {
      const status: number = err.response?.status ?? 0;
      // 4xx client errors won't succeed on retry — move to dead letter
      if (status >= 400 && status < 500) {
        await _moveToDeadLetter(item, `Client error ${status}`);
        await _cleanupPersistedPages(item.id);
        failed++;
      } else {
        // Network/server error — increment retry and keep in queue
        remaining.push({ ...item, retry_count: item.retry_count + 1 });
      }
    }
  }

  await _saveQueue(remaining);
  return { submitted, failed };
};

// ── Network listener ──────────────────────────────────────────────────────────

/**
 * Start watching for connectivity changes.
 * When the connection is restored, replayQueue() is called automatically.
 * Returns an unsubscribe function — call it in your useEffect cleanup.
 */
export const startNetworkListener = (): (() => void) => {
  let wasOffline = false;

  const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
    const isConnected = state.isConnected ?? false;
    if (!isConnected) {
      wasOffline = true;
    } else if (wasOffline && isConnected) {
      wasOffline = false;
      replayQueue().catch(() => {
        // Replay is best-effort; errors are non-critical
      });
    }
  });

  return unsubscribe;
};
