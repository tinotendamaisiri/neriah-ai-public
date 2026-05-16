// src/play/types.ts
//
// Shared types for the Neriah Play surface (gamified study mini-games for
// students). Mirrors the backend Pydantic models for `play_lessons` and
// `play_sessions`. Question shape stays small and self-contained — no
// references to subject/grade enums elsewhere in the app, those are
// strings here so on-device generation can stamp whatever the model
// produces without enum-mismatch loss.

export type GameFormat = 'lane_runner' | 'stacker' | 'blaster' | 'snake';

export interface PlayQuestion {
  /** Stem text. Capped to 80 chars (truncated at word boundary if longer). */
  prompt: string;
  /** Exactly four answer options. Each capped to 25 chars. */
  options: string[];
  /** Index (0..3) of the correct option in `options`. */
  correct: number;
}

export interface PlayLesson {
  id: string;
  title: string;
  subject: string | null;
  grade: string | null;
  owner_id: string;
  question_count: number;
  /** True when the generator auto-augmented broader-topic questions
   *  because the supplied notes were too sparse for a full bank. */
  was_expanded?: boolean;
  /** Async-generation lifecycle. New lessons are returned with
   *  status='generating' from POST /play/lessons; the mobile polls
   *  GET /play/lessons/<id> until status flips to 'ready' (worker
   *  succeeded) or 'failed' (worker hit safety valve / crashed —
   *  read `error_message`). Legacy rows default to 'ready'. */
  status?: 'generating' | 'ready' | 'failed';
  error_message?: string | null;
  /** ISO timestamp. */
  created_at: string;
  shared_with_class: boolean;
  allow_copying: boolean;
  class_id: string | null;
  /**
   * Backend-tagged origin so the library UI can colour-code each card:
   *   'mine'   — owned by the current student
   *   'class'  — class-shared by a classmate or teacher (student is enrolled)
   *   'shared' — copied from another student's shared lesson (future state)
   */
  origin?: 'mine' | 'class' | 'shared';
  /** Only present when the API returned the full lesson detail. */
  questions?: PlayQuestion[];
  /** Original notes / OCR text the lesson was generated from. */
  source_content?: string;
}

export interface SessionResult {
  lesson_id: string;
  game_format: GameFormat;
  duration_seconds: number;
  final_score: number;
  questions_attempted: number;
  questions_correct: number;
  /** e.g. 'three_lives_lost', 'tower_collapsed', 'asteroid_hit', 'self_collision', 'completed', 'quit'. */
  end_reason: string;
}

// ── Navigation ────────────────────────────────────────────────────────────────

export type PlayStackParamList = {
  PlayLibrary: undefined;
  PlayBuild: undefined;
  PlayBuildProgress: {
    /** Offline / on-device generation task id (drives lessonGenerator). */
    taskId?: string;
    /** Cloud-side lesson id — when set, the screen polls
     *  GET /play/lessons/<id> until status='ready' instead of running
     *  the on-device generator. Set by PlayBuildScreen after the
     *  POST /play/lessons fire-and-forget create. */
    cloudLessonId?: string;
  };
  PlayPreview: { lessonId: string; wasExpanded?: boolean };
  PlayGame: { lessonId: string; format: GameFormat };
  PlaySessionEnd: { sessionResult: SessionResult; lessonId: string };
  PlayShare: { lessonId: string };
};
