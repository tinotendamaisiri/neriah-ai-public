// src/services/modelManager.ts
// On-device model lifecycle — download + cache management.
//
// Hosts the resumable download state machine (ported from the pre-LiteRT-LM
// implementation). react-native-litert-lm's own download API has no resume
// support, so we download the .litertlm file ourselves via expo-file-system's
// createDownloadResumable (which can survive network drops and app restarts
// via an AsyncStorage-persisted DownloadPauseState) and hand the completed
// local path to the library's native loadModel.
//
// Public API:
//   ensureModelDownloaded(variant, onProgress) — resolves to the local path;
//     resumes from savable state on retry.
//   pauseDownload() — pauses the in-flight download and saves state.
//   cancelDownload(variant) — cancels + removes savable + deletes partial.
//   deleteModelFile(variant) — deletes a completed file and clears flags.
//     Callers should separately call litert.unloadModel() to release the
//     native session (this module does NOT import litert to avoid a
//     circular dep; litert imports ensureModelDownloaded from here).
//   isModelOnDisk(variant) — real file-size check on the cached file.
//
// Models served from the LiteRT community on HuggingFace:
//   Student (E2B): ~2.0 GB
//   Teacher (E4B): ~2.96 GB

import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { track, trackError } from './analytics';

// Keep-awake tag — held while a model download is in flight so screen-lock
// / Doze mode doesn't suspend the process mid-stream. Released in the
// finally block of ensureModelDownloaded.
const KEEP_AWAKE_TAG = 'neriah-model-download';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelVariant = 'e2b' | 'e4b';

// ── SecureStore keys (unchanged — ModelContext reads these directly) ─────────

export const MODEL_DOWNLOADED_KEY       = 'model_downloaded';
export const DOWNLOAD_PROMPTED_KEY      = 'model_download_prompted';
export const WIFI_ONLY_KEY              = 'wifi_only_downloads';
export const WIFI_NUDGE_LAST_DATE_KEY   = 'neriah_wifi_nudge_last_date';
export const WIFI_NUDGE_NEVER_KEY       = 'neriah_wifi_nudge_never';

/** Per-variant resumable snapshot key. */
function resumableKey(variant: ModelVariant): string {
  return `model_download_snapshot_${variant}`;
}

// ── Model URLs (LiteRT-LM community on HuggingFace) ──────────────────────────
// Same URLs the library ships as GEMMA_4_E2B_IT / GEMMA_4_E4B_IT constants;
// inlined so this module doesn't have to import from the native-binding-
// dependent react-native-litert-lm (which crashes at module-load in Expo Go).

export const MODEL_URLS: Record<ModelVariant, string> = {
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm',
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm',
};

// ── Local cache paths ─────────────────────────────────────────────────────────
// Files live under documentDirectory so they survive app updates (unlike
// Caches, which iOS can evict under storage pressure).

export const MODEL_DIR = `${FileSystem.documentDirectory ?? ''}models/`;

export const MODEL_PATHS: Record<ModelVariant, string> = {
  e2b: `${MODEL_DIR}gemma-4-E2B-it.litertlm`,
  e4b: `${MODEL_DIR}gemma-4-E4B-it.litertlm`,
};

// ── Display metadata (unchanged) ─────────────────────────────────────────────

// Exact file sizes from HuggingFace's published .litertlm files. These must
// match the on-disk file size byte-for-byte after a successful download —
// any deviation indicates a truncated download (interrupted network, server
// hangup, etc.) and the file MUST be re-downloaded. A truncated file silently
// passes basic existence checks but fails at engine load time with
// "TF_LITE_PREFILL_DECODE not found in the model" because the section
// offsets at the tail of the file point past EOF.
//
// Verified 2026-05-03 from the model's section offsets logged at engine
// load: section #11 (tf_lite_mtp_drafter) ends at byte 2,583,082,648, which
// matches HF's stated 2.58 GB.
export const MODEL_SIZES_BYTES: Record<ModelVariant, number> = {
  e2b: 2_583_082_648,   // 2.58 GB
  e4b: 3_650_000_000,   // ~3.65 GB (HF README)
};

export const MODEL_SIZE_LABEL: Record<ModelVariant, string> = {
  e2b: '2 GB',
  e4b: '3 GB',
};

// Both roles share E2B as of the E4B-removal pass — neutral label so the
// Settings copy reads cleanly for teachers and students alike. E4B's entry
// is kept for type completeness; nothing in the live code path reads it.
export const MODEL_DISPLAY_NAME: Record<ModelVariant, string> = {
  e2b: 'Neriah Offline AI (Gemma 4 E2B)',
  e4b: 'Neriah Offline AI (Gemma 4 E4B)',
};

// ── Active download tracking ──────────────────────────────────────────────────
// One download at a time per process. pauseDownload()/cancelDownload() drive
// this from ModelContext button actions and the Wi-Fi-drop handler.

let _active: FileSystem.DownloadResumable | null = null;
let _activeVariant: ModelVariant | null = null;

/** True iff a DownloadResumable is in flight right now. */
export function isDownloadActive(): boolean {
  return _active !== null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureModelDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODEL_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
  }
}

/**
 * True when the cached model file exists AND is at least 99% of the
 * expected size. The 80% tolerance the previous version used was too
 * lenient: it accepted truncated downloads that look complete on the
 * filesystem but fail at engine load with "section not found" because the
 * tail-of-file model sections were never written. 99% accommodates minor
 * size drifts between HuggingFace revisions while still catching real
 * truncations (which usually drop multiple hundred MB).
 *
 * If we ever need to verify exact byte-equality, switch to a SHA256 check
 * — but the file size is enough for now since HuggingFace serves the
 * canonical bytes.
 */
export async function isModelOnDisk(variant: ModelVariant): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(MODEL_PATHS[variant]);
    if (!info.exists) return false;
    const actualSize = (info as { size?: number }).size ?? 0;
    return actualSize >= MODEL_SIZES_BYTES[variant] * 0.99;
  } catch {
    return false;
  }
}

// ── Download (with resume) ────────────────────────────────────────────────────

/**
 * Ensure the model .litertlm file is on disk at MODEL_PATHS[variant],
 * resuming any saved DownloadPauseState if present. Returns the local
 * file URI on success.
 *
 * Engineered for African connectivity: assume drops are normal, not
 * exceptional. Auto-retries with exponential backoff up to 50 attempts.
 * Persists a resumable snapshot to AsyncStorage every ~3 s during the
 * download so unexpected interruptions (network drop, OS kill, screen
 * lock, Doze mode) recover from the last committed byte instead of
 * restarting at zero. Holds a keep-awake handle for the whole window so
 * screen-lock doesn't kill the process. Verifies file size on completion.
 *
 * Throws after exhausting retries OR immediately on user-initiated
 * pause / cancel (callers detect those via "paused" / "cancel" in the
 * error message).
 */
export async function ensureModelDownloaded(
  variant: ModelVariant,
  onProgress: (pct: number) => void,
): Promise<string> {
  const dest = MODEL_PATHS[variant];

  // Fast path: already cached at full size.
  if (await isModelOnDisk(variant)) {
    onProgress(100);
    return dest;
  }

  await ensureModelDir();

  // Hold the device awake for the duration. Without this, Doze mode on
  // Android (and screen-locked iOS) suspends the network task and the
  // download hangs. Best-effort — the keep-awake module isn't critical.
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});

  const _startedAt = Date.now();
  track(
    'litert.model.download.start',
    { variant, expected_size_bytes: MODEL_SIZES_BYTES[variant] },
    { surface: 'modelManager' },
  );

  try {
    const result = await _retryingDownload(variant, dest, onProgress);
    // Get final on-disk size for telemetry.
    let bytes: number | undefined;
    try {
      const info = await FileSystem.getInfoAsync(result);
      bytes = (info as { size?: number }).size;
    } catch {
      /* best-effort */
    }
    track(
      'litert.model.download.success',
      { variant, bytes },
      { surface: 'modelManager', latency_ms: Date.now() - _startedAt },
    );
    return result;
  } finally {
    try { deactivateKeepAwake(KEEP_AWAKE_TAG); } catch { /* ignore */ }
  }
}

const _MAX_DOWNLOAD_ATTEMPTS = 50;
const _SNAPSHOT_INTERVAL_MS = 3000;

/** Run a single download attempt + return on success, throw on failure. */
async function _doDownloadAttempt(
  variant: ModelVariant,
  dest: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const url = MODEL_URLS[variant];
  const expectedSize = MODEL_SIZES_BYTES[variant];

  let lastSnapshotMs = 0;
  let snapshotInFlight = false;
  // Sample progress events: emit roughly once per 10% bucket so the
  // dashboard sees ~10 progress points without flooding the queue.
  let lastReportedBucket = -1;

  const progressCallback = ({
    totalBytesWritten,
    totalBytesExpectedToWrite,
  }: FileSystem.DownloadProgressData) => {
    const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize;
    const pct = Math.min(99, Math.round((totalBytesWritten / total) * 100));
    onProgress(pct);

    const bucket = Math.floor(pct / 10);
    if (bucket > lastReportedBucket) {
      lastReportedBucket = bucket;
      track(
        'litert.model.download.progress',
        { variant, pct, bytes_written: totalBytesWritten },
        { surface: 'modelManager' },
      );
    }

    // Periodic resume-state snapshot. Without this, an unexpected death
    // (network drop, OS kill, screen lock + Doze) leaves AsyncStorage
    // empty and the next attempt starts at byte 0.
    const now = Date.now();
    if (_active && !snapshotInFlight && now - lastSnapshotMs > _SNAPSHOT_INTERVAL_MS) {
      lastSnapshotMs = now;
      snapshotInFlight = true;
      try {
        const savable = _active.savable();
        AsyncStorage.setItem(resumableKey(variant), JSON.stringify(savable))
          .catch(() => {})
          .finally(() => { snapshotInFlight = false; });
      } catch {
        snapshotInFlight = false;
      }
    }
  };

  // ── Resume from previously-persisted snapshot if present ─────────────────
  const savableRaw = await AsyncStorage.getItem(resumableKey(variant)).catch(() => null);
  if (savableRaw) {
    try {
      const savable: FileSystem.DownloadPauseState = JSON.parse(savableRaw);
      if (savable?.resumeData) {
        _active = new FileSystem.DownloadResumable(
          savable.url ?? url,
          savable.fileUri ?? dest,
          savable.options ?? {},
          progressCallback,
          savable.resumeData,
        );
        // Estimate bytes already on disk so the dashboard can show a
        // resume bar at the right offset.
        let bytesSoFar: number | undefined;
        try {
          const info = await FileSystem.getInfoAsync(savable.fileUri ?? dest);
          bytesSoFar = (info as { size?: number }).size;
        } catch {
          /* best-effort */
        }
        track(
          'litert.model.download.resumed',
          { variant, bytes_so_far: bytesSoFar },
          { surface: 'modelManager' },
        );
      }
    } catch {
      await AsyncStorage.removeItem(resumableKey(variant)).catch(() => {});
    }
  }

  // ── Fresh download (no resume snapshot or it was unusable) ───────────────
  if (!_active) {
    _active = FileSystem.createDownloadResumable(url, dest, {}, progressCallback);
  }
  _activeVariant = variant;

  try {
    const result = await _active.downloadAsync();
    _active = null;
    _activeVariant = null;

    if (!result?.uri) {
      throw new Error('Download completed but no file path was returned.');
    }
    // Post-download size verification (handles servers that close the
    // connection mid-stream without an explicit error).
    const postInfo = await FileSystem.getInfoAsync(result.uri);
    const actualSize = (postInfo as { size?: number }).size ?? 0;
    const minSize = Math.floor(expectedSize * 0.99);
    if (!postInfo.exists || actualSize < minSize) {
      try { await FileSystem.deleteAsync(result.uri, { idempotent: true }); } catch {}
      await AsyncStorage.removeItem(resumableKey(variant)).catch(() => {});
      throw new Error(
        `Model download incomplete: got ${actualSize} bytes, expected at least ${minSize} ` +
        `(target ${expectedSize}). File deleted; please retry the download.`,
      );
    }
    await AsyncStorage.removeItem(resumableKey(variant)).catch(() => {});
    onProgress(100);
    return result.uri;
  } catch (err) {
    // Persist resume state before propagating so the next attempt picks
    // up from the last committed byte.
    if (_active) {
      try {
        const savable = _active.savable();
        await AsyncStorage.setItem(resumableKey(variant), JSON.stringify(savable)).catch(() => {});
      } catch { /* ignore — best-effort */ }
    }
    _active = null;
    _activeVariant = null;
    throw err;
  }
}

/** Wrap _doDownloadAttempt with exponential-backoff auto-retry. */
async function _retryingDownload(
  variant: ModelVariant,
  dest: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= _MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await _doDownloadAttempt(variant, dest, onProgress);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();

      trackError('litert.model.download.failed', lastError, { variant, attempt });

      // User-initiated pause/cancel — don't retry, surface immediately.
      if (msg.includes('paused') || msg.includes('cancel')) throw lastError;
      // Permanent client errors (4xx) — retrying won't help.
      if (/\b40[0-9]\b/.test(msg)) throw lastError;
      // Out of attempts.
      if (attempt >= _MAX_DOWNLOAD_ATTEMPTS) break;

      // Exponential backoff capped at 30 s. Floor at 2 s so a flapping
      // network doesn't spin too fast.
      const delayMs = Math.min(2000 * Math.pow(2, Math.min(attempt - 1, 5)), 30_000);
      console.log(
        `[modelManager] download attempt ${attempt}/${_MAX_DOWNLOAD_ATTEMPTS} failed: ${lastError.message}. ` +
        `retrying in ${delayMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new Error('Download failed after exhausting retries');
}

// ── Pause / cancel ────────────────────────────────────────────────────────────

/**
 * Pause the in-flight download and persist its DownloadPauseState to
 * AsyncStorage so a later call to ensureModelDownloaded() can resume.
 * No-op if nothing is active.
 */
export async function pauseDownload(): Promise<void> {
  if (!_active || !_activeVariant) return;
  const variant = _activeVariant;
  try {
    const savable = await _active.pauseAsync();
    if (savable) {
      await AsyncStorage.setItem(resumableKey(variant), JSON.stringify(savable)).catch(() => {});
    }
  } catch {
    // Swallow — pauseAsync occasionally throws on Android if called when
    // the native side has already finished writing the last chunk.
  } finally {
    _active = null;
    _activeVariant = null;
  }
}

/**
 * Cancel the in-flight download, delete the partial file, and discard any
 * savable state. Always safe to call — no-ops cleanly when nothing is in
 * flight or on disk.
 */
export async function cancelDownload(variant: ModelVariant): Promise<void> {
  if (_active && _activeVariant === variant) {
    try { await _active.pauseAsync(); } catch { /* best-effort */ }
    _active = null;
    _activeVariant = null;
  }
  await AsyncStorage.removeItem(resumableKey(variant)).catch(() => {});
  try {
    const info = await FileSystem.getInfoAsync(MODEL_PATHS[variant]);
    if (info.exists) {
      await FileSystem.deleteAsync(MODEL_PATHS[variant], { idempotent: true });
    }
  } catch {
    // File may have been gone already; ignore.
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete a downloaded model to free device storage. Reuses cancelDownload's
 * cleanup path then clears the "has been downloaded" SecureStore flag.
 *
 * Callers that have loaded the model into memory should separately call
 * litert.unloadModel() to release the native session; this function
 * intentionally does NOT import litert to avoid a circular dep.
 */
export async function deleteModelFile(variant: ModelVariant): Promise<void> {
  await cancelDownload(variant);
  await SecureStore.deleteItemAsync(MODEL_DOWNLOADED_KEY).catch(() => {});
}
