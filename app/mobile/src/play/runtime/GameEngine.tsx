// src/play/runtime/GameEngine.tsx
//
// Top-level shell for a Neriah Play session. Owns:
//   - score (starts at 5 for lane_runner so the score=0 loss has buffer,
//     0 for the others)
//   - question shuffling & sequencing
//   - speedMultiplier — bidirectional: ×1.05 on correct, ×0.95 on wrong,
//     clamped to [0.5, 2.5], reset to 1.0 at session start
//   - pause state (button + system back hardware key)
//   - SessionResult construction on loss / quit / completion
//   - cross-fade between question banners
//   - per-letter flash on the AnswerGrid
//
// The engine routes the chosen game format to the matching scene. The
// scene reports player taps via `onAnswer(letter)` and fatal loss via
// `onLoss(reason)`. The engine ALSO drives a visual loss path for the
// LaneRunner-style "score-zero" rule by passing a `loseSignal` prop into
// the scene — the scene runs its own fade and then calls onLoss.
//
// The AnswerGrid below the canvas exists primarily as a HUD reference;
// when the player taps the grid, the engine forwards that tap to the
// active scene's onAnswer pipeline (treats it like the scene called
// onAnswer itself). Some scenes also call onAnswer from the canvas
// (e.g. when a falling block lands in a bin).

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  StyleSheet,
  Text,
  View,
  LayoutChangeEvent,
} from 'react-native';
import { track, trackError, trackScreen } from '../../services/analytics';
import type { GameFormat, PlayLesson, PlayQuestion, SessionResult } from '../types';
import AnswerGrid from './AnswerGrid';
import HUD from './HUD';
import PauseOverlay from './PauseOverlay';
import QuestionBanner from './QuestionBanner';
import LaneRunnerScene from './scenes/LaneRunnerScene';
import StackerScene from './scenes/StackerScene';
import BlasterScene from './scenes/BlasterScene';
import SnakeScene from './scenes/SnakeScene';
import type { AnswerLetter, HUDHints } from './types';

interface Props {
  lesson: PlayLesson;
  format: GameFormat;
  onSessionEnd: (result: SessionResult) => void;
}

const STARTING_SCORE: Record<GameFormat, number> = {
  lane_runner: 5, // buffer so score → 0 is the loss condition
  stacker: 0,
  blaster: 0,
  snake: 0,
};

const SPEED_MAX = 2.5;
const SPEED_MIN = 0.5;
const SPEED_STEP_UP = 1.05;     // ×1.05 on each correct
// Wrong answers no longer slow the game down. The user wanted: start
// slow, speed up on correct, stay at the current speed on wrong. So
// SPEED_STEP_DOWN is kept as a constant for symmetry (and in case we
// want to bring the slowdown back) but it is NOT applied in
// handleAnswer.
const SPEED_STEP_DOWN = 0.95;
const FLASH_MS = 220;
const BANNER_FADE_MS = 150;

const GameEngine: React.FC<Props> = ({ lesson, format, onSessionEnd }) => {
  // ── Question pool ──
  // Defensive validation. A malformed question (missing options,
  // bad correct index, undefined fields) reaching Skia / a scene
  // can cascade into a native crash, not a JS error: state updates
  // happen each frame and one NaN deep in the math is enough to
  // panic the canvas. Reject anything that doesn't match the
  // PlayQuestion contract before it gets near the engine state.
  const questions: PlayQuestion[] = useMemo(() => {
    const all = (lesson.questions ?? []).filter((q) => {
      if (!q || typeof q !== 'object') return false;
      if (typeof q.prompt !== 'string' || q.prompt.length === 0) return false;
      if (!Array.isArray(q.options) || q.options.length !== 4) return false;
      if (q.options.some((o) => typeof o !== 'string' || o.length === 0)) {
        return false;
      }
      if (
        typeof q.correct !== 'number' ||
        Number.isNaN(q.correct) ||
        q.correct < 0 ||
        q.correct > 3
      ) {
        return false;
      }
      return true;
    });
    const copy = [...all];
    // Fisher-Yates shuffle
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }, [lesson.questions]);

  const totalQuestions = questions.length;

  // If validation rejected every question (truly broken row), bail with
  // a friendly screen rather than crashing the canvas on undefined state.
  // PlayGameScreen also guards on lesson.questions.length, but a row
  // with 100 malformed entries would slip past that filter.
  if (totalQuestions === 0) {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        <Text style={{ color: '#fff', fontFamily: 'Georgia', fontSize: 16, textAlign: 'center' }}>
          This game has no valid questions. Please make a new one.
        </Text>
      </View>
    );
  }

  // ── Session state ──
  const [score, setScore] = useState<number>(STARTING_SCORE[format]);
  const [questionIndex, setQuestionIndex] = useState<number>(0);
  const [questionsAttempted, setQuestionsAttempted] = useState<number>(0);
  const [questionsCorrect, setQuestionsCorrect] = useState<number>(0);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1.0);
  const [paused, setPaused] = useState<boolean>(false);
  const [hudHints, setHudHints] = useState<HUDHints>({});

  // ── Flash + fade animation state ──
  const [flashLetter, setFlashLetter] = useState<AnswerLetter | null>(null);
  const [flashKind, setFlashKind] = useState<'correct' | 'wrong' | null>(null);
  const [answerLocked, setAnswerLocked] = useState<boolean>(false);
  const bannerOpacity = useRef(new Animated.Value(1)).current;

  // ── Loss signaling ──
  const [loseSignal, setLoseSignal] = useState<boolean>(false);
  const [wrongAnswerTick, setWrongAnswerTick] = useState<number>(0);
  const [correctAnswerTick, setCorrectAnswerTick] = useState<number>(0);
  const sessionEndedRef = useRef<boolean>(false);
  const startedAtRef = useRef<Date>(new Date());

  // ── Layout for scene canvas ──
  const [sceneSize, setSceneSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  // Track session start once
  useEffect(() => {
    startedAtRef.current = new Date();
    try {
      trackScreen('play.game', { lesson_id: lesson.id, format });
      track('play.session.start', {
        lesson_id: lesson.id,
        format,
        question_count: totalQuestions,
      });
    } catch (e) {
      trackError('play.session.start.error', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // System back (hardware key OR Android 10+ edge-swipe back gesture)
  // → open the pause overlay. The handler is registered ONCE with
  // empty deps so there's no remove/re-add gap when `paused` flips —
  // a back event landing during the gap would otherwise pop the screen
  // and exit the game. Mutable state is read through refs.
  const pausedRef = useRef<boolean>(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sessionEndedRef.current) return false;
      if (!pausedRef.current) {
        setPaused(true);
        return true;
      }
      // already paused → consume too; user uses Resume / Quit buttons
      return true;
    });
    return () => sub.remove();
  }, []);

  // ── Helpers ──
  const buildSessionResult = useCallback(
    (endReason: SessionResult['end_reason']): SessionResult => {
      const durationSeconds = Math.max(
        0,
        Math.round((Date.now() - startedAtRef.current.getTime()) / 1000),
      );
      return {
        lesson_id: lesson.id,
        game_format: format,
        duration_seconds: durationSeconds,
        final_score: score,
        questions_attempted: questionsAttempted,
        questions_correct: questionsCorrect,
        end_reason: endReason,
      };
    },
    [
      lesson.id,
      format,
      score,
      questionsAttempted,
      questionsCorrect,
    ],
  );

  const fireSessionEnd = useCallback(
    (endReason: SessionResult['end_reason']) => {
      if (sessionEndedRef.current) return;
      sessionEndedRef.current = true;
      const result = buildSessionResult(endReason);
      try {
        track('play.session.end', {
          lesson_id: lesson.id,
          format,
          end_reason: endReason,
          final_score: result.final_score,
          questions_attempted: result.questions_attempted,
          questions_correct: result.questions_correct,
          duration_seconds: result.duration_seconds,
        });
      } catch (e) {
        trackError('play.session.end.error', e);
      }
      onSessionEnd(result);
    },
    [buildSessionResult, format, lesson.id, onSessionEnd],
  );

  // ── Answer handling ──
  const handleAnswer = useCallback(
    (letter: AnswerLetter) => {
      if (sessionEndedRef.current) return;
      if (answerLocked) return;
      if (paused) return;
      const current = questions[questionIndex];
      if (!current) return;

      const correctIndex = current.correct;
      const correctLetter: AnswerLetter = (['A', 'B', 'C', 'D'] as AnswerLetter[])[
        correctIndex
      ];
      const isCorrect = letter === correctLetter;

      setAnswerLocked(true);
      setFlashLetter(letter);
      setFlashKind(isCorrect ? 'correct' : 'wrong');

      // Score update + bidirectional speed scaling.
      let newScore = score;
      if (isCorrect) {
        newScore = score + 2;
        setScore(newScore);
        setQuestionsCorrect((c) => c + 1);
        setSpeedMultiplier((s) => Math.min(SPEED_MAX, s * SPEED_STEP_UP));
        setCorrectAnswerTick((t) => t + 1);
      } else {
        // Wrong answers are now neutral: no score change, no speed
        // change. Per the user's design, "correct rewards points,
        // wrong has no reward". The per-format loss conditions
        // (lane runner: 3 wrongs in a row, stacker: bins overflow,
        // blaster: invader breach / health 0, snake: collision /
        // length 0) are what end the run.
        // newScore stays = score
        setWrongAnswerTick((t) => t + 1);
      }
      setQuestionsAttempted((n) => n + 1);

      try {
        track('play.game.answer', {
          lesson_id: lesson.id,
          format,
          question_index: questionIndex,
          letter,
          correct: isCorrect,
          score_after: newScore,
        });
        const nextIndex = questionIndex + 1;
        if (nextIndex > 0 && nextIndex % 5 === 0) {
          track('play.game.checkpoint', {
            questionIndex: nextIndex,
            score: newScore,
          });
        }
      } catch (e) {
        trackError('play.game.answer.error', e);
      }

      // After flash window: cross-fade banner & advance question
      setTimeout(() => {
        // Cross-fade out
        Animated.timing(bannerOpacity, {
          toValue: 0,
          duration: BANNER_FADE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start(() => {
          // Advance index
          let nextIdx = questionIndex + 1;
          if (nextIdx >= totalQuestions) {
            // Wrap or complete? The lesson set is large but we still allow
            // wrapping so loops never starve. The "completed" end reason is
            // still possible if the engine detects all questions answered.
            // For now: wrap.
            nextIdx = 0;
          }
          setQuestionIndex(nextIdx);
          // Cross-fade in
          Animated.timing(bannerOpacity, {
            toValue: 1,
            duration: BANNER_FADE_MS,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }).start();
          setFlashLetter(null);
          setFlashKind(null);
          setAnswerLocked(false);
        });

        // Lane runner now uses the wrong-streak loss inside the scene
        // (3 consecutive wrongs). The old score-zero path is dead with
        // the no-deduct rule, so loseSignal stays unset here.
      }, FLASH_MS);
    },
    [
      answerLocked,
      bannerOpacity,
      format,
      lesson.id,
      paused,
      questionIndex,
      questions,
      score,
      totalQuestions,
    ],
  );

  // Scene loss
  const handleSceneLoss = useCallback(
    (reason: string) => {
      if (sessionEndedRef.current) return;
      try {
        track('play.game.loss', {
          lesson_id: lesson.id,
          format,
          reason,
          score,
          question_index: questionIndex,
        });
      } catch (e) {
        trackError('play.game.loss.error', e);
      }
      // SessionResult requires one of the well-known end_reasons; loss
      // always maps to 'loss_condition'. The granular reason rides in the
      // analytics payload above.
      fireSessionEnd('loss_condition');
    },
    [fireSessionEnd, format, lesson.id, questionIndex, score],
  );

  // Pause / resume / quit
  const handlePause = useCallback(() => {
    setPaused(true);
    track('play.game.pause.open');
  }, []);
  const handleResume = useCallback(() => {
    setPaused(false);
    track('play.game.pause.resume');
  }, []);
  const handleQuit = useCallback(() => {
    track('play.game.quit', {
      lesson_id: lesson.id,
      format,
      score,
      question_index: questionIndex,
    });
    fireSessionEnd('quit');
  }, [fireSessionEnd, format, lesson.id, questionIndex, score]);

  // Layout for scene canvas
  const onSceneLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setSceneSize({ w: Math.round(width), h: Math.round(height) });
    }
  }, []);

  // HUD hints sink for scenes
  const hudHintsCallback = useCallback((h: HUDHints) => {
    setHudHints((prev) => {
      // Avoid useless re-renders
      if (
        prev.health === h.health &&
        prev.lengthRemaining === h.lengthRemaining &&
        prev.binRowOffset === h.binRowOffset
      ) {
        return prev;
      }
      return { ...prev, ...h };
    });
  }, []);

  // ── Render ──
  const currentQuestion = questions[questionIndex];

  // No questions in lesson → end immediately as completed (must run as a
  // hook unconditionally).
  useEffect(() => {
    if (totalQuestions === 0 && !sessionEndedRef.current) {
      fireSessionEnd('completed');
    }
  }, [totalQuestions, fireSessionEnd]);

  if (!currentQuestion) {
    return <View style={styles.root} />;
  }

  const sceneCommonProps = {
    currentQuestion,
    questionIndex,
    speedMultiplier,
    paused,
    onAnswer: handleAnswer,
    onLoss: handleSceneLoss,
    onHudHintsChange: hudHintsCallback,
    width: sceneSize.w,
    height: sceneSize.h,
  };

  return (
    <View style={styles.root}>
      <HUD
        format={format}
        score={score}
        questionIndex={questionIndex}
        total={totalQuestions}
        onPause={handlePause}
        hints={hudHints}
      />

      <Animated.View style={{ opacity: bannerOpacity }}>
        <QuestionBanner
          prompt={currentQuestion.prompt}
          questionIndex={questionIndex}
          total={totalQuestions}
        />
      </Animated.View>

      <AnswerGrid
        options={currentQuestion.options}
        onAnswer={handleAnswer}
        flashLetter={flashLetter}
        flashKind={flashKind}
        disabled={answerLocked || paused}
      />

      <View style={styles.sceneHost} onLayout={onSceneLayout}>
        {sceneSize.w > 0 && sceneSize.h > 0 ? (
          <>
            {format === 'lane_runner' ? (
              <LaneRunnerScene
                {...sceneCommonProps}
                loseSignal={loseSignal}
                wrongAnswerTick={wrongAnswerTick}
                correctAnswerTick={correctAnswerTick}
              />
            ) : null}
            {format === 'stacker' ? (
              <StackerScene
                {...sceneCommonProps}
                wrongAnswerTick={wrongAnswerTick}
              />
            ) : null}
            {format === 'blaster' ? (
              <BlasterScene
                {...sceneCommonProps}
                wrongAnswerTick={wrongAnswerTick}
                correctAnswerTick={correctAnswerTick}
              />
            ) : null}
            {format === 'snake' ? (
              <SnakeScene
                {...sceneCommonProps}
                wrongAnswerTick={wrongAnswerTick}
                correctAnswerTick={correctAnswerTick}
              />
            ) : null}
          </>
        ) : null}
      </View>

      <PauseOverlay
        visible={paused}
        onResume={handleResume}
        onQuit={handleQuit}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#04342C',
  },
  sceneHost: {
    flex: 1,
    overflow: 'hidden',
  },
});

export default GameEngine;
