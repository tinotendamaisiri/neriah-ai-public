// src/services/playSync.ts
//
// Promote on-device-only Play lessons (those built via the LiteRT path
// while the student was offline, stored in playLocalStore with a
// `local_*` id) to the cloud the moment connectivity returns.
//
// One-shot fire on the online edge — the App component subscribes to
// NetInfo and calls syncLocalLessonsToCloud() whenever the device
// transitions to "connected with internet reachable".
//
// Idempotent: if a local lesson upload fails, the local copy stays
// put and the next online edge retries. Successful uploads delete
// the local copy and prime the cloud-lesson cache so the student can
// still play the now-cloud lesson if they go offline again.

import type { AxiosResponse } from 'axios';
import { client } from './api';
import {
  deleteLocalLesson,
  isLocalLessonId,
  listLocalLessons,
} from './playLocalStore';
import { cacheCloudLesson } from './playLessonCache';
import { track, trackError } from './analytics';
import type { PlayLesson } from '../play/types';

let _runInFlight = false;

interface ImportResponse extends PlayLesson {}

/**
 * Push every locally-stored Play lesson to the cloud and remove the
 * local copy on success. Safe to call repeatedly — guarded against
 * concurrent runs.
 */
export async function syncLocalLessonsToCloud(): Promise<void> {
  if (_runInFlight) return;
  _runInFlight = true;
  try {
    const local = await listLocalLessons();
    if (local.length === 0) return;
    track('play.sync.local_to_cloud.start', { count: local.length });

    let uploaded = 0;
    let failed = 0;
    for (const lesson of local) {
      if (!isLocalLessonId(lesson.id)) continue; // safety
      try {
        const res: AxiosResponse<ImportResponse> = await client.post(
          '/play/lessons/import',
          {
            title: lesson.title,
            subject: lesson.subject ?? undefined,
            grade: lesson.grade ?? undefined,
            source_content: lesson.source_content ?? '',
            questions: lesson.questions,
            was_expanded: !!lesson.was_expanded,
          },
          { timeout: 30000 },
        );
        const cloudLesson = res.data;
        // Cache the new cloud copy so an immediate offline replay still
        // works even before the next library fetch.
        await cacheCloudLesson(cloudLesson);
        // Then drop the local original — the cloud row is now the
        // canonical source.
        await deleteLocalLesson(lesson.id);
        uploaded += 1;
      } catch (err) {
        failed += 1;
        trackError('play.sync.local_to_cloud.item_failed', err, {
          local_id: lesson.id,
        });
        // Keep the local lesson around — next online edge retries.
      }
    }
    track('play.sync.local_to_cloud.done', {
      uploaded,
      failed,
      total: local.length,
    });
  } finally {
    _runInFlight = false;
  }
}
