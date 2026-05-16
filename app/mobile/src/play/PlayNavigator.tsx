// src/play/PlayNavigator.tsx
//
// Native stack rooted at PlayLibrary. Mounted from StudentResultsScreen
// so the bottom-nav slot (still wired as `name="StudentResults"` for
// deep-link compat) renders the full Play surface — the route name is
// kept, the file content swapped.
//
// Slide-from-right animation matches the rest of the student stack
// motion (StudentRootStack). Headers are off everywhere — each Play
// screen renders its own teal header band + BackButton.
//
// PlayHome was removed in favour of letting PlayLibrary handle both
// the empty-state ("+ Make a new game" CTA) and the populated state
// (lesson list with filter pills + badges) in a single screen.

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { PlayStackParamList } from './types';

import PlayLibraryScreen from './screens/PlayLibraryScreen';
import PlayBuildScreen from './screens/PlayBuildScreen';
import PlayBuildProgressScreen from './screens/PlayBuildProgressScreen';
import PlayPreviewScreen from './screens/PlayPreviewScreen';
import PlayGameScreen from './screens/PlayGameScreen';
import PlaySessionEndScreen from './screens/PlaySessionEndScreen';
import PlayShareScreen from './screens/PlayShareScreen';

const Stack = createNativeStackNavigator<PlayStackParamList>();

export default function PlayNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="PlayLibrary"
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="PlayLibrary" component={PlayLibraryScreen} />
      <Stack.Screen name="PlayBuild" component={PlayBuildScreen} />
      <Stack.Screen
        name="PlayBuildProgress"
        component={PlayBuildProgressScreen}
        // Mid-generation: swiping back loses the run. Force the
        // student to use the in-screen Cancel button instead.
        options={{ gestureEnabled: false }}
      />
      <Stack.Screen name="PlayPreview" component={PlayPreviewScreen} />
      <Stack.Screen
        name="PlayGame"
        component={PlayGameScreen}
        // In-game swipes (lane change, snake direction, stacker steer)
        // would otherwise be intercepted by the iOS native-stack
        // swipe-back gesture and exit the game. Quitting goes through
        // pause → Quit to picker, or the Android hardware back which
        // GameEngine intercepts to show the pause overlay.
        options={{ gestureEnabled: false }}
      />
      <Stack.Screen name="PlaySessionEnd" component={PlaySessionEndScreen} />
      <Stack.Screen name="PlayShare" component={PlayShareScreen} />
    </Stack.Navigator>
  );
}
