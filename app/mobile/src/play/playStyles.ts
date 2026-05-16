// src/play/playStyles.ts
//
// Shared brand tokens + small style primitives for the Play surface.
// Centralised here so every Play screen pulls the same Georgia serif,
// the same 4-teal answer mapping, and the same header band geometry.

import { StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';

export const PLAY_FONT = 'Georgia';

/** Fixed mapping for MCQ answer cards. The order is canonical — A always
 *  gets teal500, B always teal700, etc. Game scenes rely on this so the
 *  same option index reads as the same colour run-to-run. */
export const ANSWER_COLORS = [
  COLORS.teal500, // A
  COLORS.teal700, // B
  COLORS.teal300, // C
  COLORS.teal100, // D
] as const;

export const playStyles = StyleSheet.create({
  // Page wrappers
  page: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  pageWhite: {
    flex: 1,
    backgroundColor: COLORS.white,
  },

  // Teal header band (matches the wireframe deck's branded top strip).
  headerBand: {
    backgroundColor: COLORS.teal500,
    paddingTop: 8,
    paddingBottom: 24,
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerTitle: {
    fontFamily: PLAY_FONT,
    color: COLORS.white,
    fontSize: 22,
    fontWeight: '700',
  },
  headerSub: {
    fontFamily: PLAY_FONT,
    color: COLORS.teal100,
    fontSize: 13,
    marginTop: 2,
  },

  // Section titles below a header band.
  section: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  sectionTitle: {
    fontFamily: PLAY_FONT,
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 10,
  },

  // Cards (lesson cards, recommendations).
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardTitle: {
    fontFamily: PLAY_FONT,
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  cardMeta: {
    fontSize: 12,
    color: COLORS.textLight,
  },

  // Pill-style buttons.
  primaryPill: {
    backgroundColor: COLORS.teal500,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryPillText: {
    fontFamily: PLAY_FONT,
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryPill: {
    backgroundColor: COLORS.white,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.teal500,
  },
  secondaryPillText: {
    fontFamily: PLAY_FONT,
    color: COLORS.teal500,
    fontSize: 14,
    fontWeight: '700',
  },

  // Origin badges. ~50pt × 24pt, 7-8pt bold, rounded, bordered.
  originBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
    minWidth: 50,
    alignItems: 'center',
  },
  originBadgeMine: {
    backgroundColor: COLORS.teal50,
    borderColor: COLORS.teal500,
  },
  originBadgeClass: {
    backgroundColor: COLORS.amber50,
    borderColor: COLORS.amber500,
  },
  originBadgeShared: {
    backgroundColor: COLORS.gray50,
    borderColor: COLORS.border,
  },
  originBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: PLAY_FONT,
    textAlign: 'center',
  },
  originBadgeTextMine: {
    color: COLORS.teal500,
  },
  originBadgeTextClass: {
    color: COLORS.amber700,
  },
  originBadgeTextShared: {
    color: COLORS.gray500,
  },

  // Status chip (Online · Gemma 4 / Offline · Gemma 4 (on-device)).
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusChipOnline: {
    backgroundColor: COLORS.teal100,
  },
  statusChipOffline: {
    backgroundColor: COLORS.amber100,
  },
  statusChipText: {
    fontFamily: PLAY_FONT,
    fontSize: 12,
    fontWeight: '700',
  },
  statusChipTextOnline: {
    color: COLORS.teal700,
  },
  statusChipTextOffline: {
    color: COLORS.amber700,
  },

  // Body text default — Georgia.
  body: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 21,
  },
  bodyMuted: {
    fontFamily: PLAY_FONT,
    fontSize: 13,
    color: COLORS.textLight,
    lineHeight: 19,
  },
});
