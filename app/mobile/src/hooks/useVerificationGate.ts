// src/hooks/useVerificationGate.ts
// Reusable verification gate for sensitive actions.
// Shows PIN modal (if PIN is set) and/or OTP modal before proceeding.

import { useState, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface VerificationState {
  /** Whether PIN verification is currently showing */
  pinModalVisible: boolean;
  /** Whether OTP verification is currently showing */
  otpModalVisible: boolean;
  /** Phone number for OTP (masked for display) */
  otpPhone: string;
  /** OTP verification ID */
  verificationId: string;
  /** Dismiss all modals */
  dismiss: () => void;
}

type Action = () => void | Promise<void>;

/**
 * Hook that gates sensitive actions behind PIN and/or OTP verification.
 *
 * Usage:
 *   const gate = useVerificationGate();
 *   // Then in JSX render gate.pinModalVisible / gate.otpModalVisible modals
 *   // On PIN success call gate.onPinVerified()
 *   // On OTP success call gate.onOtpVerified()
 *
 *   gate.guard(() => doSensitiveAction(), { requirePin: true });
 */
export function useVerificationGate() {
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [otpModalVisible, setOtpModalVisible] = useState(false);
  const [otpPhone, setOtpPhone] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const pendingAction = useRef<Action | null>(null);
  const pendingRequireOtp = useRef(false);

  const dismiss = useCallback(() => {
    setPinModalVisible(false);
    setOtpModalVisible(false);
    pendingAction.current = null;
    pendingRequireOtp.current = false;
  }, []);

  /**
   * Gate an action behind PIN and/or OTP verification.
   */
  const guard = useCallback(async (
    action: Action,
    options: { requirePin?: boolean; requireOtp?: boolean; phone?: string } = {},
  ) => {
    pendingAction.current = action;
    pendingRequireOtp.current = options.requireOtp ?? false;
    if (options.phone) setOtpPhone(options.phone);

    if (options.requirePin) {
      const hasPin = await SecureStore.getItemAsync('neriah_has_pin');
      if (hasPin === 'true') {
        setPinModalVisible(true);
        return; // Wait for onPinVerified
      }
    }

    // No PIN required or no PIN set — check OTP
    if (options.requireOtp) {
      setOtpModalVisible(true);
      return; // Wait for onOtpVerified
    }

    // No verification needed — proceed immediately
    await action();
    pendingAction.current = null;
  }, []);

  /** Called when PIN verification succeeds. */
  const onPinVerified = useCallback(async () => {
    setPinModalVisible(false);
    if (pendingRequireOtp.current) {
      setOtpModalVisible(true);
      return; // Wait for onOtpVerified
    }
    // PIN was all that was needed — proceed
    const action = pendingAction.current;
    pendingAction.current = null;
    if (action) await action();
  }, []);

  /** Called when OTP verification succeeds. */
  const onOtpVerified = useCallback(async () => {
    setOtpModalVisible(false);
    const action = pendingAction.current;
    pendingAction.current = null;
    if (action) await action();
  }, []);

  return {
    pinModalVisible,
    otpModalVisible,
    otpPhone,
    verificationId,
    dismiss,
    guard,
    onPinVerified,
    onOtpVerified,
  };
}
