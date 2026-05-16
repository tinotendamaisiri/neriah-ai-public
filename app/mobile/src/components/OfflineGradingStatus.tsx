// src/components/OfflineGradingStatus.tsx
// Small status pill that tells the teacher whether offline grading is ready,
// what's blocking it, and what to do. Mounted on Home + Marking screens.
//
// States (first match wins):
//   - "Offline grading: rebuild required" — native modules not linked (dev
//      builds only; hidden in production since this shouldn't happen there).
//   - "Downloading AI model — X%" — while the 2.96 GB download is running.
//   - "Offline grading: tap to download model" — native modules linked but
//      the .task file isn't on disk yet.
//   - "Loading AI model…" — file on disk but loadModel() hasn't finished
//      initialising the native module.
//   - "Offline grading ready" — native module linked, model loaded.
//
// The pill is tappable when the action is "download" — taps call
// acceptDownload() from ModelContext (same entry point as the Wi-Fi nudge).

import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useModel } from '../context/ModelContext';
import {
  isNativeModuleAvailable,
  getLiteRTState,
  subscribeToLiteRT,
} from '../services/litert';
import { isOcrAvailable } from '../services/ocr';
import { COLORS } from '../constants/colors';

type PillKind = 'downloading' | 'installing' | 'need-download' | 'loading' | 'rebuild';

interface Tone {
  bg: string;
  fg: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const TONES: Record<PillKind, Tone> = {
  downloading:    { bg: COLORS.teal50,   fg: COLORS.teal700, icon: 'cloud-download' },
  installing:     { bg: COLORS.teal50,   fg: COLORS.teal700, icon: 'cog' },
  'need-download':{ bg: COLORS.amber50,  fg: COLORS.amber500,icon: 'cloud-offline' },
  loading:        { bg: COLORS.teal50,   fg: COLORS.teal700, icon: 'sync' },
  // Rebuild-required intentionally uses a subtler grey so it reads as "dev
  // build quirk" rather than "something's broken" — only developers see it.
  rebuild:        { bg: '#F1F5F9',       fg: '#475569',      icon: 'construct' },
};

function labelFor(kind: PillKind, progress: number): string {
  switch (kind) {
    case 'downloading':     return `Downloading AI model: ${Math.round(progress)}%`;
    case 'installing':      return 'Installing AI model…';
    case 'need-download':   return 'Offline grading: tap to download model';
    case 'loading':         return 'Loading AI model…';
    case 'rebuild':         return 'Offline grading: rebuild required';
  }
}

export default function OfflineGradingStatus() {
  const { status, progress, modelReady, variant, acceptDownload } = useModel();
  const [loadedModel, setLoadedModel] = useState(getLiteRTState().loadedModel);

  // Track LiteRT load state — fires when ModelContext's auto-load effect
  // completes, so the pill flips to 'ready' without a manual refresh.
  useEffect(() => {
    setLoadedModel(getLiteRTState().loadedModel);
    return subscribeToLiteRT(() => setLoadedModel(getLiteRTState().loadedModel));
  }, []);

  // Cloud-only device (low RAM / low storage). Nothing to say — cloud is fine.
  if (variant === null) return null;

  // Dev build with missing native deps — only show in __DEV__ so production
  // teachers never see an alarming "rebuild required" pill.
  const nativeReady = isNativeModuleAvailable() && isOcrAvailable();
  if (!nativeReady) {
    if (!__DEV__) return null;
    return <Pill kind="rebuild" progress={0} />;
  }

  if (status === 'downloading') {
    // Once progress hits 100, the library's native init phase is running
    // (no progress feedback for 20–30s on a 3 GB model). Flip the label
    // to "Installing AI model…" so the teacher doesn't stare at a stuck
    // "Downloading — 100%" — same fix as SettingsScreen's progress bar.
    if (progress >= 99) {
      return <Pill kind="installing" progress={progress} />;
    }
    return <Pill kind="downloading" progress={progress} />;
  }

  if (!modelReady) {
    // Tappable — calls the same acceptDownload the Wi-Fi nudge uses.
    return <Pill kind="need-download" progress={0} onPress={() => { void acceptDownload(); }} />;
  }

  if (loadedModel !== variant) {
    return <Pill kind="loading" progress={0} />;
  }

  // Fully ready — model downloaded AND loaded into native memory. Hide the
  // pill entirely. Teachers shouldn't see an "Offline grading ready" badge
  // forever on every screen — the absence of the pill *is* the ready state.
  // Settings still has its own "Offline mode ready ✓" indicator for users
  // who want to verify.
  return null;
}

interface PillProps {
  kind: PillKind;
  progress: number;
  onPress?: () => void;
}

function Pill({ kind, progress, onPress }: PillProps) {
  const tone = TONES[kind];
  const label = labelFor(kind, progress);
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={onPress ? 0.7 : 1}
      style={[styles.pill, { backgroundColor: tone.bg }]}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={label}
    >
      <Ionicons name={tone.icon} size={13} color={tone.fg} style={styles.icon} />
      <Text style={[styles.text, { color: tone.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginHorizontal: 16,
    marginVertical: 6,
  },
  icon: {
    marginRight: 6,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
});
