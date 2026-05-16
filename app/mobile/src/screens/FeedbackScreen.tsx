// src/screens/FeedbackScreen.tsx
// Payoff screen: student sees their annotated work, score, per-question breakdown.
// Receives mark_id (and optionally the cached mark object) as nav params.

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { getMark } from '../services/api';
import { StudentMark, GradingVerdict, StudentRootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';

type Props = NativeStackScreenProps<StudentRootStackParamList, 'Feedback'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

function scoreColor(pct: number): string {
  if (pct >= 70) return COLORS.success;
  if (pct >= 50) return COLORS.warning;
  return COLORS.error;
}

function verdictIcon(verdict: string): string {
  if (verdict === 'correct') return '✓';
  if (verdict === 'partial') return '~';
  return '✗';
}

function verdictColor(verdict: string): string {
  if (verdict === 'correct') return COLORS.success;
  if (verdict === 'partial') return COLORS.warning;
  return COLORS.error;
}

export default function FeedbackScreen({ route, navigation }: Props) {
  const { mark_id, mark: cachedMark } = route.params;
  const [mark, setMark] = useState<StudentMark | null>(cachedMark ?? null);
  const [loading, setLoading] = useState(!cachedMark);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);

  useEffect(() => {
    if (!cachedMark) {
      getMark(mark_id)
        .then(setMark)
        .catch(() => Alert.alert('Error', 'Could not load feedback.'))
        .finally(() => setLoading(false));
    }
  }, [mark_id]);

  if (loading) {
    return (
      <ScreenContainer scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      </ScreenContainer>
    );
  }

  if (!mark) {
    return (
      <ScreenContainer scroll={false}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>Could not load feedback. Go back and try again.</Text>
        </View>
      </ScreenContainer>
    );
  }

  const pct = mark.percentage ?? (
    mark.max_score > 0 ? Math.round((mark.score / mark.max_score) * 100) : 0
  );
  const color = scoreColor(pct);

  // Set header title
  navigation.setOptions({ title: mark.answer_key_title ?? 'Feedback' });

  return (
    <ScreenContainer scroll={false} style={{ backgroundColor: COLORS.background }}>
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Score header */}
      <View style={[styles.scoreHeader, { backgroundColor: color }]}>
        {/* StudentRootStack hides the native nav header (`headerShown: false`),
            so the screen used to have no way back. White-circle back button
            sits over the coloured score band — high contrast on red/amber/green. */}
        <BackButton variant="onTeal" style={styles.backBtn} />
        <Text style={styles.scoreMain}>{mark.score}/{mark.max_score}</Text>
        <Text style={styles.scorePct}>{pct}%</Text>
        <Text style={styles.scoreLabel}>
          {pct >= 70 ? 'Great work!' : pct >= 50 ? 'Good effort' : 'Keep practising'}
        </Text>
      </View>

      {/* Annotated image */}
      <View style={styles.imageSection}>
        <Text style={styles.sectionTitle}>Annotated Work</Text>
        {mark.marked_image_url && !imageError ? (
          <View style={styles.imageWrapper}>
            {imageLoading && (
              <View style={styles.imageLoadingOverlay}>
                <ActivityIndicator color={COLORS.teal500} />
              </View>
            )}
            <ScrollView
              maximumZoomScale={4}
              minimumZoomScale={1}
              bouncesZoom
              centerContent
              style={styles.zoomScroll}
            >
              <Image
                source={{ uri: mark.marked_image_url }}
                style={styles.annotatedImage}
                resizeMode="contain"
                onLoad={() => setImageLoading(false)}
                onError={() => { setImageLoading(false); setImageError(true); }}
              />
            </ScrollView>
            <Text style={styles.zoomHint}>Pinch to zoom</Text>
          </View>
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="image-outline" size={40} color={COLORS.gray500} style={styles.imagePlaceholderIcon} />
            <Text style={styles.imagePlaceholderText}>Annotated image not available</Text>
          </View>
        )}
      </View>

      {/* Per-question breakdown */}
      {mark.verdicts && mark.verdicts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Question Breakdown</Text>
          {mark.verdicts.map((v: GradingVerdict) => (
            <VerdictRow key={v.question_number} verdict={v} />
          ))}
        </View>
      )}

      {/* Teacher feedback */}
      {mark.feedback && (
        <View style={styles.section}>
          <View style={fStyles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Teacher's Note</Text>
            {mark.manually_edited && (
              <View style={fStyles.editedTagRow}>
                <Ionicons name="pencil-outline" size={11} color={COLORS.amber500} />
                <Text style={fStyles.editedTag}> Teacher-edited</Text>
              </View>
            )}
          </View>
          <View style={styles.feedbackCard}>
            <Ionicons name="chatbubble-outline" size={20} color={COLORS.gray500} />
            <Text style={styles.feedbackText}>{mark.feedback}</Text>
          </View>
        </View>
      )}

      {/* Assignment info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Submission Info</Text>
        <View style={styles.infoCard}>
          {mark.answer_key_title && (
            <InfoRow label="Assignment" value={mark.answer_key_title} />
          )}
          <InfoRow label="Source" value={mark.source === 'student_submission' ? 'Student App' : 'Teacher Scan'} />
          <InfoRow
            label="Date"
            value={new Date(mark.timestamp).toLocaleDateString('en-ZW', {
              year: 'numeric', month: 'long', day: 'numeric',
            })}
          />
        </View>
      </View>
    </ScrollView>
    </ScreenContainer>
  );
}

function VerdictRow({ verdict }: { verdict: GradingVerdict }) {
  const color = verdictColor(verdict.verdict);
  const icon = verdictIcon(verdict.verdict);

  return (
    <View style={vStyles.row}>
      <View style={[vStyles.iconCircle, { backgroundColor: color }]}>
        <Text style={vStyles.icon}>{icon}</Text>
      </View>
      <View style={vStyles.body}>
        <Text style={vStyles.qNum}>Q{verdict.question_number}</Text>
        {verdict.feedback && (
          <Text style={vStyles.feedback}>{verdict.feedback}</Text>
        )}
      </View>
      <Text style={[vStyles.marks, { color }]}>
        {verdict.awarded_marks}/{verdict.max_marks}
      </Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={iStyles.row}>
      <Text style={iStyles.label}>{label}</Text>
      <Text style={iStyles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: COLORS.gray500, fontSize: 15, textAlign: 'center' },
  scoreHeader: {
    paddingVertical: 32,
    alignItems: 'center',
    position: 'relative',
  },
  backBtn: {
    position: 'absolute',
    top: 16,
    left: 16,
    zIndex: 1,
  },
  scoreMain: { fontSize: 52, fontWeight: '900', color: COLORS.white },
  scorePct: { fontSize: 24, fontWeight: '700', color: 'rgba(255,255,255,0.85)', marginTop: 4 },
  scoreLabel: { fontSize: 16, color: 'rgba(255,255,255,0.75)', marginTop: 8 },
  imageSection: { margin: 16 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.gray900,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  imageWrapper: { borderRadius: 12, overflow: 'hidden', backgroundColor: COLORS.text },
  imageLoadingOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  zoomScroll: { height: 420 },
  annotatedImage: {
    width: SCREEN_WIDTH - 32,
    height: 420,
  },
  zoomHint: {
    textAlign: 'center',
    color: COLORS.gray500,
    fontSize: 11,
    paddingVertical: 6,
    backgroundColor: COLORS.background,
  },
  imagePlaceholder: {
    height: 160,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
  },
  imagePlaceholderIcon: { marginBottom: 8 },
  imagePlaceholderText: { color: COLORS.textLight, fontSize: 14 },
  section: { marginHorizontal: 16, marginBottom: 16 },
  feedbackCard: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  feedbackText: { flex: 1, fontSize: 14, color: COLORS.gray900, lineHeight: 21 },
  infoCard: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
});

const vStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    padding: 12,
    marginBottom: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { color: COLORS.white, fontSize: 16, fontWeight: '900' },
  body: { flex: 1 },
  qNum: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  feedback: { fontSize: 12, color: COLORS.gray500, marginTop: 2, lineHeight: 17 },
  marks: { fontSize: 14, fontWeight: '700', minWidth: 40, textAlign: 'right' },
});

const fStyles = StyleSheet.create({
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  editedTagRow: { flexDirection: 'row', alignItems: 'center' },
  editedTag: { fontSize: 11, color: COLORS.amber500, fontWeight: '600' },
});

const iStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.background,
  },
  label: { fontSize: 13, color: COLORS.gray500 },
  value: { fontSize: 13, color: COLORS.text, fontWeight: '500', textAlign: 'right', flexShrink: 1, marginLeft: 8 },
});
