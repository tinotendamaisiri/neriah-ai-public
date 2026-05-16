// App.tsx
// Root of the Neriah mobile app.
//
// Navigation structure:
//   Unauthenticated → AuthStack (initial: RoleSelect)
//     RoleSelect (landing) → TeacherRegister → OTP
//     RoleSelect (landing) → StudentRegister → OTP
//     RoleSelect → "Sign in" → Phone → OTP   (existing users)
//
//   Authenticated, role=teacher → TeacherNavigator
//     MainTabs (Home | Mark | Analytics | Settings)
//     + ClassSetup modal
//     + ClassDetail push screen
//
//   Authenticated, role=student → StudentNavigator
//     StudentTabs (Home | Submit | Results | Settings)

import React from 'react';
import {
  ActivityIndicator, View, Modal, Text, TouchableOpacity,
  StyleSheet, LogBox,
} from 'react-native';

// Suppress Expo Go limitations that are not bugs in our code
LogBox.ignoreLogs([
  'expo-notifications: Android Push notifications',
  'expo-notifications functionality is not fully supported',
  'Due to changes in Androids permission requirements',
  'Bottom Tab Navigator: lazy',
]);
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ModelProvider, useModel } from './src/context/ModelContext';
import { bootAnalytics, trackScreen, track } from './src/services/analytics';

// Analytics must boot at module top-level (before any component renders)
// so screen views and api calls fired during the very first frame are
// captured. bootAnalytics is idempotent.
bootAnalytics();
import PinSetupScreen from './src/screens/PinSetupScreen';
import PinLoginScreen from './src/screens/PinLoginScreen';
import { LanguageProvider, useLanguage } from './src/context/LanguageContext';
import NetInfo from '@react-native-community/netinfo';
import {
  getQueueLength,
  migrateQueueIfNeeded,
  replayQueue,
  startNetworkListener,
} from './src/services/offlineQueue';
import { detectAndStoreCapability } from './src/services/deviceCapabilities';
import { ErrorBoundary } from './src/components/ErrorBoundary';
// NetworkBanner is no longer rendered — keep the import out so
// stale components can't accidentally re-add the top strip.
// import NetworkBanner from './src/components/NetworkBanner';
import { COLORS } from './src/constants/colors';
import { MODEL_DISPLAY_NAME, MODEL_SIZE_LABEL } from './src/services/modelManager';
import {
  AuthStackParamList,
  MainTabParamList,
  RootStackParamList,
  StudentTabParamList,
} from './src/types';

// ── Auth screens ──────────────────────────────────────────────────────────────
import PhoneScreen from './src/screens/PhoneScreen';
import OTPScreen from './src/screens/OTPScreen';
import RoleSelectScreen from './src/screens/RoleSelectScreen';
import TeacherRegisterScreen from './src/screens/TeacherRegisterScreen';
import StudentRegisterScreen from './src/screens/StudentRegisterScreen';

// ── Teacher screens ───────────────────────────────────────────────────────────
import HomeScreen from './src/screens/HomeScreen';
import MarkingScreen from './src/screens/MarkingScreen';
import PageReviewScreen from './src/screens/PageReviewScreen';
import AnalyticsScreen from './src/screens/AnalyticsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ClassSetupScreen from './src/screens/ClassSetupScreen';
import ClassDetailScreen from './src/screens/ClassDetailScreen';
import TeacherInboxScreen from './src/screens/TeacherInboxScreen';
import HomeworkDetailScreen from './src/screens/HomeworkDetailScreen';
import HomeworkListScreen from './src/screens/HomeworkListScreen';
import AddHomeworkScreen from './src/screens/AddHomeworkScreen';
import HomeworkCreatedScreen from './src/screens/HomeworkCreatedScreen';
import ReviewSchemeScreen from './src/screens/ReviewSchemeScreen';
import SetPinScreen from './src/screens/SetPinScreen';
import GradingResultsScreen from './src/screens/GradingResultsScreen';
import GradingDetailScreen from './src/screens/GradingDetailScreen';
import TeacherClassAnalyticsScreen from './src/screens/TeacherClassAnalyticsScreen';
import TeacherStudentAnalyticsScreen from './src/screens/TeacherStudentAnalyticsScreen';
import HomeworkAnalyticsScreen from './src/screens/HomeworkAnalyticsScreen';
import TeacherAssistantScreen from './src/screens/TeacherAssistantScreen';
import EditProfileScreen from './src/screens/EditProfileScreen';
import TermsOfServiceScreen from './src/screens/TermsOfServiceScreen';

// ── Student screens ───────────────────────────────────────────────────────────
import StudentHomeScreen from './src/screens/StudentHomeScreen';
import StudentSubmitScreen from './src/screens/StudentSubmitScreen';
import StudentResultsScreen from './src/screens/StudentResultsScreen';
import StudentTutorScreen from './src/screens/StudentTutorScreen';
import StudentSettingsScreen from './src/screens/StudentSettingsScreen';
import ClassManagementScreen from './src/screens/ClassManagementScreen';
import StudentCameraScreen from './src/screens/StudentCameraScreen';
import StudentPreviewScreen from './src/screens/StudentPreviewScreen';
import StudentConfirmScreen from './src/screens/StudentConfirmScreen';
import SubmissionSuccessScreen from './src/screens/SubmissionSuccessScreen';
import FeedbackScreen from './src/screens/FeedbackScreen';
import StudentAnalyticsScreen from './src/screens/StudentAnalyticsScreen';

// ── Navigators ────────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const TeacherTab = createBottomTabNavigator<MainTabParamList>();
const TeacherStack = createNativeStackNavigator<RootStackParamList>();
const StudentTab = createBottomTabNavigator<StudentTabParamList>();
const StudentRootStack = createNativeStackNavigator<import('./src/types').StudentRootStackParamList>();

// The AgreementNavigator + UserAgreementScreen post-login interstitial was
// removed. Terms acceptance now happens inline via a checkbox on the two
// register screens (TeacherRegisterScreen, StudentRegisterScreen). The
// TermsOfServiceScreen is still reachable from Settings for review.

// ── Auth navigator (shared by both roles) ─────────────────────────────────────

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="RoleSelect" component={RoleSelectScreen} />
      <AuthStack.Screen name="TeacherRegister" component={TeacherRegisterScreen} />
      <AuthStack.Screen name="StudentRegister" component={StudentRegisterScreen} />
      <AuthStack.Screen name="Phone" component={PhoneScreen} />
      <AuthStack.Screen name="OTP" component={OTPScreen} />
    </AuthStack.Navigator>
  );
}

// ── Teacher tab bar ───────────────────────────────────────────────────────────

function TeacherTabs() {
  const { t } = useLanguage();
  console.log('[TeacherTabs] render, my_classes =', t('my_classes'));
  return (
    <TeacherTab.Navigator
      screenOptions={({ route }) => ({
        lazy: true,
        headerShown: false,
        freezeOnBlur: true,
        tabBarActiveTintColor: COLORS.teal500,
        tabBarInactiveTintColor: COLORS.textLight,
        tabBarStyle: { borderTopColor: COLORS.border },
        tabBarIcon: ({ color, size }) => {
          const icons: Partial<Record<keyof MainTabParamList, keyof typeof Ionicons.glyphMap>> = {
            Home: 'home-outline',
            Analytics: 'bar-chart-outline',
            Assistant: 'sparkles-outline',
          };
          return <Ionicons name={icons[route.name] ?? 'ellipse-outline'} size={size} color={color} />;
        },
      })}
    >
      <TeacherTab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarLabel: t('my_classes') }}
      />
      <TeacherTab.Screen
        name="Assistant"
        component={TeacherAssistantScreen}
        options={{ tabBarLabel: t('assistant') }}
      />
      <TeacherTab.Screen
        name="Analytics"
        component={AnalyticsScreen}
        options={{ tabBarLabel: t('analytics') }}
      />
      <TeacherTab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarLabel: t('settings'), tabBarButton: () => null }}
      />
    </TeacherTab.Navigator>
  );
}

// ── Teacher root (tabs + modal screens) ───────────────────────────────────────

function TeacherNavigator() {
  return (
    <TeacherStack.Navigator screenOptions={{ animation: 'none' }}>
      <TeacherStack.Screen name="Main" component={TeacherTabs} options={{ headerShown: false }} />
      <TeacherStack.Screen
        name="ClassSetup"
        component={ClassSetupScreen}
        options={{ title: 'New Class', presentation: 'modal' }}
      />
      <TeacherStack.Screen
        name="ClassDetail"
        component={ClassDetailScreen}
        options={({ route }: any) => ({ title: route.params?.class_name ?? 'Class' })}
      />
      <TeacherStack.Screen
        name="TeacherInbox"
        component={TeacherInboxScreen}
        options={{ title: 'Student Submissions', headerShown: false }}
      />
      <TeacherStack.Screen
        name="HomeworkDetail"
        component={HomeworkDetailScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="AddHomework"
        component={AddHomeworkScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="ReviewScheme"
        component={ReviewSchemeScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="HomeworkCreated"
        component={HomeworkCreatedScreen}
        options={{ headerShown: false, gestureEnabled: false }}
      />
      <TeacherStack.Screen
        name="SetPin"
        component={SetPinScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="HomeworkList"
        component={HomeworkListScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="GradingResults"
        component={GradingResultsScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="GradingDetail"
        component={GradingDetailScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="Mark"
        component={MarkingScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="PageReview"
        component={PageReviewScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="TeacherClassAnalytics"
        component={TeacherClassAnalyticsScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="HomeworkAnalytics"
        component={HomeworkAnalyticsScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="TeacherStudentAnalytics"
        component={TeacherStudentAnalyticsScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="EditProfile"
        component={EditProfileScreen}
        options={{ headerShown: false }}
      />
      <TeacherStack.Screen
        name="TermsOfService"
        component={TermsOfServiceScreen}
        options={{ headerShown: false }}
      />
    </TeacherStack.Navigator>
  );
}

// ── Student tab bar ───────────────────────────────────────────────────────────

function StudentTabs() {
  const { t } = useLanguage();
  return (
    <StudentTab.Navigator
      screenOptions={({ route }) => ({
        lazy: true,
        freezeOnBlur: true,
        tabBarActiveTintColor: COLORS.teal500,
        tabBarInactiveTintColor: COLORS.textLight,
        tabBarStyle: { borderTopColor: COLORS.border },
        tabBarIcon: ({ color, size }) => {
          const icons: Partial<Record<keyof StudentTabParamList, keyof typeof Ionicons.glyphMap>> = {
            StudentHome: 'document-text-outline',
            StudentTutor: 'sparkles-outline',
            // Bottom-nav "Play" tab — Results moved into StudentHome as a
            // sub-tab (see screen file header for context).
            StudentResults: 'game-controller-outline',
          };
          return <Ionicons name={icons[route.name] ?? 'ellipse-outline'} size={size} color={color} />;
        },
      })}
    >
      <StudentTab.Screen
        name="StudentHome"
        component={StudentHomeScreen}
        options={{ title: t('my_homework'), tabBarLabel: t('my_homework'), headerShown: false }}
      />
      <StudentTab.Screen
        name="StudentTutor"
        component={StudentTutorScreen}
        options={{ title: t('tutor'), tabBarLabel: t('tutor'), headerShown: false }}
      />
      <StudentTab.Screen
        name="StudentResults"
        component={StudentResultsScreen}
        options={{ title: t('play'), tabBarLabel: t('play'), headerShown: false }}
      />
      <StudentTab.Screen
        name="StudentSubmit"
        component={StudentSubmitScreen}
        options={{ title: t('submit'), headerShown: false, tabBarButton: () => null }}
      />
      <StudentTab.Screen
        name="StudentSettings"
        component={StudentSettingsScreen}
        options={{ title: t('settings'), headerShown: false, tabBarButton: () => null }}
      />
    </StudentTab.Navigator>
  );
}

// ── Student root (tabs + submission flow screens) ─────────────────────────────

function StudentNavigator() {
  return (
    <StudentRootStack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
      <StudentRootStack.Screen name="StudentTabs" component={StudentTabs} />
      <StudentRootStack.Screen
        name="StudentCamera"
        component={StudentCameraScreen}
        options={{ headerShown: false }}
      />
      <StudentRootStack.Screen
        name="StudentPreview"
        component={StudentPreviewScreen}
        options={{ headerShown: false }}
      />
      <StudentRootStack.Screen
        name="StudentConfirm"
        component={StudentConfirmScreen}
        options={{ headerShown: false }}
      />
      <StudentRootStack.Screen
        name="SubmissionSuccess"
        component={SubmissionSuccessScreen}
        options={{ headerShown: false, gestureEnabled: false }}
      />
      <StudentRootStack.Screen
        name="Feedback"
        component={FeedbackScreen}
        options={{ title: 'Feedback', headerBackTitle: 'Results' }}
      />
      <StudentRootStack.Screen
        name="StudentAnalytics"
        component={StudentAnalyticsScreen}
        options={{ title: 'My Analytics', headerBackTitle: 'Back' }}
      />
      <StudentRootStack.Screen
        name="SetPin"
        component={SetPinScreen}
        options={{ headerShown: false }}
      />
      <StudentRootStack.Screen
        name="ClassManagement"
        component={ClassManagementScreen}
        options={{ headerShown: false }}
      />
    </StudentRootStack.Navigator>
  );
}

// ── App shell — auth gate + role routing ──────────────────────────────────────

// ── Download prompt modal ─────────────────────────────────────────────────────

function DownloadPromptModal() {
  const { showPrompt, variant, acceptDownload, skipDownload } = useModel();
  if (!showPrompt || !variant) return null;

  return (
    <Modal visible animationType="fade" transparent>
      <View style={promptStyles.overlay}>
        <View style={promptStyles.card}>
          <Text style={promptStyles.title}>Download AI model</Text>
          <Text style={promptStyles.body}>
            Neriah can grade and assist offline with an on-device AI model.
          </Text>
          <Text style={promptStyles.name}>Powered by Gemma 4 E2B</Text>
          <Text style={promptStyles.size}>~3GB : recommended on Wi-Fi</Text>

          <TouchableOpacity style={promptStyles.primaryBtn} onPress={acceptDownload}>
            <Text style={promptStyles.primaryBtnText}>Download now</Text>
          </TouchableOpacity>

          <TouchableOpacity style={promptStyles.secondaryBtn} onPress={skipDownload}>
            <Text style={promptStyles.secondaryBtnText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const promptStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  card: {
    backgroundColor: COLORS.white, borderRadius: 16,
    padding: 20, width: '100%', maxWidth: 300,
  },
  title: { fontSize: 17, fontWeight: '800', color: COLORS.text, marginBottom: 8 },
  body: { fontSize: 13, color: COLORS.textLight, lineHeight: 18, marginBottom: 12 },
  name: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 2 },
  size: { fontSize: 12, color: COLORS.gray500, marginBottom: 18 },
  primaryBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginBottom: 6,
  },
  primaryBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },
  secondaryBtn: { paddingVertical: 8, alignItems: 'center' },
  secondaryBtnText: { color: COLORS.gray500, fontSize: 13 },
});

// ── App shell — auth gate + role routing ──────────────────────────────────────

function AppShell() {
  const { user, loading, hasPin, pinUnlocked, needsPinSetup } = useAuth();
  const { initPrompt } = useModel();

  // Device capability detection — runs once on first launch only.
  // Then check if we should show the model download prompt.
  React.useEffect(() => {
    detectAndStoreCapability()
      .then(() => initPrompt())
      .catch(() => {});
  }, []);

  // Offline queue replay only needed for teachers (marking pipeline).
  // Run the v1→v2 migration on first launch of the multi-page build so any
  // stale single-image queued scans don't blow up replay.
  React.useEffect(() => {
    if (user?.role !== 'teacher') return;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      await migrateQueueIfNeeded().catch(() => {});
      // Kick replay on cold start if we're already online with queued items.
      // The NetInfo listener inside startNetworkListener only fires on
      // offline→online transitions, so without this items queued in a prior
      // session would never drain on a fresh launch.
      try {
        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected && (await getQueueLength()) > 0) {
          replayQueue().catch((err) =>
            console.error('[startup] replayQueue failed', err),
          );
        }
      } catch {
        // Best-effort — don't block startup on NetInfo/storage errors
      }
      unsubscribe = startNetworkListener();
    })();
    return () => {
      unsubscribe?.();
    };
  }, [user?.role]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  let content: React.ReactElement;
  let isAuthed = false;
  if (!user) {
    content = <AuthNavigator />;
  } else if (hasPin && !pinUnlocked) {
    // Cold start with PIN set — require PIN before anything else
    content = <PinLoginScreen />;
  } else if (needsPinSetup) {
    // First OTP login after registration — prompt user to set a PIN
    // (or skip). Terms are now accepted inline during registration, so no
    // post-login agreement interstitial here.
    content = <PinSetupScreen />;
  } else if (user.role === 'teacher') {
    content = <TeacherNavigator />;
    isAuthed = true;
  } else {
    content = <StudentNavigator />;
    isAuthed = true;
  }

  return (
    <NavigationContainer
      onReady={() => track('app.ready', undefined, { surface: 'app' })}
      onStateChange={(state) => {
        try {
          const r = state?.routes?.[state.index ?? 0];
          if (r) trackScreen(r.name, r.params as Record<string, unknown> | undefined);
        } catch {
          /* never break navigation over telemetry */
        }
      }}
    >
      <View style={{ flex: 1 }}>
        {/* NetworkBanner removed — sync status now lives on the
            profile avatar (orange ring + "Syncing…" label, see
            AvatarWithStatus). The previous top banner could get
            stuck "Uploading N pending scans…" because it only
            triggered replay on offline → online edges. */}
        <ErrorBoundary>
          {content}
        </ErrorBoundary>
      </View>
      {/* Startup "Download AI model" modal removed — users download from
          Settings or via the in-session Wi-Fi nudge. DownloadPromptModal is
          kept below as dead code for now in case we reintroduce it later. */}
    </NavigationContainer>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

export default function App() {
  return (
    // GestureHandlerRootView must wrap any screen that uses
    // react-native-gesture-handler's PinchGestureHandler / TapGestureHandler
    // (MarkResult + PageReviewScreen). React Navigation's internal wrap
    // covers its own transitions but doesn't scope to custom handlers.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <LanguageProvider>
          <AuthProvider>
            <ModelProvider>
              <AppShell />
            </ModelProvider>
          </AuthProvider>
        </LanguageProvider>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
