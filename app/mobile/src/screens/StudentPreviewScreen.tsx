// src/screens/StudentPreviewScreen.tsx
// Swipeable gallery of captured pages. Allows retaking individual pages.
// Runs silent image enhancement (resize + EXIF normalise) and heuristic quality
// checks on every page. Quality warnings are shown as an advisory banner only —
// the student can always proceed.

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  TouchableOpacity,
  Dimensions,
  Alert,
  ActivityIndicator,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { StudentRootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import { enhanceImage } from '../services/imageEnhance';
import { ScreenContainer } from '../components/ScreenContainer';
import { checkImageQuality } from '../services/imageQuality';
import InAppCamera from '../components/InAppCamera';
import { BackButton } from '../components/BackButton';

type Props = NativeStackScreenProps<StudentRootStackParamList, 'StudentPreview'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function StudentPreviewScreen({ route, navigation }: Props) {
  const { answer_key_id, answer_key_title, class_id } = route.params;
  const [images, setImages] = useState<string[]>(route.params.images);
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  // Retake camera state
  const [retakeIndex, setRetakeIndex] = useState<number | null>(null);

  // Enhancement + quality state
  const [optimizing, setOptimizing] = useState(true);
  const [qualityWarnings, setQualityWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function processImages() {
      setOptimizing(true);
      const allWarnings: string[] = [];

      const enhanced = await Promise.all(
        images.map(async (uri) => {
          const [newUri, quality] = await Promise.all([
            enhanceImage(uri),
            checkImageQuality(uri),
          ]);
          allWarnings.push(...quality.warnings);
          return newUri;
        }),
      );

      if (!cancelled) {
        setImages(enhanced);
        // Deduplicate warnings
        setQualityWarnings([...new Set(allWarnings)]);
        setOptimizing(false);
      }
    }

    processImages();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount with the initial images

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setCurrentIndex(page);
  };

  const retakePage = (index: number) => {
    setRetakeIndex(index);
  };

  const handleRetakeCapture = async (uri: string) => {
    const index = retakeIndex;
    setRetakeIndex(null);
    if (index === null) return;
    const enhanced = await enhanceImage(uri);
    setImages(prev => {
      const updated = [...prev];
      updated[index] = enhanced;
      return updated;
    });
    const quality = await checkImageQuality(enhanced);
    if (quality.warnings.length > 0) {
      setQualityWarnings(prev => [...new Set([...prev, ...quality.warnings])]);
    }
  };

  const handleContinue = () => {
    navigation.navigate('StudentConfirm', {
      images,
      answer_key_id,
      answer_key_title,
      class_id,
    });
  };

  if (optimizing) {
    return (
      <ScreenContainer scroll={false} style={{ backgroundColor: '#111827' }}>
        <View style={styles.optimizingContainer}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
          <Text style={styles.optimizingText}>Optimizing images…</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <>
      <InAppCamera
        visible={retakeIndex !== null}
        onCapture={handleRetakeCapture}
        onClose={() => setRetakeIndex(null)}
        quality={0.85}
      />
      <ScreenContainer scroll={false} style={{ backgroundColor: '#111827' }}>
      <View style={styles.container}>
      <View style={styles.titleRow}>
        <BackButton variant="onTeal" />
        <Text style={styles.titleText}>Preview</Text>
      </View>
      {/* Quality warnings */}
      {qualityWarnings.length > 0 && (
        <View style={styles.warningBanner}>
          <View style={styles.warningTitleRow}>
            <Ionicons name="warning-outline" size={14} color="#fef3c7" />
            <Text style={styles.warningTitle}> Quality notice</Text>
          </View>
          {qualityWarnings.map((w, i) => (
            <Text key={i} style={styles.warningItem}>· {w}</Text>
          ))}
          <TouchableOpacity onPress={() => setQualityWarnings([])}>
            <Text style={styles.warningDismiss}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Page indicator */}
      <View style={styles.indicatorRow}>
        {images.map((_, i) => (
          <View
            key={i}
            style={[styles.dot, i === currentIndex && styles.dotActive]}
          />
        ))}
      </View>

      <Text style={styles.pageLabel}>
        Page {currentIndex + 1} of {images.length}
      </Text>

      {/* Swipeable images */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        style={styles.gallery}
      >
        {images.map((uri, index) => (
          <View key={uri + index} style={styles.pageContainer}>
            <Image source={{ uri }} style={styles.pageImage} resizeMode="contain" />
          </View>
        ))}
      </ScrollView>

      {/* Retake button for current page */}
      <View style={styles.retakeRow}>
        <TouchableOpacity
          style={styles.retakeBtn}
          onPress={() => retakePage(currentIndex)}
        >
          <View style={styles.retakeBtnInner}>
              <Ionicons name="camera-reverse-outline" size={16} color={COLORS.teal500} />
              <Text style={styles.retakeBtnText}>  Retake Page {currentIndex + 1}</Text>
            </View>
        </TouchableOpacity>
      </View>

      {/* Quality tip */}
      <View style={styles.tip}>
        <Text style={styles.tipText}>
          Swipe to check each page. Retake any that are blurry or cut off.
        </Text>
      </View>

      {/* Continue */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.continueBtn} onPress={handleContinue}>
          <Text style={styles.continueBtnText}>
            Submit {images.length} Page{images.length !== 1 ? 's' : ''} →
          </Text>
        </TouchableOpacity>
      </View>
    </View>
    </ScreenContainer>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  titleText: { fontSize: 22, fontWeight: '700', color: '#FFFFFF', flex: 1 },
  optimizingContainer: {
    flex: 1,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  optimizingText: {
    color: '#9ca3af',
    fontSize: 15,
  },
  warningBanner: {
    backgroundColor: '#78350f',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
  },
  warningTitleRow: { flexDirection: 'row', alignItems: 'center' },
  warningTitle: {
    color: '#fef3c7',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  warningItem: {
    color: '#fde68a',
    fontSize: 12,
    lineHeight: 18,
  },
  warningDismiss: {
    color: '#fcd34d',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    textDecorationLine: 'underline',
  },
  indicatorRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 14,
    paddingBottom: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4b5563',
  },
  dotActive: { backgroundColor: COLORS.teal500, width: 18 },
  pageLabel: {
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 13,
    marginBottom: 8,
  },
  gallery: { flex: 1 },
  pageContainer: {
    width: SCREEN_WIDTH,
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  pageImage: {
    width: SCREEN_WIDTH - 16,
    height: '100%',
    borderRadius: 8,
  },
  retakeRow: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  retakeBtn: {
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#1f2937',
  },
  retakeBtnInner: { flexDirection: 'row', alignItems: 'center' },
  retakeBtnText: { color: '#d1d5db', fontSize: 14, fontWeight: '600' },
  tip: {
    margin: 16,
    marginBottom: 4,
    backgroundColor: '#1f2937',
    borderRadius: 10,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.teal500,
  },
  tipText: { color: '#9ca3af', fontSize: 12, lineHeight: 18 },
  footer: { padding: 16, paddingBottom: 24 },
  continueBtn: {
    backgroundColor: COLORS.teal500,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  continueBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
});
