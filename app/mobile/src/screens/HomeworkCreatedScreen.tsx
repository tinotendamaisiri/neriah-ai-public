// src/screens/HomeworkCreatedScreen.tsx
// Success screen shown after homework + marking scheme are created.

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { useNavigation, useRoute } from '@react-navigation/native';
import { updateAnswerKey } from '../services/api';
import { COLORS } from '../constants/colors';

export default function HomeworkCreatedScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { answer_key_id } = route.params as {
    answer_key_id: string;
    class_id: string;
    class_name: string;
  };

  const [opening, setOpening] = useState(false);

  const handleOpenForSubmissions = async () => {
    setOpening(true);
    try {
      await updateAnswerKey(answer_key_id, { open_for_submission: true });
      navigation.goBack();
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not open homework for submissions. Please try again.');
    } finally {
      setOpening(false);
    }
  };

  const handleDoLater = () => {
    navigation.goBack();
  };

  return (
    <ScreenContainer scroll={false}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Text style={styles.checkmark}>✓</Text>
        </View>

        <Text style={styles.title}>Homework Created</Text>
        <Text style={styles.body}>
          Your marking scheme has been generated. You can now start accepting student submissions.
        </Text>

        <TouchableOpacity
          style={[styles.primaryButton, opening && styles.primaryButtonDisabled]}
          onPress={handleOpenForSubmissions}
          disabled={opening}
        >
          {opening ? (
            <ActivityIndicator color={COLORS.white} size="small" />
          ) : (
            <Text style={styles.primaryButtonText}>Open for Submissions</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={handleDoLater} style={styles.laterLink} disabled={opening}>
          <Text style={styles.laterText}>I'll do this later</Text>
        </TouchableOpacity>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#E6F4EA',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  checkmark: {
    fontSize: 36,
    color: '#2E7D32',
    fontWeight: '700',
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: COLORS.gray500,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 40,
  },
  primaryButton: {
    backgroundColor: COLORS.teal500,
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 32,
    alignItems: 'center',
    width: '100%',
    minHeight: 52,
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: COLORS.teal300,
  },
  primaryButtonText: {
    color: COLORS.white,
    fontWeight: 'bold',
    fontSize: 16,
  },
  laterLink: {
    marginTop: 20,
    paddingVertical: 8,
  },
  laterText: {
    fontSize: 15,
    color: COLORS.gray500,
  },
});
