// src/components/MarkResult.tsx
// Post-scan result view: zoomable annotated image, editable verdict rows,
// overall feedback, and Approve/Skip buttons.
//
// Edits are batched in local state — no API call per edit. On "Approve &
// Next Student", updateMark fires with the full edited verdict list; on
// "Skip", nothing is persisted and the caller is just told to advance.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  Dimensions,
  FlatList,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MarkResult, Student, GradingVerdict, GradingVerdictEnum } from '../types';
import { COLORS } from '../constants/colors';
import { updateMark, deleteMark } from '../services/api';
import EditVerdictModal from './EditVerdictModal';
import LocalAnnotationOverlay from './LocalAnnotationOverlay';
import OfflineGradedToast from './OfflineGradedToast';

interface MarkResultProps {
  result: MarkResult;
  /** Optional — the display name comes from `result.student_name` first, so
   *  this prop is only used as a fallback for legacy callers that already
   *  have a loaded Student in hand. New callers can omit it. */
  student?: Student;
  /** Called after Approve succeeds, Skip is tapped, or the submission is
   *  deleted. Parent uses it to advance the queue + update session counters.
   *  `deleted` is treated the same as skip (no approve-counter increment). */
  onDone: (info: { approved: boolean; deleted?: boolean }) => void;
}

const VERDICT_COLOUR: Record<GradingVerdictEnum, string> = {
  correct: COLORS.success,
  incorrect: COLORS.error,
  partial: COLORS.warning,
};

const VERDICT_LABEL: Record<GradingVerdictEnum, string> = {
  correct: '✓',
  incorrect: '✗',
  partial: '~',
};

const { width: SW } = Dimensions.get('window');
const IMAGE_H = 420;

export default function MarkResultComponent({ result, student, onDone }: MarkResultProps) {
  // Prefer the backend-supplied name; fall back to the optional Student prop
  // for legacy callers; finally fall back to a generic label so nothing ever
  // blows up on undefined.
  const studentName =
    result.student_name ||
    (student ? `${student.first_name} ${student.surname}`.trim() : 'Student');

  // ── Editable state (batched; saved on Approve) ──────────────────────────────
  const initialVerdicts = useMemo<GradingVerdict[]>(() => result.verdicts ?? [], [result]);
  const [verdicts, setVerdicts] = useState<GradingVerdict[]>(initialVerdicts);
  const [editedQuestions, setEditedQuestions] = useState<Set<number>>(new Set());
  const [overallFeedback, setOverallFeedback] = useState('');
  const [feedbackExpanded, setFeedbackExpanded] = useState(false);
  const [questionsExpanded, setQuestionsExpanded] = useState(false);
  const [editingVerdict, setEditingVerdict] = useState<GradingVerdict | null>(null);
  const [approving, setApproving] = useState(false);

  // Auto-expand the feedback section on mount if there's already text (e.g.
  // if a future change hydrates overallFeedback from result.overall_feedback).
  // Today overallFeedback starts empty so this is a no-op; kept as scaffolding
  // so the behaviour is right the moment hydration lands.
  useEffect(() => {
    if (overallFeedback?.length > 0) setFeedbackExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Live totals (recompute from local state each render) ────────────────────
  const totalAwarded = verdicts.reduce((s, v) => s + (v.awarded_marks ?? 0), 0);
  const totalMax = verdicts.reduce((s, v) => s + (v.max_marks ?? 0), 0) || result.max_score || 1;
  const percentage = totalMax > 0 ? Math.round((totalAwarded / totalMax) * 100) : 0;
  const pctColour =
    percentage >= 75 ? COLORS.success : percentage >= 50 ? COLORS.warning : COLORS.error;

  // ── Pages ──────────────────────────────────────────────────────────────────
  // We always overlay verdicts in React Native (LocalAnnotationOverlay) so
  // online and offline grades look identical: big tick/X on the right margin
  // next to each answer. That means we want the *originals* underneath, not
  // the server-baked annotated copies — otherwise the teacher would see two
  // sets of marks (Pillow's left-side marks AND ours).
  //
  // Preference order:
  //   1. `page_urls`   — originals (cloud responses include them)
  //   2. `annotated_urls` — fallback for older responses or offline (which
  //      sets annotated_urls to the originals already)
  //   3. `marked_image_url` — single-page legacy alias
  const pages = useMemo<string[]>(() => {
    if (result.page_urls && result.page_urls.length > 0) return result.page_urls;
    if (result.annotated_urls && result.annotated_urls.length > 0) return result.annotated_urls;
    if (result.marked_image_url) return [result.marked_image_url];
    return [];
  }, [result.page_urls, result.annotated_urls, result.marked_image_url]);
  const isMultiPage = pages.length > 1;

  // Tracks whether the result came from on-device grading. Used to gate the
  // "Graded on-device" toast and the local-only Approve message — *not* the
  // overlay, which now renders for both online and offline so the visual
  // contract is identical.
  const isLocallyGraded = !!result.locally_graded;

  // ── Annotation overlay ────────────────────────────────────────────────────
  // Render the overlay for *every* mark (not just offline). Cloud verdicts
  // may carry qx/qy from the server-side annotator; offline ones won't and
  // fall back to right-margin stacking inside the overlay component. Either
  // way, the visual is consistent: green tick / red X on the right side of
  // the answer column with a score bubble in the corner.
  // Map verdicts onto their original page_index. For cloud grades the
  // backend doesn't currently send verdict_page_indices, so default every
  // verdict to page 0 (single-page is the common case).
  const pageIndexByVerdict = useMemo<number[]>(() => {
    if (Array.isArray(result.verdict_page_indices)) return result.verdict_page_indices;
    return verdicts.map(() => 0);
  }, [result.verdict_page_indices, verdicts]);
  const verdictsByPage = useMemo<GradingVerdict[][]>(() => {
    const grouped: GradingVerdict[][] = pages.map(() => []);
    verdicts.forEach((v, i) => {
      const pi = pageIndexByVerdict[i] ?? 0;
      const bucket = Math.max(0, Math.min(pages.length - 1, pi));
      grouped[bucket].push(v);
    });
    return grouped;
  }, [verdicts, pageIndexByVerdict, pages.length]);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  // Single-page: iOS ScrollView's native pinch + zoom buttons control the
  // same ref (scrollResponderZoomTo) — unchanged from before.
  // Multi-page: pinch is off (nested ScrollView breaks horizontal paging on
  // Android), so the +/-/reset buttons apply a shared transform scale to
  // every pager item instead.
  const imageScrollRef = useRef<ScrollView>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const setZoom = (next: number) => {
    const clamped = Math.max(1, Math.min(5, next));
    setZoomLevel(clamped);
    if (isMultiPage) {
      // Buttons-only zoom in multi-page mode; transform applied in render.
      return;
    }
    // iOS supports programmatic zoom via scrollResponderZoomTo. Android's
    // RN <ScrollView> ignores `maximumZoomScale`, so the buttons simply
    // scale the inner Image view on Android via transform (fallback).
    const node: any = imageScrollRef.current;
    if (Platform.OS === 'ios' && node?.scrollResponderZoomTo) {
      const visibleW = SW - 32;
      const w = visibleW / clamped;
      const h = IMAGE_H / clamped;
      node.scrollResponderZoomTo({
        x: (visibleW - w) / 2,
        y: (IMAGE_H - h) / 2,
        width: w,
        height: h,
        animated: true,
      });
    }
  };

  // ── Multi-page pager ──────────────────────────────────────────────────────
  const pagerRef = useRef<FlatList<string>>(null);
  const [currentPage, setCurrentPage] = useState(0);
  // Paged item width — `imageCard` spans content-width (SW - padding*2 = SW - 32).
  const PAGE_W = SW - 32;

  const handlePagerMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / PAGE_W);
    if (idx !== currentPage) {
      setCurrentPage(idx);
      // Reset zoom when the teacher swipes to a different page so each page
      // starts at 1×, matching the single-page UX.
      setZoomLevel(1);
    }
  };

  // ── Verdict row tap → open modal ────────────────────────────────────────────
  const openEdit = (v: GradingVerdict) => setEditingVerdict(v);
  const closeEdit = () => setEditingVerdict(null);

  const saveEdit = (next: GradingVerdict) => {
    setVerdicts((prev) =>
      prev.map((v) => (v.question_number === next.question_number ? next : v)),
    );
    setEditedQuestions((prev) => new Set(prev).add(next.question_number));
    setEditingVerdict(null);
  };

  // ── Actions ─────────────────────────────────────────────────────────────────
  const wasEdited = editedQuestions.size > 0 || overallFeedback.trim().length > 0;

  const handleApprove = async () => {
    if (!result.mark_id) {
      Alert.alert('Cannot approve', 'This mark has no server ID. Try submitting again.');
      return;
    }
    // Local marks have no server-side mark_id — the Approve / PUT /marks
    // flow would 404. The scan has already been queued for replay on
    // reconnect (see PageReviewScreen.handleSubmit), so the right move
    // here is to tell the teacher what will happen and treat the tap
    // like Skip (advance the queue, don't bump the approved counter).
    if (isLocallyGraded || result.mark_id.startsWith('local_')) {
      Alert.alert(
        'Grade saved offline',
        "We'll re-grade this in the cloud and drop it in your review list the next time you're online. Moving on to the next student.",
        [{ text: 'OK', onPress: () => onDone({ approved: false }) }],
      );
      return;
    }
    setApproving(true);
    try {
      await updateMark(result.mark_id, {
        verdicts: verdicts.map((v) => ({
          question_number: v.question_number,
          verdict: v.verdict,
          awarded_marks: v.awarded_marks,
          max_marks: v.max_marks,
          feedback: v.feedback,
        })),
        overall_feedback: overallFeedback.trim() || undefined,
        manually_edited: wasEdited,
        approved: true,
      });
      onDone({ approved: true });
    } catch (err: any) {
      Alert.alert('Could not approve', err.message ?? 'Please try again.');
    } finally {
      setApproving(false);
    }
  };

  const handleSkip = () => {
    // No API call — mark stays approved=false on the backend.
    onDone({ approved: false });
  };

  const handleDelete = () => {
    if (!result.mark_id) {
      Alert.alert('Cannot delete', 'This mark has no server ID.');
      return;
    }
    const hwLabel = 'this homework';
    Alert.alert(
      'Delete submission?',
      `This will permanently delete ${studentName}'s submission for ${hwLabel}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setApproving(true);
            try {
              await deleteMark(result.mark_id);
              // Deleted — advance like skip, but flag so parent doesn't
              // bump the approved counter.
              onDone({ approved: false, deleted: true });
            } catch (err: any) {
              Alert.alert('Could not delete', err.message ?? 'Please try again.');
            } finally {
              setApproving(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.flex}>
      {/* Transient "Graded on-device" badge — shows for 5 s after a local
          grade completes, silent for cloud grades. */}
      <OfflineGradedToast visible={isLocallyGraded} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Student name + live score on one row, left/right. Raw score and
            percentage are both carried here so the old scoreBadge row below
            is no longer needed. `pctColour` follows the 75 / 50 / else
            palette used throughout the app. */}
        <View style={styles.headerRow}>
          <Text style={styles.studentLabel}>
            <Text style={styles.labelKey}>Student: </Text>
            <Text style={styles.labelValue}>{studentName}</Text>
          </Text>
          <Text style={styles.markLabel}>
            <Text style={styles.labelKey}>Mark: </Text>
            <Text style={styles.labelValue}>{totalAwarded}/{totalMax}</Text>
            <Text style={styles.labelKey}> | </Text>
            <Text style={[styles.labelValue, { color: pctColour }]}>{percentage}%</Text>
            {wasEdited && <Text style={styles.labelKey}> · edited</Text>}
          </Text>
        </View>

        {/* Zoomable annotated image(s) */}
        <View style={styles.imageCard}>
          {isMultiPage ? (
            <FlatList
              ref={pagerRef}
              data={pages}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              keyExtractor={(uri, i) => `${i}-${uri}`}
              onMomentumScrollEnd={handlePagerMomentumEnd}
              getItemLayout={(_, index) => ({ length: PAGE_W, offset: PAGE_W * index, index })}
              renderItem={({ item, index }) => (
                <View style={styles.pagerItem}>
                  <Image
                    source={{ uri: item }}
                    style={[styles.annotatedImage, { transform: [{ scale: zoomLevel }] }]}
                    resizeMode="contain"
                  />
                  <LocalAnnotationOverlay
                    verdicts={verdictsByPage[index] ?? []}
                    width={PAGE_W}
                    height={IMAGE_H}
                    imageUri={item}
                    // Score bubble only on the last page so multi-page
                    // submissions don't duplicate it.
                    summary={
                      index === pages.length - 1
                        ? { score: totalAwarded, max_score: totalMax, percentage }
                        : undefined
                    }
                  />
                </View>
              )}
            />
          ) : (
            <ScrollView
              ref={imageScrollRef}
              style={styles.imageScroll}
              contentContainerStyle={styles.imageScrollContent}
              maximumZoomScale={5}
              minimumZoomScale={1}
              bouncesZoom
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              centerContent
              pinchGestureEnabled
            >
              <Image
                source={{ uri: pages[0] }}
                style={[
                  styles.annotatedImage,
                  Platform.OS === 'android' && { transform: [{ scale: zoomLevel }] },
                ]}
                resizeMode="contain"
              />
            </ScrollView>
          )}
          {!isMultiPage && (
            <LocalAnnotationOverlay
              verdicts={verdicts}
              width={SW - 32}
              height={IMAGE_H}
              imageUri={pages[0]}
              summary={{ score: totalAwarded, max_score: totalMax, percentage }}
            />
          )}

          {/* Zoom controls, top-right over the image */}
          <View style={styles.zoomControls}>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(zoomLevel + 0.5)}>
              <Text style={styles.zoomBtnText}>＋</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(zoomLevel - 0.5)}>
              <Text style={styles.zoomBtnText}>－</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(1)}>
              <Text style={styles.zoomBtnText}>⊡</Text>
            </TouchableOpacity>
          </View>

          {/* Page indicator — only shown when there's more than one page. */}
          {isMultiPage && (
            <View style={styles.pageIndicator}>
              <Text style={styles.pageIndicatorText}>
                {currentPage + 1} / {pages.length}
              </Text>
            </View>
          )}
        </View>

        {/* Per-question comments — collapsible. Tap the header to toggle. */}
        {verdicts.length > 0 && (
          <>
            <TouchableOpacity
              onPress={() => setQuestionsExpanded((v) => !v)}
              style={styles.sectionHeader}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={questionsExpanded ? 'Collapse per question comments' : 'Expand per question comments'}
            >
              <Text style={styles.sectionTitle}>Per Question Comments</Text>
              <Ionicons
                name={questionsExpanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={COLORS.gray500}
              />
            </TouchableOpacity>
            {questionsExpanded && (
              <>
                <Text style={styles.breakdownHint}>Tap a row to edit the verdict.</Text>
                {verdicts.map((verdict) => {
              const edited = editedQuestions.has(verdict.question_number);
              return (
                <TouchableOpacity
                  key={verdict.question_number}
                  style={styles.verdictRow}
                  onPress={() => openEdit(verdict)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.questionNum}>Q{verdict.question_number}</Text>
                  <Text
                    style={[styles.verdictIcon, { color: VERDICT_COLOUR[verdict.verdict] }]}
                  >
                    {VERDICT_LABEL[verdict.verdict]}
                  </Text>
                  <Text style={styles.marks}>
                    {verdict.awarded_marks}/{verdict.max_marks}
                  </Text>
                  <View style={styles.rowTail}>
                    {verdict.feedback ? (
                      <Text numberOfLines={2} style={styles.feedback}>
                        {verdict.feedback}
                      </Text>
                    ) : null}
                    {edited && <Text style={styles.editedBadge}>Edited</Text>}
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            })}
              </>
            )}
          </>
        )}

        {/* Overall feedback — collapsible. Tap the header to toggle. */}
        <TouchableOpacity
          onPress={() => setFeedbackExpanded(v => !v)}
          style={styles.sectionHeader}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={feedbackExpanded ? 'Collapse overall feedback' : 'Expand overall feedback'}
        >
          <Text style={styles.sectionTitle}>Overall Feedback</Text>
          <Ionicons
            name={feedbackExpanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={COLORS.gray500}
          />
        </TouchableOpacity>
        {feedbackExpanded && (
          <TextInput
            style={styles.overallInput}
            value={overallFeedback}
            onChangeText={setOverallFeedback}
            placeholder="Add overall feedback for this student..."
            placeholderTextColor={COLORS.gray500}
            multiline
            textAlignVertical="top"
          />
        )}

        {/* Actions */}
        <TouchableOpacity
          style={[styles.approveBtn, approving && styles.btnDisabled]}
          onPress={handleApprove}
          disabled={approving}
        >
          {approving ? (
            <ActivityIndicator color={COLORS.white} />
          ) : (
            <Text style={styles.approveBtnText}>Approve & Next Student</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.skipBtn, approving && styles.btnDisabled]}
          onPress={handleSkip}
          disabled={approving}
        >
          <Text style={styles.skipBtnText}>Skip (don't approve)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.deleteLink, approving && styles.btnDisabled]}
          onPress={handleDelete}
          disabled={approving}
          accessibilityLabel="Delete this submission"
        >
          <Text style={styles.deleteLinkText}>Delete this submission</Text>
        </TouchableOpacity>
      </ScrollView>

      <EditVerdictModal
        visible={editingVerdict !== null}
        verdict={editingVerdict}
        onCancel={closeEdit}
        onSave={saveEdit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.white },
  container: { flex: 1, backgroundColor: COLORS.white },
  content: { padding: 16, paddingBottom: 40 },
  studentName: { fontSize: 22, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  studentLabel: { fontSize: 15 },
  markLabel: { fontSize: 15 },
  labelKey: { color: COLORS.textLight, fontWeight: '400' },
  labelValue: { color: COLORS.text, fontWeight: '700' },

  scoreBadge: {
    flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 16,
  },
  scoreNumber: { fontSize: 36, fontWeight: 'bold', color: COLORS.text },
  scorePercent: { fontSize: 20, fontWeight: '600' },
  editedFlag: { fontSize: 13, color: COLORS.amber500, fontWeight: '600', marginLeft: 4 },

  imageCard: {
    width: '100%', height: IMAGE_H, borderRadius: 8,
    backgroundColor: COLORS.background, marginBottom: 24, overflow: 'hidden',
  },
  imageScroll: { flex: 1 },
  imageScrollContent: { flexGrow: 1, justifyContent: 'center' },
  annotatedImage: { width: '100%', height: IMAGE_H },
  pagerItem: {
    width: SW - 32,
    height: IMAGE_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageIndicator: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  pageIndicatorText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '700',
  },
  zoomControls: {
    position: 'absolute', top: 8, right: 8, flexDirection: 'column', gap: 6,
  },
  zoomBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  zoomBtnText: { color: COLORS.white, fontSize: 20, fontWeight: '700' },

  // Shared style for every collapsible section header (tappable row with
  // title on the left and chevron on the right).
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 16, fontWeight: '600', color: COLORS.text,
  },
  breakdownHint: { fontSize: 12, color: COLORS.gray500, marginBottom: 8 },

  verdictRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 10,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    borderRadius: 6,
  },
  questionNum: { width: 32, fontSize: 14, color: COLORS.gray500 },
  verdictIcon: { width: 20, fontSize: 18, fontWeight: 'bold' },
  marks: { fontSize: 13, color: COLORS.text, minWidth: 44 },
  rowTail: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  feedback: { fontSize: 12, color: COLORS.textLight, flexShrink: 1 },
  editedBadge: {
    fontSize: 10, fontWeight: '700', color: COLORS.amber500,
    backgroundColor: COLORS.amber50, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, overflow: 'hidden',
  },
  chevron: { fontSize: 20, color: COLORS.gray200, marginLeft: 2 },

  overallInput: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: COLORS.text, minHeight: 80, marginBottom: 20,
  },

  approveBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', marginTop: 8,
  },
  approveBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },

  skipBtn: {
    borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 10,
  },
  skipBtnText: { color: COLORS.text, fontWeight: '600', fontSize: 15 },

  deleteLink: {
    alignSelf: 'center', paddingVertical: 12, marginTop: 8,
  },
  deleteLinkText: { color: COLORS.error, fontSize: 12, fontWeight: '600' },

  btnDisabled: { opacity: 0.5 },
});
