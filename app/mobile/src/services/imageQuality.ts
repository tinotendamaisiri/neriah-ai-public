// src/services/imageQuality.ts
// Heuristic image quality checker for captured homework photos.
// Uses file metadata and dimensions — no server round-trip.
// Warnings are advisory; canSubmit is always true so the student is never blocked.

import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'react-native';

export interface QualityResult {
  passed: boolean;
  warnings: string[];
  canSubmit: boolean; // always true — warnings are advisory
}

const MIN_FILE_KB = 120;        // below this → likely very low-res or heavily compressed
const MAX_FILE_KB = 18_000;     // above this → warn about slow upload
const MIN_SHORT_SIDE_PX = 600;  // below this → warn about resolution
const MAX_SQUARE_RATIO = 0.94;  // above this → page may not be fully in frame or is square-cropped
const MIN_PORTRAIT_RATIO = 0.35;// below this → image is extremely narrow (tilted or cropped badly)

function getDimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: 0, height: 0 }),
    );
  });
}

export async function checkImageQuality(uri: string): Promise<QualityResult> {
  const warnings: string[] = [];

  try {
    // ── File size ──────────────────────────────────────────────────────────────
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (info.exists && 'size' in info && info.size !== undefined) {
      const sizeKB = info.size / 1024;
      if (sizeKB < MIN_FILE_KB) {
        warnings.push('Image quality may be too low — hold the camera closer and retake.');
      }
      if (sizeKB > MAX_FILE_KB) {
        warnings.push('Large file — upload may be slow on a weak connection.');
      }
    }

    // ── Dimensions ────────────────────────────────────────────────────────────
    const { width, height } = await getDimensions(uri);
    if (width > 0 && height > 0) {
      const shortSide = Math.min(width, height);
      const longSide = Math.max(width, height);
      const ratio = shortSide / longSide;

      if (shortSide < MIN_SHORT_SIDE_PX) {
        warnings.push('Resolution is low. Step closer to the page and retake.');
      }
      if (ratio > MAX_SQUARE_RATIO) {
        warnings.push('The image looks square — make sure the full page is visible.');
      }
      if (ratio < MIN_PORTRAIT_RATIO) {
        warnings.push('The page looks tilted or cut off. Straighten the book and retake.');
      }
    }
  } catch {
    // Non-fatal — metadata errors should not block submission
  }

  return {
    passed: warnings.length === 0,
    warnings,
    canSubmit: true,
  };
}
