// src/play/runtime/QuestionBanner.tsx
//
// Static text card that renders the current question prompt above the
// gameplay canvas. Off-white background, teal-500 1.5px border, Georgia
// serif body. Always visible during play. The engine cross-fades the
// content when the active question changes.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../../constants/colors';

interface Props {
  prompt: string;
  questionIndex: number;
  total: number;
}

const QuestionBanner: React.FC<Props> = ({ prompt, questionIndex, total }) => {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.qDot}>
          <Text style={styles.qDotText}>?</Text>
        </View>
        <View style={styles.textCol}>
          <Text style={styles.meta}>
            Question {questionIndex + 1} of {total}
          </Text>
          <Text style={styles.prompt} numberOfLines={3}>
            {prompt}
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFCF7', // off-white
    borderWidth: 1.5,
    borderColor: COLORS.teal500,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 12,
    marginVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  qDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.teal500,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 2,
  },
  qDotText: {
    color: COLORS.white,
    fontFamily: 'Georgia',
    fontSize: 16,
    fontWeight: '700',
  },
  textCol: {
    flex: 1,
  },
  meta: {
    fontFamily: 'Georgia',
    fontSize: 11,
    color: COLORS.teal700,
    marginBottom: 2,
    letterSpacing: 0.4,
  },
  prompt: {
    fontFamily: 'Georgia',
    fontSize: 19,
    lineHeight: 25,
    color: COLORS.gray900,
  },
});

export default QuestionBanner;
