// src/components/NetworkBanner.tsx
// Persistent status strip shown at the top of every screen.
//   Amber → syncing queued items
//   Green → just synced (auto-dismisses after 3 s)
//   Hidden when offline OR when online with nothing pending
//
// We deliberately do NOT show a banner for plain "offline" — Neriah is
// offline-first, so being offline is a supported state, not a problem.
// The status dot on the profile avatar already conveys connectivity;
// stacking a top-of-screen banner on top of that just made teachers
// think something was broken.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { getQueueLength, replayQueue } from '../services/offlineQueue';
import { getMutationQueueLength, replayMutationQueue } from '../services/mutationQueue';
import {
  getQueueLength as getStudentSubmissionQueueLength,
  replayQueue as replayStudentSubmissionQueue,
} from '../services/studentSubmissionQueue';
import { COLORS } from '../constants/colors';

type BannerState = 'hidden' | 'syncing' | 'synced';

const POLL_INTERVAL_MS = 3000;
const SYNCED_DISMISS_MS = 3000;

export default function NetworkBanner() {
  const { isConnected } = useNetworkStatus();
  const [queueCount, setQueueCount] = useState(0);
  const [bannerState, setBannerState] = useState<BannerState>('hidden');
  const opacity = useRef(new Animated.Value(0)).current;
  const syncing = useRef(false);
  const wasOffline = useRef(false);

  // Poll combined queue length (scans + mutations) so the banner
  // surfaces both kinds of pending work.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active) return;
      const [scans, mutations, studentSubs] = await Promise.all([
        getQueueLength(),
        getMutationQueueLength(),
        getStudentSubmissionQueueLength(),
      ]);
      if (active) setQueueCount(scans + mutations + studentSubs);
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Drive banner state from connectivity + queue
  useEffect(() => {
    const decide = async () => {
      if (!isConnected) {
        // Track that we went offline so we know to trigger sync when
        // we come back, but don't render anything — the profile-avatar
        // status dot already shows offline state.
        wasOffline.current = true;
        setBannerState('hidden');
        return;
      }

      if (wasOffline.current && !syncing.current) {
        wasOffline.current = false;
        const [scans, mutations, studentSubs] = await Promise.all([
          getQueueLength(),
          getMutationQueueLength(),
          getStudentSubmissionQueueLength(),
        ]);
        if (scans + mutations + studentSubs > 0) {
          syncing.current = true;
          setBannerState('syncing');
          try {
            // Replay all three queues in parallel. Each handles its own
            // retries / dead-letters internally.
            await Promise.all([
              replayQueue(),
              replayMutationQueue(),
              replayStudentSubmissionQueue(),
            ]);
          } finally {
            syncing.current = false;
            setQueueCount(0);
            setBannerState('synced');
            setTimeout(() => setBannerState('hidden'), SYNCED_DISMISS_MS);
          }
          return;
        }
      }

      if (queueCount > 0 && !syncing.current) {
        setBannerState('syncing');
        return;
      }

      if (bannerState !== 'synced') {
        setBannerState('hidden');
      }
    };

    decide();
  }, [isConnected, queueCount]);

  // Animate in/out
  useEffect(() => {
    const toValue = bannerState === 'hidden' ? 0 : 1;
    Animated.timing(opacity, {
      toValue,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [bannerState]);

  if (bannerState === 'hidden') return null;

  const config: Record<Exclude<BannerState, 'hidden'>, { bg: string; text: string }> = {
    syncing: {
      bg: COLORS.warning,
      text: queueCount > 0 ? `Uploading ${queueCount} pending scan${queueCount !== 1 ? 's' : ''}…` : 'Syncing…',
    },
    synced: { bg: COLORS.success, text: 'All synced ✓' },
  };

  const { bg, text } = config[bannerState as Exclude<BannerState, 'hidden'>];

  return (
    <Animated.View style={[styles.banner, { backgroundColor: bg, opacity }]}>
      <Text style={styles.text}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
