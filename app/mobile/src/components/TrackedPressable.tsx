// src/components/TrackedPressable.tsx
//
// Drop-in replacement for React Native's Pressable that fires a tap event
// to the analytics layer before invoking the user's onPress handler.
//
// Usage:
//   <TrackedPressable analyticsId="home.create_class" onPress={...}>
//     <Text>+ Class</Text>
//   </TrackedPressable>
//
// `analyticsId` follows the pattern `<surface>.<action>` (e.g.
// "home.create_class"). The first segment is used as the surface unless
// `surface` is explicitly provided.

import React, { useCallback } from 'react';
import {
  Pressable,
  PressableProps,
  GestureResponderEvent,
} from 'react-native';
import { trackTap } from '../services/analytics';

export interface TrackedPressableProps extends PressableProps {
  /** Dotted identifier — first segment is the default surface, the rest is
   *  joined into the action. Examples:
   *    "home.create_class"           → surface=home, action=create_class
   *    "home.class_card.open"        → surface=home, action=class_card.open
   */
  analyticsId: string;
  /** Override the surface inferred from analyticsId. Optional. */
  surface?: string;
  /** Extra payload merged into the tap event. Avoid PII. */
  analyticsPayload?: Record<string, unknown>;
}

function splitId(id: string, surfaceOverride?: string): { surface: string; action: string } {
  const parts = id.split('.');
  if (parts.length < 2) {
    // Single-segment id ("submit") — use the id as both the surface and
    // the action so the event still fires sensibly.
    return { surface: surfaceOverride || id || 'unknown', action: id || 'tap' };
  }
  const [first, ...rest] = parts;
  return {
    surface: surfaceOverride || first,
    action: rest.join('.'),
  };
}

const TrackedPressable: React.FC<TrackedPressableProps> = ({
  analyticsId,
  surface,
  analyticsPayload,
  onPress,
  ...rest
}) => {
  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      try {
        const { surface: s, action } = splitId(analyticsId, surface);
        trackTap(s, action, analyticsPayload);
      } catch {
        // Never let a tracking failure swallow a real tap.
      }
      if (onPress) onPress(e);
    },
    [analyticsId, surface, analyticsPayload, onPress],
  );

  return <Pressable {...rest} onPress={handlePress} />;
};

export default TrackedPressable;
