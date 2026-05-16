// src/play/runtime/types.ts
//
// Internal contract between the GameEngine shell and the four playable
// scenes (LaneRunner, Stacker, Blaster, Snake). The engine owns score,
// question sequencing, and pause state; the scene owns the gameplay
// canvas, input handling, and loss detection. The scene reports the
// player's chosen answer letter back through `onAnswer` and a fatal
// game state through `onLoss(reason)`. The reason string surfaces in
// SessionResult.end_reason for analytics.

import type { PlayQuestion } from '../types';

export type AnswerLetter = 'A' | 'B' | 'C' | 'D';

/** Optional state hints surfaced to the HUD by the active scene. */
export interface HUDHints {
  /** 0..N segments remaining (Blaster). */
  health?: number;
  /** Snake body length (Snake). */
  lengthRemaining?: number;
  /** Number of rows the bin row has been pushed up by (Stacker). */
  binRowOffset?: number;
}

export interface SceneProps {
  /** Active question — already shuffled and selected by the engine. */
  currentQuestion: PlayQuestion;
  /** 0-based index in the active session. */
  questionIndex: number;
  /** 1.0 baseline. Engine bumps this up by ~4% per correct answer, capped. */
  speedMultiplier: number;
  /** When true, the scene must freeze its game loop. */
  paused: boolean;
  /** Scene → engine: player picked a letter. */
  onAnswer: (letter: AnswerLetter) => void;
  /** Scene → engine: gameplay loss with a short reason code. */
  onLoss: (reason: string) => void;
  /** Optional: scene → engine HUD state pipe. Engine reads these to render
   *  health bars, length counters, etc. The engine passes a callback the
   *  scene calls inside its render loop; we model it as a pull-prop here
   *  so the scene reports state by calling `onHudHintsChange`. */
  onHudHintsChange?: (hints: HUDHints) => void;
  /** Container width in px. Scenes that draw with Skia rely on this. */
  width: number;
  /** Container height in px. */
  height: number;
}
