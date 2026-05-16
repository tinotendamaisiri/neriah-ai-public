// src/screens/GradingDetailScreen.tsx
// Teacher detail view for a single student mark.
// Shows per-question verdicts with editable marks and per-question comments,
// plus an overall feedback field. Teacher saves edits and optionally approves.

import React, { useCallback, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
  Dimensions,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';
import { getMarkById, updateMark, deleteMark } from '../services/api';
import { GradingVerdict, Mark } from '../types';
import { COLORS } from '../constants/colors';

interface EditableVerdict {
  question_number: number;
  verdict: string;
  awarded_marks: string; // string so TextInput stays controlled
  max_marks: number;
  feedback: string;
}

function verdictColor(v: string): string {
  if (v === 'correct') return COLORS.success;
  if (v === 'partial') return COLORS.warning;
  return COLORS.error;
}

function verdictIcon(v: string): string {
  if (v === 'correct') return '✓';
  if (v === 'partial') return '~';
  return '✗';
}

export default function GradingDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { mark_id, student_name, class_name, answer_key_title } = route.params as {
    mark_id: string;
    student_name: string;
    class_name: string;
    answer_key_title: string;
  };

  // Locally-graded marks live in the offline queue under a synthesised
  // id "local_q_<queueId>". We branch every read + write at the
  // boundary: load reads the queue item, save writes it back via
  // updateQueuedScan, delete removes it from the queue. When the device
  // is online, replayQueue (NetworkBanner / useSyncCoordinator) sends
  // the queue item to /api/mark and the cloud creates the canonical
  // Mark; from that point on the homework list shows the real cloud
  // row and taps go through the standard cloud branch below.
  const isLocalMark = mark_id?.startsWith('local_q_') ?? false;
  const queueId = isLocalMark ? mark_id.slice('local_q_'.length) : null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasVerdicts, setHasVerdicts] = useState(false);
  const [verdicts, setVerdicts] = useState<EditableVerdict[]>([]);
  const [totalScore, setTotalScore] = useState('');
  const [totalMax, setTotalMax] = useState('');
  const [overallFeedback, setOverallFeedback] = useState('');
  const [approved, setApproved] = useState(false);
  const [manuallyEdited, setManuallyEdited] = useState(false);
  // The submitted document — annotated pages preferred, fall back to
  // originals, then to legacy single-page marked_image_url. Same source
  // of truth as the post-scan MarkResult flow so the teacher sees the
  // actual paper regardless of how it was submitted (in-app scan,
  // WhatsApp, email).
  const [pages, setPages] = useState<string[]>([]);
  // Per-section collapsed state — default closed so the document is the
  // first thing the teacher sees. Tap a section header to expand.
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);
  const [feedbackExpanded, setFeedbackExpanded] = useState(false);

  // ── Document viewer state — mirrors MarkResult ─────────────────────────────
  // Single page: iOS native pinch via ScrollView.maximumZoomScale; Android
  // falls back to button-driven transform scale on the inner Image.
  // Multi-page: horizontal pager FlatList + button-driven scale (nested
  // ScrollView would break horizontal paging on Android).
  const imageScrollRef = useRef<ScrollView>(null);
  const pagerRef = useRef<FlatList<string>>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);

  const isMultiPage = pages.length > 1;
  const SW = Dimensions.get('window').width;
  const IMAGE_H = 420;
  const PAGE_W = SW - 32;

  const setZoom = (next: number) => {
    const clamped = Math.max(1, Math.min(5, next));
    setZoomLevel(clamped);
    if (isMultiPage) return; // multi-page uses transform only
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

  const handlePagerMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / PAGE_W);
    if (idx !== currentPage) {
      setCurrentPage(idx);
      setZoomLevel(1); // each page starts at 1×
    }
  };

  // Snapshot of the mark as the teacher first saw it, taken on load. Used
  // to decide whether the teacher actually changed anything before they
  // press Save / Approve. Without this, every save flagged the mark as
  // "Teacher-edited" — even when the teacher only tapped Approve.
  const originalRef = useRef<{
    verdicts: { qn: number; awarded: string; feedback: string }[];
    totalScore: string;
    overallFeedback: string;
  }>({ verdicts: [], totalScore: '', overallFeedback: '' });

  const loadMark = useCallback(async () => {
    setLoading(true);
    try {
      // ── Local-queue branch: build a Mark-shaped view from the
      //    QueuedScan instead of hitting /api/marks/<id>. The
      //    /api request would 404 because the cloud has never seen
      //    this mark — it only exists on this phone until replay.
      if (isLocalMark && queueId) {
        const { getQueue } = await import('../services/offlineQueue');
        const queue = await getQueue();
        const item = queue.find(q => q.id === queueId);
        if (!item) {
          // Queue replayed already (or got cleared) → the synthesised
          // id is now stale. Quietly bail; the previous screen
          // refetches on focus and will show the real cloud row.
          navigation.goBack();
          return;
        }
        const rawVerdicts = (item.pre_graded_verdicts ?? []) as unknown as GradingVerdict[];
        let initialTotalScore = '';
        let initialVerdictSnapshot: { qn: number; awarded: string; feedback: string }[] = [];
        if (rawVerdicts.length > 0) {
          setHasVerdicts(true);
          const editable = rawVerdicts.map(v => ({
            question_number: v.question_number,
            verdict: v.verdict,
            awarded_marks: String(v.awarded_marks),
            max_marks: v.max_marks,
            feedback: v.feedback ?? '',
          }));
          setVerdicts(editable);
          initialVerdictSnapshot = editable.map(v => ({
            qn: v.question_number,
            awarded: v.awarded_marks,
            feedback: v.feedback,
          }));
          const totalAwarded = rawVerdicts.reduce((s, v) => s + Number(v.awarded_marks ?? 0), 0);
          const totalMaxV = rawVerdicts.reduce((s, v) => s + Number(v.max_marks ?? 0), 0);
          setTotalMax(String(totalMaxV));
          setTotalScore(String(totalAwarded));
        } else {
          setHasVerdicts(false);
        }
        setOverallFeedback('');
        setApproved(!!item.approved);
        setManuallyEdited(false);
        // Original page URIs as fallback for annotated pages — the
        // offline path doesn't render server-side annotations yet.
        setPages(item.pages?.map(p => p.uri).filter(Boolean) ?? []);
        originalRef.current = {
          verdicts: initialVerdictSnapshot,
          totalScore: initialTotalScore,
          overallFeedback: '',
        };
        return;
      }

      const mark = await getMarkById(mark_id);
      const rawVerdicts: GradingVerdict[] = mark.verdicts ?? [];
      let initialTotalScore = '';
      let initialVerdictSnapshot: { qn: number; awarded: string; feedback: string }[] = [];
      if (rawVerdicts.length > 0) {
        setHasVerdicts(true);
        const editable = rawVerdicts.map(v => ({
          question_number: v.question_number,
          verdict: v.verdict,
          awarded_marks: String(v.awarded_marks),
          max_marks: v.max_marks,
          feedback: v.feedback ?? '',
        }));
        setVerdicts(editable);
        initialVerdictSnapshot = editable.map(v => ({
          qn: v.question_number,
          awarded: v.awarded_marks,
          feedback: v.feedback,
        }));
      } else {
        setHasVerdicts(false);
        initialTotalScore = String(mark.score ?? 0);
        setTotalScore(initialTotalScore);
        setTotalMax(String(mark.max_score ?? 0));
      }
      const initialOverall = mark.feedback ?? '';
      setOverallFeedback(initialOverall);
      setApproved(mark.approved ?? false);
      setManuallyEdited(mark.manually_edited ?? false);
      // Populate the document viewer. Prefer annotated, then originals,
      // then the legacy single-page url. None of these may be present on
      // very old marks — the viewer hides itself in that case.
      const m = mark as Mark;
      const documentPages: string[] = (
        (m.annotated_urls && m.annotated_urls.length > 0)
          ? m.annotated_urls
          : (m.page_urls && m.page_urls.length > 0)
            ? m.page_urls
            : (m.marked_image_url ? [m.marked_image_url] : [])
      );
      setPages(documentPages);
      originalRef.current = {
        verdicts: initialVerdictSnapshot,
        totalScore: initialTotalScore,
        overallFeedback: initialOverall,
      };
    } catch (err: any) {
      // Offline + this mark hasn't been viewed online yet → it's
      // simply not in cache. Bouncing the teacher back with an alert
      // doesn't help; just goBack quietly so they see the homework
      // page and can pick a different submission to view.
      if (!err?.isOffline) {
        Alert.alert('Error', err.message ?? 'Could not load mark details.');
      }
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [mark_id]);

  useFocusEffect(
    useCallback(() => { loadMark(); }, [loadMark]),
  );

  const updateVerdictField = (qNum: number, field: 'awarded_marks' | 'feedback', value: string) => {
    setVerdicts(prev =>
      prev.map(v => v.question_number === qNum ? { ...v, [field]: value } : v)
    );
  };

  const handleSave = async (shouldApprove = false) => {
    setSaving(true);
    try {
      // Did the teacher actually change anything since the screen loaded?
      // Approving alone is not an "edit" — the badge should only flag
      // submissions where marks or feedback were genuinely modified.
      const original = originalRef.current;
      const overallChanged = overallFeedback !== original.overallFeedback;
      let verdictsChanged = false;
      if (hasVerdicts) {
        const byQn = new Map(original.verdicts.map(v => [v.qn, v]));
        verdictsChanged = (verdicts ?? []).some(v => {
          const o = byQn.get(v.question_number);
          if (!o) return true; // new verdict that wasn't in the original
          return o.awarded !== v.awarded_marks || o.feedback !== v.feedback;
        });
      } else {
        verdictsChanged = totalScore !== original.totalScore;
      }
      // Sticky: once a mark has been teacher-edited it stays flagged even
      // if the teacher reverts. We never silently clear the flag here.
      const editedFlag = manuallyEdited || overallChanged || verdictsChanged;

      const payload: Parameters<typeof updateMark>[1] = {
        overall_feedback: overallFeedback || undefined,
        manually_edited: editedFlag,
      };

      if (hasVerdicts) {
        const parsed = (verdicts ?? []).map(v => ({
          question_number: v.question_number,
          verdict: v.verdict,
          awarded_marks: parseFloat(v.awarded_marks) || 0,
          max_marks: v.max_marks,
          feedback: v.feedback || undefined,
        }));
        payload.verdicts = parsed;
        // score/max_score recomputed server-side from verdicts
      } else {
        payload.score = parseFloat(totalScore) || 0;
        payload.max_score = parseFloat(totalMax) || 0;
      }

      if (shouldApprove) {
        payload.approved = true;
      }

      // Local-queue mark: write changes back to the queue item rather
      // than calling /api/marks (which would 404). When replay fires the
      // updated verdicts + approved flag are what gets shipped to the
      // cloud, so the teacher's edits land on the canonical Mark
      // without a separate update call.
      if (isLocalMark && queueId) {
        const { updateQueuedScan } = await import('../services/offlineQueue');
        await updateQueuedScan(queueId, {
          pre_graded_verdicts: payload.verdicts as Array<Record<string, unknown>> | undefined,
          approved: shouldApprove ? true : undefined,
        });
        Alert.alert(
          shouldApprove ? 'Approved' : 'Saved',
          shouldApprove
            ? 'Mark approved on this phone. It will be released to the student when this device next syncs with the cloud.'
            : 'Changes saved on this phone. They will sync when you next connect to the internet.',
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }

      await updateMark(mark_id, payload);
      Alert.alert(
        shouldApprove ? 'Approved' : 'Saved',
        shouldApprove
          ? 'Mark saved and released to the student.'
          : 'Changes saved.',
        [{ text: 'OK', onPress: () => navigation.goBack() }],
      );
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  // Delete pattern mirrors MarkResult.tsx and GradingResultsScreen.tsx so
  // teachers see the same confirm copy across every surface that can
  // trigger a cascade delete.
  const handleDelete = () => {
    if (!mark_id) {
      Alert.alert('Cannot delete', 'This mark has no server ID.');
      return;
    }
    Alert.alert(
      'Delete submission?',
      `This will permanently delete ${student_name}'s submission for ${answer_key_title}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            try {
              if (isLocalMark && queueId) {
                // Drop the queue item so it never replays. No cloud
                // record exists yet, so there's nothing else to delete.
                const { removeFromQueue } = await import('../services/offlineQueue');
                await removeFromQueue(queueId);
              } else {
                await deleteMark(mark_id);
              }
              Alert.alert(
                'Deleted',
                'Submission deleted.',
                [{ text: 'OK', onPress: () => navigation.goBack() }],
              );
            } catch (err: any) {
              Alert.alert('Could not delete', err.message ?? 'Please try again.');
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']} keyboardVerticalOffset={80}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header — back button + title block side-by-side. The Teacher-edited
            badge appears under the Approved badge (right column) — and only
            when the teacher actually changed something before approving. */}
        <View style={styles.header}>
          <BackButton />
          <View style={styles.headerTitleBlock}>
            <View style={styles.titleRow}>
              <View style={styles.titleLeft}>
                <Text style={styles.studentName}>{student_name}</Text>
                <Text style={styles.homeworkTitle}>{answer_key_title}</Text>
              </View>
              <View style={styles.titleRight}>
                {approved && (
                  <View style={styles.approvedBadge}>
                    <Text style={styles.approvedBadgeText}>Approved</Text>
                  </View>
                )}
                {manuallyEdited && (
                  <View style={styles.editedHintRow}>
                    <Ionicons name="pencil-outline" size={12} color={COLORS.amber500} />
                    <Text style={styles.editedHint}> Teacher-edited</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        {/* Submitted work — same document viewer used in the post-scan flow.
            Pinch to zoom (iOS), +/-/reset buttons (both platforms), swipe
            sideways to page through multi-page submissions. */}
        {pages.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Submitted Work</Text>
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
                  getItemLayout={(_, index) => ({
                    length: PAGE_W, offset: PAGE_W * index, index,
                  })}
                  renderItem={({ item }) => (
                    <View style={[styles.pagerItem, { width: PAGE_W, height: IMAGE_H }]}>
                      <Image
                        source={{ uri: item }}
                        style={[styles.annotatedImage, { transform: [{ scale: zoomLevel }] }]}
                        resizeMode="contain"
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

              {/* Page indicator — only when there's more than one page. */}
              {isMultiPage && (
                <View style={styles.pageIndicator}>
                  <Text style={styles.pageIndicatorText}>
                    {currentPage + 1} / {pages.length}
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Per-question section — collapsible */}
        {hasVerdicts ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.collapsibleHeader}
              onPress={() => setBreakdownExpanded(v => !v)}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={breakdownExpanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={COLORS.gray500}
              />
              <Text style={styles.sectionTitle}>Question Breakdown</Text>
            </TouchableOpacity>
            {breakdownExpanded && (verdicts ?? []).map(v => (
              <View key={v.question_number} style={styles.verdictCard}>
                <View style={styles.verdictTop}>
                  <View style={[styles.iconCircle, { backgroundColor: verdictColor(v.verdict) }]}>
                    <Text style={styles.iconText}>{verdictIcon(v.verdict)}</Text>
                  </View>
                  <Text style={styles.qNum}>Q{v.question_number}</Text>
                  <View style={styles.marksRow}>
                    <TextInput
                      style={styles.marksInput}
                      value={v.awarded_marks}
                      onChangeText={val => updateVerdictField(v.question_number, 'awarded_marks', val)}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                    <Text style={styles.marksDivider}> / {v.max_marks}</Text>
                  </View>
                </View>
                <TextInput
                  style={[styles.commentInput, !v.feedback && styles.commentEmpty]}
                  value={v.feedback}
                  onChangeText={val => updateVerdictField(v.question_number, 'feedback', val)}
                  placeholder="Add comment..."
                  placeholderTextColor={COLORS.gray500}
                  multiline
                  textAlignVertical="top"
                />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.collapsibleHeader}
              onPress={() => setBreakdownExpanded(v => !v)}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={breakdownExpanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={COLORS.gray500}
              />
              <Text style={styles.sectionTitle}>Score</Text>
            </TouchableOpacity>
            {breakdownExpanded && <>
              <Text style={styles.sectionHint}>No auto-grading data. Enter the score manually.</Text>
              <View style={styles.manualScoreRow}>
                <View style={styles.manualField}>
                  <Text style={styles.manualLabel}>Awarded</Text>
                  <TextInput
                    style={styles.manualInput}
                    value={totalScore}
                    onChangeText={setTotalScore}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
                <Text style={styles.manualSep}>/</Text>
                <View style={styles.manualField}>
                  <Text style={styles.manualLabel}>Out of</Text>
                  <TextInput
                    style={styles.manualInput}
                    value={totalMax}
                    onChangeText={setTotalMax}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
              </View>
            </>}
          </View>
        )}

        {/* Overall feedback — collapsible */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => setFeedbackExpanded(v => !v)}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={feedbackExpanded ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color={COLORS.gray500}
            />
            <Text style={styles.sectionTitle}>Overall Feedback</Text>
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
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.btnDisabled]}
            onPress={() => handleSave(false)}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={COLORS.white} size="small" />
              : <Text style={styles.saveBtnText}>Save Changes</Text>
            }
          </TouchableOpacity>
          {!approved && (
            <TouchableOpacity
              style={[styles.approveBtn, saving && styles.btnDisabled]}
              onPress={() => handleSave(true)}
              disabled={saving}
            >
              <Text style={styles.approveBtnText}>Save & Approve ✓</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.deleteLink, saving && styles.btnDisabled]}
            onPress={handleDelete}
            disabled={saving}
            accessibilityLabel="Delete submission"
          >
            <Text style={styles.deleteLinkText}>Delete submission</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 60 }} />
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  scroll: { flex: 1 },
  content: { paddingBottom: 24 },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    backgroundColor: COLORS.white, paddingHorizontal: 20,
    paddingTop: 16, paddingBottom: 20,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitleBlock: { flex: 1 },
  backText: { fontSize: 14, color: COLORS.teal500, marginBottom: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  titleLeft: { flex: 1 },
  studentName: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  homeworkTitle: { fontSize: 14, color: COLORS.gray500, marginTop: 3 },
  approvedBadge: {
    backgroundColor: COLORS.teal50, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4, marginLeft: 10,
  },
  approvedBadgeText: { fontSize: 12, color: COLORS.teal500, fontWeight: '700' },
  titleRight: { alignItems: 'flex-end' },
  editedHintRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  editedHint: { fontSize: 12, color: COLORS.amber500 },

  section: {
    backgroundColor: COLORS.white, marginHorizontal: 16, marginTop: 16,
    borderRadius: 12, padding: 16,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  collapsibleHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  // Document viewer — mirrors MarkResult: 420 px tall card with pinch
  // zoom (iOS), button zoom (both), and horizontal pager for multi-page.
  imageCard: {
    width: '100%', height: 420, borderRadius: 8,
    backgroundColor: COLORS.gray50, overflow: 'hidden',
    position: 'relative',
  },
  imageScroll: { flex: 1 },
  imageScrollContent: { flexGrow: 1, justifyContent: 'center' },
  annotatedImage: { width: '100%', height: 420 },
  pagerItem: { alignItems: 'center', justifyContent: 'center' },
  pageIndicator: {
    position: 'absolute', bottom: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
  },
  pageIndicatorText: { color: COLORS.white, fontSize: 12, fontWeight: '700' },
  zoomControls: {
    position: 'absolute', top: 8, right: 8, flexDirection: 'column', gap: 6,
  },
  zoomBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  zoomBtnText: { color: COLORS.white, fontSize: 20, fontWeight: '700' },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: COLORS.gray500,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12,
  },
  sectionHint: { fontSize: 13, color: COLORS.textLight, marginBottom: 12 },

  verdictCard: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    padding: 12, marginBottom: 10,
  },
  verdictTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  iconCircle: {
    width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
  },
  iconText: { color: COLORS.white, fontSize: 13, fontWeight: '900' },
  qNum: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginLeft: 8, flex: 1 },
  marksRow: { flexDirection: 'row', alignItems: 'center' },
  marksInput: {
    borderWidth: 1, borderColor: COLORS.teal300, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4,
    fontSize: 15, fontWeight: '700', color: COLORS.teal500,
    minWidth: 44, textAlign: 'center',
  },
  marksDivider: { fontSize: 14, color: COLORS.gray500, marginLeft: 2 },
  commentInput: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 13, color: COLORS.text, minHeight: 40,
  },
  commentEmpty: { borderStyle: 'dashed', borderColor: COLORS.gray200 },

  manualScoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  manualField: { alignItems: 'center', gap: 6 },
  manualLabel: { fontSize: 12, color: COLORS.gray500, fontWeight: '600', textTransform: 'uppercase' },
  manualInput: {
    borderWidth: 1, borderColor: COLORS.teal300, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 22, fontWeight: 'bold', color: COLORS.teal500,
    minWidth: 80, textAlign: 'center',
  },
  manualSep: { fontSize: 28, color: COLORS.gray500, fontWeight: '300', marginTop: 18 },

  overallInput: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: COLORS.text, minHeight: 100,
  },

  actions: { marginHorizontal: 16, marginTop: 20, gap: 10 },
  saveBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
  },
  saveBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
  approveBtn: {
    backgroundColor: COLORS.white, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
    borderWidth: 2, borderColor: COLORS.teal500,
  },
  approveBtnText: { color: COLORS.teal500, fontWeight: 'bold', fontSize: 16 },
  deleteLink: {
    alignSelf: 'center', paddingVertical: 12, marginTop: 4,
  },
  deleteLinkText: { color: COLORS.error, fontSize: 12, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
});
