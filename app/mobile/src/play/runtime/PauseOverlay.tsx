// src/play/runtime/PauseOverlay.tsx
//
// Full-screen pause modal. Renders only when `visible`. Resume returns to
// play; Quit ends the session via the engine and routes to PlaySessionEnd.
//
// Visual treatment ported from GemmaPlay's PauseOverlay: dark slate scrim,
// big bold "Paused" headline, two stacked CTAs (Resume primary teal,
// Quit muted neutral).

import React from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import TrackedPressable from '../../components/TrackedPressable';
import { COLORS } from '../../constants/colors';

interface Props {
  visible: boolean;
  onResume: () => void;
  onQuit: () => void;
}

const PauseOverlay: React.FC<Props> = ({ visible, onResume, onQuit }) => {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onResume}
    >
      <View style={styles.scrim}>
        <Text style={styles.title}>Paused</Text>
        <View style={styles.buttonStack}>
          <TrackedPressable
            analyticsId="play.game.pause.resume"
            onPress={onResume}
            style={({ pressed }) => [
              styles.btn,
              styles.btnPrimary,
              { opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={styles.btnPrimaryText}>Resume</Text>
          </TrackedPressable>
          <TrackedPressable
            analyticsId="play.game.pause.quit"
            onPress={onQuit}
            style={({ pressed }) => [
              styles.btn,
              styles.btnSecondary,
              { opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={styles.btnSecondaryText}>Quit to picker</Text>
          </TrackedPressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(12, 18, 32, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 30,
  },
  title: {
    fontFamily: 'Georgia',
    fontSize: 44,
    fontWeight: '700',
    color: '#F1F5F9',
    marginBottom: 32,
  },
  buttonStack: {
    width: '100%',
    maxWidth: 280,
  },
  btn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  btnPrimary: {
    backgroundColor: COLORS.teal500,
  },
  btnPrimaryText: {
    fontFamily: 'Georgia',
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.white,
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnSecondaryText: {
    fontFamily: 'Georgia',
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.white,
  },
});

export default PauseOverlay;
