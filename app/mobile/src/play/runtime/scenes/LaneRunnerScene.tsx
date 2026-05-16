// src/play/runtime/scenes/LaneRunnerScene.tsx
//
// Four-lane endless runner. Lanes laid out with pseudo-3D perspective
// (top converges toward a horizon, bottom spans the runner row). Road
// strips alternate shading and scroll toward the runner; white edges
// frame the road; yellow dashed dividers separate the four lanes.
//
// The runner is a hand-drawn stick figure (round head with glasses,
// smile, hair tuft) with a continuous arm + leg gait (~300ms cycle).
//
// Gameplay matches the rest of Neriah Play: a "checkpoint line" sweeps
// from the horizon down toward the runner; when it reaches the runner
// the lane the runner is in becomes the picked letter and onAnswer
// fires. The player swipes left/right to change lanes; an upward swipe
// commits early (immediately resolves to the current lane).
//
// Loss: scene reports loss via `onLoss('score_zero')` when the engine
// sets `loseSignal=true` (engine drives this — score=0 trips it).
//
// Onboarding hint (Wi-fi-grade unstable network → AsyncStorage flag is
// best-effort) shows once per device on first play and explains the
// gestures. Dismisses on tap or after 4 s.

import {
  Canvas,
  Circle,
  Group,
  Path,
  Rect,
  Skia,
} from '@shopify/react-native-skia';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import type { AnswerLetter, SceneProps } from '../types';

// ── Tunables ────────────────────────────────────────────────────────────────

const LANE_COLORS = ['#0D7377', '#085041', '#3AAFA9', '#9FE1CB'];
const LETTER_BY_LANE: AnswerLetter[] = ['A', 'B', 'C', 'D'];

const BASE_SWEEP_SECONDS = 6.0;     // checkpoint horizon → runner. Picked to
                                    // give the student plenty of time to read
                                    // an 80-character question at multiplier
                                    // 1.0. Speed only ramps up as the student
                                    // chains correct answers.
const ROAD_SCROLL_RATE = 4.0;       // strips per second
const STRIP_COUNT = 24;             // road shading strips
const HORIZON_FRAC = 0.06;          // road horizon as fraction of height
const RUNNER_Y_FRAC = 0.78;         // runner Y as fraction of height
const HALF_TOP_FRAC = 0.18;         // half-width at horizon, fraction of width
const HALF_BOTTOM_FRAC = 0.46;      // half-width at runner, fraction of width

const GAIT_PERIOD_MS = 300;
const ARM_SWING_RAD = (35 * Math.PI) / 180;
const LEG_SWING_RAD = (25 * Math.PI) / 180;

const ONBOARD_KEY = 'play.lane_runner.onboarded';
const ONBOARD_AUTO_DISMISS_MS = 4000;

interface LaneRunnerProps extends SceneProps {
  loseSignal?: boolean;
  /** Engine bumps this when the previous answer was wrong. */
  wrongAnswerTick?: number;
  /** Engine bumps this when the previous answer was correct. */
  correctAnswerTick?: number;
}

// Three consecutive wrongs in a row trips the loss. With the new "wrong
// answers don't change the score" rule there's no score-zero loss path
// in lane runner, so we use a streak instead.
const WRONG_STREAK_LIMIT = 3;
// How long the green/red "Correct! / Wrong" burst sits on screen.
const ANSWER_BURST_MS = 1000;

const LaneRunnerScene: React.FC<LaneRunnerProps> = ({
  speedMultiplier,
  paused,
  onAnswer,
  onLoss,
  width,
  height,
  loseSignal,
  wrongAnswerTick,
  correctAnswerTick,
}) => {
  // ── State ─────────────────────────────────────────────────────────────────
  const [lane, setLane] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);
  const [scrollOffset, setScrollOffset] = useState<number>(0);
  const [gaitPhase, setGaitPhase] = useState<number>(0);
  const [lossFade, setLossFade] = useState<number>(0);
  const [hintVisible, setHintVisible] = useState<boolean>(false);
  const [burst, setBurst] = useState<'correct' | 'wrong' | null>(null);

  const laneRef = useRef<number>(0);
  const wrongStreakRef = useRef<number>(0);
  const lossFiredRef = useRef<boolean>(false);
  const speedRef = useRef<number>(speedMultiplier);
  const pausedRef = useRef<boolean>(paused);
  speedRef.current = speedMultiplier;
  pausedRef.current = paused;

  // ── 1-second correct/wrong burst overlay ──────────────────────────────────
  const lastCorrectRef = useRef<number | undefined>(correctAnswerTick);
  useEffect(() => {
    if (
      correctAnswerTick !== undefined &&
      correctAnswerTick !== lastCorrectRef.current
    ) {
      lastCorrectRef.current = correctAnswerTick;
      wrongStreakRef.current = 0;  // reset the streak on any correct
      setBurst('correct');
      const t = setTimeout(() => setBurst((b) => (b === 'correct' ? null : b)), ANSWER_BURST_MS);
      return () => clearTimeout(t);
    }
  }, [correctAnswerTick]);

  const lastWrongRef = useRef<number | undefined>(wrongAnswerTick);
  useEffect(() => {
    if (
      wrongAnswerTick !== undefined &&
      wrongAnswerTick !== lastWrongRef.current
    ) {
      lastWrongRef.current = wrongAnswerTick;
      wrongStreakRef.current += 1;
      setBurst('wrong');
      const t = setTimeout(() => setBurst((b) => (b === 'wrong' ? null : b)), ANSWER_BURST_MS);
      // Loss when the student misses three gates in a row.
      if (wrongStreakRef.current >= WRONG_STREAK_LIMIT && !lossFiredRef.current) {
        lossFiredRef.current = true;
        onLoss('wrong_streak');
      }
      return () => clearTimeout(t);
    }
  }, [wrongAnswerTick, onLoss]);

  // ── Onboarding hint (read once on mount) ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    AsyncStorage.getItem(ONBOARD_KEY)
      .then((seen) => {
        if (cancelled || seen === '1') return;
        setHintVisible(true);
        dismissTimer = setTimeout(() => {
          if (!cancelled) {
            setHintVisible(false);
            AsyncStorage.setItem(ONBOARD_KEY, '1').catch(() => undefined);
          }
        }, ONBOARD_AUTO_DISMISS_MS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (dismissTimer) clearTimeout(dismissTimer);
    };
  }, []);

  const dismissHint = () => {
    setHintVisible(false);
    AsyncStorage.setItem(ONBOARD_KEY, '1').catch(() => undefined);
  };

  // ── Loss propagation ──────────────────────────────────────────────────────
  useEffect(() => {
    if (loseSignal && !lossFiredRef.current) {
      lossFiredRef.current = true;
      const start = Date.now();
      const tick = () => {
        const t = Math.min(1, (Date.now() - start) / 350);
        setLossFade(t);
        if (t < 1) requestAnimationFrame(tick);
        else onLoss('score_zero');
      };
      tick();
    }
  }, [loseSignal, onLoss]);

  // ── Game loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf: number | null = null;
    let last = Date.now();

    const loop = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;

      if (!pausedRef.current && !lossFiredRef.current) {
        // Sweep advances toward the runner.
        const sweepRate = 1 / (BASE_SWEEP_SECONDS / Math.max(0.5, speedRef.current));
        setProgress((p) => {
          const next = p + sweepRate * dt;
          if (next >= 1) {
            const letter = LETTER_BY_LANE[laneRef.current] ?? 'A';
            onAnswer(letter);
            return 0;
          }
          return next;
        });
        // Road scroll + gait phase.
        setScrollOffset((s) => s + dt * ROAD_SCROLL_RATE * speedRef.current);
        setGaitPhase((p) => (p + (dt * 1000) / GAIT_PERIOD_MS) % 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Gesture: horizontal lane change + vertical commit ─────────────────────
  const pan = useMemo(
    () =>
      // .runOnJS(true) is critical: gesture-handler v2 + Reanimated v4
      // runs `.onEnd` as a UI-thread worklet by default. Our callback
      // touches React state + refs + calls the engine onAnswer prop.
      // Doing that from a worklet throws an unhandled JS exception
      // that escapes into Hermes/C++ and SIGABRTs the iOS app.
      Gesture.Pan().runOnJS(true).onEnd((e) => {
        const dx = e.translationX ?? 0;
        const dy = e.translationY ?? 0;
        const SWIPE = 36;
        if (Math.abs(dy) > Math.abs(dx) && dy < -SWIPE) {
          // Upward swipe → commit immediately.
          if (!lossFiredRef.current && !pausedRef.current) {
            const letter = LETTER_BY_LANE[laneRef.current] ?? 'A';
            onAnswer(letter);
            setProgress(0);
          }
          if (hintVisible) dismissHint();
          return;
        }
        if (Math.abs(dx) < 20) return;
        const next =
          dx < 0
            ? Math.max(0, laneRef.current - 1)
            : Math.min(3, laneRef.current + 1);
        laneRef.current = next;
        setLane(next);
        if (hintVisible) dismissHint();
      }),
    [onAnswer, hintVisible],
  );

  // ── Geometry ──────────────────────────────────────────────────────────────
  const horizonY = height * HORIZON_FRAC;
  const runnerY = height * RUNNER_Y_FRAC;
  const cx = width / 2;
  const halfTop = width * HALF_TOP_FRAC;
  const halfBottom = width * HALF_BOTTOM_FRAC;
  const roadH = runnerY - horizonY;

  // Returns half-width of the road at vertical position y between horizon
  // (returns halfTop) and runner row (returns halfBottom). t is clamped.
  const halfAtY = (y: number) => {
    const t = Math.max(0, Math.min(1, (y - horizonY) / roadH));
    return halfTop + (halfBottom - halfTop) * t;
  };

  const laneCenterAtY = (laneIdx: number, y: number) => {
    const halfW = halfAtY(y);
    const laneW = (halfW * 2) / 4;
    return cx + (laneIdx - 1.5) * laneW;
  };

  // ── Road strip paths (memoized per scrollOffset / size) ───────────────────
  const stripData = useMemo(() => {
    const stripH = roadH / STRIP_COUNT;
    const offsetInt = Math.floor(scrollOffset);
    const items: {
      pathA: string;
      pathB: string;
      tMid: number;
      shade: 'A' | 'B';
      yTop: number;
      stripH: number;
    }[] = [];
    for (let i = 0; i < STRIP_COUNT; i++) {
      const yTop = horizonY + i * stripH;
      const yBot = yTop + stripH + 1;
      const tMid = (i + 0.5) / STRIP_COUNT;
      const halfTopY = halfAtY(yTop);
      const halfBotY = halfAtY(yBot);
      // Trapezoidal strip path
      const pathA = `M ${cx - halfTopY},${yTop} L ${cx + halfTopY},${yTop} L ${cx + halfBotY},${yBot} L ${cx - halfBotY},${yBot} Z`;
      const pathB = pathA;
      const shade: 'A' | 'B' = (i + offsetInt) % 2 === 0 ? 'A' : 'B';
      items.push({ pathA, pathB, tMid, shade, yTop, stripH });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollOffset, width, height]);

  // Lane-color trapezoids (one per lane, full road height) so the lane
  // colour matches Neriah's four-teal answer scheme.
  const lanePaths = useMemo(() => {
    const out: { laneIdx: number; pathStr: string }[] = [];
    for (let li = 0; li < 4; li++) {
      const halfTopY = halfAtY(horizonY);
      const halfBotY = halfAtY(runnerY);
      const laneTopW = (halfTopY * 2) / 4;
      const laneBotW = (halfBotY * 2) / 4;
      const xTopL = cx - halfTopY + li * laneTopW;
      const xTopR = xTopL + laneTopW;
      const xBotL = cx - halfBotY + li * laneBotW;
      const xBotR = xBotL + laneBotW;
      const p = `M ${xTopL},${horizonY} L ${xTopR},${horizonY} L ${xBotR},${runnerY} L ${xBotL},${runnerY} Z`;
      out.push({ laneIdx: li, pathStr: p });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // ── Yellow dashed lane dividers (scroll-driven dashes) ────────────────────
  const dividerDashes = useMemo(() => {
    const stripH = roadH / STRIP_COUNT;
    const offsetInt = Math.floor(scrollOffset);
    const out: { x1: number; y1: number; x2: number; y2: number; w: number }[] = [];
    for (let i = 0; i < STRIP_COUNT; i++) {
      if ((i + offsetInt) % 2 !== 0) continue;
      const yTop = horizonY + i * stripH;
      const yBot = yTop + stripH + 1;
      const tMid = (i + 0.5) / STRIP_COUNT;
      const halfW = halfTop + (halfBottom - halfTop) * tMid;
      const laneW = (halfW * 2) / 4;
      const dashW = 2 + 4 * tMid;
      for (const d of [-1, 0, 1]) {
        const x = cx + d * laneW;
        out.push({ x1: x, y1: yTop, x2: x, y2: yBot, w: dashW });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollOffset, width, height]);

  // ── Stick figure (path strings derived from gait phase) ───────────────────
  const phaseRad = gaitPhase * 2 * Math.PI;
  const armAngleL = Math.sin(phaseRad) * ARM_SWING_RAD;
  const armAngleR = -armAngleL;
  const legAngleL = -armAngleL * (LEG_SWING_RAD / ARM_SWING_RAD);
  const legAngleR = -legAngleL;

  // Stick-figure scale relative to lane width. Keep it readable on phones.
  const figScale = Math.min(1.0, (halfBottom * 2) / 4 / 80);

  // Anchor points (local to runner origin at feet)
  const HIP_Y = -22 * figScale;
  const SHOULDER_Y = -46 * figScale;
  const HEAD_CY = -62 * figScale;
  const HEAD_R = 12 * figScale;
  const ARM_LEN = 18 * figScale;
  const LEG_LEN = 22 * figScale;
  const SHOULDER_X = 7 * figScale;
  const HIP_X = 5 * figScale;
  const STROKE_W = Math.max(1.6, 2.5 * figScale);
  const STROKE = '#0F172A';

  const runnerX = laneCenterAtY(lane, runnerY);
  const bobY = Math.sin(phaseRad * 2) * 1.2 * figScale;

  // Build a Skia.Path from segments expressed as svg-style strings.
  const makePath = (d: string) => Skia.Path.MakeFromSVGString(d);

  // Limb endpoints rotated about hip / shoulder
  const armEndL = {
    x: -SHOULDER_X + Math.sin(armAngleL) * ARM_LEN,
    y: SHOULDER_Y + Math.cos(armAngleL) * ARM_LEN,
  };
  const armEndR = {
    x: SHOULDER_X + Math.sin(armAngleR) * ARM_LEN,
    y: SHOULDER_Y + Math.cos(armAngleR) * ARM_LEN,
  };
  const legEndL = {
    x: -HIP_X + Math.sin(legAngleL) * LEG_LEN,
    y: HIP_Y + Math.cos(legAngleL) * LEG_LEN,
  };
  const legEndR = {
    x: HIP_X + Math.sin(legAngleR) * LEG_LEN,
    y: HIP_Y + Math.cos(legAngleR) * LEG_LEN,
  };

  // Skia paths for each limb / torso / head feature.
  const legLPath = makePath(`M ${-HIP_X},${HIP_Y} L ${legEndL.x},${legEndL.y}`);
  const legRPath = makePath(`M ${HIP_X},${HIP_Y} L ${legEndR.x},${legEndR.y}`);
  const armLPath = makePath(
    `M ${-SHOULDER_X},${SHOULDER_Y} L ${armEndL.x},${armEndL.y}`,
  );
  const armRPath = makePath(
    `M ${SHOULDER_X},${SHOULDER_Y} L ${armEndR.x},${armEndR.y}`,
  );
  const torsoPath = makePath(`M 0,${HIP_Y} L 0,${SHOULDER_Y}`);
  const neckPath = makePath(`M 0,${SHOULDER_Y} L 0,${SHOULDER_Y - 4 * figScale}`);

  // Hair tufts: three short slashes off the head's top.
  const tuftBase = HEAD_CY - HEAD_R + 1;
  const tuftPath = makePath(
    `M ${-4 * figScale},${tuftBase - 2 * figScale} L ${-6 * figScale},${tuftBase - 9 * figScale} ` +
    `M 0,${tuftBase - 3 * figScale} L ${-1 * figScale},${tuftBase - 11 * figScale} ` +
    `M ${4 * figScale},${tuftBase - 2 * figScale} L ${5 * figScale},${tuftBase - 8 * figScale}`,
  );

  // Smile arc — bottom half of a small circle centred a bit below head centre.
  const smilePath = makePath(
    `M ${-4 * figScale},${HEAD_CY + 4 * figScale} ` +
    `Q 0,${HEAD_CY + 8 * figScale} ${4 * figScale},${HEAD_CY + 4 * figScale}`,
  );

  // Sweep checkpoint line Y
  const sweepY = horizonY + (runnerY - horizonY) * progress;
  const sweepHalfW = halfAtY(sweepY);

  const overlayAlpha = Math.max(0, Math.min(1, lossFade));

  return (
    <View style={[styles.root, { width, height }]}>
      <Canvas style={{ width, height }}>
        {/* Sky / canvas background */}
        <Rect x={0} y={0} width={width} height={height} color="#04342C" />

        {/* Lane-coloured trapezoids */}
        {lanePaths.map((lp) => {
          const p = makePath(lp.pathStr);
          return p ? (
            <Path
              key={`lane-${lp.laneIdx}`}
              path={p}
              color={LANE_COLORS[lp.laneIdx]}
            />
          ) : null;
        })}

        {/* Asphalt strips overlay (alternating shading) for road scroll */}
        {stripData.map((s, i) => {
          const p = makePath(s.pathA);
          if (!p) return null;
          const alpha = s.shade === 'A' ? 0.18 : 0.06;
          return (
            <Path
              key={`strip-${i}`}
              path={p}
              color={`rgba(0,0,0,${alpha})`}
            />
          );
        })}

        {/* White edge lines (left + right of the road) */}
        {(() => {
          const left = makePath(
            `M ${cx - halfTop - 2},${horizonY} L ${cx - halfTop},${horizonY} ` +
            `L ${cx - halfBottom},${runnerY} L ${cx - halfBottom - 6},${runnerY} Z`,
          );
          const right = makePath(
            `M ${cx + halfTop},${horizonY} L ${cx + halfTop + 2},${horizonY} ` +
            `L ${cx + halfBottom + 6},${runnerY} L ${cx + halfBottom},${runnerY} Z`,
          );
          return (
            <Group>
              {left ? <Path path={left} color="rgba(255,255,255,0.85)" /> : null}
              {right ? <Path path={right} color="rgba(255,255,255,0.85)" /> : null}
            </Group>
          );
        })()}

        {/* Yellow dashed lane dividers (scroll with road) */}
        {dividerDashes.map((d, i) => (
          <Rect
            key={`dash-${i}`}
            x={d.x1 - d.w / 2}
            y={d.y1}
            width={d.w}
            height={d.y2 - d.y1}
            color="#FBBF24"
          />
        ))}

        {/* Sweep checkpoint line (clipped to road width at sweepY) */}
        <Rect
          x={cx - sweepHalfW}
          y={sweepY - 2}
          width={sweepHalfW * 2}
          height={4}
          color="rgba(255,255,255,0.9)"
        />

        {/* Stick figure runner — translated to lane center */}
        <Group transform={[{ translateX: runnerX }, { translateY: runnerY + bobY }]}>
          {/* Ground shadow */}
          <Circle cx={0} cy={2 * figScale} r={14 * figScale} color="rgba(0,0,0,0.28)" />

          {legLPath ? (
            <Path
              path={legLPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
          {legRPath ? (
            <Path
              path={legRPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
          {torsoPath ? (
            <Path
              path={torsoPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
          {neckPath ? (
            <Path
              path={neckPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
          {armLPath ? (
            <Path
              path={armLPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
          {armRPath ? (
            <Path
              path={armRPath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}

          {/* Head outline */}
          <Circle
            cx={0}
            cy={HEAD_CY}
            r={HEAD_R}
            color={STROKE}
            style="stroke"
            strokeWidth={STROKE_W}
          />
          {/* Glasses lenses */}
          <Circle
            cx={-4 * figScale}
            cy={HEAD_CY - 2 * figScale}
            r={4 * figScale}
            color={STROKE}
            style="stroke"
            strokeWidth={Math.max(1.2, 2 * figScale)}
          />
          <Circle
            cx={4 * figScale}
            cy={HEAD_CY - 2 * figScale}
            r={4 * figScale}
            color={STROKE}
            style="stroke"
            strokeWidth={Math.max(1.2, 2 * figScale)}
          />
          {/* Eye pupils */}
          <Circle cx={-3.5 * figScale} cy={HEAD_CY - 2 * figScale} r={1.4 * figScale} color={STROKE} />
          <Circle cx={3.5 * figScale} cy={HEAD_CY - 2 * figScale} r={1.4 * figScale} color={STROKE} />
          {/* Hair tufts */}
          {tuftPath ? (
            <Path
              path={tuftPath}
              style="stroke"
              strokeWidth={Math.max(1.2, 2 * figScale)}
              color={STROKE}
            />
          ) : null}
          {/* Smile */}
          {smilePath ? (
            <Path
              path={smilePath}
              style="stroke"
              strokeWidth={STROKE_W}
              color={STROKE}
            />
          ) : null}
        </Group>

        {/* Loss fade overlay */}
        {overlayAlpha > 0 ? (
          <Rect
            x={0}
            y={0}
            width={width}
            height={height}
            color={`rgba(4, 52, 44, ${overlayAlpha})`}
          />
        ) : null}
      </Canvas>

      {/* Gesture target overlays the canvas */}
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {/* Letter gates: A/B/C/D chips that descend in their lanes and
          collide with the runner row. The runner has to be in the
          right lane when the gates arrive. Gates use the same
          four-teal palette as the AnswerGrid letters above. */}
      {(() => {
        const gateSize = Math.max(36, Math.min(56, halfAtY(sweepY) * 0.5));
        return (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {LETTER_BY_LANE.map((letter, i) => {
              const cx = laneCenterAtY(i, sweepY);
              const palette = LANE_COLORS[i];
              const fg = i === 3 ? '#085041' : '#FFFFFF';
              return (
                <View
                  key={letter}
                  style={[
                    styles.gate,
                    {
                      width: gateSize,
                      height: gateSize,
                      left: cx - gateSize / 2,
                      top: sweepY - gateSize / 2,
                      backgroundColor: palette,
                    },
                  ]}
                >
                  <Text style={[styles.gateLetter, { color: fg, fontSize: gateSize * 0.5 }]}>
                    {letter}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })()}

      {/* 1-second correct/wrong burst (green / red) */}
      {burst ? (
        <View pointerEvents="none" style={styles.burstWrap}>
          <View
            style={[
              styles.burstCard,
              { backgroundColor: burst === 'correct' ? '#16A34A' : '#DC2626' },
            ]}
          >
            <Text style={styles.burstText}>
              {burst === 'correct' ? 'Correct!' : 'Wrong'}
            </Text>
          </View>
        </View>
      ) : null}

      {/* One-time onboarding hint */}
      {hintVisible ? (
        <View pointerEvents="box-none" style={styles.hintWrap}>
          <View style={styles.hintCard} pointerEvents="auto" onTouchEnd={dismissHint}>
            <Text style={styles.hintTitle}>Lane Runner</Text>
            <Text style={styles.hintBody}>
              Swipe left or right to change lanes. Swipe up to commit early.
            </Text>
            <Text style={styles.hintTap}>Tap to dismiss</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  gate: {
    position: 'absolute',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  gateLetter: {
    fontFamily: 'Georgia',
    fontWeight: '700',
  },
  burstWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  burstCard: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
  },
  burstText: {
    color: '#FFFFFF',
    fontFamily: 'Georgia',
    fontWeight: '700',
    fontSize: 28,
  },
  hintWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  hintCard: {
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    maxWidth: 320,
  },
  hintTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'Georgia',
    marginBottom: 6,
  },
  hintBody: {
    color: '#CBD5E1',
    fontSize: 14,
    lineHeight: 20,
    fontFamily: 'Georgia',
  },
  hintTap: {
    color: '#9FE1CB',
    fontSize: 12,
    fontFamily: 'Georgia',
    marginTop: 10,
    textAlign: 'right',
  },
});

export default LaneRunnerScene;
