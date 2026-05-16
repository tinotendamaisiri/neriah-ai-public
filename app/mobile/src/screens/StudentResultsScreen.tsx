// src/screens/StudentResultsScreen.tsx
//
// Bottom-nav "Play" tab landing — keeps the original route name
// `StudentResults` for deep-link compatibility but renders the full
// PlayNavigator stack inside.
//
// History — what used to live here:
//   This file used to render the full "My Results" screen. As of
//   2026-05-04 the Results UI moved INSIDE StudentHomeScreen as a
//   sub-tab next to "My Assignments" — the tap-to-feedback / withdraw
//   logic was extracted into `components/StudentResultsView.tsx` so
//   both surfaces can share it. The bottom-nav tab was relabelled
//   "Play" and pointed at this file with a placeholder.
//
//   2026-05-XX onwards: this file mounts the real Play surface (the
//   full lesson library, build flow, gameplay, results). The route
//   name `StudentResults` is intentionally kept so the existing tab
//   wiring in App.tsx stays untouched.

import React from 'react';
import PlayNavigator from '../play/PlayNavigator';

export default function StudentResultsScreen() {
  return <PlayNavigator />;
}
