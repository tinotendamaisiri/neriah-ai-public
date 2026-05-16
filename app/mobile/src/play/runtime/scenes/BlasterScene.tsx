// src/play/runtime/scenes/BlasterScene.tsx
//
// Pixel-art space-shooter answer scene. A chunky retro ship at the bottom
// centre, four invader sprites descending from the top with A/B/C/D
// labels overlaid, a two-layer parallax starfield, and a health bar
// instead of hearts.
//
// Game rules ported from GemmaPlay's ShooterAnswerScene:
//   - The player taps an invader to shoot it; that letter becomes the
//     answer. Wrong shots still resolve (the engine handles the score)
//     and the invader respawns at the top so the wave keeps moving.
//   - Health bar drains when an invader breaches the bottom; regen of
//     +1 segment fires every 2 consecutive correct answers (max 4).
//   - Loss when health hits 0 or any invader reaches y=1.
//
// Visual treatment:
//   - Ship + invaders rendered as pixel-art via per-pixel Skia Rects
//     (3 px per "pixel"). Patterns match GemmaPlay's silhouettes; colours
//     swapped to Neriah's teal + amber palette.
//   - Two-layer starfield: slow distant stars (small + faded) plus
//     faster near stars (larger + brighter) → parallax sense of motion.
//   - Health bar slot at top of canvas; segment colour goes green →
//     amber → red as health depletes (matches GemmaPlay thresholds).

import { Canvas, Group, Rect, RoundedRect, Skia, Path } from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AnswerLetter, SceneProps } from '../types';

// ── Tunables ────────────────────────────────────────────────────────────────

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

const STARS_FAR_COUNT = 28;
const STARS_NEAR_COUNT = 12;
const INVADER_BASE_FALL = 0.006; // fraction of height per second. At
                                 // multiplier 1.0 the closest invader takes
                                 // ~85 s to descend, leaving the student
                                 // plenty of time to read its letter and
                                 // shoot. Speed scales up on correct.
const HEALTH_MAX = 4;
const INVADER_SIZE_RATIO = 0.18; // of canvas width

// Pixel-art patterns (M = main, A = accent, X = invader body, . = empty)
const SHIP_PIXELS = [
  '......A......',
  '.....AMA.....',
  '....MMMMM....',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  'MMMMMMMMMMMMM',
  'MMM.MMMMM.MMM',
  'MM.........MM',
];
const ENEMY_PIXELS = [
  'X........X',
  '.X......X.',
  '.XXXXXXXX.',
  'XX.XXXX.XX',
  'XXXXXXXXXX',
  'X.XXXXXX.X',
  'X.X....X.X',
  '..XX..XX..',
];

const SHIP_COLS = SHIP_PIXELS[0].length;
const SHIP_ROWS = SHIP_PIXELS.length;
const ENEMY_COLS = ENEMY_PIXELS[0].length;
const ENEMY_ROWS = ENEMY_PIXELS.length;

interface Invader {
  letter: AnswerLetter;
  x: number;
  y: number;
  baseX: number;
  oscPhase: number;
}

interface Star {
  x: number;
  y: number;
  speed: number;
  size: number;
  bright: boolean;
}

interface BlasterProps extends SceneProps {
  loseSignal?: boolean;
  wrongAnswerTick?: number;
  correctAnswerTick?: number;
}

const BlasterScene: React.FC<BlasterProps> = ({
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
  const [invaders, setInvaders] = useState<Invader[]>(() => seedInvaders());
  const [stars, setStars] = useState<Star[]>(() =>
    [...seedStars(STARS_FAR_COUNT, false), ...seedStars(STARS_NEAR_COUNT, true)],
  );
  const [health, setHealth] = useState<number>(HEALTH_MAX);
  const [streak, setStreak] = useState<number>(0);
  const [shotFlashKey, setShotFlashKey] = useState<number>(0);

  const invadersRef = useRef<Invader[]>(invaders);
  const starsRef = useRef<Star[]>(stars);
  const lossFiredRef = useRef<boolean>(false);
  const speedRef = useRef<number>(speedMultiplier);
  const pausedRef = useRef<boolean>(paused);
  const widthRef = useRef<number>(width);
  const heightRef = useRef<number>(height);
  speedRef.current = speedMultiplier;
  pausedRef.current = paused;
  widthRef.current = width;
  heightRef.current = height;
  invadersRef.current = invaders;
  starsRef.current = stars;

  useEffect(() => {
    onHudHintsChange?.({ health });
  }, [health, onHudHintsChange]);

  // Wrong → drain health
  const lastWrongRef = useRef<number | undefined>(wrongAnswerTick);
  useEffect(() => {
    if (
      wrongAnswerTick !== undefined &&
      wrongAnswerTick !== lastWrongRef.current
    ) {
      lastWrongRef.current = wrongAnswerTick;
      setStreak(0);
      setHealth((h) => {
        const next = Math.max(0, h - 1);
        if (next === 0 && !lossFiredRef.current) {
          lossFiredRef.current = true;
          onLoss('health_zero');
        }
        return next;
      });
    }
  }, [wrongAnswerTick, onLoss]);

  // Correct → +1 segment per 2 corrects
  const lastCorrectRef = useRef<number | undefined>(correctAnswerTick);
  useEffect(() => {
    if (
      correctAnswerTick !== undefined &&
      correctAnswerTick !== lastCorrectRef.current
    ) {
      lastCorrectRef.current = correctAnswerTick;
      setStreak((s) => {
        const next = s + 1;
        if (next >= 2) {
          setHealth((h) => Math.min(HEALTH_MAX, h + 1));
          return 0;
        }
        return next;
      });
    }
  }, [correctAnswerTick]);

  useEffect(() => {
    if (loseSignal && !lossFiredRef.current) {
      lossFiredRef.current = true;
      onLoss('health_zero');
    }
  }, [loseSignal, onLoss]);

  // Game loop
  useEffect(() => {
    let raf: number | null = null;
    let last = Date.now();
    let elapsed = 0;

    const loop = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      elapsed += dt;

      if (!pausedRef.current && !lossFiredRef.current) {
        // Invader descent + side-to-side oscillation
        const fall = INVADER_BASE_FALL * Math.max(0.5, speedRef.current);
        const next = invadersRef.current.map((inv) => {
          const ny = inv.y + fall * dt;
          const osc = Math.sin(elapsed * 1.2 + inv.oscPhase) * 0.05;
          const nx = clamp01(inv.baseX + osc);
          return { ...inv, x: nx, y: ny };
        });
        if (next.some((i) => i.y >= 0.92)) {
          if (!lossFiredRef.current) {
            lossFiredRef.current = true;
            onLoss('invader_breach');
          }
        }
        invadersRef.current = next;
        setInvaders(next);

        // Stars drift — far layer slow, near layer faster
        const sNext = starsRef.current.map((s) => {
          const ny = s.y + s.speed * dt * (s.bright ? 1.6 : 1.0);
          if (ny > 1) {
            return {
              x: Math.random(),
              y: 0,
              speed: s.speed,
              size: s.size,
              bright: s.bright,
            };
          }
          return { ...s, y: ny };
        });
        starsRef.current = sNext;
        setStars(sNext);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Geometry / sprite scaling ─────────────────────────────────────────────
  const shipPx = Math.max(2, Math.floor((width * 0.18) / SHIP_COLS));
  const shipW = SHIP_COLS * shipPx;
  const shipH = SHIP_ROWS * shipPx;
  const shipX = width / 2 - shipW / 2;
  const shipY = height - shipH - 12;

  const invSize = width * INVADER_SIZE_RATIO;
  const enemyPx = Math.max(2, Math.floor(invSize / ENEMY_COLS));

  const handleInvaderTap = (letter: AnswerLetter) => {
    if (pausedRef.current || lossFiredRef.current) return;
    onAnswer(letter);
    setShotFlashKey((k) => k + 1);
    invadersRef.current = invadersRef.current.map((inv) =>
      inv.letter === letter
        ? { ...inv, y: 0, baseX: Math.random() * 0.8 + 0.1 }
        : inv,
    );
    setInvaders([...invadersRef.current]);
  };

  // Bullet path — short flash up from the ship after a tap.
  const bulletPath = useMemo(() => {
    const p = Skia.Path.Make();
    const cx = width / 2;
    p.moveTo(cx, shipY - 4);
    p.lineTo(cx, shipY - 28);
    return p;
  }, [width, shipY]);

  // ── Health bar geometry ──────────────────────────────────────────────────
  const healthBarTop = 6;
  const healthBarHeight = 10;
  const healthBarPadding = 12;
  const healthBarWidth = width - healthBarPadding * 2;
  const healthRatio = health / HEALTH_MAX;
  const healthFillWidth = healthBarWidth * healthRatio;
  const healthColor =
    healthRatio > 0.6 ? '#10B981' : healthRatio > 0.3 ? '#F59E0B' : '#EF4444';

  return (
    <View style={[styles.root, { width, height }]}>
      <Canvas style={{ width, height }}>
        {/* Backdrop */}
        <Rect x={0} y={0} width={width} height={height} color="#04141C" />

        {/* Two-layer starfield */}
        {stars.map((s, i) => (
          <Rect
            key={i}
            x={s.x * width}
            y={s.y * height}
            width={s.size}
            height={s.size}
            color={s.bright ? 'rgba(255,255,255,0.95)' : 'rgba(148,163,184,0.55)'}
          />
        ))}

        {/* Health bar */}
        <RoundedRect
          x={healthBarPadding}
          y={healthBarTop}
          width={healthBarWidth}
          height={healthBarHeight}
          r={4}
          color="rgba(15,23,42,0.85)"
        />
        {healthFillWidth > 0 ? (
          <RoundedRect
            x={healthBarPadding}
            y={healthBarTop}
            width={healthFillWidth}
            height={healthBarHeight}
            r={4}
            color={healthColor}
          />
        ) : null}
        <RoundedRect
          x={healthBarPadding}
          y={healthBarTop}
          width={healthBarWidth}
          height={healthBarHeight}
          r={4}
          color="rgba(255,255,255,0.18)"
          style="stroke"
          strokeWidth={1}
        />

        {/* Ship — pixel-art */}
        <Group>
          {pixelArt(SHIP_PIXELS, shipX, shipY, shipPx, {
            M: '#0D7377',
            A: '#F5A623',
          })}
        </Group>

        {/* Bullet flash (briefly visible after a tap; key change forces redraw) */}
        <Group key={shotFlashKey}>
          <Path
            path={bulletPath}
            color="#9FE1CB"
            style="stroke"
            strokeWidth={3}
          />
        </Group>
      </Canvas>

      {/* Invaders rendered as Pressables with pixel-art inside so the
          hit-test stays reliable while the visuals match GemmaPlay. */}
      {invaders.map((inv) => {
        const px = inv.x * width - invSize / 2;
        const py = inv.y * height - invSize / 2;
        return (
          <Pressable
            key={inv.letter}
            onPress={() => handleInvaderTap(inv.letter)}
            style={[
              styles.invader,
              { left: px, top: py, width: invSize, height: invSize },
            ]}
          >
            <Canvas style={{ width: invSize, height: invSize }}>
              {pixelArt(ENEMY_PIXELS, 0, 0, enemyPx, {
                X: COLORS_BY_LETTER[inv.letter],
              })}
            </Canvas>
            <View style={styles.invaderLabelWrap} pointerEvents="none">
              <Text
                style={[
                  styles.invaderText,
                  { color: TEXT_COLORS[inv.letter] },
                ]}
              >
                {inv.letter}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
};

// ── Pixel-art helper: emits one Rect per "on" pixel in the pattern ───────────

function pixelArt(
  pattern: string[],
  x: number,
  y: number,
  px: number,
  colorByChar: Record<string, string>,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[r].length; c++) {
      const ch = pattern[r][c];
      const color = colorByChar[ch];
      if (!color) continue;
      out.push(
        <Rect
          key={`${r}-${c}`}
          x={x + c * px}
          y={y + r * px}
          width={px}
          height={px}
          color={color}
        />,
      );
    }
  }
  return out;
}

function seedInvaders(): Invader[] {
  return LETTERS.map((letter, i) => ({
    letter,
    baseX: 0.15 + i * 0.235,
    x: 0.15 + i * 0.235,
    y: -0.05 - i * 0.1,
    oscPhase: Math.random() * Math.PI * 2,
  }));
}

function seedStars(count: number, bright: boolean): Star[] {
  const out: Star[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: Math.random(),
      y: Math.random(),
      speed: bright ? 0.08 + Math.random() * 0.05 : 0.03 + Math.random() * 0.03,
      size: bright ? 2 : 1,
      bright,
    });
  }
  return out;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  invader: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  invaderLabelWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invaderText: {
    fontFamily: 'Georgia',
    fontSize: 22,
    fontWeight: '700',
  },
});

export default BlasterScene;
