// src/services/readCache.ts
// Read-through cache for teacher data so the app stays usable offline,
// the way WhatsApp keeps your chats visible without internet.
//
// Behaviour:
//   1. Caller invokes `withCache(key, fetcher)`.
//   2. We attempt the network fetch.
//   3. On success we write the result to AsyncStorage under `cache:<key>`
//      and return it.
//   4. If the fetch fails because the device is offline (api.ts wraps
//      these errors with `isOffline: true`), we read the last cached
//      value and return it. The caller never sees an error, so screens
//      that today show "Failed to load students" just render the
//      stale-but-correct data.
//   5. Any other error (auth, server 500, etc.) re-throws unchanged so
//      it surfaces to the user as before.
//
// Cache lifetime is intentionally indefinite — we'd rather show
// last-known data than nothing on a flaky connection. The next online
// fetch overwrites it.

import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = 'cache:';

function isOfflineError(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { isOffline?: boolean }).isOffline);
}

export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const storageKey = `${CACHE_PREFIX}${key}`;
  try {
    const fresh = await fetcher();
    AsyncStorage.setItem(storageKey, JSON.stringify(fresh)).catch(() => {});
    return fresh;
  } catch (err) {
    if (isOfflineError(err)) {
      const cached = await AsyncStorage.getItem(storageKey).catch(() => null);
      if (cached != null) {
        try {
          return JSON.parse(cached) as T;
        } catch {
          // Cached blob is corrupt — drop it and rethrow so the screen
          // sees the real offline error and can show its empty state.
          AsyncStorage.removeItem(storageKey).catch(() => {});
        }
      }
    }
    throw err;
  }
}

// Read a cache slot directly without making any network call. Used
// for cross-key fallbacks (e.g. a per-class submissions view falling
// back to the teacher-wide cached slot when offline).
export async function readCacheOnly<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(`${CACHE_PREFIX}${key}`).catch(() => null);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    AsyncStorage.removeItem(`${CACHE_PREFIX}${key}`).catch(() => {});
    return null;
  }
}

// Wipe all cached reads. Called on logout so the next user doesn't
// briefly see the previous teacher's classes.
export async function clearReadCache(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((k) => k.startsWith(CACHE_PREFIX));
  if (ours.length > 0) await AsyncStorage.multiRemove(ours);
}
