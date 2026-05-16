// src/screens/SubmissionSuccessScreen.tsx
// Shown after a successful submission. Dynamic message per channel.
// No back gesture — user must tap Go Home (gestureEnabled: false in navigator).

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { StudentRootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';

type Props = NativeStackScreenProps<StudentRootStackParamList, 'SubmissionSuccess'>;

type ChannelContent = {
  iconName: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  headline: string;
  body: string;
};

const CHANNEL_CONTENT: Record<'app' | 'whatsapp' | 'email', ChannelContent> = {
  app: {
    iconName: 'checkmark-circle',
    iconColor: COLORS.success,
    headline: 'Submitted!',
    body: 'Your work has been received and is being marked. Your teacher will review and approve the result.',
  },
  whatsapp: {
    iconName: 'chatbubbles-outline',
    iconColor: COLORS.teal500,
    headline: 'Almost there!',
    body: 'WhatsApp has been opened. Attach your saved pages in the chat and tap Send to complete your submission.',
  },
  email: {
    iconName: 'mail-outline',
    iconColor: COLORS.teal500,
    headline: 'Almost there!',
    body: 'Your email app has been opened with your pages attached. Tap Send to complete your submission.',
  },
};

export default function SubmissionSuccessScreen({ route, navigation }: Props) {
  const { method } = route.params;
  const content = CHANNEL_CONTENT[method];

  const goHome = () => {
    navigation.reset({
      index: 0,
      routes: [{ name: 'StudentTabs' }],
    });
  };

  return (
    <ScreenContainer scroll={false} style={{ backgroundColor: COLORS.background }}>
    <View style={styles.container}>
      <Ionicons name={content.iconName} size={72} color={content.iconColor} style={styles.icon} />
      <Text style={styles.headline}>{content.headline}</Text>
      <Text style={styles.body}>{content.body}</Text>

      <TouchableOpacity style={styles.homeBtn} onPress={goHome}>
        <Text style={styles.homeBtnText}>Go to Home</Text>
      </TouchableOpacity>
    </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  icon: { marginBottom: 24 },
  headline: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.gray900,
    textAlign: 'center',
    marginBottom: 16,
  },
  body: {
    fontSize: 16,
    color: COLORS.gray500,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 320,
    marginBottom: 40,
  },
  homeBtn: {
    backgroundColor: COLORS.teal500,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
  },
  homeBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
});
