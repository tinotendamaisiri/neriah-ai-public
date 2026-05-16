// src/play/runtime/scenes/SnakeScene.tsx
//
// Classic snake on a 12×16 grid. Head is amber with two white eye dots,
// body is teal with a darker tail-end gradient. Four food tiles labelled
// A/B/C/D sit on free cells in their locked four-teal colours.
//
// Visual treatment ported from GemmaPlay's SnakeKnowledgeScene:
//   - Rounded body / head cells with a faint white inset stroke.
//   - Two-eye head detail (amber tile + white sclera + dark pupils).
//   - Smooth ~150 ms cell-to-cell tween (interpolated between the
//     previous and current snake position each frame).
//   - Food tiles drawn as rounded rects with the four-teal palette and
//     a white inset border so the letter chip reads cleanly.
//
// Game rules: swipe to change direction (the snake auto-moves on a
// timer scaled by speedMultiplier). Eating a food fires onAnswer; the
// engine ticks correct/wrong → grow / shrink. Wall or self collision,
// or shrinking past length 1, ends the run.

import { Canvas, Circle, Group, Rect, RoundedRect } from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import type { AnswerLetter, SceneProps } from '../types';

// ── Tunables ────────────────────────────────────────────────────────────────

const COLS = 12;
const ROWS = 16;
const LETTERS: AnswerLetter[] = ['A', 'B', 'C', 'D'];
const COLORS_BY_LETTER: Record<AnswerLetter, string> = {
  A: '#0D7377',
  B: '#085041',
  C: '#3AAFA9',
  D: '#9FE1CB',
};
const TEXT_COLORS: Record<AnswerLetter, string> = {
  A: '#FFFFFF',
  B: '#FFFFFF',
  C: '#FFFFFF',
  D: '#085041',
};
const HEAD_COLOR = '#F5A623';
const BODY_LIGHT = '#0D7377';
const BODY_DARK = '#04342C';

const BASE_TICK_SECONDS = 0.55;     // 550 ms base step at multiplier 1.0.
                                    // Easy to read the four food labels and
                                    // change direction in time. Tick gets
                                    // shorter (faster snake) as the student
                                    // chains correct answers.

type Direction = 'up' | 'down' | 'left' | 'right';

interface Cell { c: number; r: number; }
interface FoodTile extends Cell { letter: AnswerLetter; }

interface SnakeProps extends SceneProps {
  loseSignal?: boolean;
  wrongAnswerTick?: number;
  correctAnswerTick?: number;
}

const SnakeScene: React.FC<SnakeProps> = ({
  speedMultiplier,
  paused,
  onAnswer,
  onLoss,
  onHudHintsChange,
  width,
  height,
  loseSignal,
  wrongAnswerTick,
  correctAnswerTick,
}) => {
  // ── Geometry ──────────────────────────────────────────────────────────────
  const cellSize = Math.min(width / COLS, height / ROWS);
  const gridW = cellSize * COLS;
  const gridH = cellSize * ROWS;
  const offX = (width - gridW) / 2;
  const offY = (height - gridH) / 2;
  const cellPad = Math.max(1, cellSize * 0.06);
  const cellRadius = Math.max(2, cellSize * 0.22);

  // ── Initial state ─────────────────────────────────────────────────────────
  const initialSnake: Cell[] = useMemo(
    () =>
      Array.from({ length: 4 }).map((_, i) => ({
        c: Math.floor(COLS / 2) - i,
        r: Math.floor(ROWS / 2),
      })),
    [],
  );

  const [snake, setSnake] = useState<Cell[]>(initialSnake);
  const [prevSnake, setPrevSnake] = useState<Cell[]>(initialSnake);
  const [tickProgress, setTickProgress] = useState<number>(1);
  const [dir, setDir] = useState<Direction>('right');
  const [foods, setFoods] = useState<FoodTile[]>(() =>
    placeFoods(initialSnake),
  );
  const [pendingGrow, setPendingGrow] = useState<number>(0);
  const [pendingShrink, setPendingShrink] = useState<number>(0);

  const snakeRef = useRef<Cell[]>(snake);
  const prevSnakeRef = useRef<Cell[]>(initialSnake);
  const dirRef = useRef<Direction>(dir);
  const foodsRef = useRef<FoodTile[]>(foods);
  const lossFiredRef = useRef<boolean>(false);
  const speedRef = useRef<number>(speedMultiplier);
  const pausedRef = useRef<boolean>(paused);
  const pendingGrowRef = useRef<number>(0);
  const pendingShrinkRef = useRef<number>(0);
  speedRef.current = speedMultiplier;
  pausedRef.current = paused;
  snakeRef.current = snake;
  dirRef.current = dir;
  foodsRef.current = foods;
  pendingGrowRef.current = pendingGrow;
  pendingShrinkRef.current = pendingShrink;

  // HUD: snake length
  useEffect(() => {
    onHudHintsChange?.({ lengthRemaining: snake.length });
  }, [snake.length, onHudHintsChange]);

  // Wrong → schedule shrink
  const lastWrongRef = useRef<number | undefined>(wrongAnswerTick);
  useEffect(() => {
    if (
      wrongAnswerTick !== undefined &&
      wrongAnswerTick !== lastWrongRef.current
    ) {
      lastWrongRef.current = wrongAnswerTick;
      setPendingShrink((p) => p + 1);
    }
  }, [wrongAnswerTick]);

  // Correct → schedule grow
  const lastCorrectRef = useRef<number | undefined>(correctAnswerTick);
  useEffect(() => {
    if (
      correctAnswerTick !== undefined &&
      correctAnswerTick !== lastCorrectRef.current
    ) {
      lastCorrectRef.current = correctAnswerTick;
      setPendingGrow((p) => p + 1);
    }
  }, [correctAnswerTick]);

  useEffect(() => {
    if (loseSignal && !lossFiredRef.current) {
      lossFiredRef.current = true;
      onLoss('length_zero');
    }
  }, [loseSignal, onLoss]);

  // ── Gesture: swipe to change direction ────────────────────────────────────
  const pan = useMemo(
    () =>
      // .runOnJS(true) is critical: gesture-handler v2 + Reanimated v4
      // runs `.onEnd` as a UI-thread worklet by default. Our callback
      // touches React state + refs to update the snake direction.
      // Doing that from a worklet SIGABRTs the iOS app.
      Gesture.Pan().runOnJS(true).onEnd((e) => {
        const dx = e.translationX ?? 0;
        const dy = e.translationY ?? 0;
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 0 && dirRef.current !== 'left') {
            dirRef.current = 'right';
            setDir('right');
          } else if (dx < 0 && dirRef.current !== 'right') {
            dirRef.current = 'left';
            setDir('left');
          }
        } else {
          if (dy > 0 && dirRef.current !== 'up') {
            dirRef.current = 'down';
            setDir('down');
          } else if (dy < 0 && dirRef.current !== 'down') {
            dirRef.current = 'up';
            setDir('up');
          }
        }
      }),
    [],
  );

  // ── Tick loop with smooth interpolation ───────────────────────────────────
  useEffect(() => {
    let raf: number | null = null;
    let last = Date.now();
    let acc = 0;

    const stepOnce = () => {
      const head = snakeRef.current[0];
      const next = applyDir(head, dirRef.current);
      // Wall collision
      if (next.c < 0 || next.c >= COLS || next.r < 0 || next.r >= ROWS) {
        if (!lossFiredRef.current) {
          lossFiredRef.current = true;
          onLoss('collision');
        }
        return;
      }
      // Self collision (not against the moving tail)
      const willGrow = pendingGrowRef.current > 0;
      const body = willGrow
        ? snakeRef.current
        : snakeRef.current.slice(0, -1);
      if (body.some((s) => s.c === next.c && s.r === next.r)) {
        if (!lossFiredRef.current) {
          lossFiredRef.current = true;
          onLoss('collision');
        }
        return;
      }

      // Food pickup
      const foodHit = foodsRef.current.find(
        (f) => f.c === next.c && f.r === next.r,
      );
      if (foodHit) {
        onAnswer(foodHit.letter);
        const newFoods = foodsRef.current.map((f) =>
          f.letter === foodHit.letter
            ? {
                ...f,
                ...randomFreeCell(
                  [next, ...snakeRef.current],
                  foodsRef.current.filter((g) => g.letter !== f.letter),
                ),
              }
            : f,
        );
        foodsRef.current = newFoods;
        setFoods(newFoods);
      }

      let nextSnake: Cell[];
      if (pendingGrowRef.current > 0) {
        nextSnake = [next, ...snakeRef.current];
        pendingGrowRef.current = pendingGrowRef.current - 1;
        setPendingGrow(pendingGrowRef.current);
      } else {
        nextSnake = [next, ...snakeRef.current.slice(0, -1)];
      }
      while (pendingShrinkRef.current > 0 && nextSnake.length > 1) {
        nextSnake = nextSnake.slice(0, -1);
        pendingShrinkRef.current = pendingShrinkRef.current - 1;
      }
      setPendingShrink(pendingShrinkRef.current);

      if (nextSnake.length <= 1 && pendingShrinkRef.current > 0) {
        if (!lossFiredRef.current) {
          lossFiredRef.current = true;
          onLoss('length_zero');
        }
      }

      // Save previous frame for the visual lerp.
      prevSnakeRef.current = snakeRef.current;
      setPrevSnake(snakeRef.current);
      snakeRef.current = nextSnake;
      setSnake(nextSnake);
      setTickProgress(0);
    };

    const loop = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      if (!pausedRef.current && !lossFiredRef.current) {
        acc += dt;
        const tick = BASE_TICK_SECONDS / Math.max(0.5, speedRef.current);
        // Tick progress for smooth tween between cells.
        setTickProgress(Math.min(1, acc / tick));
        while (acc >= tick) {
          acc -= tick;
          stepOnce();
          if (lossFiredRef.current) break;
        }
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Per-segment interpolated screen position. If the previous frame had a
  // shorter body (we just grew), the new tail simply starts at the new
  // tail's grid cell.
  const segmentScreen = (segIdx: number, current: Cell[], prev: Cell[]) => {
    const cur = current[segIdx];
    const prv = prev[segIdx] ?? cur;
    const t = tickProgress;
    const cx = offX + (prv.c + (cur.c - prv.c) * t) * cellSize;
    const cy = offY + (prv.r + (cur.r - prv.r) * t) * cellSize;
    return { x: cx + cellPad, y: cy + cellPad };
  };

  return (
    <View style={[styles.root, { width, height }]}>
      <GestureDetector gesture={pan}>
        <View style={[StyleSheet.absoluteFill]}>
          <Canvas style={{ width, height }}>
            {/* Backdrop */}
            <Rect x={0} y={0} width={width} height={height} color="#04141C" />

            {/* Grid background */}
            <Rect
              x={offX}
              y={offY}
              width={gridW}
              height={gridH}
              color="rgba(8,80,65,0.5)"
            />

            {/* Body segments — drawn back-to-front so head sits on top.
                Per-segment colour interpolates from light teal at the
                head end to dark teal at the tail end. */}
            {snake.slice(1).map((_seg, i) => {
              const pos = segmentScreen(i + 1, snake, prevSnake);
              const t = i / Math.max(1, snake.length - 2);
              const fill = lerpHex(BODY_LIGHT, BODY_DARK, t);
              return (
                <Group key={`b-${i}`}>
                  <RoundedRect
                    x={pos.x}
                    y={pos.y}
                    width={cellSize - cellPad * 2}
                    height={cellSize - cellPad * 2}
                    r={cellRadius}
                    color={fill}
                  />
                  <RoundedRect
                    x={pos.x}
                    y={pos.y}
                    width={cellSize - cellPad * 2}
                    height={cellSize - cellPad * 2}
                    r={cellRadius}
                    color="rgba(255,255,255,0.18)"
                    style="stroke"
                    strokeWidth={1}
                  />
                </Group>
              );
            })}

            {/* Head — amber tile + two white eyes + dark pupils */}
            {snake[0] ? (() => {
              const pos = segmentScreen(0, snake, prevSnake);
              const inner = cellSize - cellPad * 2;
              const eyeR = inner * 0.12;
              const pupilR = eyeR * 0.55;
              return (
                <Group>
                  <RoundedRect
                    x={pos.x}
                    y={pos.y}
                    width={inner}
                    height={inner}
                    r={cellRadius}
                    color={HEAD_COLOR}
                  />
                  <Circle
                    cx={pos.x + inner * 0.32}
                    cy={pos.y + inner * 0.32}
                    r={eyeR}
                    color="#FFFFFF"
                  />
                  <Circle
                    cx={pos.x + inner * 0.68}
                    cy={pos.y + inner * 0.32}
                    r={eyeR}
                    color="#FFFFFF"
                  />
                  <Circle
                    cx={pos.x + inner * 0.32}
                    cy={pos.y + inner * 0.32}
                    r={pupilR}
                    color="#0F172A"
                  />
                  <Circle
                    cx={pos.x + inner * 0.68}
                    cy={pos.y + inner * 0.32}
                    r={pupilR}
                    color="#0F172A"
                  />
                </Group>
              );
            })() : null}

            {/* Food tiles */}
            {foods.map((f) => (
              <Group key={`f-${f.letter}`}>
                <RoundedRect
                  x={offX + f.c * cellSize + cellPad}
                  y={offY + f.r * cellSize + cellPad}
                  width={cellSize - cellPad * 2}
                  height={cellSize - cellPad * 2}
                  r={cellRadius}
                  color={COLORS_BY_LETTER[f.letter]}
                />
                <RoundedRect
                  x={offX + f.c * cellSize + cellPad}
                  y={offY + f.r * cellSize + cellPad}
                  width={cellSize - cellPad * 2}
                  height={cellSize - cellPad * 2}
                  r={cellRadius}
                  color="rgba(255,255,255,0.65)"
                  style="stroke"
                  strokeWidth={1.4}
                />
              </Group>
            ))}
          </Canvas>

          {/* Food letter overlay (RN text on top of canvas for crisp text) */}
          {foods.map((f) => (
            <View
              key={`l-${f.letter}`}
              pointerEvents="none"
              style={[
                styles.foodLabel,
                {
                  left: offX + f.c * cellSize,
                  top: offY + f.r * cellSize,
                  width: cellSize,
                  height: cellSize,
                },
              ]}
            >
              <Text
                style={[
                  styles.foodLetter,
                  {
                    color: TEXT_COLORS[f.letter],
                    fontSize: cellSize * 0.55,
                  },
                ]}
              >
                {f.letter}
              </Text>
            </View>
          ))}
        </View>
      </GestureDetector>
    </View>
  );
};

function applyDir(c: Cell, d: Direction): Cell {
  switch (d) {
    case 'up':    return { c: c.c,     r: c.r - 1 };
    case 'down':  return { c: c.c,     r: c.r + 1 };
    case 'left':  return { c: c.c - 1, r: c.r };
    case 'right': return { c: c.c + 1, r: c.r };
  }
}

function placeFoods(snake: Cell[]): FoodTile[] {
  const occ = [...snake];
  const out: FoodTile[] = [];
  for (const letter of LETTERS) {
    const cell = randomFreeCell(occ, out);
    out.push({ letter, ...cell });
    occ.push(cell);
  }
  return out;
}

function randomFreeCell(occ: Cell[], extra: Cell[]): Cell {
  for (let attempts = 0; attempts < 200; attempts++) {
    const c = Math.floor(Math.random() * COLS);
    const r = Math.floor(Math.random() * ROWS);
    if (
      !occ.some((o) => o.c === c && o.r === r) &&
      !extra.some((o) => o.c === c && o.r === r)
    ) {
      return { c, r };
    }
  }
  return { c: 0, r: 0 };
}

// Linearly interpolate two #RRGGBB hex colours.
function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  foodLabel: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  foodLetter: {
    fontFamily: 'Georgia',
    fontWeight: '700',
  },
});

export default SnakeScene;
