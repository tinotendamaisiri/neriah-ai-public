// src/context/ModelContext.tsx
// React context for the on-device model download state machine.
//
// State machine:
//   idle        — no download in progress, model not on disk
//   downloading — active download, progress 0–100
//   paused      — download paused, can be resumed
//   done        — model file on disk and ready
//   error       — download failed
//
// One-time prompt logic:
//   After device capability detection, if the device is capable AND the user
//   hasn't been prompted before, showPrompt = true. The modal in App.tsx
//   renders when showPrompt is true. Accepting starts the download; skipping
//   records the prompt and never shows it again.
//
// Wi-Fi only gate:
//   If wifiOnly is enabled, downloads only start/resume on a Wi-Fi connection.
//   The user can toggle this in Settings. Persisted via SecureStore.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Alert, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';

import {
  detectCapability,
  canRunVariant,
  type DeviceCapability,
} from '../services/deviceCapabilities';
import { useAuth } from './AuthContext';

export type { DeviceCapability };
import {
  pauseDownload as pauseMgr,
  cancelDownload as cancelMgr,
  deleteModelFile,
  isModelOnDisk,
  MODEL_DOWNLOADED_KEY,
  DOWNLOAD_PROMPTED_KEY,
  WIFI_ONLY_KEY,
  WIFI_NUDGE_LAST_DATE_KEY,
  WIFI_NUDGE_NEVER_KEY,
  MODEL_DISPLAY_NAME,
  MODEL_SIZE_LABEL,
  MODEL_SIZES_BYTES,
  type ModelVariant,
} from '../services/modelManager';
import {
  isNativeModuleAvailable,
  loadModel,
  getLiteRTState,
} from '../services/litert';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DownloadStatus = 'idle' | 'downloading' | 'paused' | 'done' | 'error';

export interface ModelContextValue {
  /** Current download status. */
  status: DownloadStatus;
  /** Download progress 0–100. Meaningful only when status === 'downloading'. */
  progress: number;
  /** True if the one-time download prompt should be shown. */
  showPrompt: boolean;
  /** True if the model file is present and usable. */
  modelReady: boolean;
  /** Which model variant this device will use (null if cloud-only). */
  variant: ModelVariant | null;
  /** Raw device capability tier — null until first launch detection completes. */
  capability: DeviceCapability | null;
  /** Whether downloads are restricted to Wi-Fi. */
  wifiOnly: boolean;
  /** Last error message, if status === 'error'. */
  errorMessage: string | null;

  /** Called once on app start to check capability + prompt state. */
  initPrompt: () => Promise<void>;
  /** User tapped "Download now" on the prompt. Starts the download. */
  acceptDownload: () => Promise<void>;
  /** User tapped "Skip for now" on the prompt. Records the prompt. */
  skipDownload: () => Promise<void>;
  /** Pause the active download. */
  pauseDownload: () => Promise<void>;
  /** Resume a paused download. */
  resumeDownload: () => Promise<void>;
  /** Cancel download and delete partial file. */
  cancelDownload: () => Promise<void>;
  /** Delete the downloaded model to free storage. */
  deleteModel: () => Promise<void>;
  /** Toggle Wi-Fi only setting. */
  setWifiOnly: (val: boolean) => Promise<void>;

  /** True when the recurring Wi-Fi nudge banner should be shown. */
  showWifiNudge: boolean;
  /**
   * Check whether the recurring Wi-Fi nudge should be shown now.
   * Safe to call on every HomeScreen focus — all gates are checked internally.
   */
  checkWifiNudge: () => Promise<void>;
  /** User tapped "Later" — dismisses the nudge and resets the 7-day clock. */
  dismissWifiNudge: () => Promise<void>;
  /** User tapped "Never ask again" — permanently suppresses the nudge. */
  neverShowNudge: () => Promise<void>;
  /**
   * Called by active-task screens (grading, submitting, tutoring) to prevent
   * the nudge from appearing while the user is busy.
   * Pass true on mount, false on unmount.
   */
  suppressNudge: (suppress: boolean) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ModelContext = createContext<ModelContextValue | null>(null);

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error('useModel must be used inside ModelProvider');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Which variant a logged-in user gets. Both roles now share E2B:
 *
 *   - Most African teacher phones can't run E4B (need 8+ GB RAM); leaving
 *     them on cloud-only for everything excludes the majority of the
 *     market from offline grading entirely.
 *   - E2B handles short-answer text grading well; the gap to E4B/cloud
 *     is biggest on math, where we now block offline grading explicitly
 *     in PageReviewScreen and require the teacher to submit online for
 *     math homeworks.
 *
 * Returns null until auth has loaded so the boot effect waits for role
 * before running the device-capability check.
 */
function requiredVariantForRole(role: 'teacher' | 'student' | undefined): ModelVariant | null {
  if (role === 'teacher' || role === 'student') return 'e2b';
  return null;
}

async function isWifi(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return state.type === 'wifi';
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ModelProvider({ children }: { children: React.ReactNode }) {
  // Web never downloads models — all inference is cloud-side.
  if (Platform.OS === 'web') {
    const noopCtx: ModelContextValue = {
      status: 'idle',
      progress: 0,
      showPrompt: false,
      modelReady: false,
      variant: null,
      capability: 'cloud-only',
      wifiOnly: false,
      errorMessage: null,
      initPrompt: async () => {},
      acceptDownload: async () => {},
      skipDownload: async () => {},
      pauseDownload: async () => {},
      resumeDownload: async () => {},
      cancelDownload: async () => {},
      deleteModel: async () => {},
      setWifiOnly: async () => {},
      showWifiNudge: false,
      checkWifiNudge: async () => {},
      dismissWifiNudge: async () => {},
      neverShowNudge: async () => {},
      suppressNudge: () => {},
    };
    return <ModelContext.Provider value={noopCtx}>{children}</ModelContext.Provider>;
  }

  return <ModelProviderNative>{children}</ModelProviderNative>;
}

function ModelProviderNative({ children }: { children: React.ReactNode }) {
  // Role is the source of truth for which variant we test against. ModelProvider
  // is mounted inside AuthProvider in App.tsx so useAuth() is always callable.
  const { user } = useAuth();
  const role = user?.role;

  const [status, setStatus]             = useState<DownloadStatus>('idle');
  const [progress, setProgress]         = useState(0);
  const [showPrompt, setShowPrompt]     = useState(false);
  const [modelReady, setModelReady]     = useState(false);
  const [variant, setVariant]           = useState<ModelVariant | null>(null);
  const [capability, setCapability]     = useState<DeviceCapability | null>(null);
  const [wifiOnly, setWifiOnlyState]    = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep a ref to the current variant so callbacks can access it without
  // stale-closure issues.
  const variantRef = useRef<ModelVariant | null>(null);
  useEffect(() => { variantRef.current = variant; }, [variant]);

  // ── Auto-load the downloaded model into memory ────────────────────────────
  // Without this, the router's 'on-device' branch never fires even when the
  // 2.96 GB .task file is on disk — router.ts checks getLiteRTState()
  // .loadedModel, not disk presence. Fires once whenever (modelReady,
  // variant) both flip true AND the native module is linked. A no-op in
  // Expo Go (MediapipeLlm == null) so nothing breaks there.
  const loadingRef = useRef(false);
  useEffect(() => {
    if (!modelReady || !variant) return;
    if (!isNativeModuleAvailable()) return;
    if (getLiteRTState().loadedModel === variant) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    loadModel(variant)
      .catch((err: unknown) => {
        // Don't block anything — the router falls back to 'unavailable' if
        // the load failed, and the teacher still gets the offline-queue
        // path. We log and move on.
        console.warn(
          '[ModelContext] loadModel failed:',
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        loadingRef.current = false;
      });
  }, [modelReady, variant]);

  // ── Wi-Fi nudge refs ───────────────────────────────────────────────────────
  // These are refs (not state) because they govern show-guards, not render output.
  /** True once the nudge banner has been shown in this app session. */
  const nudgeShownThisSessionRef = useRef(false);
  /** Set to true by active-task screens (grading, tutoring) to block the nudge. */
  const nudgeSuppressedRef = useRef(false);

  const [showWifiNudge, setShowWifiNudge] = useState(false);

  // ── Boot: read persisted state, run capability check for THIS user's role ──
  // Re-runs whenever the role becomes known (auth load is async on cold
  // start, and role can change if user logs out and back in as a different
  // role on the same device).

  useEffect(() => {
    (async () => {
      // Wi-Fi only preference (role-independent)
      const wifiPref = await SecureStore.getItemAsync(WIFI_ONLY_KEY).catch(() => null);
      if (wifiPref === 'true') setWifiOnlyState(true);

      // Refresh the descriptive tier label (used by Settings UI for info text)
      // — independent of the role-aware variant decision below.
      const cap = await detectCapability();
      setCapability(cap);

      // Role unknown yet (AuthContext still loading) — leave variant=null
      // until we know which check to run.
      const required = requiredVariantForRole(role);
      if (!required) {
        setVariant(null);
        variantRef.current = null;
        return;
      }

      // Hard gate: device must pass the check for the role's required
      // variant. No downgrades — a teacher whose phone can't run E4B is
      // cloud-only, never silently moved to E2B.
      const ok = await canRunVariant(required);
      if (!ok) {
        setVariant(null);
        variantRef.current = null;
        return;
      }

      setVariant(required);
      variantRef.current = required;

      const downloaded = await SecureStore.getItemAsync(MODEL_DOWNLOADED_KEY).catch(() => null);
      if (downloaded === 'true') {
        // Sanity: confirm file actually exists
        const onDisk = await isModelOnDisk(required);
        if (onDisk) {
          setStatus('done');
          setModelReady(true);
        } else {
          // File missing — clear stale flag
          await SecureStore.deleteItemAsync(MODEL_DOWNLOADED_KEY).catch(() => {});
        }
      }
    })();
  }, [role]);

  // ── initPrompt ─────────────────────────────────────────────────────────────

  const initPrompt = useCallback(async () => {
    if (Platform.OS === 'web') return;

    const cap = await detectCapability();
    setCapability(cap);

    // Role-aware: a teacher needs E4B, a student needs E2B. If the device
    // can't run the variant their role requires, this is a cloud-only
    // device — nothing to prompt for, nothing to download.
    const required = requiredVariantForRole(role);
    if (!required) return;
    const ok = await canRunVariant(required);
    if (!ok) {
      setVariant(null);
      variantRef.current = null;
      return;
    }

    setVariant(required);
    variantRef.current = required;

    // Already done?
    const downloaded = await SecureStore.getItemAsync(MODEL_DOWNLOADED_KEY).catch(() => null);
    if (downloaded === 'true') {
      const onDisk = await isModelOnDisk(required);
      if (onDisk) { setStatus('done'); setModelReady(true); return; }
      await SecureStore.deleteItemAsync(MODEL_DOWNLOADED_KEY).catch(() => {});
    }

    // Already prompted?
    const prompted = await SecureStore.getItemAsync(DOWNLOAD_PROMPTED_KEY).catch(() => null);
    if (prompted === 'true') return;

    // Startup modal is disabled — users opt in via Settings or the Wi-Fi nudge.
    // Mark as prompted so the nudge gate (requires DOWNLOAD_PROMPTED_KEY='true'
    // at line ~384) opens on the next Wi-Fi connection.
    await SecureStore.setItemAsync(DOWNLOAD_PROMPTED_KEY, 'true').catch(() => {});
  }, [role]);

  // ── acceptDownload ─────────────────────────────────────────────────────────

  // Shared download/load runner — used by acceptDownload, resumeDownload,
  // and the Wi-Fi auto-download handler. Wraps litert.loadModel (which
  // internally delegates to modelManager.ensureModelDownloaded for the
  // resumable download + the library for native init) and translates
  // success/pause/cancel/error into ModelContext state.
  const runDownload = useCallback(async (v: ModelVariant) => {
    setStatus('downloading');
    setErrorMessage(null);
    try {
      await loadModel(v, (pct) => setProgress(pct));
      await SecureStore.setItemAsync(MODEL_DOWNLOADED_KEY, 'true').catch(() => {});
      setStatus('done');
      setModelReady(true);
      setProgress(100);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // pauseAsync() throws with "paused" (or "cancelled") — not a real
      // error. Status is already set by the pause handler for the Wi-Fi
      // branch; for user-initiated pauses we shouldn't overwrite it with
      // 'error' either. Just return silently.
      if (msg.includes('paused') || msg.includes('cancelled')) return;
      setStatus('error');
      setErrorMessage(msg);
    }
  }, []);

  const acceptDownload = useCallback(async () => {
    setShowPrompt(false);
    await SecureStore.setItemAsync(DOWNLOAD_PROMPTED_KEY, 'true').catch(() => {});

    const v = variantRef.current;
    if (!v) return;

    // Wi-Fi only gate
    const onWifi = await isWifi();
    const wifiPref = await SecureStore.getItemAsync(WIFI_ONLY_KEY).catch(() => null);
    if (wifiPref === 'true' && !onWifi) {
      Alert.alert(
        'Wi-Fi required',
        `${MODEL_DISPLAY_NAME[v]} (${MODEL_SIZE_LABEL[v]}) will download automatically when you connect to Wi-Fi.`,
      );
      return;
    }

    setProgress(0);
    await runDownload(v);
  }, [runDownload]);

  // ── skipDownload ───────────────────────────────────────────────────────────

  const skipDownload = useCallback(async () => {
    setShowPrompt(false);
    await SecureStore.setItemAsync(DOWNLOAD_PROMPTED_KEY, 'true').catch(() => {});
  }, []);

  // ── pauseDownload ──────────────────────────────────────────────────────────

  const pauseDownload = useCallback(async () => {
    await pauseMgr();
    setStatus('paused');
  }, []);

  // ── resumeDownload ─────────────────────────────────────────────────────────

  const resumeDownload = useCallback(async () => {
    const v = variantRef.current;
    if (!v) return;

    // Wi-Fi only gate
    const onWifi = await isWifi();
    const wifiPref = await SecureStore.getItemAsync(WIFI_ONLY_KEY).catch(() => null);
    if (wifiPref === 'true' && !onWifi) {
      Alert.alert('Wi-Fi required', 'Connect to Wi-Fi to resume the download.');
      return;
    }

    // ensureModelDownloaded picks up the saved DownloadPauseState and
    // resumes from the last committed byte — no fresh restart.
    await runDownload(v);
  }, [runDownload]);

  // ── cancelDownload ─────────────────────────────────────────────────────────

  const cancelDownload = useCallback(async () => {
    const v = variantRef.current;
    if (!v) return;
    await cancelMgr(v);
    setStatus('idle');
    setProgress(0);
    setErrorMessage(null);
  }, []);

  // ── deleteModel ────────────────────────────────────────────────────────────

  const deleteModel = useCallback(async () => {
    const v = variantRef.current;
    if (!v) return;
    await deleteModelFile(v);
    setStatus('idle');
    setModelReady(false);
    setProgress(0);
  }, []);

  // ── setWifiOnly ────────────────────────────────────────────────────────────

  const setWifiOnly = useCallback(async (val: boolean) => {
    setWifiOnlyState(val);
    await SecureStore.setItemAsync(WIFI_ONLY_KEY, val ? 'true' : 'false').catch(() => {});
  }, []);

  // ── checkWifiNudge ─────────────────────────────────────────────────────────
  // All gates are checked here so the caller (HomeScreen) can call this
  // unconditionally on every focus without any logic on its side.

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  const checkWifiNudge = useCallback(async () => {
    if (Platform.OS === 'web') return;
    // Once-per-session guard
    if (nudgeShownThisSessionRef.current) return;
    // Active-task suppression guard
    if (nudgeSuppressedRef.current) return;

    // Device must be on-device-capable
    // Variant comes from the user's role — never from "best the device
    // can do". If we don't yet know the role (auth still loading) or the
    // device fails the role-required variant's check, skip the nudge.
    const required = variantRef.current ?? requiredVariantForRole(role);
    if (!required) return;
    const ok = await canRunVariant(required);
    if (!ok) return;

    // Model must not already be on disk
    const onDisk = await isModelOnDisk(required);
    if (onDisk) return;

    // User must have seen the one-time prompt (i.e. skipped it, not brand-new)
    const prompted = await SecureStore.getItemAsync(DOWNLOAD_PROMPTED_KEY).catch(() => null);
    if (prompted !== 'true') return;

    // Permanent opt-out
    const neverNudge = await SecureStore.getItemAsync(WIFI_NUDGE_NEVER_KEY).catch(() => null);
    if (neverNudge === 'true') return;

    // 7-day cooldown
    const lastNudgeRaw = await SecureStore.getItemAsync(WIFI_NUDGE_LAST_DATE_KEY).catch(() => null);
    if (lastNudgeRaw) {
      const lastMs = parseInt(lastNudgeRaw, 10);
      if (!isNaN(lastMs) && Date.now() - lastMs < SEVEN_DAYS_MS) return;
    }

    // Must be on Wi-Fi right now
    const onWifi = await isWifi();
    if (!onWifi) return;

    // All gates passed — show the nudge once this session
    nudgeShownThisSessionRef.current = true;
    setShowWifiNudge(true);
  }, [role]);

  // ── dismissWifiNudge ───────────────────────────────────────────────────────
  // "Later" — hides the banner and resets the 7-day clock.

  const dismissWifiNudge = useCallback(async () => {
    setShowWifiNudge(false);
    await SecureStore.setItemAsync(
      WIFI_NUDGE_LAST_DATE_KEY,
      String(Date.now()),
    ).catch(() => {});
  }, []);

  // ── neverShowNudge ─────────────────────────────────────────────────────────
  // "Never ask again" — permanently suppresses the nudge via SecureStore.

  const neverShowNudge = useCallback(async () => {
    setShowWifiNudge(false);
    await SecureStore.setItemAsync(WIFI_NUDGE_NEVER_KEY, 'true').catch(() => {});
  }, []);

  // ── suppressNudge ──────────────────────────────────────────────────────────
  // Called by active-task screens on mount (true) and unmount (false).

  const suppressNudge = useCallback((suppress: boolean) => {
    nudgeSuppressedRef.current = suppress;
    if (suppress) setShowWifiNudge(false);
  }, []);

  // ── Auto-download on Wi-Fi ──────────────────────────────────────────────────
  // Watches connectivity: starts download when Wi-Fi connects, pauses when it drops.

  const autoDownloadStartedRef = useRef(false);
  const AUTO_NOTIFIED_KEY = 'offline_model_auto_notified';

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(async (state) => {
      const onWifi = state.type === 'wifi' && state.isConnected === true;
      const v = variantRef.current;

      if (onWifi && v) {
        // Model already downloaded or currently downloading — skip
        const downloaded = await SecureStore.getItemAsync(MODEL_DOWNLOADED_KEY).catch(() => null);
        if (downloaded === 'true') return;
        if (autoDownloadStartedRef.current) return; // already triggered this session

        // Check if model is on disk (stale flag cleared earlier)
        const onDisk = await isModelOnDisk(v);
        if (onDisk) return;

        // Auto-start download
        autoDownloadStartedRef.current = true;
        console.log('[ModelProvider] Wi-Fi detected — auto-starting model download');

        // One-time notification (first auto-download ever)
        const notified = await SecureStore.getItemAsync(AUTO_NOTIFIED_KEY).catch(() => null);
        if (notified !== 'true') {
          await SecureStore.setItemAsync(AUTO_NOTIFIED_KEY, 'true').catch(() => {});
          // Mark prompt as shown so the manual prompt never appears
          await SecureStore.setItemAsync(DOWNLOAD_PROMPTED_KEY, 'true').catch(() => {});
          Alert.alert(
            'Downloading offline AI',
            'Neriah is downloading the AI model in the background. Once complete, marking and tutoring work without internet.',
          );
        }

        // If there's saved savable state, runDownload resumes from it
        // automatically (ensureModelDownloaded handles that). Otherwise
        // it starts fresh. Don't reset progress when resuming so the UI
        // doesn't bounce visually.
        await runDownload(v);
        if (status === 'error') {
          autoDownloadStartedRef.current = false;
        }
      } else if (!onWifi && status === 'downloading') {
        // Wi-Fi dropped mid-download. modelManager.pauseDownload actually
        // pauses now (we own the DownloadResumable) and persists savable
        // state, so the next Wi-Fi reconnect resumes from the last
        // committed byte instead of starting over.
        console.log('[ModelProvider] Wi-Fi lost — pausing download');
        await pauseMgr();
        setStatus('paused');
        autoDownloadStartedRef.current = false; // allow auto-resume on reconnect
      }
    });

    return unsubscribe;
  }, [status]);

  // ── Context value ──────────────────────────────────────────────────────────

  const value: ModelContextValue = {
    status,
    progress,
    showPrompt,
    modelReady,
    variant,
    capability,
    wifiOnly,
    errorMessage,
    initPrompt,
    acceptDownload,
    skipDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    deleteModel,
    setWifiOnly,
    showWifiNudge,
    checkWifiNudge,
    dismissWifiNudge,
    neverShowNudge,
    suppressNudge,
  };

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}
