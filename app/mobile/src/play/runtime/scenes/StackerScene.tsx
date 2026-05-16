// src/play/runtime/scenes/StackerScene.tsx
//
// Tetris-style answer stacker. The playfield is an 8×12 cell grid drawn
// as faint slate cells. A chunky rounded teal block falls from the top
// and the player drags left-right to steer it across four answer bins
// (A/B/C/D, four-teal palette) anchored at the bottom.
//
// Game rules ported from GemmaPlay's TetrisAnswerScene:
//   - Block lands → onAnswer fires for the bin it touched. The block
//     vanishes (we never stack — every question is its own block).
//   - Wrong answer → the entire bin row pushes UP by one cell (smooth
//     ~200 ms tween). Loss when the bin row rises within two cells of
//     the question banner zone.
//
// The visual treatment matches GemmaPlay:
//   - Decorative 8×12 grid cells with subtle separators and a darker
//     fill so the whole playfield reads as a Tetris well.
//   - Falling block is a 3-layer composite (shadow + body + highlight)
//     for a chunky arcade feel.
//   - Bins are white-rounded, letter-stamped, with the four-teal border
//     colour that matches the AnswerGrid HUD palette.

import { Canvas, Group, Rect, RoundedRect } from '@shopify/react-native-skia';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native';
import type { AnswerLetter, SceneProps } from '../types';

// ── Tunables ────────────────────────────────────────────────────────────────

const COLS = 8;
const ROWS = 12;
const BIN_LETTERS: AnswerLetter[] = ['A', 'B', 'C', 'D'];
const BIN_BORDERS = ['#0D7377', '#085041', '#3AAFA9', '#9FE1CB'];

const BLOCK_FALL_SECONDS = 5.5;     // base fall time top→bottom of playfield.
                                    // Slow enough at multiplier 1.0 that a
                                    // student can read the prompt and steer
                                    // the block. Speeds up as they chain
                                    // correct answers.
const BIN_RISE_TWEEN_MS = 220;      // bin-row push-up animation
const COL_COUNT = 4;                // four answer bins, each spans 2 grid cells

interface StackerProps extends SceneProps {
  loseSignal?: boolean;
  wrongAnswerTick?: number;
}

const StackerScene: React.FC<StackerProps> = ({
  speedMultiplier,
  paused,
  onAnswer,
  onLoss,
  onHudHintsChange,
  width,
  height,
  loseSignal,
  wrongAnswerTick,
}) => {
  const cellH = height / ROWS;
  const cellW = width / COLS;

  // ── Block + bin state ─────────────────────────────────────────────────────
  const [blockX, setBlockX] = useState<number>(width / 2);
  const [blockY, setBlockY] = useState<number>(0); // 0..1 (fraction of playfield)
  const [binOffset, setBinOffset] = useState<number>(0);
  const binOffsetAnim = useRef(new Animated.Value(0)).current;
  const [animatedBinOffset, setAnimatedBinOffset] = useState<number>(0);

  const targetXRef = useRef<number>(width / 2);
  const blockYRef = useRef<number>(0);
  const blockXRef = useRef<number>(width / 2);
  const lossFiredRef = useRef<boolean>(false);
  const speedRef = useRef<number>(speedMultiplier);
  const pausedRef = useRef<boolean>(paused);
  const widthRef = useRef<number>(width);
  speedRef.current = speedMultiplier;
  pausedRef.current = paused;
  widthRef.current = width;

  // Plumb the rising bin-row offset to the HUD so it can show "Bins +N".
  useEffect(() => {
    onHudHintsChange?.({ binRowOffset: binOffset });
  }, [binOffset, onHudHintsChange]);

  // ── Wrong-answer push-up (animated) ───────────────────────────────────────
  const lastWrongRef = useRef<number | undefined>(wrongAnswerTick);
  useEffect(() => {
    if (
      wrongAnswerTick !== undefined &&
      wrongAnswerTick !== lastWrongRef.current
    ) {
      lastWrongRef.current = wrongAnswerTick;
      setBinOffset((prev) => {
        const next = prev + 1;
        Animated.timing(binOffsetAnim, {
          toValue: next,
          duration: BIN_RISE_TWEEN_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }).start();
        // Loss when the bin row reaches within 2 cells of the top — same
        // as GemmaPlay's BIN_ROW_LIMIT (GRID_ROWS - 2).
        if (next >= ROWS - 2 && !lossFiredRef.current) {
          lossFiredRef.current = true;
          onLoss('bins_overflow');
        }
        return next;
      });
    }
  }, [wrongAnswerTick, onLoss, binOffsetAnim]);

  // Subscribe the JS-side animated value into state so Skia re-renders.
  useEffect(() => {
    const id = binOffsetAnim.addListener(({ value }) => {
      setAnimatedBinOffset(value);
    });
    return () => binOffsetAnim.removeListener(id);
  }, [binOffsetAnim]);

  useEffect(() => {
    if (loseSignal && !lossFiredRef.current) {
      lossFiredRef.current = true;
      onLoss('bins_overflow');
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
        const fallRate = 1 / (BLOCK_FALL_SECONDS / Math.max(0.5, speedRef.current));
        let nextY = blockYRef.current + fallRate * dt;

        // Steer toward the player's drag X (smooth chase rather than snap).
        const steerSpeed = widthRef.current * 1.6;
        const dx = targetXRef.current - blockXRef.current;
        const move = Math.sign(dx) * Math.min(Math.abs(dx), steerSpeed * dt);
        const nextX = blockXRef.current + move;
        blockXRef.current = nextX;
        setBlockX(nextX);

        if (nextY >= 1) {
          const bin = pickBin(blockXRef.current, widthRef.current);
          const letter = BIN_LETTERS[bin];
          onAnswer(letter);
          nextY = 0;
          const startX = widthRef.current / 2;
          blockXRef.current = startX;
          targetXRef.current = startX;
          setBlockX(startX);
        }
        blockYRef.current = nextY;
        setBlockY(nextY);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Drag input ────────────────────────────────────────────────────────────
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_e, g) => {
        targetXRef.current = clampX(g.x0, widthRef.current);
      },
      onPanResponderMove: (_e, g) => {
        targetXRef.current = clampX(g.moveX, widthRef.current);
      },
    }),
  ).current;

  // ── Geometry ──────────────────────────────────────────────────────────────
  const binTop = height - cellH - cellH * animatedBinOffset;
  const blockSize = Math.min(cellW, cellH) * 0.92;
  const blockRadius = Math.max(2, blockSize * 0.18);
  const blockPxY = blockY * (binTop - blockSize) + blockSize / 2;
  const binW = width / COL_COUNT;

  // Decorative grid cells (8 cols × 12 rows). Drawn faintly so the
  // playfield reads as a stacker well without competing with the block.
  const gridCells = useMemo(() => {
    const cells: { x: number; y: number; w: number; h: number; key: string }[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        cells.push({
          x: c * cellW + 2,
          y: r * cellH + 2,
          w: cellW - 4,
          h: cellH - 4,
          key: `g-${r}-${c}`,
        });
      }
    }
    return cells;
  }, [cellW, cellH]);

  return (
    <View style={[styles.root, { width, height }]} {...responder.panHandlers}>
      <Canvas style={{ width, height }}>
        {/* Playfield background */}
        <Rect x={0} y={0} width={width} height={height} color="#0F1B17" />

        {/* Decorative grid cells */}
        {gridCells.map((c) => (
          <RoundedRect
            key={c.key}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            r={3}
            color="rgba(255,255,255,0.04)"
          />
        ))}

        {/* Bins (one row, four cells, with the lettered four-teal borders) */}
        {BIN_BORDERS.map((borderColor, i) => (
          <Group key={`bin-${i}`}>
            {/* Bin fill */}
            <RoundedRect
              x={i * binW + 4}
              y={binTop + 3}
              width={binW - 8}
              height={cellH - 6}
              r={6}
              color="#FFFFFF"
            />
            {/* Bin border (matching the answer letter teal) — drawn as a
                slightly larger rounded rect underneath so the white fill
                shows a coloured ring. */}
            <RoundedRect
              x={i * binW + 2}
              y={binTop + 1}
              width={binW - 4}
              height={cellH - 2}
              r={8}
              color={borderColor}
              opacity={0.35}
            />
          </Group>
        ))}

        {/* Falling block — chunky 3-layer composite */}
        <Group transform={[{ translateX: blockX }, { translateY: blockPxY }]}>
          {/* Shadow */}
          <RoundedRect
            x={-blockSize / 2 + 2}
            y={-blockSize / 2 + 3}
            width={blockSize}
            height={blockSize}
            r={blockRadius}
            color="rgba(0,0,0,0.32)"
          />
          {/* Body */}
          <RoundedRect
            x={-blockSize / 2}
            y={-blockSize / 2}
            width={blockSize}
            height={blockSize}
            r={blockRadius}
            color="#0D7377"
          />
          {/* Body stroke */}
          <RoundedRect
            x={-blockSize / 2}
            y={-blockSize / 2}
            width={blockSize}
            height={blockSize}
            r={blockRadius}
            color="rgba(255,255,255,0.35)"
            style="stroke"
            strokeWidth={1.5}
          />
          {/* Top-left highlight */}
          <RoundedRect
            x={-blockSize / 2 + 4}
            y={-blockSize / 2 + 4}
            width={blockSize / 2 - 2}
            height={blockSize / 4 - 1}
            r={Math.max(1, blockRadius - 3)}
            color="rgba(255,255,255,0.35)"
          />
        </Group>
      </Canvas>

      {/* Bin labels (RN Text overlay so the letters render crisp) */}
      <View
        pointerEvents="none"
        style={[styles.binLabelRow, { top: binTop, height: cellH }]}
      >
        {BIN_LETTERS.map((letter, i) => (
          <View key={letter} style={styles.binLabelCell}>
            <Text style={[styles.binLabelText, { color: BIN_BORDERS[i] }]}>
              {letter}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
};

function pickBin(blockX: number, width: number): number {
  const idx = Math.floor(blockX / (width / COL_COUNT));
  return Math.max(0, Math.min(COL_COUNT - 1, idx));
}

function clampX(x: number, width: number): number {
  return Math.max(8, Math.min(width - 8, x));
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  binLabelRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
  },
  binLabelCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  binLabelText: {
    fontFamily: 'Georgia',
    fontSize: 24,
    fontWeight: '700',
  },
});

export default StackerScene;
