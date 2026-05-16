// src/play/runtime/HUD.tsx
//
// Top status bar for the active game session. Layout matches GemmaPlay's
// AnswerGridHUD treatment: small uppercase label above large value,
// dedicated panels for score and question counter.
//
// Shows:
//   - Game format title (left)
//   - Score panel (right, large amber number with SCORE label)
//   - Question counter panel (left of score, with QUESTION label)
//   - Pause button (top-right)
//   - Optional health segments (Blaster) or length counter (Snake)
//   - Optional bin-row offset hint (Stacker — small caption)

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TrackedPressable from '../../components/TrackedPressable';
import { COLORS } from '../../constants/colors';
import type { GameFormat } from '../types';
import type { HUDHints } from './types';

const FORMAT_TITLE: Record<GameFormat, string> = {
  lane_runner: 'Lane Runner',
  stacker: 'Stacker',
  blaster: 'Blaster',
  snake: 'Snake',
};

interface Props {
  format: GameFormat;
  score: number;
  questionIndex: number;
  total: number;
  onPause: () => void;
  hints?: HUDHints;
}

const HEALTH_SEGMENTS = 4;

const HUD: React.FC<Props> = ({
  format,
  score,
  questionIndex,
  total,
  onPause,
  hints,
}) => {
  const showHealth = hints?.health !== undefined;
  const showLength = hints?.lengthRemaining !== undefined;
  const showBinOffset =
    hints?.binRowOffset !== undefined && hints.binRowOffset > 0;

  return (
    <View style={styles.bar}>
      {/* Left: title + per-format status */}
      <View style={styles.leftCol}>
        <Text style={styles.title}>{FORMAT_TITLE[format]}</Text>
        {showHealth ? (
          <View style={styles.healthRow}>
            {Array.from({ length: HEALTH_SEGMENTS }).map((_, i) => {
              const filled = i < (hints?.health ?? 0);
              return (
                <View
                  key={i}
                  style={[
                    styles.healthSeg,
                    filled ? styles.healthSegOn : styles.healthSegOff,
                  ]}
                />
              );
            })}
          </View>
        ) : null}
        {showLength ? (
          <Text style={styles.hint}>Length · {hints?.lengthRemaining}</Text>
        ) : null}
        {showBinOffset ? (
          <Text style={styles.hint}>Stack · {hints?.binRowOffset} up</Text>
        ) : null}
      </View>

      {/* Question panel */}
      <View style={styles.panel}>
        <Text style={styles.panelLabel}>QUESTION</Text>
        <Text style={styles.panelValue}>{questionIndex + 1}</Text>
        <Text style={styles.panelDenom}>/ {total}</Text>
      </View>

      {/* Score panel */}
      <View style={styles.panel}>
        <Text style={styles.panelLabel}>SCORE</Text>
        <Text style={[styles.panelValue, styles.scoreValue]}>{score}</Text>
      </View>

      {/* Pause */}
      <TrackedPressable
        analyticsId="play.game.pause"
        onPress={onPause}
        style={styles.pauseBtn}
        hitSlop={10}
      >
        <Ionicons
          name="pause-circle-outline"
          size={28}
          color={COLORS.white}
        />
      </TrackedPressable>
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    backgroundColor: COLORS.teal500,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  leftCol: {
    flex: 1,
  },
  title: {
    fontFamily: 'Georgia',
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.white,
  },
  hint: {
    fontFamily: 'Georgia',
    fontSize: 11,
    color: COLORS.teal100,
    marginTop: 4,
  },
  panel: {
    backgroundColor: 'rgba(12, 18, 32, 0.4)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 8,
    minWidth: 56,
    alignItems: 'center',
  },
  panelLabel: {
    fontFamily: 'Georgia',
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.teal100,
    letterSpacing: 0.6,
  },
  panelValue: {
    fontFamily: 'Georgia',
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
    lineHeight: 22,
  },
  scoreValue: {
    color: COLORS.amber300,
  },
  panelDenom: {
    fontFamily: 'Georgia',
    fontSize: 10,
    color: COLORS.teal100,
  },
  pauseBtn: {
    padding: 4,
  },
  healthRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  healthSeg: {
    width: 22,
    height: 6,
    borderRadius: 2,
    marginRight: 3,
  },
  healthSegOn: {
    backgroundColor: COLORS.amber300,
  },
  healthSegOff: {
    backgroundColor: COLORS.teal700,
  },
});

export default HUD;
