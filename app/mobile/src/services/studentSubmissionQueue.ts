// src/services/studentSubmissionQueue.ts
// Offline queue for student submissions made via the App channel.
//
// When the student taps "Submit via App" without connectivity (or the
// upload itself fails because the device is offline), we queue the
// submission locally instead of bouncing the student off the screen
// with "No connection". On the next online edge the queue replays and
// each item is sent to POST /api/submissions/student exactly the same
// way an online submission would be — backend doesn't need to know the
// difference.
//
// This is the student-side mirror of offlineQueue.ts (teacher scans).
// Same persistence story: page URIs from the camera land in iOS /tmp
// or /Caches and the OS may clear them between launches, so we copy
// each page into documentDirectory at enqueue and clean it up on
// successful replay / dead-letter / manual remove.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { submitStudentWork } from './api';

const QUEUE_KEY        = 'neriah_student_submission_queue';
const DEAD_LETTER_KEY  = 'neriah_student_submission_dead_letter';
const MAX_RETRIES      = 3;
const QUEUE_PAGES_ROOT = `${FileSystem.documentDirectory}neriah_student_submission_pages/`;

export interface QueuedStudentSubmission {
  id:             string;
  student_id:     string;
  class_id:       string;
  answer_key_id:  string;
  pages:          { uri: string }[];
  queued_at:      string;
  retry_count:    number;
  /** Echoed to the backend; the existing single-file flow uses 'app'. */
  source:         'app';
}

// ── Persistence helpers ───────────────────────────────────────────────────────

async function _persistPages(
  queueId: string,
  pages: { uri: string }[],
): Promise<{ uri: string }[]> {
  if (!pages || pages.length === 0) return [];
  const dir = `${QUEUE_PAGES_ROOT}${queueId}/`;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    /* dir may already exist; copyAsync surfaces real errors per file */
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
      // Source already gone or copy failed — fall back to the raw URI
      // so we don't lose the reference; replay will fail and item ends
      // up in dead-letter, which is the same outcome as before this
      // queue existed.
      out.push({ uri: src });
    }
  }
  return out;
}

async function _cleanupPersistedPages(queueId: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(`${QUEUE_PAGES_ROOT}${queueId}/`, { idempotent: true });
  } catch {
    /* best-effort */
  }
}

// ── Queue ops ─────────────────────────────────────────────────────────────────

const _readQueue = async (): Promise<QueuedStudentSubmission[]> => {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedStudentSubmission[]) : [];
  } catch {
    return [];
  }
};

const _saveQueue = (queue: QueuedStudentSubmission[]) =>
  AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

export const getQueue = _readQueue;

export const getQueueLength = async (): Promise<number> => {
  const q = await _readQueue();
  return q.length;
};

export const enqueue = async (
  payload: Omit<QueuedStudentSubmission, 'id' | 'queued_at' | 'retry_count'>,
): Promise<string> => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const persistedPages = await _persistPages(id, payload.pages ?? []);
  const queue = await _readQueue();
  queue.push({
    ...payload,
    pages: persistedPages.length > 0 ? persistedPages : (payload.pages ?? []),
    id,
    queued_at: new Date().toISOString(),
    retry_count: 0,
  });
  await _saveQueue(queue);
  return id;
};

export const removeFromQueue = async (id: string): Promise<void> => {
  const queue = await _readQueue();
  await _saveQueue(queue.filter((q) => q.id !== id));
  await _cleanupPersistedPages(id);
};

export const clearQueue = async (): Promise<void> => {
  await AsyncStorage.removeItem(QUEUE_KEY);
};

// ── Dead letter ───────────────────────────────────────────────────────────────

const _moveToDeadLetter = async (
  item: QueuedStudentSubmission,
  reason: string,
): Promise<void> => {
  try {
    const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
    const dead: Array<QueuedStudentSubmission & { failed_at: string; reason: string }> = raw
      ? JSON.parse(raw)
      : [];
    dead.push({ ...item, failed_at: new Date().toISOString(), reason });
    await AsyncStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead));
  } catch {
    /* best-effort */
  }
};

// ── Replay ────────────────────────────────────────────────────────────────────
//
// Send each queued submission to POST /api/submissions/student via
// submitStudentWork. Same retry / dead-letter / cleanup discipline as
// the teacher offline queue. Called from NetworkBanner (manual) and
// useSyncCoordinator (auto on online edge).

export const replayQueue = async (): Promise<{ submitted: number; failed: number }> => {
  const queue = await _readQueue();
  if (queue.length === 0) return { submitted: 0, failed: 0 };

  let submitted = 0;
  let failed = 0;
  const remaining: QueuedStudentSubmission[] = [];

  for (const item of queue) {
    if (item.retry_count >= MAX_RETRIES) {
      await _moveToDeadLetter(item, 'Max retries exceeded');
      await _cleanupPersistedPages(item.id);
      failed++;
      continue;
    }

    try {
      const fd = new FormData();
      fd.append('student_id',     item.student_id);
      fd.append('class_id',       item.class_id);
      fd.append('answer_key_id',  item.answer_key_id);
      fd.append('source',         item.source);
      item.pages.forEach((p, i) => {
        fd.append('images', {
          uri:  p.uri,
          name: `page_${i + 1}.jpg`,
          type: 'image/jpeg',
        } as unknown as Blob);
      });
      await submitStudentWork(fd);
      submitted++;
      await _cleanupPersistedPages(item.id);
    } catch (err: any) {
      const status: number = err?.response?.status ?? err?.status ?? 0;
      // 4xx (auth, validation, duplicate submission) won't recover on
      // retry — move to dead-letter so the queue drains.
      if (status >= 400 && status < 500) {
        await _moveToDeadLetter(item, `Client error ${status}`);
        await _cleanupPersistedPages(item.id);
        failed++;
      } else {
        // Network / server / 5xx — keep the item with a retry bump.
        remaining.push({ ...item, retry_count: item.retry_count + 1 });
      }
    }
  }

  await _saveQueue(remaining);
  return { submitted, failed };
};
