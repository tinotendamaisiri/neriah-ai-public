// src/components/BackButton.tsx
//
// Brand-coloured circular back button. Replaces every "← Back" / chevron-
// plus-text combo across the app. The icon does the talking — no label
// underneath, no breadcrumb. Tap goes one screen back via React
// Navigation, falling back to the Main route when there's no nav stack
// (deep-links, app-launch landing on a deep screen).
//
// Usage:
//   <BackButton />
//   <BackButton onPress={() => customAction()} />     // override navigation
//   <BackButton style={{ marginLeft: 12 }} />          // extra positioning

import React from 'react';
import {
  TouchableOpacity,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { COLORS } from '../constants/colors';

interface BackButtonProps {
  /** Override the default goBack behaviour (e.g. for multi-step screens
   *  that want to go back one step instead of one screen). */
  onPress?: () => void;
  /** Extra style overrides — typically just margin/positioning. */
  style?: StyleProp<ViewStyle>;
  /** Visual size variant. Default 'md' = 36 px circle. */
  size?: 'sm' | 'md';
  /** Color variant. 'default' = teal circle + white chevron (light pages).
   *  'onTeal' = white circle + teal chevron (when sitting on the teal header band). */
  variant?: 'default' | 'onTeal';
}

export function BackButton({ onPress, style, size = 'md', variant = 'default' }: BackButtonProps) {
  const navigation = useNavigation<any>();
  const handle = onPress ?? (() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Main');
  });

  const dim = size === 'sm' ? 32 : 36;
  const iconSize = size === 'sm' ? 18 : 22;
  const onTeal = variant === 'onTeal';

  return (
    <TouchableOpacity
      onPress={handle}
      activeOpacity={0.75}
      style={[
        styles.btn,
        { width: dim, height: dim, borderRadius: dim / 2 },
        onTeal && styles.btnOnTeal,
        style,
      ]}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityLabel="Go back"
      accessibilityRole="button"
    >
      <Ionicons name="chevron-back" size={iconSize} color={onTeal ? COLORS.teal500 : COLORS.white} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: COLORS.teal500,
    justifyContent: 'center',
    alignItems: 'center',
    // Subtle shadow so the button reads as elevated above the page,
    // matching the reference design's lift.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  btnOnTeal: {
    backgroundColor: COLORS.white,
  },
});
