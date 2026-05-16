// src/components/OfflineGradedToast.tsx
// Transient "graded on-device" toast shown at the top of the Mark results
// screen for 5 seconds after an offline-graded submission completes.
//
// Silent when the teacher is online (MarkResult.locally_graded is false/
// undefined), so there's no cognitive overhead during the normal cloud
// flow. Only speaks up when the result came from the on-device E4B model
// so the teacher knows accuracy may differ from their usual cloud grade.
//
// Timing: 300 ms fade in → 4400 ms visible → 300 ms fade out → unmount.
// One-shot per mount — re-rendering with visible=true again won't restart
// the animation (avoids flashing on every re-render of MarkResult).

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';

interface OfflineGradedToastProps {
  /** True when the MarkResult was produced by the on-device E4B model. */
  visible: boolean;
}

export default function OfflineGradedToast({ visible }: OfflineGradedToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [hidden, setHidden] = useState(!visible);

  useEffect(() => {
    if (!visible) return;
    setHidden(false);
    const anim = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(4400),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => {
      if (finished) setHidden(true);
    });
    return () => anim.stop();
    // One-shot on mount — ignore subsequent visible flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hidden) return null;

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <Animated.View style={[styles.toast, { opacity }]}>
        <Ionicons name="cloud-offline" size={14} color="#ffffff" />
        <Text style={styles.text} numberOfLines={1}>
          Graded on-device • No internet
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // Absolute so the toast floats above MarkResult's scrollable content
    // without reserving layout space.
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 14,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.teal700,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 4,
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
});
