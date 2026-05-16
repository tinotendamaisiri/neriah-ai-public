// src/services/ocr.ts
// On-device OCR via @react-native-ml-kit/text-recognition.
//
// Used exclusively by the offline grading path — cloud grading uses Gemma
// multimodal and doesn't need an intermediate OCR step. MLKit runs entirely
// on-device (no network, no per-call cost) and recognises Latin script + a
// useful subset of punctuation, digits, and Greek letters. Math notation
// (fractions, exponents, square roots) is recognised poorly — that's a
// known trade-off of offline grading.
//
// The native module is only present in a dev-client build. When running in
// Expo Go, `require()` of the package throws at module load time — we catch
// that once and surface an OcrUnavailable error so callers can fall back.

import { Platform } from 'react-native';

export type OcrPage = {
  /** Zero-indexed page position, matching CapturedPage order. */
  page_index: number;
  /** Full extracted text, concatenated blocks in natural reading order. */
  text: string;
};

export class OcrUnavailableError extends Error {
  constructor(message = 'OCR native module not linked. Rebuild the app with a dev client.') {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

// Lazy-load the native module once. Wrapping the require in a function lets
// us return a typed error instead of crashing at module load time when
// running inside Expo Go.
type TextRecognitionModule = {
  recognize: (uri: string) => Promise<{ text: string }>;
};

let _module: TextRecognitionModule | null | undefined = undefined;

function getModule(): TextRecognitionModule | null {
  if (_module !== undefined) return _module;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('@react-native-ml-kit/text-recognition');
    // Package exports default or named — handle both.
    _module = (mod?.default ?? mod) as TextRecognitionModule;
  } catch {
    _module = null;
  }
  return _module;
}

/** True when the native MLKit module is linked and callable. */
export function isOcrAvailable(): boolean {
  if (Platform.OS === 'web') return false;
  return getModule() !== null;
}

/**
 * Extract text from a single local image URI.
 * Returns the empty string on any failure — callers can decide whether to
 * proceed with empty text or surface an error. Throws OcrUnavailableError
 * only when the native module isn't linked at all.
 */
export async function recognizeTextInImage(uri: string): Promise<string> {
  const mod = getModule();
  if (!mod) throw new OcrUnavailableError();
  try {
    const result = await mod.recognize(uri);
    return (result?.text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Run OCR on every page URI in order. Returns one OcrPage per input URI,
 * with `page_index` matching the array position.
 */
export async function recognizePages(uris: string[]): Promise<OcrPage[]> {
  if (!isOcrAvailable()) throw new OcrUnavailableError();
  const results: OcrPage[] = [];
  for (let i = 0; i < uris.length; i++) {
    const text = await recognizeTextInImage(uris[i]);
    results.push({ page_index: i, text });
  }
  return results;
}
