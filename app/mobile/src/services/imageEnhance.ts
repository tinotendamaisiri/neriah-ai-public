// src/services/imageEnhance.ts
// On-device image enhancement before submission or answer key upload.
// Resizes to max 2048px on longest side and normalises EXIF rotation.
// Returns original URI unchanged on any error (non-blocking).

import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

const MAX_DIMENSION = 2048;
const OUTPUT_QUALITY = 0.85;

function getDimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: 0, height: 0 }),
    );
  });
}

/**
 * Enhance a captured image for submission:
 * - Resize so the longest side ≤ 2048 px (only downsizes, never upscales)
 * - Re-encode as JPEG at 0.85 quality (normalises EXIF rotation as a side-effect)
 * - Returns the enhanced local URI, or the original URI if enhancement fails
 */
export async function enhanceImage(uri: string): Promise<string> {
  try {
    const { width, height } = await getDimensions(uri);

    const actions: ImageManipulator.Action[] = [];

    if (width > 0 && height > 0) {
      const maxDim = Math.max(width, height);
      if (maxDim > MAX_DIMENSION) {
        if (width >= height) {
          actions.push({ resize: { width: MAX_DIMENSION } });
        } else {
          actions.push({ resize: { height: MAX_DIMENSION } });
        }
      }
      // Even with no resize action, manipulateAsync re-encodes the JPEG
      // which normalises the EXIF rotation flag.
    }

    const result = await ImageManipulator.manipulateAsync(
      uri,
      actions,
      {
        compress: OUTPUT_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      },
    );

    return result.uri;
  } catch {
    return uri;
  }
}
