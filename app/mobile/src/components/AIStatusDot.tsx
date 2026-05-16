// src/components/AIStatusDot.tsx
// Quad-state status dot — sits on the top-right corner of the avatar.
//
// Lime green (#22C55E)  = online + nothing pending (fully synced)
// Amber (#F5A623)       = either:
//                          - offline + on-device model ready, OR
//                          - online but still flushing queued offline
//                            work (the avatar's orange ring is also
//                            spinning while this is true)
// Red (#EF4444)         = offline + no model available
//
// The "online but still syncing" state matters because we don't want
// the dot to flip green the moment Wi-Fi comes back — it should only
// turn green once the offline queue has actually drained. Otherwise
// the teacher sees a green status while their submissions are still
// only on the device.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useAIRouter } from '../services/router';
import { useModel } from '../context/ModelContext';
import { useSyncCoordinator } from '../hooks/useSyncCoordinator';

export default function AIStatusDot({ borderColor = '#0D7377' }: { borderColor?: string }) {
  const { isOnline } = useAIRouter();
  const { status: modelStatus } = useModel();
  const { isSyncing, pending } = useSyncCoordinator();
  const modelReady = modelStatus === 'done';

  const stillFlushing = isOnline && (isSyncing || pending > 0);

  const color = !isOnline
    ? modelReady
      ? '#F5A623'
      : '#EF4444'
    : stillFlushing
      ? '#F5A623'
      : '#22C55E';

  return (
    <View style={[styles.dot, { backgroundColor: color, borderColor }]} />
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    top: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
});
