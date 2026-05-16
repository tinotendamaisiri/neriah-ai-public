// src/utils/showError.ts
// Centralized error display. All catch blocks should use showError(err) instead
// of rolling their own Alert.alert calls.

import { Alert } from 'react-native';

/**
 * Show a user-friendly alert from any caught error.
 * Handles the normalized error shape from api.ts interceptor:
 *   { title, message, isOffline? }
 * as well as raw Axios errors and unknown values.
 */
export const showError = (error: unknown): void => {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title : 'Error';
    const message = typeof e.message === 'string'
      ? e.message
      : 'Something went wrong. Please try again.';
    Alert.alert(title, message);
    return;
  }
  Alert.alert('Error', 'Something went wrong. Please try again.');
};

/**
 * Show a brief success notice. Use sparingly — prefer UI state changes over alerts.
 */
export const showSuccess = (message: string, title = 'Done'): void => {
  Alert.alert(title, message);
};
