// src/components/ScanButton.tsx
// Camera capture button — opens InAppCamera full-screen.

import React, { useState } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import InAppCamera from './InAppCamera';

interface ScanButtonProps {
  onCapture: (imageUri: string) => void;
  disabled?: boolean;
  label?: string;
  onDisabledPress?: () => void;
  /** Override the default open-InAppCamera-modal behaviour. If provided,
   *  `onPress` fires instead of opening the internal Modal. Used by
   *  MarkingScreen on Android to navigate to TeacherCameraScreen (a native
   *  camera screen) rather than mounting CameraView inside a Modal. */
  onPress?: () => void;
}

export default function ScanButton({
  onCapture,
  disabled = false,
  label = 'Capture Homework',
  onDisabledPress,
  onPress,
}: ScanButtonProps) {
  const [cameraVisible, setCameraVisible] = useState(false);

  const handleCapture = (uri: string) => {
    setCameraVisible(false);
    onCapture(uri);
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.btn, disabled && styles.btnDisabled]}
        onPress={() => {
          if (disabled) {
            onDisabledPress?.();
            return;
          }
          if (onPress) {
            onPress();
            return;
          }
          setCameraVisible(true);
        }}
        activeOpacity={0.7}
      >
        <Ionicons name="camera" size={22} color={COLORS.white} />
        <Text style={styles.btnText}>{label}</Text>
      </TouchableOpacity>

      {/* Only mount the internal InAppCamera Modal when the caller didn't
          provide an onPress override. Avoids a dormant Modal on Android. */}
      {!onPress && (
        <InAppCamera
          visible={cameraVisible}
          onCapture={handleCapture}
          onClose={() => setCameraVisible(false)}
          quality={0.9}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: COLORS.teal500,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 16,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: COLORS.white, fontSize: 17, fontWeight: '700' },
});
