// src/components/LocalAnnotationOverlay.tsx
// Visual overlay drawn on top of an UN-annotated page image when a MarkResult
// came from offline (on-device) grading. Matches the Pillow annotator's visual
// contract (shared/annotator.py) — same colours, same per-verdict symbol +
// label, same bottom-right score bubble — but composed in React Native so no
// baked image is needed.
//
// Positioning rules mirror `_resolve_verdict_position` in the Python annotator,
// but mapped onto the *rendered image bounds*, not the container. The page
// photo is laid out with `resizeMode="contain"`, so a portrait page in a
// landscape-ish container leaves big empty gutters on the left/right. If we
// treated qx as a fraction of the container, qx=0.05 would land in the gutter
// (which is exactly the bug that put the ticks in a column to the side of
// the page). Instead, we pull the source image's intrinsic dimensions via
// Image.getSize, compute the contain-fit bounds, and map qx/qy onto those.
//
//   - question_x / question_y are fractions of image dimensions (0.0-1.0)
//     clamped to [0.05, 0.95] so symbols never bleed off the page edge.
//   - When qx/qy are missing (the usual case offline — OCR gives no spatial
//     info), fall back to right-side stacking: x = 0.85, y = (i+0.5)/total.
//     Right side mimics how a teacher pen-marks alongside each answer column,
//     and stays inside the page rather than landing in the side gutter.
//
// The overlay is positioned with StyleSheet.absoluteFill and expects to
// sit inside a View whose bounds match the rendered page image — the caller
// is responsible for that alignment.

import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { GradingVerdict, GradingVerdictEnum } from '../types';

// Matches shared/annotator.py palette.
const VERDICT_COLOUR: Record<GradingVerdictEnum, string> = {
  correct: '#22C55E',
  incorrect: '#EF4444',
  partial: '#F59E0B',
};

const VERDICT_SYMBOL: Record<GradingVerdictEnum, string> = {
  correct: '✓',
  incorrect: '✗',
  partial: '~',
};

interface LocalAnnotationOverlayProps {
  /** Verdicts that apply to the page this overlay is drawn on. Pre-filter by
   *  page_index before passing in. */
  verdicts: GradingVerdict[];
  /** Container width/height — the bounds the overlay's absoluteFill covers.
   *  We map qx/qy onto the contain-fitted image bounds *inside* this box,
   *  not onto the box itself, so symbols don't drift into the side gutters
   *  for portrait pages in a wider container. */
  width: number;
  height: number;
  /** Source URI of the page image. Used to read intrinsic dimensions so the
   *  contain-fit bounds can be computed. Required for correct placement —
   *  if omitted, the overlay falls back to mapping onto the full container
   *  (the old buggy behaviour) so existing call sites keep working visually. */
  imageUri?: string;
  /** Overall score bubble. When omitted, no bubble is rendered — pass only on
   *  the page the bubble should appear on (typically the last page). */
  summary?: {
    score: number;
    max_score: number;
    percentage: number;
  };
}

// Clamp helper — keeps symbols in the visible [0.05, 0.95] band.
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function pickColour(pct: number): string {
  if (pct >= 75) return VERDICT_COLOUR.correct;
  if (pct >= 50) return VERDICT_COLOUR.partial;
  return VERDICT_COLOUR.incorrect;
}

export default function LocalAnnotationOverlay({
  verdicts,
  width,
  height,
  imageUri,
  summary,
}: LocalAnnotationOverlayProps) {
  // Intrinsic source dimensions, used to recompute the contain-fit bounds.
  // Until they resolve, we render nothing — better to flash one frame of
  // blank overlay than to put symbols in the wrong place for a tick.
  const [intrinsic, setIntrinsic] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!imageUri) { setIntrinsic(null); return; }
    let cancelled = false;
    Image.getSize(
      imageUri,
      (w, h) => { if (!cancelled) setIntrinsic({ w, h }); },
      // On error just let the overlay map to the container bounds; same as
      // legacy behaviour — degrades to "ticks may sit in the gutter" but
      // never crashes.
      () => { if (!cancelled) setIntrinsic({ w: width, h: height }); },
    );
    return () => { cancelled = true; };
  }, [imageUri, width, height]);

  // Compute contain-fit bounds: the image preserves aspect ratio and is
  // centred inside the container. Whichever side is the binding constraint
  // gets the full container dimension; the other side is letterboxed.
  let renderedW = width;
  let renderedH = height;
  let offsetX = 0;
  let offsetY = 0;
  if (intrinsic && intrinsic.w > 0 && intrinsic.h > 0) {
    const containerAspect = width / height;
    const imageAspect = intrinsic.w / intrinsic.h;
    if (imageAspect > containerAspect) {
      // Image is wider than container — fits to width, vertical letterbox.
      renderedW = width;
      renderedH = width / imageAspect;
      offsetY = (height - renderedH) / 2;
    } else {
      // Image is taller (or equal) — fits to height, horizontal letterbox.
      renderedH = height;
      renderedW = height * imageAspect;
      offsetX = (width - renderedW) / 2;
    }
  }

  const total = Math.max(verdicts.length, 1);
  // Symbol size: scale with rendered height but keep big and visible — the
  // teacher needs to be able to read the verdict at a glance from a thumb-
  // sized preview. 8% of height with a 56 px floor lands around 56–80 px on
  // a typical 420 px overlay, which matches a pen-mark you'd actually draw
  // on the page.
  const symbolSize = Math.max(56, Math.round(renderedH * 0.08));

  // Don't render symbols until we know the rendered bounds — otherwise the
  // first paint would put them at the old (gutter) position and snap a tick
  // later, which looks broken. Summary bubble is fine to draw immediately
  // because it pins to a corner, not a verdict location.
  const verdictsReady = !imageUri || intrinsic !== null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {verdictsReady && verdicts.map((v, i) => {
        const colour = VERDICT_COLOUR[v.verdict] ?? VERDICT_COLOUR.incorrect;
        const symbol = VERDICT_SYMBOL[v.verdict] ?? VERDICT_SYMBOL.incorrect;

        // X is *always* forced to the right margin (0.92) — never the
        // model's question_x — so every tick stacks down the right
        // side of the page like a teacher's pen-marks. Honouring the
        // cloud's qx put symbols on top of the student's handwriting.
        // Y honours the verdict's question_y so each tick aligns
        // vertically with the answer it grades; falls back to evenly-
        // spaced when missing. Mirrors the server-side annotator's
        // contract in shared/annotator.py:_resolve_verdict_position.
        const qx = 0.92;
        const qyRaw =
          typeof v.question_y === 'number' ? v.question_y : (i + 0.5) / total;
        const qy = clamp(qyRaw, 0.05, 0.95);

        // Map onto the rendered image bounds, not the container.
        const cx = Math.round(offsetX + qx * renderedW);
        const cy = Math.round(offsetY + qy * renderedH);

        return (
          <View
            key={`v-${v.question_number}`}
            style={[
              styles.markerWrap,
              {
                left: cx - symbolSize,
                top: cy - symbolSize / 2,
                width: symbolSize * 2,
              },
            ]}
          >
            <Text
              style={[
                styles.symbol,
                { color: colour, fontSize: symbolSize, lineHeight: symbolSize * 1.1 },
              ]}
              numberOfLines={1}
            >
              {symbol}
            </Text>
            {/* Per-question label dropped — the bare tick/X reads as a
                teacher's pen-mark, and the corner score bubble already
                carries the totals. Cleaner without. */}
          </View>
        );
      })}

      {/* Summary bubble — drawn at the bottom-right corner of the *rendered*
          image so it sits on the page, not in the side gutter for portrait
          scans. Falls back to container corner when bounds aren't ready. */}
      {summary && (
        <View
          style={[
            styles.bubble,
            { backgroundColor: pickColour(summary.percentage) },
            verdictsReady && {
              right: Math.round(offsetX) + 16,
              bottom: Math.round(offsetY) + 16,
            },
          ]}
        >
          <Text style={styles.bubbleScore}>
            {summary.score}/{summary.max_score}
          </Text>
          <Text style={styles.bubblePct}>{Math.round(summary.percentage)}%</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  markerWrap: {
    position: 'absolute',
    alignItems: 'center',
  },
  symbol: {
    fontWeight: '900',
    textAlign: 'center',
    // Letter-outline effect so symbols stay legible on any page background.
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
  bubble: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
  },
  bubbleScore: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '900',
  },
  bubblePct: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
});
