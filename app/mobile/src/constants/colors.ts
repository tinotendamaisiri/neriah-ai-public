// src/constants/colors.ts
// Official Neriah brand palette. Import from here — never use raw hex values.

export const COLORS = {
  // Primary: Deep Teal
  teal50:  '#E1F5EE',  // Light backgrounds, report cards
  teal100: '#9FE1CB',  // Secondary text on dark, borders, disabled states
  teal300: '#3AAFA9',  // Hover states, secondary buttons
  teal500: '#0D7377',  // PRIMARY — headers, buttons, active tabs, profile
  teal700: '#085041',  // Dark accents, pressed states
  teal900: '#04342C',  // Dark backgrounds, text on light surfaces

  // Accent: Warm Amber
  amber50:  '#FFF3E0', // Light highlight backgrounds
  amber100: '#FAC775', // Subtle accents, progress bars
  amber300: '#F5A623', // ACCENT — scores, CTAs, badges, student role
  amber500: '#D4880B', // Text on light amber backgrounds
  amber700: '#854F0B', // Dark amber for emphasis
  amber900: '#412402', // Text on amber backgrounds

  // Neutrals
  gray50:  '#FAFAFA',  // Page backgrounds
  gray200: '#E8E8E8',  // Borders, dividers
  gray500: '#6B6B6B',  // Secondary text, captions
  gray900: '#2C2C2A',  // Primary text, headings

  // Semantic
  success: '#27AE60',  // Correct answers, approved marks, good scores (≥70%)
  warning: '#F5A623',  // Amber 300 — pending status, medium scores (50-69%)
  error:   '#E74C3C',  // Incorrect answers, failed, low scores (<50%)

  // Convenience aliases
  primary:    '#0D7377',
  accent:     '#F5A623',
  background: '#FAFAFA',
  card:       '#FFFFFF',
  text:       '#2C2C2A',
  textLight:  '#6B6B6B',
  border:     '#E8E8E8',
  white:      '#FFFFFF',
} as const;

export type ColorKey = keyof typeof COLORS;
