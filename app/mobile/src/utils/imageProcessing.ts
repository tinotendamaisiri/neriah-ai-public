// src/utils/imageProcessing.ts
// Shared quality-check + auto-enhancement pipeline for any picked image URI.
//
// Call processPickedImage(uri) immediately after selecting any image from
// Gallery or Camera. It runs heuristic quality checks and applies
// expo-image-manipulator enhancement, then returns the enhanced base64 along
// with any advisory warnings.
//
// Non-blocking: never throws. On any error the original image is returned
// unchanged (canSubmit/canCreate is never affected).

import * as FileSystem from 'expo-file-system/legacy';
import { enhanceImage } from '../services/imageEnhance';
import { checkImageQuality } from '../services/imageQuality';

export interface ProcessedImage {
  /** Enhanced local URI (may equal originalUri if enhancement errored). */
  uri: string;
  /** base64 of the enhanced file — ready to send to the API. */
  base64: string;
  /** Advisory quality warnings. Empty array means image passed all checks. */
  warnings: string[];
  /** True if enhance actually produced a new URI (resize or re-encode happened). */
  enhanced: boolean;
}

/**
 * Run quality heuristics + auto-enhancement on a picked image URI.
 *
 * Steps:
 *   1. checkImageQuality(uri)  — file-size + dimension heuristics
 *   2. enhanceImage(uri)       — resize ≤2048px + EXIF normalise
 *   3. FileSystem.readAsStringAsync — read enhanced file as base64
 *
 * Returns warnings even when quality passes, so callers always get the
 * enhanced base64 regardless of quality outcome.
 */
export async function processPickedImage(originalUri: string): Promise<ProcessedImage> {
  // 1. Quality heuristics on the original (before any manipulation)
  const qualityResult = await checkImageQuality(originalUri);

  // 2. Enhance — resize to ≤2048 px on longest side + EXIF normalise
  const enhancedUri = await enhanceImage(originalUri);

  // 3. Read back as base64
  const base64 = await FileSystem.readAsStringAsync(enhancedUri, {
    encoding: 'base64' as any,
  });

  return {
    uri: enhancedUri,
    base64,
    warnings: qualityResult.warnings,
    enhanced: enhancedUri !== originalUri,
  };
}
