// src/services/play.ts
// Typed REST client for the Neriah Play backend (gamified study mini-games).
//
// All calls go through the shared axios `client` from api.ts so they pick up
// JWT auth, the route-key trace headers, and the same offline error mapping
// the rest of the app uses. Long timeout on createLesson — the user-facing
// promise is "your lesson becomes a game in under 5 minutes" so we wait
// 320 s (matches the 300 s Cloud Function timeout + 20 s margin so the
// backend's 503 always wins over a client-side timeout).

import type { AxiosResponse } from 'axios';
import { client } from './api';
import type { PlayLesson, PlayQuestion, SessionResult } from '../play/types';

// ── Generation timeouts ──────────────────────────────────────────────────────
//
// Cloud Function timeout is 540s and the gemma_client request timeout is
// 240s, so 180s here gives the request room to complete without the mobile
// axios bailing first. Same reasoning as /tutor/chat.
const GEN_TIMEOUT = 320000;

export interface CreateLessonInput {
  title: string;
  source_content: string;
  subject?: string;
  grade?: string;
}

export interface PlayLessonStats {
  best_score: number;
  last_played: string | null;
  total_sessions: number;
}

export const playApi = {
  /**
   * Cloud-side lesson generation. Backend cleans the source content, runs
   * the three-tier Gemma 4 escalation, dedupes (semantic + hash), validates,
   * and persists exactly 100 questions. Returns the full PlayLesson on
   * success. When the generator falls short the route returns 503 — there
   * is no draft state, no expand/append fallback flow.
   */
  createLesson: async (data: CreateLessonInput): Promise<PlayLesson> => {
    const res: AxiosResponse<PlayLesson> = await client.post('/play/lessons', data, {
      timeout: GEN_TIMEOUT,
    });
    return res.data;
  },

  /**
   * Lessons the student can see: own + shared-by-class + copied. Backend
   * tags `origin` on each so the library UI can filter + colour-code.
   */
  listLessons: async (): Promise<PlayLesson[]> => {
    const res: AxiosResponse<PlayLesson[]> = await client.get('/play/lessons');
    return res.data ?? [];
  },

  getLesson: async (id: string): Promise<PlayLesson> => {
    const res: AxiosResponse<PlayLesson> = await client.get(`/play/lessons/${id}`);
    return res.data;
  },

  deleteLesson: async (id: string): Promise<void> => {
    await client.delete(`/play/lessons/${id}`);
  },

  /**
   * Toggle "share with class" + "allow copying" flags. `class_id` is
   * required when shared_with_class is true so the backend knows which
   * roster gets read access.
   */
  updateSharing: async (
    id: string,
    shared_with_class: boolean,
    allow_copying: boolean,
    class_id?: string,
  ): Promise<PlayLesson> => {
    const res: AxiosResponse<PlayLesson> = await client.put(
      `/play/lessons/${id}/sharing`,
      {
        shared_with_class,
        allow_copying,
        ...(class_id ? { class_id } : {}),
      },
    );
    return res.data;
  },

  /**
   * Persist a finished session. Fire-and-forget from the caller's POV — we
   * still surface errors so the screen can decide whether to retry.
   */
  logSession: async (
    session: SessionResult & { started_at: string; ended_at: string },
  ): Promise<void> => {
    await client.post('/play/sessions', session);
  },

  /** Best score / last played / count for the lesson card stats strip. */
  getLessonStats: async (id: string): Promise<PlayLessonStats> => {
    const res: AxiosResponse<PlayLessonStats> = await client.get(
      `/play/lessons/${id}/stats`,
    );
    return res.data;
  },
};

// ── Types re-exported for convenience ────────────────────────────────────────

export type { PlayLesson, PlayQuestion, SessionResult };
