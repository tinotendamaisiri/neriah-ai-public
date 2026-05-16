// src/components/ScreenContainer.tsx
// Shared screen wrapper — correct safe-area handling on both iOS and Android.
//
// Uses SafeAreaView from react-native-safe-area-context (NOT the one from
// 'react-native' — that one only handles iOS system-provided insets and
// silently ignores Android status-bar and display cutouts).
//
// Requires <SafeAreaProvider> at the app root (already present in App.tsx).
//
// Variants:
//   <ScreenContainer>...</ScreenContainer>
//     Default: scroll=true, all four edges insetted.
//
//   <ScreenContainer scroll={false}>...</ScreenContainer>
//     Fixed layout (camera-adjacent screens, full-screen results).
//
//   <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
//     Sticky bottom bar — the bar renders its own bottom inset.
//
//   <ScreenContainer edges={['top', 'left', 'right']}>
//     Screen inside a bottom tab navigator — the tab bar handles bottom.
//
//   <ScreenContainer edges={['bottom', 'left', 'right']}>
//     Content inside a React Native <Modal> — Modal handles the top edge on iOS.

import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  ViewStyle,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Edge = 'top' | 'bottom' | 'left' | 'right';

type Props = {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  contentStyle?: ViewStyle;
  edges?: Edge[];
  /** Extra iOS offset for KeyboardAvoidingView when a header or sticky bar
   *  sits above the scrolling content. Matches the existing hand-rolled
   *  KAV pattern in chat and form screens. */
  keyboardVerticalOffset?: number;
};

export function ScreenContainer({
  children,
  scroll = true,
  style,
  contentStyle,
  edges = ['top', 'bottom', 'left', 'right'],
  keyboardVerticalOffset,
}: Props) {
  return (
    <SafeAreaView style={[styles.safe, style]} edges={edges}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor="transparent"
        translucent={false}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={keyboardVerticalOffset}
      >
        {scroll ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.scrollContent, contentStyle]}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 24 },
});
