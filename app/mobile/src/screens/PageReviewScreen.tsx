// src/screens/PageReviewScreen.tsx
// Multi-page submission staging screen.
//
// Flow: MarkingScreen captures the FIRST page via InAppCamera, navigates
// here with that page in initialPages. Teacher can:
//   - tap "+ Add page" to capture more (up to 5)
//   - tap a thumbnail to view it full-screen + zoom
//   - tap the X on a thumbnail to delete (with Alert confirm)
//   - reorder via up/down chevrons (no draggable-flatlist installed)
//   - tap "Submit N pages for grading"
//
// On submit success, navigates back to MarkingScreen with the markResult
// in route params. MarkingScreen re-runs its existing post-scan logic.
// On 409 DUPLICATE_SUBMISSION, navigates back with markError so MarkingScreen's
// "Replace existing?" dialog fires.

import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
  ActivityIndicator,
  Dimensions,
  Platform,
  Animated,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import {
  PinchGestureHandler,
  TapGestureHandler,
  State as GestureState,
  PinchGestureHandlerGestureEvent,
  PinchGestureHandlerStateChangeEvent,
  TapGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import InAppCamera from '../components/InAppCamera';
import { submitTeacherScan } from '../services/api';
import {
  queueMarkingScan,
  resolveRoute,
  gradeScanOffline,
  type OnDeviceUserContext,
} from '../services/router';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../constants/colors';
import { CapturedPage, RootStackParamList, MarkResult as MarkResultType } from '../types';

const { width: SW } = Dimensions.get('window');
const MAX_PAGES = 5;
const IMAGE_HEIGHT = 380;

type Route = { key: string; name: 'PageReview'; params: RootStackParamList['PageReview'] };

function _uid(): string {
  return `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * True when an answer key's subject string looks like math.
 * Used to gate offline grading — E2B (the on-device model both roles
 * share) can't reliably grade multi-step math, and MLKit OCR mangles
 * handwritten math notation before the LLM sees it. We block the
 * offline path for math-flavoured subjects and queue the scan for
 * cloud replay instead.
 *
 * Kept permissive — substring matches catch "Mathematics", "Maths Paper 2",
 * "Algebra 1", etc. Physics / Chemistry / Biology stay offline-eligible
 * because their grading is closer to text recall + concept matching, where
 * E2B handles itself well; only pure math / its sub-disciplines are gated.
 */
function isMathSubject(subject?: string | null): boolean {
  if (!subject) return false;
  const s = subject.toLowerCase();
  return (
    s.includes('math') ||
    s.includes('algebra') ||
    s.includes('geometry') ||
    s.includes('calculus') ||
    s.includes('trigonometry') ||
    s.includes('arithmetic')
  );
}

// ── ZoomableImage ────────────────────────────────────────────────────────────
// Pinch-to-zoom image tile used inside the horizontal paginated pager.
//
// Implementation: react-native-gesture-handler's PinchGestureHandler (for
// scale) + TapGestureHandler with numberOfTaps=2 (for reset). Animated
// values from 'react-native' drive a transform — no reanimated needed.
//
// Reports zoom state via onZoomChange so the parent can disable outer
// paging while the image is zoomed (so horizontal drags pan inside the
// zoomed image instead of flipping pages — though pan itself isn't wired
// yet; this is "zoom to inspect, pinch out to un-zoom", no drag-pan).
interface ZoomableImageProps {
  uri: string;
  zoomed: boolean;
  onZoomChange: (zoomed: boolean) => void;
}

const ZoomableImage = React.memo(function ZoomableImage({
  uri,
  onZoomChange,
}: ZoomableImageProps) {
  const baseScale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const composedScale = useRef(Animated.multiply(baseScale, pinchScale)).current;
  const lastScale = useRef(1);

  const onPinchEvent = useRef(
    Animated.event<PinchGestureHandlerGestureEvent['nativeEvent']>(
      [{ nativeEvent: { scale: pinchScale } }],
      { useNativeDriver: true },
    ),
  ).current;

  const onPinchStateChange = useCallback(
    (e: PinchGestureHandlerStateChangeEvent) => {
      if (e.nativeEvent.oldState === GestureState.ACTIVE) {
        const next = Math.max(1, Math.min(5, lastScale.current * e.nativeEvent.scale));
        lastScale.current = next;
        baseScale.setValue(next);
        pinchScale.setValue(1);
        onZoomChange(next > 1.01);
      }
    },
    [baseScale, pinchScale, onZoomChange],
  );

  const resetZoom = useCallback(() => {
    lastScale.current = 1;
    Animated.parallel([
      Animated.spring(baseScale, { toValue: 1, useNativeDriver: true, bounciness: 0 }),
      Animated.spring(pinchScale, { toValue: 1, useNativeDriver: true, bounciness: 0 }),
    ]).start();
    onZoomChange(false);
  }, [baseScale, pinchScale, onZoomChange]);

  const onDoubleTap = useCallback(
    (e: TapGestureHandlerStateChangeEvent) => {
      if (e.nativeEvent.state === GestureState.ACTIVE) {
        resetZoom();
      }
    },
    [resetZoom],
  );

  return (
    <PinchGestureHandler onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
      <Animated.View style={styles.pagerItem}>
        <TapGestureHandler numberOfTaps={2} onHandlerStateChange={onDoubleTap}>
          <Animated.Image
            source={{ uri }}
            style={[styles.fullImage, { transform: [{ scale: composedScale }] }]}
            resizeMode="contain"
          />
        </TapGestureHandler>
      </Animated.View>
    </PinchGestureHandler>
  );
});

export default function PageReviewScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<Route>();
  const { user } = useAuth();
  const {
    initialPages, studentId, answerKeyId, educationLevel, classId, className, replace,
    answerKey, studentName,
  } = route.params;

  const [pages, setPages] = useState<CapturedPage[]>(initialPages);
  const [selectedId, setSelectedId] = useState<string>(initialPages[0]?.id ?? '');
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Ref for the horizontal paginated main-image FlatList. Used to keep the
  // pager in sync when the teacher taps a thumbnail, adds a page, or deletes
  // the currently-visible page.
  const mainListRef = useRef<FlatList<CapturedPage>>(null);

  // When any page image is pinch-zoomed, the outer pager must stop claiming
  // horizontal drags — otherwise the zoomed page would slide out from under
  // the fingers while pinching or inspecting. Re-enabled once the image is
  // un-zoomed (via pinch-out or double-tap).
  const [zoomedPageId, setZoomedPageId] = useState<string | null>(null);

  const selectedPage = pages.find(p => p.id === selectedId) ?? pages[0];

  // ── Main pager ↔ thumbnail sync ────────────────────────────────────────────
  // Swipe in the main pager → update selectedId so the thumbnail strip
  // highlights the visible page.
  const handleMainMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / SW);
      const page = pages[idx];
      if (page && page.id !== selectedId) {
        setSelectedId(page.id);
      }
    },
    [pages, selectedId],
  );

  // Tap a thumbnail → scroll the main pager to that index (and update selection).
  const selectPage = useCallback(
    (pageId: string) => {
      const idx = pages.findIndex(p => p.id === pageId);
      if (idx < 0) return;
      setSelectedId(pageId);
      mainListRef.current?.scrollToIndex({ index: idx, animated: true });
    },
    [pages],
  );

  // ── Camera handlers ────────────────────────────────────────────────────────
  const openCamera = useCallback(() => {
    if (pages.length >= MAX_PAGES) return;
    setShowCamera(true);
  }, [pages.length]);

  const handleCameraCapture = useCallback((uri: string) => {
    // InAppCamera already cropped to the overlay frame and ran enhanceImage.
    // Width/height aren't surfaced by InAppCamera's onCapture signature today;
    // they're only used by the zoom view, where the Image component infers
    // them. Storing 0/0 — the renderer doesn't depend on them.
    setShowCamera(false);
    const newPage: CapturedPage = {
      id: _uid(),
      uri,
      width: 0,
      height: 0,
      capturedAt: Date.now(),
    };
    setPages(prev => {
      const next = [...prev, newPage];
      // Scroll the main pager to the newly-appended page after the FlatList
      // has re-rendered with the new item.
      requestAnimationFrame(() => {
        mainListRef.current?.scrollToIndex({ index: next.length - 1, animated: true });
      });
      return next;
    });
    setSelectedId(newPage.id);
  }, []);

  // ── Page management ────────────────────────────────────────────────────────
  const handleDeletePage = useCallback((pageId: string) => {
    const idx = pages.findIndex(p => p.id === pageId);
    if (idx < 0) return;
    Alert.alert(
      'Delete page?',
      `Remove page ${idx + 1} from this submission?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setPages(prev => {
              const next = prev.filter(p => p.id !== pageId);
              // If we deleted the currently-selected page, fall back to the
              // first remaining one (or empty selection if none left), and
              // snap the pager to that page.
              if (selectedId === pageId) {
                const fallback = next[0];
                setSelectedId(fallback?.id ?? '');
                if (fallback) {
                  requestAnimationFrame(() => {
                    mainListRef.current?.scrollToIndex({ index: 0, animated: false });
                  });
                }
              }
              return next;
            });
          },
        },
      ],
    );
  }, [pages, selectedId]);

  const movePage = useCallback((pageId: string, direction: -1 | 1) => {
    setPages(prev => {
      const idx = prev.findIndex(p => p.id === pageId);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────────────
  //
  // Routing decision happens BEFORE any network call:
  //   resolveRoute('grading') returns 'cloud' | 'on-device' | 'unavailable'.
  //
  //   cloud       → POST to /api/mark (current behaviour). Silent — the
  //                 teacher shouldn't be told anything about routing when
  //                 the app is working as designed.
  //
  //   on-device   → Phase B+ hook: run grading through the loaded LiteRT
  //                 E4B model locally and return a MarkResult without
  //                 touching the network. Until the native module is
  //                 re-linked, this falls through to the same offline
  //                 queue as 'unavailable' but with a different user-
  //                 facing message, so the teacher knows their setup is
  //                 capable of local grading — just not wired yet.
  //
  //   unavailable → Offline AND no model loaded. Queue the scan; replay
  //                 on reconnect.
  const handleSubmit = useCallback(async () => {
    if (pages.length === 0 || submitting) return;
    setSubmitting(true);

    // Used by every offline-ish branch below: best-effort enqueue for replay
    // when connectivity is restored. AsyncStorage failures are swallowed
    // because they shouldn't block the teacher from moving to the next
    // student.
    const queueForReplay = async (
      preGradedVerdicts?: Array<Record<string, unknown>>,
    ) => {
      try {
        await queueMarkingScan({
          teacher_id: user?.id ?? '',
          student_id: studentId,
          class_id: classId,
          answer_key_id: answerKeyId,
          education_level: educationLevel,
          pages: pages.map(p => ({ uri: p.uri })),
          // When supplied, the cloud will skip its own grading call on
          // replay and persist these verdicts as the canonical Mark.
          pre_graded_verdicts: preGradedVerdicts,
        });
      } catch {
        // Best-effort.
      }
    };

    try {
      const route = await resolveRoute('grading');

      // ── On-device route ──────────────────────────────────────────────────
      // Run OCR on each page + grade via the loaded LiteRT E2B model. The
      // resulting verdicts are the same shape the cloud would return, so
      // the existing MarkResult UI handles everything downstream.
      //
      // Math gate: E2B can't reliably grade multi-step math (and MLKit
      // mangles handwritten math notation before any LLM sees it). For
      // any homework where the answer key's subject is math-flavoured,
      // we skip offline grading entirely — queue for cloud replay and
      // tell the teacher this one needs internet.
      //
      // If the answer key wasn't threaded through the route params (older
      // call sites) we can't grade locally — fall back to queue-for-replay
      // with the cloud-sync message.
      if (route === 'on-device') {
        if (isMathSubject(answerKey?.subject)) {
          await queueForReplay();
          Alert.alert(
            'Math grading needs internet',
            "Maths takes a stronger AI than your phone can run offline. We've saved this submission and will grade it as soon as you reconnect.",
            [{ text: 'OK', onPress: () => navigation.goBack() }],
          );
          return;
        }
        if (!answerKey) {
          await queueForReplay();
          Alert.alert(
            "You're offline",
            "We'll grade this submission when you're back online.",
            [{ text: 'OK', onPress: () => navigation.goBack() }],
          );
          return;
        }
        try {
          const userCtx: OnDeviceUserContext = {
            education_level: educationLevel,
            subject: answerKey.subject,
          };
          const graded = await gradeScanOffline({
            pageUris: pages.map(p => p.uri),
            answerKey: {
              questions: answerKey.questions ?? [],
              total_marks: answerKey.total_marks,
            },
            educationLevel,
            userContext: userCtx,
          });

          // Build a MarkResult that mirrors the cloud response shape.
          // marked_image_url / annotated_urls use the original page URIs
          // as a fallback until Phase D renders local annotations.
          const pageUris = pages.map(p => p.uri);
          const offlineResult: MarkResultType = {
            mark_id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            student_id: studentId,
            student_name: studentName ?? 'Student',
            score: graded.score,
            max_score: graded.max_score,
            percentage: graded.percentage,
            marked_image_url: pageUris[0] ?? '',
            page_urls: pageUris,
            annotated_urls: pageUris,
            page_count: pageUris.length,
            verdicts: graded.verdicts.map(v => ({
              question_number: v.question_number,
              student_answer: v.student_answer,
              expected_answer: v.expected_answer,
              verdict: v.verdict,
              awarded_marks: v.awarded_marks,
              max_marks: v.max_marks,
              feedback: v.feedback,
            })),
            locally_graded: true,
            verdict_page_indices: graded.verdicts.map(v => v.page_index),
          };

          // Queue the same scan PLUS the verdicts we just produced for
          // cloud sync. When the network listener picks this up on
          // reconnect, it posts pre_graded_verdicts to /api/mark and the
          // backend skips its own grading call — our E2B verdicts become
          // the canonical Mark in Firestore (still subject to the same
          // dedupe + clamp guards server-side). No re-grading, no Vertex
          // spend, and the screen the teacher saw matches the database.
          await queueForReplay(graded.verdicts as unknown as Array<Record<string, unknown>>);

          navigation.navigate('Mark', {
            class_id: classId,
            class_name: className,
            education_level: educationLevel,
            answer_key_id: answerKeyId,
            markResult: offlineResult,
          });
          return;
        } catch (err: any) {
          // On-device path failed (OCR error, model not loaded, JSON parse,
          // etc). Don't lose the scan — drop into queue-for-replay.
          const detail = err?.message ?? String(err);
          console.warn('[PageReview] offline grading failed:', detail);
          await queueForReplay();
          // Surface the actual failure reason so we can tell whether
          // it's MLKit OCR, the LiteRT model, JSON parsing, or
          // something else. Hidden cause turned this into a
          // black-box "it just doesn't work" issue.
          Alert.alert(
            "Couldn't grade offline",
            `We saved your submission and will grade it as soon as you reconnect.\n\nReason: ${detail}`,
            [{ text: 'OK', onPress: () => navigation.goBack() }],
          );
          return;
        }
      }

      // ── Unavailable route ────────────────────────────────────────────────
      if (route === 'unavailable') {
        await queueForReplay();
        Alert.alert(
          "You're offline",
          "We'll grade this submission when you're back online. Continue with the next student.",
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }

      // ── Cloud route (default happy path) ─────────────────────────────────
      const result = await submitTeacherScan({
        teacherId: '',  // server resolves from JWT; field unused server-side for auth
        studentId,
        answerKeyId,
        classId,
        educationLevel,
        pages: pages.map(p => ({ uri: p.uri })),
        replace: !!replace,
      });
      navigation.navigate('Mark', {
        class_id: classId,
        class_name: className,
        education_level: educationLevel,
        answer_key_id: answerKeyId,
        markResult: result,
      });
    } catch (err: any) {
      // Flaky-connection fallback: NetInfo said we were online but the
      // request still blew up at the socket. The api.ts axios interceptor
      // tags these with isOffline=true / error_code='NO_CONNECTION' — treat
      // as the same queue-for-replay path.
      const isNetworkError = err?.isOffline === true || err?.error_code === 'NO_CONNECTION';
      if (isNetworkError) {
        await queueForReplay();
        Alert.alert(
          'Saved offline',
          "We'll grade this submission when you're back online. Continue with the next student.",
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }

      // Typed server error — hand it back to MarkingScreen. Ship the pages
      // so MarkingScreen can preload them for "Replace" on a 409.
      navigation.navigate('Mark', {
        class_id: classId,
        class_name: className,
        education_level: educationLevel,
        answer_key_id: answerKeyId,
        markError: {
          status: err?.status,
          error_code: err?.error_code,
          message: err?.message,
          // Forward the studentId so MarkingScreen can resolve the name for
          // the duplicate-submission dialog without relying on selectedStudent.
          extra: { ...(err?.extra ?? {}), student_id: studentId },
        },
        pendingPages: pages,
      });
    } finally {
      setSubmitting(false);
    }
  }, [pages, submitting, studentId, answerKeyId, classId, className, educationLevel, replace, navigation]);

  // ── Renderers ──────────────────────────────────────────────────────────────
  const renderThumb = ({ item, index }: { item: CapturedPage; index: number }) => {
    const isSelected = item.id === selectedId;
    return (
      <View style={[styles.thumbWrap, isSelected && styles.thumbWrapSelected]}>
        <TouchableOpacity onPress={() => selectPage(item.id)} activeOpacity={0.8}>
          <Image source={{ uri: item.uri }} style={styles.thumb} />
          <View style={styles.pageBadge}>
            <Text style={styles.pageBadgeText}>{index + 1}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.thumbDelete}
          onPress={() => handleDeletePage(item.id)}
          accessibilityLabel="Delete page"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={12} color={COLORS.white} />
        </TouchableOpacity>
        {/* Reorder chevrons — visible only when there's somewhere to move to. */}
        <View style={styles.reorderRow}>
          <TouchableOpacity
            style={[styles.reorderBtn, index === 0 && styles.reorderBtnDisabled]}
            onPress={() => movePage(item.id, -1)}
            disabled={index === 0}
            accessibilityLabel="Move page left"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={12} color={index === 0 ? COLORS.gray200 : COLORS.teal500} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.reorderBtn, index === pages.length - 1 && styles.reorderBtnDisabled]}
            onPress={() => movePage(item.id, 1)}
            disabled={index === pages.length - 1}
            accessibilityLabel="Move page right"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-forward" size={12} color={index === pages.length - 1 ? COLORS.gray200 : COLORS.teal500} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderAddTile = () => {
    if (pages.length >= MAX_PAGES) return null;
    return (
      <TouchableOpacity style={styles.addTile} onPress={openCamera} activeOpacity={0.7}>
        <Ionicons name="add" size={28} color={COLORS.teal500} />
        <Text style={styles.addTileText}>Add page</Text>
      </TouchableOpacity>
    );
  };

  return (
    <ScreenContainer scroll={false}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Review pages</Text>
        <Text style={styles.counter}>{pages.length} / {MAX_PAGES}</Text>
      </View>

      {/* Main pager — swipe left/right between pages, pinch-to-zoom on each. */}
      <View style={styles.imageCard}>
        {pages.length > 0 ? (
          <FlatList
            ref={mainListRef}
            data={pages}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={p => p.id}
            onMomentumScrollEnd={handleMainMomentumEnd}
            getItemLayout={(_, index) => ({ length: SW, offset: SW * index, index })}
            initialScrollIndex={Math.max(0, pages.findIndex(p => p.id === selectedId))}
            // If an item's scroll target is outside the render window, fall
            // back to offset scrolling. Avoids the "scrollToIndex out of
            // range" warning when pages are added.
            onScrollToIndexFailed={({ index }) => {
              requestAnimationFrame(() => {
                mainListRef.current?.scrollToOffset({
                  offset: index * SW,
                  animated: false,
                });
              });
            }}
            scrollEnabled={zoomedPageId === null}
            renderItem={({ item }) => (
              <ZoomableImage
                uri={item.uri}
                zoomed={zoomedPageId === item.id}
                onZoomChange={(z) =>
                  setZoomedPageId((prev) => {
                    if (z) return item.id;
                    // Only clear if we're the page that was holding the zoom lock.
                    return prev === item.id ? null : prev;
                  })
                }
              />
            )}
          />
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="document-outline" size={48} color={COLORS.gray200} />
            <Text style={styles.emptyText}>No pages — add one to get started.</Text>
          </View>
        )}
      </View>

      {/* Thumbnail strip + add tile */}
      <View style={styles.stripContainer}>
        <FlatList
          data={pages}
          renderItem={renderThumb}
          keyExtractor={p => p.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.stripContent}
          ListFooterComponent={renderAddTile()}
        />
      </View>

      {/* Submit button */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[
            styles.submitBtn,
            (pages.length === 0 || submitting) && styles.submitBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={pages.length === 0 || submitting}
        >
          {submitting ? (
            <ActivityIndicator color={COLORS.white} />
          ) : (
            <Text style={styles.submitBtnText}>
              Submit {pages.length} page{pages.length === 1 ? '' : 's'} for grading
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* InAppCamera modal — opened by "+ Add page". Untouched component, the
          PageReviewScreen owns the open/close state and adds the captured
          page to its local state. */}
      <InAppCamera
        visible={showCamera}
        onCapture={handleCameraCapture}
        onClose={() => setShowCamera(false)}
        quality={0.85}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 8 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, flex: 1 },
  counter: {
    fontSize: 13, fontWeight: '600', color: COLORS.gray500,
    backgroundColor: COLORS.background,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
  },

  imageCard: {
    width: '100%', height: IMAGE_HEIGHT,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
  },
  pagerItem: {
    width: SW,
    height: IMAGE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: { width: SW, height: IMAGE_HEIGHT },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { color: COLORS.gray500, fontSize: 13 },

  stripContainer: {
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  stripContent: { paddingHorizontal: 16, gap: 12, alignItems: 'flex-start' },

  thumbWrap: {
    width: 80,
    alignItems: 'center',
    gap: 4,
    padding: 4,
    borderRadius: 8,
  },
  thumbWrapSelected: {
    backgroundColor: COLORS.teal50,
  },
  thumb: {
    width: 72, height: 96,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.gray200,
    backgroundColor: COLORS.white,
  },
  pageBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4,
  },
  pageBadgeText: { color: COLORS.white, fontSize: 10, fontWeight: '700' },
  thumbDelete: {
    position: 'absolute', top: 0, right: 0,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: COLORS.error,
    alignItems: 'center', justifyContent: 'center',
  },
  reorderRow: {
    flexDirection: 'row', gap: 8,
  },
  reorderBtn: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: COLORS.white,
    borderWidth: 1, borderColor: COLORS.teal100,
    alignItems: 'center', justifyContent: 'center',
  },
  reorderBtnDisabled: { borderColor: COLORS.gray200 },

  addTile: {
    width: 72, height: 96,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: COLORS.teal300,
    borderStyle: 'dashed',
    backgroundColor: COLORS.teal50,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 4,
  },
  addTileText: { fontSize: 11, color: COLORS.teal500, fontWeight: '600', marginTop: 2 },

  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.white,
  },
  submitBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
});
