// src/utils/retry.ts
// Exponential-backoff retry for API calls that may fail due to transient errors.
// Does NOT retry on client errors (4xx) — only network / server errors.

export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Offline or client-side (4xx) — don't retry
      const e = error as Record<string, unknown>;
      if (e?.isOffline) throw error;
      const status = (e?.response as Record<string, unknown> | undefined)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) throw error;

      // Last attempt — give up
      if (attempt === maxRetries - 1) throw error;

      // Wait before next attempt: 2s, 4s, 8s
      await new Promise<void>(resolve =>
        setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)),
      );
    }
  }

  throw lastError;
};
