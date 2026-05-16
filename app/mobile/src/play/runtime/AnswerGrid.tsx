// src/play/runtime/AnswerGrid.tsx
//
// 2x2 grid of A/B/C/D answer buttons. Each lettered tile is locked to a
// specific brand teal:
//   A → teal500 (#0D7377)
//   B → teal700 (#085041)
//   C → teal300 (#3AAFA9)
//   D → teal100 (#9FE1CB)
// D uses dark teal text for contrast against the pale fill; the others
// use white text.
//
// On press the grid forwards `letter` to the active scene via `onAnswer`.
// The engine drives a brief visual flash via `flashLetter` + `flashKind`:
//   'correct' → amber outline
//   'wrong'   → red outline
//
// All buttons are TrackedPressable so each tap is captured in analytics.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TrackedPressable from '../../components/TrackedPressable';
import { COLORS } from '../../constants/colors';
import type { AnswerLetter } from './types';

const LETTER_COLORS: Record<AnswerLetter, { bg: string; fg: string }> = {
  A: { bg: '#0D7377', fg: COLORS.white },
  B: { bg: '#085041', fg: COLORS.white },
  C: { bg: '#3AAFA9', fg: COLORS.white },
  D: { bg: '#9FE1CB', fg: '#085041' }, // pale fill → teal700 text
};

const LETTERS: AnswerLetter[] = ['A', 'B', 'C', 'D'];

const AMBER_FLASH = '#F5A623';
const RED_FLASH = '#C0392B';

interface Props {
  options: string[];
  onAnswer: (letter: AnswerLetter) => void;
  flashLetter?: AnswerLetter | null;
  flashKind?: 'correct' | 'wrong' | null;
  /** When true, all buttons are inert. The engine uses this during the
   *  brief flash window between answers to prevent double-taps. */
  disabled?: boolean;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

const AnswerGrid: React.FC<Props> = ({
  options,
  onAnswer,
  flashLetter,
  flashKind,
  disabled,
}) => {
  return (
    <View style={styles.grid}>
      {LETTERS.map((letter, idx) => {
        const palette = LETTER_COLORS[letter];
        const optionText = options?.[idx] ?? '';
        const isFlashing = flashLetter === letter;
        const flashColor =
          isFlashing && flashKind === 'correct'
            ? AMBER_FLASH
            : isFlashing && flashKind === 'wrong'
            ? RED_FLASH
            : 'transparent';

        return (
          <TrackedPressable
            key={letter}
            analyticsId={`play.game.answer.${letter}`}
            onPress={() => {
              if (disabled) return;
              onAnswer(letter);
            }}
            style={({ pressed }) => [
              styles.tile,
              {
                backgroundColor: palette.bg,
                borderColor: flashColor,
                opacity: pressed && !disabled ? 0.9 : 1,
              },
            ]}
          >
            <Text style={[styles.letter, { color: palette.fg }]}>{letter}</Text>
            <Text
              style={[styles.optionText, { color: palette.fg }]}
              numberOfLines={1}
            >
              {truncate(optionText, 25)}
            </Text>
          </TrackedPressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tile: {
    width: '48%',
    margin: '1%',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  letter: {
    fontFamily: 'Georgia',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 1,
  },
  optionText: {
    fontFamily: 'Georgia',
    fontSize: 12,
    textAlign: 'center',
  },
});

export default AnswerGrid;
