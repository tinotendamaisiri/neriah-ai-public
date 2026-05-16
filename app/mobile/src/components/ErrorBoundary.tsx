// src/components/ErrorBoundary.tsx
// Catches rendering crashes. Shows a recovery UI without exposing raw error details.
// React error boundaries must be class components.

import React, { Component, ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { COLORS } from '../constants/colors';

interface Props {
  children: ReactNode;
  /** Optional label for the recover button. Default: "Try Again" */
  resetLabel?: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log in dev; in production this would go to your error tracker
    if (__DEV__) {
      console.error('[ErrorBoundary] Caught rendering error:', error, info.componentStack);
    }
  }

  reset = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Ionicons name="warning-outline" size={56} color={COLORS.amber500} style={styles.icon} />
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            An unexpected error occurred. Your data is safe — tap below to try again.
          </Text>
          <TouchableOpacity style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>{this.props.resetLabel ?? 'Try Again'}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: 32,
  },
  icon: { marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '700', color: COLORS.gray900, marginBottom: 12, textAlign: 'center' },
  body: {
    fontSize: 15,
    color: COLORS.gray500,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
    maxWidth: 300,
  },
  button: {
    backgroundColor: COLORS.teal500,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 36,
  },
  buttonText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
});
