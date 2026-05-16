// src/components/AvatarWithStatus.tsx
// Circular avatar with connectivity status dot + sync ring.
//
// Visual language:
//   - Tap → opens role-appropriate Settings.
//   - Status dot (top-right corner): green = online + idle,
//     amber = offline-with-model, red = offline-no-model.
//   - Animated orange ring around the circle: appears whenever
//     queued offline work is being replayed to the server. The ring
//     spins from the dot corner (matches the visual the teacher
//     thinks of as "the side that has the network status"). It
//     disappears the moment the queue is empty.
//   - "Syncing…" label to the LEFT of the avatar while the ring is
//     spinning, so the action has a name.
//
// The actual work — replaying scan + mutation queues — lives in
// useSyncCoordinator. This component only listens.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, Text, TouchableOpacity } from 'react-native';
import { useSyncCoordinator } from '../hooks/useSyncCoordinator';

interface Props {
  initial: string;
  onPress: () => void;
  size?: number;
  /** 'solid' = teal circle on white headers (default), 'light' = translucent on teal headers */
  variant?: 'solid' | 'light';
}

const RING_COLOR = '#F5A623';        // Neriah amber
const RING_TRACK = 'rgba(245,166,35,0.20)'; // faded amber for the back-track
const RING_THICKNESS = 2;

let StatusDot: React.FC<{ borderColor?: string }> | null = null;
try {
  StatusDot = require('./AIStatusDot').default;
} catch {
  // Avatar still renders without the dot.
}

export default function AvatarWithStatus({ initial, onPress, size = 44, variant = 'solid' }: Props) {
  const radius = size / 2;
  const isSolid = variant === 'solid';
  const bg = isSolid ? '#0D7377' : 'rgba(255,255,255,0.22)';
  const dotBorder = isSolid ? '#FFFFFF' : '#0D7377';

  const { isSyncing } = useSyncCoordinator();

  // Spin animation — kicked off and torn down based on isSyncing so
  // we don't burn CPU on a permanent rotation timer.
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isSyncing) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [isSyncing, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Ring radius = avatar radius + (small gap) + thickness/2.
  const ringSize = size + 8;
  const ringRadius = ringSize / 2;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {/* "Syncing…" label sits to the LEFT of the avatar so the
          teacher knows what the spinning ring means. Hidden when
          the ring isn't spinning. */}
      {isSyncing ? (
        <Text
          style={{
            color: isSolid ? '#0D7377' : '#FFFFFF',
            fontSize: 12,
            fontWeight: '600',
            marginRight: 8,
          }}
        >
          Syncing…
        </Text>
      ) : null}

      <View
        style={{
          width: ringSize,
          height: ringSize,
          alignItems: 'center',
          justifyContent: 'center',
          // The avatar's status dot has overflow:visible because we
          // render it absolutely outside the avatar bounds. Same here.
          overflow: 'visible',
        }}
      >
        {/* Animated ring — only rendered while syncing so it costs
            nothing in the steady-state. The track is a faint amber,
            and we layer an arc-shaped gradient via a rotated
            half-ring trick (a View with a transparent left half).
            Keeps it native-driver friendly. */}
        {isSyncing ? (
          <>
            {/* Faint full track */}
            <View
              style={{
                position: 'absolute',
                width: ringSize,
                height: ringSize,
                borderRadius: ringRadius,
                borderWidth: RING_THICKNESS,
                borderColor: RING_TRACK,
              }}
            />
            {/* Spinning arc — borderTopColor is the only opaque side,
                so as the View rotates the visible arc sweeps around. */}
            <Animated.View
              style={{
                position: 'absolute',
                width: ringSize,
                height: ringSize,
                borderRadius: ringRadius,
                borderWidth: RING_THICKNESS,
                borderColor: 'transparent',
                borderTopColor: RING_COLOR,
                borderRightColor: RING_COLOR,
                transform: [{ rotate }],
              }}
            />
          </>
        ) : null}

        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.7}
          style={{
            width: size,
            height: size,
            borderRadius: radius,
            backgroundColor: bg,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'visible',
          }}
        >
          <Text
            style={{
              color: '#FFFFFF',
              fontSize: size * 0.40,
              fontWeight: '700',
              includeFontPadding: false,
            }}
          >
            {(initial && initial.trim()) || 'T'}
          </Text>

          {StatusDot ? (
            <ErrorSafe>
              <StatusDot borderColor={dotBorder} />
            </ErrorSafe>
          ) : (
            <View
              style={{
                position: 'absolute',
                top: 1,
                right: 1,
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: '#22C55E',
                borderWidth: 2,
                borderColor: dotBorder,
              }}
            />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

class ErrorSafe extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
