// src/components/OfflineModelBanner.tsx
// Unified offline-AI status banner mounted on the Home screen. Replaces the
// older two-component setup (small "OfflineGradingStatus" pill + separate
// inline Wi-Fi nudge) with a single banner that morphs between states:
//
//   1. Downloading        → "Downloading offline AI: 35%" + progress bar.
//                           No buttons — user just waits or backgrounds the app.
//   2. Installing (≥99%)  → "Installing AI model: this can take a minute…"
//                           Library's native init phase has no progress feedback.
//   3. Paused             → "Paused: 35% complete" — auto-resumes when Wi-Fi
//                           returns; no manual button (the resume is automatic).
//   4. Loading            → "Loading AI model…" — file on disk, native session
//                           initialising.
//   5. Wi-Fi nudge        → "You're on Wi-Fi — download offline AI now?"
//                           + Download / Later buttons.
//                           Only fires when the Wi-Fi-nudge gating allows
//                           (per ModelContext.checkWifiNudge logic).
//   6. Ready              → null. Absence of banner is the ready state.
//   7. Cloud-only         → null. Capability check failed for this user's
//                           role; offline isn't possible on this device.
//   8. Dev rebuild needed → null on Home (Settings still surfaces it).
//
// Mounted only on HomeScreen for now — the user's design instinct was that
// Home is the right place for this since it's the surface the teacher
// returns to most often, and it aligns with where the Wi-Fi nudge already
// lived. MarkingScreen has its own contextual UI and doesn't need this.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useModel } from '../context/ModelContext';
import { isNativeModuleAvailable } from '../services/litert';
import { isOcrAvailable } from '../services/ocr';
import { COLORS } from '../constants/colors';

export default function OfflineModelBanner() {
  const {
    status,
    progress,
    modelReady,
    variant,
    errorMessage,
    showWifiNudge,
    acceptDownload,
    dismissWifiNudge,
  } = useModel();

  // ── Hide cases ────────────────────────────────────────────────────────────
  // Cloud-only device — no point talking about offline.
  if (variant === null) return null;

  // Dev build with missing native deps — don't surface on Home; Settings'
  // own offline section is the right place to debug this.
  if (!isNativeModuleAvailable() || !isOcrAvailable()) {
    return null;
  }

  // Fully ready — silent. Absence of banner = success.
  if (modelReady && status === 'done') return null;

  // ── Error state ─────────────────────────────────────────────────────────
  // Surface the real error message instead of a generic "Download failed".
  // If the underlying problem is a missing native symbol, an OOM during
  // engine init, or a corrupt downloaded file, the message will say so —
  // and the teacher can paste it back to us instead of just saying
  // "didn't work". Tap to retry restarts loadModel from scratch.
  if (status === 'error') {
    return (
      <View style={[styles.banner, styles.bannerError]}>
        <View style={styles.row}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
          <Text style={[styles.text, styles.textError]} numberOfLines={5}>
            {' '}Offline AI download failed{errorMessage ? `: ${errorMessage}` : ''}
          </Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => { void acceptDownload(); }}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Active download / install / paused ────────────────────────────────────
  if (status === 'downloading' || status === 'paused') {
    const pct = Math.max(0, Math.min(100, Math.round(progress)));
    const isInstalling = status === 'downloading' && pct >= 99;
    const isPaused = status === 'paused';

    const label = isPaused
      ? `Paused: ${pct}% complete`
      : isInstalling
        ? 'Installing AI model: this can take a minute…'
        : `Downloading AI model: ${pct}%`;

    return (
      <View style={styles.banner}>
        <View style={styles.row}>
          <Ionicons
            name={isPaused ? 'pause-circle-outline' : 'cloud-download-outline'}
            size={16}
            color={COLORS.teal500}
          />
          <Text style={styles.text} numberOfLines={2}>{' '}{label}</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
      </View>
    );
  }

  // ── Loading (file on disk, native init in flight) ────────────────────────
  // Brief — usually <1s on a fast device, up to ~5s on older Android. Surface
  // it so the user isn't confused about why offline grading isn't working
  // *yet* on the first launch after download.
  if (!modelReady && variant && status === 'idle') {
    // We can be in 'idle' status with the file on disk but loadModel() not
    // yet called (boot effect); or with loadModel() in flight (the LiteRT
    // state changes via subscribeToLiteRT, but we'd need to wire that here
    // to detect it). For simplicity: only show this state when ModelContext
    // status is 'idle' AND showWifiNudge is also false (so we're not sitting
    // on top of an unstarted download).
    // Skipped for now — falls through to the nudge / silent paths below.
  }

  // ── Wi-Fi nudge — ready to download, conditions met ──────────────────────
  if (showWifiNudge) {
    return (
      <View style={styles.banner}>
        <View style={styles.row}>
          <Ionicons name="wifi-outline" size={16} color={COLORS.teal500} />
          <Text style={styles.text} numberOfLines={2}>
            {' '}You're on Wi-Fi — download offline AI now?
          </Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => { void acceptDownload(); void dismissWifiNudge(); }}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>Download</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => { void dismissWifiNudge(); }}
            activeOpacity={0.8}
          >
            <Text style={styles.secondaryBtnText}>Later</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // No banner state matched — stay silent. The user can still trigger a
  // download from Settings; we just don't push them here.
  return null;
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: COLORS.teal50,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.teal100,
  },
  // Error variant — same shape, red-tinted so it doesn't blend with the
  // "everything's fine" teal of the normal banner states.
  bannerError: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
  },
  textError: {
    color: COLORS.error,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  text: {
    fontSize: 13,
    color: COLORS.teal500,
    fontWeight: '600',
    lineHeight: 18,
    flexShrink: 1,
  },
  // Progress track — inline below the label, fills horizontally as bytes
  // arrive. 4 px tall pill so it reads as "progress" without dominating
  // the banner.
  progressTrack: {
    height: 4,
    backgroundColor: COLORS.teal100,
    borderRadius: 2,
    marginTop: 10,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: COLORS.teal500,
    borderRadius: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    justifyContent: 'flex-end',
  },
  primaryBtn: {
    backgroundColor: COLORS.teal500,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  primaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.teal100,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.teal500,
  },
});
