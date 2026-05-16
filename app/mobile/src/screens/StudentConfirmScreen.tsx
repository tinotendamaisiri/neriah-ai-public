// src/screens/StudentConfirmScreen.tsx
// 3-channel submission: App (direct API), WhatsApp (Linking), Email (expo-mail-composer).
// Shows a channel picker; offline state disables App channel.

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as MailComposer from 'expo-mail-composer';
import * as MediaLibrary from 'expo-media-library';
import Constants from 'expo-constants';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { submitStudentWork } from '../services/api';
import { showError } from '../utils/showError';
import { useDebouncePress } from '../hooks/useDebouncePress';
import { StudentRootStackParamList } from '../types';
import { NERIAH_WHATSAPP_NUMBER, NERIAH_EMAIL } from '../constants';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';

type Props = NativeStackScreenProps<StudentRootStackParamList, 'StudentConfirm'>;

const WA_URL_BASE = `whatsapp://send`;

export default function StudentConfirmScreen({ route, navigation }: Props) {
  const { images, answer_key_id, answer_key_title, class_id } = route.params;
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [whatsAppAvailable, setWhatsAppAvailable] = useState(true);

  // Check WhatsApp availability once on mount
  React.useEffect(() => {
    Linking.canOpenURL('whatsapp://send').then(ok => setWhatsAppAvailable(ok));
  }, []);

  // ── App channel (queued multipart upload) ─────────────────────────────────
  //
  // Submitting is optimistic: we enqueue the submission locally, navigate
  // straight to SubmissionSuccess, and let the existing replay
  // infrastructure (NetworkBanner + useSyncCoordinator) drain the queue
  // in the background. When online the drain fires immediately; when
  // offline the item waits for the next online edge. Either way the
  // student doesn't sit on a 30-90 second spinner while the multipart
  // upload + Vertex MaaS grading round-trip completes — that work
  // happens after they've already moved on.
  //
  // NetInfo pre-flight was removed because iOS reports captive portals
  // and brief cellular flickers as offline and was bouncing students
  // off the screen even when the upload would have succeeded.

  const _submitViaApp = async () => {
    if (!user) return;

    try {
      const { enqueue, replayQueue } =
        await import('../services/studentSubmissionQueue');

      await enqueue({
        student_id:    user.id,
        class_id,
        answer_key_id,
        source:        'app',
        pages:         (images ?? []).map((uri) => ({ uri })),
      });

      // Kick off a background drain. We never await it: the queue
      // handles its own retries + dead-letter, and the global sync
      // coordinator will pick up anything that's still pending on the
      // next online edge.
      void replayQueue().catch(() => { /* swallowed; queue keeps the item */ });

      navigation.replace('SubmissionSuccess', { method: 'app' });
    } catch (err) {
      // Enqueue itself failed (FS / AsyncStorage). Surface so the
      // student knows to try another channel; nothing else we can do
      // locally if we can't even persist a queue entry.
      showError(err);
    }
  };
  const submitViaApp = useDebouncePress(_submitViaApp);

  // ── WhatsApp channel ──────────────────────────────────────────────────────

  const _submitViaWhatsApp = async () => {
    const isExpoGo = Constants.appOwnership === 'expo';

    if (!isExpoGo) {
      // Save images to camera roll so the student can attach them in WhatsApp
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Allow access to save pages to your gallery for WhatsApp sharing.');
        return;
      }
      try {
        for (const uri of images) {
          await MediaLibrary.saveToLibraryAsync(uri);
        }
      } catch {
        // Non-critical — images may already be accessible
      }
    }
    // Expo Go: media library unavailable — skip gallery save, continue with WhatsApp link

    const studentName = user ? `${user.first_name} ${user.surname}` : 'Student';
    const message =
      `Hi Neriah, here is my submission:\n` +
      `Name: ${studentName}\n` +
      `Assignment: ${answer_key_title}\n` +
      `Class ID: ${class_id}\n` +
      `Answer Key ID: ${answer_key_id}\n\n` +
      `I have saved ${images.length} page(s) to my gallery and will attach them now.`;

    const waNumber = NERIAH_WHATSAPP_NUMBER.replace(/\D/g, '');
    const waUrl = `${WA_URL_BASE}?phone=${waNumber}&text=${encodeURIComponent(message)}`;

    await Linking.openURL(waUrl);
    navigation.replace('SubmissionSuccess', { method: 'whatsapp' });
  };
  const submitViaWhatsApp = useDebouncePress(_submitViaWhatsApp);

  // ── Email channel ─────────────────────────────────────────────────────────

  const submitViaEmail = async () => {
    const isAvailable = await MailComposer.isAvailableAsync();
    if (!isAvailable) {
      Alert.alert('No email app', 'No email app is configured on this device. Use the App or WhatsApp channel instead.');
      return;
    }

    const studentName = user ? `${user.first_name} ${user.surname}` : 'Student';

    await MailComposer.composeAsync({
      recipients: [NERIAH_EMAIL],
      subject: `Submission: ${answer_key_title} — ${studentName}`,
      body:
        `Assignment: ${answer_key_title}\n` +
        `Student: ${studentName}\n` +
        `Class ID: ${class_id}\n` +
        `Answer Key ID: ${answer_key_id}\n\n` +
        `Please find my ${images.length} page(s) attached.`,
      attachments: images,
    });

    navigation.replace('SubmissionSuccess', { method: 'email' });
  };

  return (
    <ScreenContainer scroll={false}>
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Summary */}
      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>Assignment</Text>
        <Text style={styles.summaryTitle}>{answer_key_title}</Text>
        <Text style={styles.summaryMeta}>
          {images.length} page{images.length !== 1 ? 's' : ''} ready to submit
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Choose submission method</Text>

      {/* App channel */}
      <TouchableOpacity
        style={[styles.channelCard, styles.channelApp, submitting && styles.cardDisabled]}
        onPress={submitViaApp}
        disabled={submitting}
      >
        <View style={styles.channelHeader}>
          <Ionicons name="phone-portrait-outline" size={22} color={COLORS.teal500} style={styles.channelIcon} />
          <View style={styles.channelHeaderText}>
            <Text style={styles.channelName}>Submit via App</Text>
            <View style={styles.recommendedBadge}>
              <Text style={styles.recommendedText}>Recommended</Text>
            </View>
          </View>
          {submitting && <ActivityIndicator color={COLORS.teal500} style={{ marginLeft: 8 }} />}
        </View>
        <Text style={styles.channelDesc}>
          Uploads directly — fastest and most accurate. Requires internet connection.
        </Text>
      </TouchableOpacity>

      {/* WhatsApp channel — hidden if WhatsApp is not installed */}
      {whatsAppAvailable && (
        <TouchableOpacity
          style={[styles.channelCard, styles.channelWhatsApp]}
          onPress={submitViaWhatsApp}
          disabled={submitting}
        >
          <View style={styles.channelHeader}>
            <Ionicons name="chatbubbles-outline" size={22} color={COLORS.teal500} style={styles.channelIcon} />
            <Text style={styles.channelName}>Submit via WhatsApp</Text>
          </View>
          <Text style={styles.channelDesc}>
            Saves pages to your gallery and opens WhatsApp. Attach the images in the chat.
          </Text>
        </TouchableOpacity>
      )}

      {/* Email channel */}
      <TouchableOpacity
        style={[styles.channelCard, styles.channelEmail]}
        onPress={submitViaEmail}
        disabled={submitting}
      >
        <View style={styles.channelHeader}>
          <Ionicons name="mail-outline" size={22} color={COLORS.gray900} style={styles.channelIcon} />
          <Text style={styles.channelName}>Submit via Email</Text>
        </View>
        <Text style={styles.channelDesc}>
          Opens your email app with pages attached and sends to {NERIAH_EMAIL}.
        </Text>
      </TouchableOpacity>

      <Text style={styles.footerNote}>
        All channels deliver to the same marking pipeline. Your teacher will see the result.
      </Text>
    </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 40 },
  summaryCard: {
    backgroundColor: COLORS.teal500,
    borderRadius: 14,
    padding: 18,
    marginBottom: 24,
  },
  summaryLabel: { color: COLORS.teal100, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  summaryTitle: { color: COLORS.white, fontSize: 18, fontWeight: '700', marginTop: 4 },
  summaryMeta: { color: COLORS.teal100, fontSize: 13, marginTop: 6 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: COLORS.gray900, marginBottom: 14 },
  channelCard: {
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
  },
  channelApp: {
    backgroundColor: COLORS.teal50,
    borderColor: COLORS.teal500,
  },
  channelWhatsApp: {
    backgroundColor: COLORS.teal50,
    borderColor: COLORS.teal500,
  },
  channelEmail: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
  },
  cardDisabled: { opacity: 0.6 },
  channelHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  channelIcon: { marginRight: 10 },
  channelHeaderText: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelName: { fontSize: 16, fontWeight: '700', color: COLORS.gray900 },
  recommendedBadge: {
    backgroundColor: COLORS.teal500,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  recommendedText: { color: COLORS.white, fontSize: 10, fontWeight: '700' },
  channelDesc: { color: COLORS.gray500, fontSize: 13, lineHeight: 19 },
  footerNote: {
    textAlign: 'center',
    color: COLORS.textLight,
    fontSize: 12,
    marginTop: 16,
    lineHeight: 18,
  },
});
