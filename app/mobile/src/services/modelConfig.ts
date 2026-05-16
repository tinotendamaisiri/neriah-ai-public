// src/services/modelConfig.ts
//
// Server-driven LiteRT-LM model spec. Fetches /api/config/litert-model
// on demand, caches the result in AsyncStorage, and falls back to
// cache → hardcoded upstream URL if the network can't reach the
// backend.
//
// The reason this exists: we want to be able to ship a Neriah-fine-
// tuned `.litertlm` to phones, AND to be able to roll BACK to the
// upstream HuggingFace base model, without an app rebuild. Until an
// override is published the endpoint returns the same upstream URL
// the package shipped with — so behaviour is identical to today for
// every existing install.

import { client } from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Hardcoded upstream URL — used as the absolute fallback if both the
// network call and the cache fail. Mirrors the GEMMA_4_E2B_IT URL
// constant in react-native-litert-lm.
const HARDCODED_HF_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm';

const CACHE_KEY = 'neriah_litert_model_config_v1';

export interface LitertModelConfig {
  /** Stable id for this bundle. Used to detect that the on-disk file
   *  belongs to a different version than what the server now wants. */
  version: string;
  /** Where to download the .litertlm bundle from. https:// or gs://. */
  url: string;
  /** Optional content hash. When set, modelManager verifies the
   *  downloaded file matches before swapping it in. */
  sha256: string | null;
  /** Optional approximate size for progress reporting. */
  size_bytes?: number | null;
  /** Optional URL to fall back to if the primary model file fails to
   *  load on-device (e.g. native init crashes). */
  fallback_url?: string | null;
  /** Optional release timestamp, surfaced in the admin panel. */
  released_at?: string | null;
  /** Optional human-readable note. */
  notes?: string | null;
}

const DEFAULT_CONFIG: LitertModelConfig = {
  version: 'v0-base-hf',
  url: HARDCODED_HF_URL,
  sha256: null,
  size_bytes: 2_584_834_834,
  fallback_url: null,
  released_at: null,
  notes: 'Upstream Gemma 4 E2B IT (HuggingFace litert-community).',
};

async function readCache(): Promise<LitertModelConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: string; config?: LitertModelConfig };
    return parsed?.config ?? null;
  } catch {
    return null;
  }
}

async function writeCache(config: LitertModelConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: new Date().toISOString(), config }),
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch the active LiteRT-LM model spec. Network → cache → hardcoded
 * default, in that order. Always resolves; never throws.
 *
 * Pass `forceRefresh: true` to bypass the cache (e.g. on a manual
 * "check for updates" tap in Settings).
 */
export async function getLitertModelConfig(opts: { forceRefresh?: boolean } = {}): Promise<LitertModelConfig> {
  if (!opts.forceRefresh) {
    // Stale-while-revalidate would be nicer, but the model file is
    // 2.5+ GB — re-downloads are expensive. Keep it strict: prefer
    // cache, only refresh when explicitly asked.
    const cached = await readCache();
    if (cached) return cached;
  }
  try {
    const res = await client.get('/config/litert-model', { timeout: 8000 });
    const data = res.data as Partial<LitertModelConfig>;
    if (data && typeof data.url === 'string' && typeof data.version === 'string') {
      const config: LitertModelConfig = {
        version:      data.version,
        url:          data.url,
        sha256:       data.sha256 ?? null,
        size_bytes:   data.size_bytes ?? null,
        fallback_url: data.fallback_url ?? null,
        released_at:  data.released_at ?? null,
        notes:        data.notes ?? null,
      };
      await writeCache(config);
      return config;
    }
  } catch {
    /* fall through to cache / default */
  }
  const cached = await readCache();
  if (cached) return cached;
  return DEFAULT_CONFIG;
}

/**
 * Read the cached config without hitting the network. Used by code
 * that needs the spec but mustn't block on a fetch (e.g. crash
 * recovery paths). Always returns something — `DEFAULT_CONFIG` when
 * no cache exists.
 */
export async function getLitertModelConfigCachedOnly(): Promise<LitertModelConfig> {
  const cached = await readCache();
  return cached ?? DEFAULT_CONFIG;
}

/**
 * Forget the cached config. Called after a model swap so the next
 * cold-start re-fetches and updates against the latest server state.
 */
export async function clearLitertModelConfigCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    /* best-effort */
  }
}
