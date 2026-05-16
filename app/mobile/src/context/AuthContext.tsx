// src/context/AuthContext.tsx
// Provides JWT auth state to the entire app.
// Stores token + user in SecureStore so the session survives restarts securely.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { JWT_STORAGE_KEY, USER_STORAGE_KEY, registerPushToken, setUnauthorizedHandler } from '../services/api';
import { AuthUser, VerifyResponse } from '../types';
import { PENDING_JOIN_CODE_KEY } from '../constants';
import { clearDeadLetter, clearQueue, getQueue } from '../services/offlineQueue';
import { clearMutationQueue, getMutationQueue } from '../services/mutationQueue';
import { clearReadCache } from '../services/readCache';
import { warmOfflineCache } from '../services/prefetch';
import { setUser as setAnalyticsUser, track, flush as flushAnalytics } from '../services/analytics';
import NetInfo from '@react-native-community/netinfo';

const PIN_SET_KEY = 'neriah_has_pin';
const TERMS_ACCEPTED_KEY = 'neriah_terms_accepted';
const TERMS_VERSION = '1.0';

// ── Context shape ─────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;               // true while reading SecureStore on startup
  hasPin: boolean;                // true if user has set a PIN (persisted)
  pinUnlocked: boolean;           // true after PIN entered or fresh OTP login
  needsPinSetup: boolean;         // true after first OTP login with no PIN set
  termsAccepted: boolean;         // true if user has accepted current terms version
  login: (response: VerifyResponse) => Promise<void>;
  logout: () => Promise<void>;
  markPinSet: () => Promise<void>;  // call after successful PIN creation
  skipPinSetup: () => void;         // user chose "Skip for now"
  unlockWithPin: () => void;        // call after successful PIN verify on cold start
  updateUser: (updates: Partial<AuthUser>, newToken?: string) => Promise<void>; // update profile in-place
  acceptTerms: () => Promise<void>; // call after user accepts terms agreement
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  loading: true,
  hasPin: false,
  pinUnlocked: false,
  needsPinSetup: false,
  termsAccepted: false,
  login: async () => {},
  logout: async () => {},
  markPinSet: async () => {},
  skipPinSetup: () => {},
  unlockWithPin: () => {},
  updateUser: async () => {},
  acceptTerms: async () => {},
});

// ── JWT expiry check ──────────────────────────────────────────────────────────
//
// Decode the payload of a JWT (base64url) and check the `exp` claim.
// Returns true if the token has expired or is unreadable.
// This is a client-side check only — the server is still the authority.

function isJwtExpired(token: string): boolean {
  try {
    // JWT payload is base64url-encoded (uses - and _ instead of + and /)
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as { exp?: number };
    if (!payload.exp) return false; // no exp claim → treat as valid
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true; // malformed JWT → treat as expired
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasPin, setHasPin] = useState(false);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [needsPinSetup, setNeedsPinSetup] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Restore session from SecureStore on cold start
  useEffect(() => {
    const restore = async () => {
      try {
        const [storedToken, storedUserJson, storedPin, storedTermsVersion] = await Promise.all([
          SecureStore.getItemAsync(JWT_STORAGE_KEY),
          SecureStore.getItemAsync(USER_STORAGE_KEY),
          SecureStore.getItemAsync(PIN_SET_KEY),
          SecureStore.getItemAsync(TERMS_ACCEPTED_KEY),
        ]);

        if (storedToken && storedUserJson) {
          if (isJwtExpired(storedToken)) {
            // Token is expired — clear it now so the auth screen shows immediately
            // rather than flashing the main app and then getting a 401.
            // hasPin is NOT cleared — user can still re-authenticate on this device.
            await Promise.all([
              SecureStore.deleteItemAsync(JWT_STORAGE_KEY),
              SecureStore.deleteItemAsync(USER_STORAGE_KEY),
            ]).catch(() => {});
          } else {
            const stored = JSON.parse(storedUserJson) as AuthUser;
            // Backfill surname from combined name for sessions saved before split fields existed
            if (!stored.surname && stored.name) {
              const parts = stored.name.trim().split(' ');
              stored.first_name = stored.first_name || parts[0];
              stored.surname = parts.slice(1).join(' ') || parts[0];
            }
            setToken(storedToken);
            setUser(stored);
            // Identify the analytics layer with the restored user so events
            // emitted before login() runs (cold-start screen views, etc.)
            // still carry user_id / role.
            setAnalyticsUser(stored.id, stored.role, stored.phone);
            track('auth.session_restored', { role: stored.role }, { surface: 'auth' });
          }
        }

        if (storedPin === 'true') {
          setHasPin(true);
          // pinUnlocked stays false — user must enter PIN on cold start
        }
        if (storedTermsVersion === TERMS_VERSION) {
          setTermsAccepted(true);
        }
      } catch {
        // Ignore corrupt storage — start unauthenticated
      } finally {
        setLoading(false);
      }
    };
    restore();
  }, []);

  // Wire up 401 handler so any request that gets a 401 forces logout.
  // A 401 on a non-expired token means the server revoked it (token_version
  // change from account recovery). Logout clears the JWT and shows auth screen.
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  // Warm the offline cache on cold-start (after a stored session is
  // restored) and again whenever connectivity flips offline → online.
  // Login itself triggers a warm-up directly; this effect handles the
  // other two entry points.
  useEffect(() => {
    if (!user?.id) return;
    // warmOfflineCache hits teacher-only endpoints (listClasses,
    // listAnswerKeys, getTeacherSubmissions). Firing it for a student
    // 401s on listClasses, the axios 401 interceptor calls logout(),
    // and the student gets bounced back to RoleSelect immediately
    // after registration. Students get their own offline cache
    // warm-up via the per-screen load() effects (StudentHomeScreen,
    // etc.); this teacher-wide prefetch should never run for them.
    if (user.role !== 'teacher') return;

    // Cold-start warm-up — best-effort, runs once after restore.
    warmOfflineCache(user.id);

    // Reconnect warm-up — debounced to a single trigger per
    // offline → online edge.
    let wasConnected: boolean | null = null;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const nowConnected = !!state.isConnected;
      if (wasConnected === false && nowConnected) {
        warmOfflineCache(user.id);
      }
      wasConnected = nowConnected;
    });
    return unsubscribe;
  }, [user?.id, user?.role]);

  const login = useCallback(async (response: VerifyResponse) => {
    // If this is a student registering via join code, the pending join_code
    // was stored in AsyncStorage by StudentRegisterScreen before OTP navigation.
    let joinCode: string | undefined;
    if (response.user.role === 'student') {
      try {
        const pending = await AsyncStorage.getItem(PENDING_JOIN_CODE_KEY);
        if (pending) {
          joinCode = pending;
          await AsyncStorage.removeItem(PENDING_JOIN_CODE_KEY);
        }
      } catch {
        // Non-critical — proceed without join_code
      }
    }

    const authUser: AuthUser = {
      id: response.user.id,
      phone: response.user.phone,
      role: response.user.role,
      name: response.user.name,
      title: response.user.title,
      display_name: response.user.display_name,
      first_name: response.user.first_name,
      surname: response.user.surname,
      school: response.user.school ?? response.user.school_name,
      class_id: response.user.class_id,
      join_code: joinCode,
    };
    await Promise.all([
      SecureStore.setItemAsync(JWT_STORAGE_KEY, response.token),
      SecureStore.setItemAsync(USER_STORAGE_KEY, JSON.stringify(authUser)),
    ]);
    setToken(response.token);
    setUser(authUser);
    setPinUnlocked(true); // OTP login always unlocks

    // Identify subsequent analytics events with this user.
    setAnalyticsUser(authUser.id, authUser.role, authUser.phone);
    track('auth.login.success', { role: authUser.role }, { surface: 'auth' });

    // Fire-and-forget cache warm-up so the app is fully usable
    // offline without the teacher having to navigate every screen
    // online first. Teacher-only — see the role guard on the
    // useEffect above. Calling for a student 401s on listClasses
    // and bounces them back to RoleSelect via the axios handler.
    if (authUser.role === 'teacher') {
      warmOfflineCache(authUser.id);
    }

    // Show PIN setup prompt if user hasn't set a PIN AND hasn't dismissed the prompt before.
    // "neriah_pin_prompt_shown" is written to AsyncStorage when the user either sets a PIN
    // or taps "Skip" in PinSetupScreen, so it survives logout/re-login and JWT rotation.
    const [existingPin, promptShown] = await Promise.all([
      SecureStore.getItemAsync(PIN_SET_KEY),
      AsyncStorage.getItem('neriah_pin_prompt_shown'),
    ]);
    if (existingPin !== 'true' && promptShown !== 'true') {
      setNeedsPinSetup(true);
    }

    // Register Expo push token in the background (best-effort).
    // Skip in Expo Go — push notifications require a standalone/dev-client build.
    if (Device.isDevice && Constants.appOwnership !== 'expo') {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status === 'granted') {
          const tokenData = await Notifications.getExpoPushTokenAsync();
          await registerPushToken(tokenData.data);
        }
      } catch {
        // Push registration is non-critical
      }
    }
  }, []);

  const logout = useCallback(async () => {
    // Emit logout event BEFORE clearing the JWT — flush() needs the
    // token to authenticate the /events/batch POST.
    track('auth.logout', undefined, { surface: 'auth' });
    // Best-effort flush so the logout event ships with the user still
    // identified. Failure is fine — events stay queued and replay on
    // the next login.
    flushAnalytics().catch(() => {});

    // Clear the offline scan queue so the next teacher on this device
    // doesn't inherit stale items. Log discarded items first (never drop
    // silently) so post-hoc debugging is possible.
    try {
      const pending = await getQueue();
      if (pending.length > 0) {
        console.warn(
          `[logout] discarding ${pending.length} queued scan(s):`,
          pending.map((i) => ({
            id: i.id,
            student_id: i.student_id,
            queued_at: i.queued_at,
            retry_count: i.retry_count,
          })),
        );
      }
      // Same reasoning for the mutation queue: log discarded items
      // before wiping so post-hoc audit is possible if a teacher
      // reports "I approved a submission but it never went through".
      const pendingMutations = await getMutationQueue();
      if (pendingMutations.length > 0) {
        console.warn(
          `[logout] discarding ${pendingMutations.length} queued mutation(s):`,
          pendingMutations.map((m) => ({
            id: m.id,
            type: m.op.type,
            queued_at: m.queued_at,
            retry_count: m.retry_count,
          })),
        );
      }
      await clearQueue();
      await clearDeadLetter();
      await clearMutationQueue();
      await clearReadCache();
    } catch {
      // Best-effort — never block logout on storage errors
    }

    await Promise.all([
      SecureStore.deleteItemAsync(JWT_STORAGE_KEY),
      SecureStore.deleteItemAsync(USER_STORAGE_KEY),
    ]);
    setToken(null);
    setUser(null);
    setPinUnlocked(false);
    setNeedsPinSetup(false);
    // hasPin intentionally preserved — user may log back in with same phone

    // Drop user identity from analytics. The next login() will re-identify;
    // any events emitted between now and then carry user_id=null.
    setAnalyticsUser(null, null, null);
  }, []);

  const markPinSet = useCallback(async () => {
    await SecureStore.setItemAsync(PIN_SET_KEY, 'true');
    setHasPin(true);
    setNeedsPinSetup(false);
  }, []);

  const skipPinSetup = useCallback(() => {
    setNeedsPinSetup(false);
  }, []);

  const unlockWithPin = useCallback(() => {
    setPinUnlocked(true);
  }, []);

  const acceptTerms = useCallback(async () => {
    await SecureStore.setItemAsync(TERMS_ACCEPTED_KEY, TERMS_VERSION);
    setTermsAccepted(true);
  }, []);

  const updateUser = useCallback(async (updates: Partial<AuthUser>, newToken?: string) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, ...updates };
      SecureStore.setItemAsync(USER_STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
    if (newToken) {
      setToken(newToken);
      await SecureStore.setItemAsync(JWT_STORAGE_KEY, newToken);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, hasPin, pinUnlocked, needsPinSetup, termsAccepted, login, logout, markPinSet, skipPinSetup, unlockWithPin, updateUser, acceptTerms }),
    [user, token, loading, hasPin, pinUnlocked, needsPinSetup, termsAccepted, login, logout, markPinSet, skipPinSetup, unlockWithPin, updateUser, acceptTerms],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export const useAuth = () => useContext(AuthContext);
