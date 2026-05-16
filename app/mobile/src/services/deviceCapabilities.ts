// src/services/deviceCapabilities.ts
// Device capability detection — runs at every app launch.
//
// Checks whether the device can run a specific Gemma 4 variant. The
// caller (ModelContext) passes the variant their user's role *needs*:
//   - teacher → 'e4b' (full grading model)
//   - student → 'e2b' (Socratic tutor model)
//
// There is no graceful "downgrade" path. If a teacher's device can't run
// E4B, we return cloud-only — we never give them E2B as a fallback,
// because E2B is the wrong model for grading and the teacher would just
// get worse results silently.
//
// Thresholds are based on empirical data, not vendor specs:
//   - Samsung Galaxy A51 (3.65 GB total, ~1 GB available) crashes during
//     vision-executor compile when loading E2B (2.58 GB). So the realistic
//     E2B floor is well above 3.65 GB; we set it at 6 GB total RAM.
//   - E4B (3.65 GB on disk, ~5 GB peak working set during compile) needs
//     8 GB total RAM to leave headroom for Android system overhead.
//   - Storage thresholds match each model's file size + ~1 GB temp room
//     for the download.
//
// Fields stored in SecureStore:
//   - device_capability        — kept for backward compat; the highest
//                                tier the device can run, regardless of
//                                role. Now derived from canRunVariant().
// Fresh detection on every launch — never returns stale cached values.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import type { ModelVariant } from './modelManager';

export type DeviceCapability = 'e4b-capable' | 'e2b-capable' | 'cloud-only';

export const CAPABILITY_STORE_KEY = 'device_capability';

// ── Per-variant minimums ──────────────────────────────────────────────────────
// Total device RAM needed to load the variant. Includes headroom for the
// vision-executor compile phase (the part that crashes on under-provisioned
// devices like the Galaxy A51) and Android system overhead.

const REQUIREMENTS: Record<ModelVariant, { ramGB: number; freeStorageGB: number }> = {
  // Gemma 4 E2B file is 2.58 GB. Compile peak ~3.5 GB. + ~2 GB Android
  // overhead + ~0.5 GB safety = 6 GB total. Galaxy A51 (3.65 GB) sits
  // below this floor — empirically confirmed to crash at vision compile.
  e2b: { ramGB: 6, freeStorageGB: 3 },
  // Gemma 4 E4B file is 3.65 GB. Compile peak ~5 GB. + ~2 GB system
  // overhead + ~1 GB safety = 8 GB. Mid-range Androids (Galaxy A55, Pixel
  // 7a at 8 GB) sit right at the edge; flagships (S24, Pixel 8 Pro at
  // 12+ GB) clear it comfortably.
  e4b: { ramGB: 8, freeStorageGB: 4.5 },
};

function bytesToGB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

// ── RAM + storage detection ──────────────────────────────────────────────────

async function readDeviceRamGB(): Promise<number> {
  if (Platform.OS === 'ios') {
    // iOS Device.totalMemory returns app-available memory, not physical
    // RAM. Infer from device model; modern iOS hardware floors high.
    const model = (Device.modelName ?? '').toLowerCase();
    if (model.includes('pro') || model.includes('max')) return 8;
    if (model.includes('iphone')) return 6;
    if (model.includes('ipad')) return 6;
    return 6; // unknown modern iOS device — assume mid-tier
  }
  // Android: Device.totalMemory is accurate.
  const totalMemoryBytes: number | null = Device.totalMemory ?? null;
  return totalMemoryBytes != null ? bytesToGB(totalMemoryBytes) : 0;
}

async function readFreeStorageGB(): Promise<number> {
  try {
    const freeBytes = await FileSystem.getFreeDiskStorageAsync();
    const freeGB = bytesToGB(freeBytes);
    // Some Expo versions return 0 from this API on certain Android
    // releases. Treat 0 as "unknown, assume sufficient" rather than
    // gating download — the OS will fail more honestly if storage is
    // really exhausted.
    return freeGB > 0 ? freeGB : 10;
  } catch {
    return 10;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether the device can run the given variant. The thresholds are stored
 * per-variant in REQUIREMENTS — callers don't need to know the numbers.
 *
 * Web is always false (no on-device inference at all). On native, both
 * RAM and free storage must clear the variant's bar.
 */
export async function canRunVariant(variant: ModelVariant): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const req = REQUIREMENTS[variant];
  const [ramGB, freeStorageGB] = await Promise.all([readDeviceRamGB(), readFreeStorageGB()]);
  const ok = ramGB >= req.ramGB && freeStorageGB >= req.freeStorageGB;
  console.log(
    `[deviceCapabilities] canRunVariant(${variant}): ` +
    `RAM=${ramGB.toFixed(1)} GB (need ${req.ramGB}), ` +
    `freeStorage=${freeStorageGB.toFixed(1)} GB (need ${req.freeStorageGB}) → ${ok}`,
  );
  return ok;
}

/**
 * Detect the highest tier the device supports. Kept for callers (Settings,
 * UI) that want the descriptive label; routing decisions should call
 * canRunVariant() directly so they're per-role, not "best the device can
 * do".
 */
export async function detectCapability(): Promise<DeviceCapability> {
  if (Platform.OS === 'web') {
    await _persist('cloud-only');
    return 'cloud-only';
  }
  if (await canRunVariant('e4b')) {
    await _persist('e4b-capable');
    return 'e4b-capable';
  }
  if (await canRunVariant('e2b')) {
    await _persist('e2b-capable');
    return 'e2b-capable';
  }
  await _persist('cloud-only');
  return 'cloud-only';
}

/** Alias kept for callers that imported the old name. */
export const detectAndStoreCapability = detectCapability;

/**
 * Read the cached tier without re-running detection. Returns null if the
 * first-launch check has never run.
 */
export async function getStoredCapability(): Promise<DeviceCapability | null> {
  try {
    const stored = await SecureStore.getItemAsync(CAPABILITY_STORE_KEY);
    if (stored === 'e4b-capable' || stored === 'e2b-capable' || stored === 'cloud-only') {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}

async function _persist(capability: DeviceCapability): Promise<void> {
  try {
    await SecureStore.setItemAsync(CAPABILITY_STORE_KEY, capability);
  } catch {
    // Non-fatal — capability detection still succeeds even if storage fails.
  }
}
