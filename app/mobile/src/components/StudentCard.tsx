// src/components/StudentCard.tsx
// Compact card showing a student's name, register number, and latest score.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Student } from '../types';
import { COLORS } from '../constants/colors';

interface StudentCardProps {
  student: Student;
  latestScore?: { score: number; max_score: number } | null;
  onPress?: () => void;
}

export default function StudentCard({ student, latestScore, onPress }: StudentCardProps) {
  const displayName = `${student.first_name} ${student.surname}`;

  const scoreText = latestScore
    ? `${latestScore.score}/${latestScore.max_score} (${Math.round((latestScore.score / latestScore.max_score) * 100)}%)`
    : 'Not yet marked';

  const scoreColour = latestScore
    ? latestScore.score / latestScore.max_score >= 0.5
      ? COLORS.success
      : COLORS.error
    : COLORS.textLight;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.info}>
        <Text style={styles.name}>{displayName}</Text>
        {student.register_number && (
          <Text style={styles.regNumber}>#{student.register_number}</Text>
        )}
      </View>
      <Text style={[styles.score, { color: scoreColour }]}>{scoreText}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', padding: 14,
    backgroundColor: COLORS.background, borderRadius: 8, marginBottom: 8,
    justifyContent: 'space-between',
  },
  info: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: COLORS.text },
  regNumber: { fontSize: 12, color: COLORS.textLight, marginTop: 2 },
  score: { fontSize: 14, fontWeight: '600', marginLeft: 8 },
});
