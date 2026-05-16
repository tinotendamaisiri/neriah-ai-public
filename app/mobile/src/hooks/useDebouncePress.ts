// src/hooks/useDebouncePress.ts
// Prevents double-tap on action buttons by locking during execution.
// Usage:
//   const handleSubmit = useDebouncePress(async () => { ... });
//   <TouchableOpacity onPress={handleSubmit} />

import { useCallback, useRef } from 'react';

export const useDebouncePress = (
  onPress: () => Promise<void> | void,
  lockMs = 1500,
): (() => void) => {
  const locked = useRef(false);

  return useCallback(async () => {
    if (locked.current) return;
    locked.current = true;
    try {
      await onPress();
    } finally {
      setTimeout(() => { locked.current = false; }, lockMs);
    }
  }, [onPress, lockMs]);
};
