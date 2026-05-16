// src/screens/TeacherAssistantScreen.tsx
// AI Teaching Assistant — wired to POST /api/teacher/assistant.
// Curriculum/level-aware, AsyncStorage history, structured-output cards, export flow.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  SafeAreaView,
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';

import {
  AssistantActionType,
  AssistantChatMessage,
  AssistantResponse,
  CurriculumOptions,
  getCurriculumOptions,
  teacherAssistantChat,
} from '../services/api';
import {
  assistantOnDevice,
  assistantOnDeviceWithImage,
  documentToOnDeviceReply,
  imageToOnDeviceReply,
  resolveRoute,
  showUnavailableAlert,
} from '../services/router';
import type { AssistantOnDeviceActionType } from '../services/litert';
import {
  enqueueChatRequest,
  onNetworkRestore,
  replayChatQueue,
  type ChatReplaySender,
} from '../services/chatOfflineQueue';
import { detectCountryFromPhone } from '../utils/country';
import InAppCamera from '../components/InAppCamera';
import AvatarWithStatus from '../components/AvatarWithStatus';
import { useAuth } from '../context/AuthContext';
import { RootStackParamList } from '../types';

// ── Neriah brand palette ───────────────────────────────────────────────────────
const AI = {
  bg:        '#FAFAFA',   // page background (same as rest of app)
  card:      '#FFFFFF',   // white cards and AI bubbles
  user:      '#0D7377',   // teal user message bubbles
  userText:  '#FFFFFF',   // white text on teal user bubbles
  border:    '#E8E8E8',   // light gray borders
  purple:    '#0D7377',   // teal (avatar, send button)
  purpleLt:  '#0D7377',   // teal accents
  text:      '#2C2C2A',   // dark gray text
  sub:       '#6B7280',   // medium gray subtext
  inputBg:   '#FFFFFF',   // white input background
  chip:      '#E8F4F4',   // light teal chip background
  chipText:  '#0D7377',   // teal chip text
  teal:      '#0D7377',   // Neriah teal
  tealDark:  '#0F766E',   // darker teal
  headerBg:  '#0D7377',   // teal header
  exportCard:'#F0FDFA',   // light teal structured card
  exportBdr: '#CCEDEC',   // light teal card border
} as const;

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ── Action type mapping ────────────────────────────────────────────────────────

// "Create Homework" + "Create a Quiz" removed from the menu 2026-04-22 along
// with the export endpoint that persisted those structures as draft answer_keys.
// The action types stay in AssistantActionType so the chat routing / tests
// still work; teachers just can't pick them as a button anymore.
const QUICK_ACTIONS: Array<{ label: string; action: AssistantActionType }> = [
  { label: 'Prepare Notes',             action: 'prepare_notes' },
  { label: 'Suggest teaching methods',  action: 'teaching_methods' },
  { label: 'Generate exam questions',   action: 'exam_questions' },
];

// ── Curriculum / Level data ────────────────────────────────────────────────────

const CURRICULUMS = ['ZIMSEC', 'Cambridge', 'IB', 'National Curriculum'] as const;

const ALL_LEVELS = 'All Levels';

const CURRICULUM_LEVELS: Record<string, string[]> = {
  ZIMSEC: [
    ALL_LEVELS,
    'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7',
    'Form 1', 'Form 2', 'Form 3', 'Form 4',
    'Form 5 (A-Level)', 'Form 6 (A-Level)', 'College/University',
  ],
  Cambridge: [
    ALL_LEVELS,
    'Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5', 'Year 6',
    'Year 7', 'Year 8', 'Year 9 (Lower Secondary)',
    'IGCSE (Year 10)', 'IGCSE (Year 11)',
    'A-Level (Year 12)', 'A-Level (Year 13)',
  ],
  IB:  [ALL_LEVELS, 'Primary Years (PYP)', 'Middle Years (MYP)', 'Diploma Programme (DP)'],
  'National Curriculum': [ALL_LEVELS, 'KS1', 'KS2', 'KS3', 'GCSE', 'A-Level'],
};

const DEFAULT_LEVEL: Record<string, string> = {
  ZIMSEC:               'Form 3',
  Cambridge:            'IGCSE (Year 10)',
  IB:                   'Middle Years (MYP)',
  'National Curriculum': 'GCSE',
};

// ── History helpers ───────────────────────────────────────────────────────────

const historyKey      = (userId: string) => `teacher_assistant_history_${userId}`;
const sessionsKey     = (userId: string) => `teacher_assistant_sessions_${userId}`;
const MAX_HISTORY     = 10;  // messages in context window
const MAX_SESSIONS = 50;  // chat sessions stored
const MAX_DISPLAY     = 20;  // sessions shown in drawer

const SCREEN_WIDTH = Dimensions.get('window').width;

// Strip the most common markdown emphasis marks the model leaks into chat
// bubbles (bold, italic, code, headings, bullet asterisks). The chat UI
// renders raw Text — markdown isn't parsed, so users see literal '**' chars.
// Structured cards keep their data untouched; this only runs on the bubble
// content string.
function stripMarkdown(text: string): string {
  if (!text) return text;
  return text
    // fenced code block: ```json ... ``` (or any lang). Strip the fence
    // markers but keep the content. The backend already scrubs JSON for
    // the assistant + tutor endpoints, so this is the defensive layer
    // that catches anything new (e.g. on-device responses) before the
    // user ever sees a literal ```...``` in the chat bubble.
    .replace(/```[a-zA-Z]*\s*\n?/g, '')
    .replace(/\n?```\s*/g, '')
    // bold **x** or __x__
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    // italic *x* or _x_ — only when not part of a word (avoid mangling file_name etc.)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2')
    // inline code `x`
    .replace(/`([^`\n]+)`/g, '$1')
    // ATX headings at line start: "# heading", "## heading", etc.
    .replace(/^#{1,6}\s+/gm, '')
    // leading bullet asterisks: "* item" → "• item"
    .replace(/^\s*\*\s+/gm, '• ');
}

function makeId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hrs   = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24)  return `${hrs}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id:          string;
  role:        'user' | 'assistant';
  content:     string;
  actionType?: AssistantActionType;
  structured?: Record<string, unknown>;
  exportable?: boolean;
  timestamp:   string;  // ISO 8601
  attachment?: { media_type: string; name: string; uri?: string };
  /** Set on user messages whose request is currently sitting in the
   *  offline queue waiting for connectivity. Cleared by replay logic. */
  queued?:     boolean;
  queuedReason?: string;
}

interface ChatSession {
  chat_id:     string;
  created_at:  string;  // ISO 8601
  updated_at:  string;  // ISO 8601
  preview:     string;  // first user message, max 60 chars
  action_type?: string;
  messages:    ChatMessage[];
}

// ── Structured output card helpers ────────────────────────────────────────────

function cardIcon(action: AssistantActionType): string {
  // create_homework / create_quiz cases removed 2026-04-22 along with the
  // export feature. If the chat endpoint ever returns one of those action
  // types now, it falls through to the default bulb icon — harmless.
  switch (action) {
    case 'prepare_notes':    return 'book-outline';
    case 'exam_questions':   return 'ribbon-outline';
    case 'class_performance':return 'bar-chart-outline';
    default:                 return 'bulb-outline';
  }
}

function cardLabel(action: AssistantActionType): string {
  switch (action) {
    case 'prepare_notes':    return 'Lesson Notes';
    case 'exam_questions':   return 'Exam Questions';
    case 'class_performance':return 'Class Performance';
    default:                 return 'Content';
  }
}

function previewLines(structured: Record<string, unknown>, action: AssistantActionType): string {
  const questions = (structured.questions as unknown[]) ?? [];
  const sections  = (structured.sections  as unknown[]) ?? [];

  if (questions.length > 0) {
    const preview = questions.slice(0, 2).map((q: any, i) =>
      `${q.number ?? i + 1}. ${String(q.question ?? '').slice(0, 50)}${(q.question?.length ?? 0) > 50 ? '…' : ''}`
    );
    return preview.join('\n') + (questions.length > 2 ? `\n+${questions.length - 2} more` : '');
  }
  if (sections.length > 0) {
    const s = sections[0] as any;
    return `${s.heading ?? 'Section 1'}` + (sections.length > 1 ? ` • +${sections.length - 1} more` : '');
  }
  if (action === 'class_performance') {
    const s = structured as any;
    return `${s.summary?.slice(0, 80) ?? 'Class analysis ready'}`;
  }
  return String(structured.title ?? cardLabel(action));
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface ToastProps { message: string; visible: boolean }
function Toast({ message, visible }: ToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(2400),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, opacity]);
  if (!visible) return null;
  return (
    <Animated.View style={[s.toast, { opacity }]}>
      <Ionicons name="checkmark-circle" size={16} color={AI.tealDark} />
      <Text style={s.toastTxt}>{message}</Text>
    </Animated.View>
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(dot, { toValue: -4, duration: 280, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0,  duration: 280, useNativeDriver: true }),
          Animated.delay(500 - i * 150),
        ]),
      ),
    );
    anims.forEach(a => a.start());
    const slowTimer = setTimeout(() => setSlow(true), 30000);
    return () => {
      anims.forEach(a => a.stop());
      clearTimeout(slowTimer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={s.rowLeft}>
      <View style={s.avatar}>
        <Image source={require('../../assets/icon-transparent.png')} style={{ width: 16, height: 16, tintColor: 'white' }} resizeMode="contain" />
      </View>
      <View style={s.bubbleLeft}>
        <View style={s.typingRow}>
          {dots.map((dot, i) => (
            <Animated.View key={i} style={[s.dot, { transform: [{ translateY: dot }] }]} />
          ))}
        </View>
        {slow && (
          <Text style={s.slowText}>Neriah is taking longer than usual — still thinking…</Text>
        )}
      </View>
    </View>
  );
}

// ClassPicker component removed 2026-04-22 — its only caller was the export
// flow (now deleted). Class list state and listClasses() fetch also removed
// from the main screen below.


// ── Main screen ────────────────────────────────────────────────────────────────

export default function TeacherAssistantScreen() {
  const { user }  = useAuth();
  const navigation = useNavigation<Nav>();

  const [curriculum, setCurriculum]       = useState('ZIMSEC');
  const [level, setLevel]                 = useState(ALL_LEVELS);
  const [showCurrDrop, setShowCurrDrop]   = useState(false);
  const [showLvlDrop, setShowLvlDrop]     = useState(false);

  // Country-driven picker config: fetched from /api/curriculum/options on mount.
  // Server resolves country from teacher's phone — Zimbabwe teachers see ZIMSEC,
  // Kenya teachers see KNEC (CBC), etc. Falls back to local hardcoded ZIMSEC list
  // if the fetch fails (offline or first paint).
  const [pickerOptions, setPickerOptions] = useState<CurriculumOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await getCurriculumOptions();
        if (cancelled) return;
        setPickerOptions(opts);
        // Snap to the server-suggested default unless the user has already
        // changed the curriculum manually (state still equals 'ZIMSEC' default).
        setCurriculum(prev => (prev === 'ZIMSEC' ? opts.default_curriculum : prev));
      } catch {
        // Offline / unauthorised — keep hardcoded ZIMSEC fallback.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState('');
  const [typing, setTyping]               = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  // Export state (classes, exportMsg, showClassPicker, exporting) removed
  // 2026-04-22 along with the export flow.
  const [toastMsg, setToastMsg]           = useState('');
  const [toastVisible, setToastVisible]   = useState(false);
  const [attachment, setAttachment]       = useState<{
    data: string;
    type: 'image' | 'pdf' | 'word';
    name: string;
    uri?: string;
  } | null>(null);
  const [showAttachSheet, setShowAttachSheet]   = useState(false);
  const [showInAppCamera, setShowInAppCamera]   = useState(false);

  // ── Drawer state ──────────────────────────────────────────────────────────
  const [showDrawer, setShowDrawer]         = useState(false);
  const [chatHistory, setChatHistory]       = useState<ChatSession[]>([]);
  const [currentChatId, setCurrentChatId]   = useState<string | null>(null);
  const drawerAnim  = useRef(new Animated.Value(-SCREEN_WIDTH * 0.8)).current;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flatRef   = useRef<FlatList<ChatMessage>>(null);
  const userId    = user?.id ?? 'unknown';

  // ── Load sessions on mount — restore most recent ──────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(sessionsKey(userId)).then(raw => {
      if (!raw) return;
      try {
        const saved: ChatSession[] = JSON.parse(raw);
        if (saved.length === 0) return;
        setChatHistory(saved);
        // Restore the most-recently-updated session automatically
        const last = saved[0]; // array is sorted updated_at desc on save
        setMessages(last.messages);
        setCurrentChatId(last.chat_id);
      } catch {}
    });
  }, [userId]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 120);
    }
  }, [messages, typing]);

  // ── Offline queue replay ──────────────────────────────────────────────────
  // Track currentChatId in a ref so the sender doesn't recreate when
  // the teacher switches chats — we want a single, stable replay loop.
  const currentChatIdRef = useRef(currentChatId);
  useEffect(() => { currentChatIdRef.current = currentChatId; }, [currentChatId]);

  const replayQueueOnce = useCallback(async () => {
    const sender: ChatReplaySender = async (item) => {
      try {
        const res = await teacherAssistantChat(item.payload as any);
        const structured = res.structured;
        const isEmptyStructured = !!structured && Object.values(structured).every((v) => {
          if (v == null) return true;
          if (typeof v === 'string') return v.trim() === '';
          if (Array.isArray(v)) return v.length === 0;
          return false;
        });
        const aiMsg: ChatMessage = {
          id:         makeId(),
          role:       'assistant',
          content:    res.response ?? '',
          actionType: res.action_type,
          structured: isEmptyStructured ? undefined : structured,
          exportable: res.exportable,
          timestamp:  new Date().toISOString(),
        };
        try {
          const raw = await AsyncStorage.getItem(sessionsKey(userId));
          const sessions: ChatSession[] = raw ? JSON.parse(raw) : [];
          const idx = sessions.findIndex(s => s.chat_id === item.chat_id);
          if (idx >= 0) {
            const updatedMsgs = sessions[idx].messages.map(m =>
              m.id === item.user_msg_id ? { ...m, queued: false } : m,
            );
            updatedMsgs.push(aiMsg);
            sessions[idx] = {
              ...sessions[idx],
              messages: updatedMsgs,
              updated_at: new Date().toISOString(),
            };
            await AsyncStorage.setItem(sessionsKey(userId), JSON.stringify(sessions));
            setChatHistory(sessions);
            if (item.chat_id === currentChatIdRef.current) {
              setMessages(updatedMsgs);
            }
          }
        } catch {
          // Storage write failed — replay still succeeded.
        }
        return { ok: true, response: res };
      } catch (err: any) {
        const status = err?.response?.status ?? err?.status;
        const permanent = typeof status === 'number' &&
          status >= 400 && status < 500 && status !== 408 && status !== 429;
        return { ok: false, permanent, error: err };
      }
    };
    try {
      await replayChatQueue('teacher_assistant', sender);
    } catch {
      // Best-effort.
    }
  }, [userId]);

  useEffect(() => { void replayQueueOnce(); }, [replayQueueOnce]);
  useEffect(() => onNetworkRestore(() => { void replayQueueOnce(); }), [replayQueueOnce]);

  // (listClasses effect removed — classes state only existed to feed the
  // export-to-class picker, which is gone.)

  // ── Persist history (legacy key — kept for API context window) ───────────
  const persistHistory = useCallback((msgs: ChatMessage[]) => {
    AsyncStorage.setItem(historyKey(userId), JSON.stringify(msgs)).catch(() => {});
  }, [userId]);

  // ── Save session to AsyncStorage (debounced 500 ms) ───────────────────────
  const saveToSessionHistory = useCallback((
    msgs: ChatMessage[],
    chatId: string,
    actionType?: string,
  ) => {
    if (msgs.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const raw = await AsyncStorage.getItem(sessionsKey(userId));
        let sessions: ChatSession[] = raw ? JSON.parse(raw) : [];
        const now = new Date().toISOString();
        const preview = (msgs.find(m => m.role === 'user')?.content ?? 'Chat').slice(0, 60);
        const existing = sessions.find(s => s.chat_id === chatId);
        const session: ChatSession = {
          chat_id:     chatId,
          created_at:  existing ? existing.created_at : now,
          updated_at:  now,
          preview,
          action_type: actionType ?? existing?.action_type,
          messages:    msgs,
        };
        sessions = sessions.filter(s => s.chat_id !== chatId);
        sessions = [session, ...sessions]; // newest first
        if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(0, MAX_SESSIONS);
        await AsyncStorage.setItem(sessionsKey(userId), JSON.stringify(sessions));
        setChatHistory(sessions);
      } catch {}
    }, 500);
  }, [userId]);

  // ── Open drawer: refresh history then animate in ─────────────────────────
  const openDrawer = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(sessionsKey(userId));
      if (raw) setChatHistory(JSON.parse(raw));
    } catch {}
    setShowDrawer(true);
    Animated.timing(drawerAnim, {
      toValue: 0, duration: 250, useNativeDriver: true,
    }).start();
  }, [userId, drawerAnim]);

  // ── Close drawer (animate out, then hide) ────────────────────────────────
  const closeDrawer = useCallback(() => {
    Animated.timing(drawerAnim, {
      toValue: -SCREEN_WIDTH * 0.8, duration: 220, useNativeDriver: true,
    }).start(() => setShowDrawer(false));
  }, [drawerAnim]);

  // ── Start a new chat: flush current session, then reset to blank ──────────
  const startNewChat = useCallback(() => {
    if (messages.length > 0 && currentChatId) {
      // Flush immediately (bypass debounce)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveToSessionHistory(messages, currentChatId);
    }
    setMessages([]);
    setConversationId(undefined);
    setCurrentChatId(null);  // next message will create a new session
    closeDrawer();
  }, [messages, currentChatId, saveToSessionHistory, closeDrawer]);

  // ── Load a saved chat session ─────────────────────────────────────────────
  const loadChatSession = useCallback((session: ChatSession) => {
    setMessages(session.messages);
    setCurrentChatId(session.chat_id);
    setConversationId(undefined);
    closeDrawer();
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 80);
  }, [closeDrawer]);

  // ── Delete a chat session ─────────────────────────────────────────────────
  const deleteChatSession = useCallback(async (chatId: string) => {
    try {
      const raw = await AsyncStorage.getItem(sessionsKey(userId));
      let sessions: ChatSession[] = raw ? JSON.parse(raw) : [];
      sessions = sessions.filter(s => s.chat_id !== chatId);
      await AsyncStorage.setItem(sessionsKey(userId), JSON.stringify(sessions));
      setChatHistory(sessions);
      // If the deleted session was active, reset to blank
      if (chatId === currentChatId) {
        setMessages([]);
        setCurrentChatId(null);
      }
    } catch {}
  }, [userId, currentChatId]);

  // ── Clear history (pencil button) ─────────────────────────────────────────
  const clearHistory = useCallback(() => {
    startNewChat();
  }, [startNewChat]);

  // ── Close dropdowns ───────────────────────────────────────────────────────
  const closeDrops = () => { setShowCurrDrop(false); setShowLvlDrop(false); };

  // ── Show toast ────────────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 3000);
  };

  // ── Attachment picker ─────────────────────────────────────────────────────
  // Wait for the attach-sheet Modal to finish dismissing before opening a
  // native picker. Without this, iOS silently no-ops because the Modal is
  // still animating out when the picker tries to present.
  const closeSheetAndRun = useCallback((fn: () => void | Promise<void>) => {
    setShowAttachSheet(false);
    setTimeout(() => { void fn(); }, 350);
  }, []);

  const pickFromCamera = useCallback(() => {
    setShowInAppCamera(true);
  }, []);

  const pickFromGallery = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Photos permission needed',
          'Allow Neriah to read your photos so you can attach images. Open Settings to enable it.',
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setAttachment({ data: asset.base64 ?? '', type: 'image', name: asset.fileName ?? 'Image', uri: asset.uri });
    } catch (err: any) {
      Alert.alert('Could not open the gallery', err?.message ?? 'Please try again.');
    }
  }, []);

  const pickDocument = useCallback(async (docType: 'pdf' | 'word') => {
    try {
      const mimeTypes = docType === 'pdf'
        ? ['application/pdf']
        : ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      const result = await DocumentPicker.getDocumentAsync({ type: mimeTypes, copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        setAttachment({ data: base64, type: docType, name: asset.name ?? `Document.${docType}` });
      } catch {
        showToast('Could not read the document. Try a different file.');
      }
    } catch (err: any) {
      Alert.alert(
        docType === 'pdf' ? 'Could not open PDF picker' : 'Could not open Word picker',
        err?.message ?? 'Please try again.',
      );
    }
  }, []);

  const openAttachPicker = useCallback(() => {
    setShowAttachSheet(true);
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (
    text: string,
    forcedActionType?: AssistantActionType,
    classId?: string,
  ) => {
    if ((!text.trim() && !attachment) || typing) return;
    closeDrops();

    const displayText = text.trim() || (attachment ? `[${attachment.name}]` : '');
    const snap = attachment;
    setAttachment(null);

    // Create a new session ID on first message if none is active
    const activeChatId = currentChatId ?? makeId();
    if (!currentChatId) setCurrentChatId(activeChatId);

    const userMsg: ChatMessage = {
      id:        makeId(),
      role:      'user',
      content:   displayText,
      timestamp: new Date().toISOString(),
      ...(snap ? { attachment: { media_type: snap.type, name: snap.name, uri: snap.uri } } : {}),
    };
    const updatedWithUser = [...messages, userMsg];
    setMessages(updatedWithUser);
    setInput('');
    setTyping(true);

    // Build chat_history for API (last MAX_HISTORY messages, assistant turns only)
    const apiHistory: AssistantChatMessage[] = updatedWithUser
      .slice(-MAX_HISTORY)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const route = await resolveRoute('teacher_assistant');

      if (route === 'unavailable') {
        if (snap) {
          // Offline + attachment — queue the request and flip the user
          // bubble to "Will send when online" instead of dropping it.
          await enqueueChatRequest({
            kind:        'teacher_assistant',
            chat_id:     activeChatId,
            user_msg_id: userMsg.id,
            payload: {
              message:         text.trim() || '(See attached file)',
              action_type:     forcedActionType,
              curriculum,
              level:           level === ALL_LEVELS ? undefined : level,
              class_id:        classId,
              chat_history:    apiHistory,
              conversation_id: conversationId,
              file_data:       snap.data,
              media_type:      snap.type,
            },
          });
          const queuedMsgs = updatedWithUser.map(m =>
            m.id === userMsg.id ? { ...m, queued: true } : m,
          );
          setMessages(queuedMsgs);
          persistHistory(queuedMsgs);
          saveToSessionHistory(queuedMsgs, activeChatId, forcedActionType);
          return;
        }
        // No attachment + offline + no on-device model → there's nothing
        // useful to do. Surface the standard "Connect to continue" alert.
        showUnavailableAlert();
        return;
      }

      if (route === 'on-device') {
        // LiteRT E2B is text-only. For image attachments we can still
        // produce an on-device answer by running OCR locally and feeding
        // the extracted text into the assistant prompt. That covers the
        // common case (screenshots, textbook pages, photographed marking
        // schemes). Object-only photos / blurry images / decorative
        // attachments fall back to the queue. PDFs and Word docs always
        // queue — extracting them client-side is impractical.
        if (snap) {
          // Map cloud action types to the on-device subset.
          const onDeviceActionForImage: AssistantOnDeviceActionType =
            forcedActionType === 'prepare_notes'    ? 'prepare_notes' :
            forcedActionType === 'teaching_methods' ? 'teaching_methods' :
            forcedActionType === 'exam_questions'   ? 'exam_questions' :
            'chat';
          const onDeviceHistoryForImage = apiHistory.map(m => ({
            role: m.role as 'user' | 'assistant', content: m.content,
          }));
          const isGenericCurr = !curriculum || curriculum.toLowerCase() === 'generic';
          const isAnyLevel    = !level || level === ALL_LEVELS || ['all', 'any'].includes(level.toLowerCase());

          // Offline + attachment: extract text client-side (image OCR,
          // DOCX unzip, PDF byte-regex with FlateDecode inflate) and
          // feed it into the on-device assistant. Anything we can't
          // extract falls back to the queue for cloud replay when
          // reconnected.
          let attachmentReason: string | undefined;
          try {
            const assistantContext = {
              curriculum:      isGenericCurr ? undefined : curriculum,
              education_level: isAnyLevel    ? undefined : level,
              country:         detectCountryFromPhone((user as any)?.phone),
            };
            const runner = (combined: string) => assistantOnDevice(
              onDeviceActionForImage,
              onDeviceHistoryForImage,
              combined,
              assistantContext,
            );
            // Vision-capable runner — same pattern as the student tutor.
            // Available on Android today; iOS waits on the XCFramework rebuild.
            const multimodalRunner = (msg: string, imagePath: string) => assistantOnDeviceWithImage(
              onDeviceActionForImage,
              onDeviceHistoryForImage,
              msg,
              imagePath,
              assistantContext,
            );

            let result: Awaited<ReturnType<typeof imageToOnDeviceReply>> | null = null;
            if (snap.type === 'image' && snap.uri) {
              result = await imageToOnDeviceReply(snap.uri, text.trim(), runner, multimodalRunner);
            } else if (snap.type === 'pdf' || snap.type === 'word') {
              result = await documentToOnDeviceReply(
                snap.data,
                snap.type,
                snap.name,
                text.trim(),
                runner,
              );
            }

            if (result && result.kind === 'replied') {
              const aiMsg: ChatMessage = {
                id:          makeId(),
                role:        'assistant',
                content:     stripMarkdown(result.reply),
                actionType:  forcedActionType ?? 'chat',
                timestamp:   new Date().toISOString(),
              };
              const updated = [...updatedWithUser, aiMsg];
              setMessages(updated);
              persistHistory(updated);
              saveToSessionHistory(updated, activeChatId, forcedActionType ?? 'chat');
              return;
            }
            if (result?.kind === 'no_text') {
              attachmentReason = snap.type === 'image'
                ? "Couldn't read text in this image"
                : 'No readable text found in this file';
            } else if (result?.kind === 'unavailable') {
              attachmentReason = 'Offline reader unavailable';
            } else if (result?.kind === 'extraction_error') {
              attachmentReason = `Extract error: ${result.error.slice(0, 80)}`;
            } else if (result?.kind === 'runner_error') {
              attachmentReason = `Local AI error: ${result.error.slice(0, 80)}`;
            }
          } catch (err: any) {
            attachmentReason = `Local AI crashed: ${(err?.message ?? String(err)).slice(0, 80)}`;
          }

          if (!attachmentReason) attachmentReason = 'fell through to queue';

          await enqueueChatRequest({
            kind:        'teacher_assistant',
            chat_id:     activeChatId,
            user_msg_id: userMsg.id,
            payload: {
              message:         text.trim() || '(See attached file)',
              action_type:     forcedActionType,
              curriculum,
              level:           level === ALL_LEVELS ? undefined : level,
              class_id:        classId,
              chat_history:    apiHistory,
              conversation_id: conversationId,
              file_data:       snap.data,
              media_type:      snap.type,
            },
          });
          const queuedMsgs = updatedWithUser.map(m =>
            m.id === userMsg.id ? { ...m, queued: true, queuedReason: attachmentReason } : m,
          );
          setMessages(queuedMsgs);
          persistHistory(queuedMsgs);
          saveToSessionHistory(queuedMsgs, activeChatId, forcedActionType);
          return;
        }

        // Map cloud action types to the on-device subset (drops class_performance).
        const onDeviceAction: AssistantOnDeviceActionType =
          forcedActionType === 'prepare_notes'    ? 'prepare_notes' :
          forcedActionType === 'teaching_methods' ? 'teaching_methods' :
          forcedActionType === 'exam_questions'   ? 'exam_questions' :
          'chat';

        const onDeviceHistory = apiHistory.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

        // Treat "Generic" curriculum and "All Levels" the same way the
        // backend does — as unspecified, so the on-device prompt's
        // "let the teacher lead" rule kicks in instead of pinning the
        // model to a fake default.
        const isGenericCurr = !curriculum || curriculum.toLowerCase() === 'generic';
        const isAnyLevel    = !level || level === ALL_LEVELS || ['all', 'any'].includes(level.toLowerCase());

        const responseText = await assistantOnDevice(
          onDeviceAction,
          onDeviceHistory,
          text.trim() || '(See attached file)',
          {
            curriculum:      isGenericCurr ? undefined : curriculum,
            education_level: isAnyLevel    ? undefined : level,
            country:         detectCountryFromPhone((user as any)?.phone),
          },
        );

        const aiMsg: ChatMessage = {
          id:          makeId(),
          role:        'assistant',
          content:     stripMarkdown(responseText),
          actionType:  forcedActionType ?? 'chat',
          timestamp:   new Date().toISOString(),
        };
        const updated = [...updatedWithUser, aiMsg];
        setMessages(updated);
        persistHistory(updated);
        saveToSessionHistory(updated, activeChatId, forcedActionType ?? 'chat');
        return;
      }

      // Cloud path
      const res: AssistantResponse = await teacherAssistantChat({
        message:          text.trim() || '(See attached file)',
        action_type:      forcedActionType,
        curriculum,
        level:            level === ALL_LEVELS ? undefined : level,
        class_id:         classId,
        chat_history:     apiHistory,
        conversation_id:  conversationId,
        ...(snap ? { file_data: snap.data, media_type: snap.type } : {}),
      });

      if (res.conversation_id && !conversationId) {
        setConversationId(res.conversation_id);
      }

      // Detect an empty structured payload from older backends so the
      // empty card doesn't render. Don't fabricate a synthetic AI bubble
      // when both `response` and `structured` are empty — the new backend
      // returns the model's clarifying question as `response` instead.
      const structured = res.structured;
      const isEmptyStructured = !!structured && Object.values(structured).every((v) => {
        if (v == null) return true;
        if (typeof v === 'string') return v.trim() === '';
        if (Array.isArray(v)) return v.length === 0;
        return false;
      });

      const aiMsg: ChatMessage = {
        id:          makeId(),
        role:        'assistant',
        content:     stripMarkdown(res.response ?? ''),
        actionType:  res.action_type,
        structured:  isEmptyStructured ? undefined : structured,
        exportable:  res.exportable,
        timestamp:   new Date().toISOString(),
      };
      const updated = [...updatedWithUser, aiMsg];
      setMessages(updated);
      persistHistory(updated);
      saveToSessionHistory(updated, activeChatId, res.action_type);
    } catch (err: any) {
      const aiMsg: ChatMessage = {
        id:        makeId(),
        role:      'assistant',
        content:   err?.message ?? 'Something went wrong. Please try again.',
        timestamp: new Date().toISOString(),
      };
      const updated = [...updatedWithUser, aiMsg];
      setMessages(updated);
      persistHistory(updated);
      saveToSessionHistory(updated, activeChatId);
    } finally {
      setTyping(false);
    }
  }, [typing, attachment, messages, curriculum, level, conversationId, persistHistory, currentChatId, saveToSessionHistory]);

  // handleExport / doExport removed 2026-04-22 along with
  // POST /api/teacher/assistant/export.

  // Prefer server-driven options for the teacher's country; fall back to
  // hardcoded values when the fetch hasn't completed or has failed.
  const curriculums: readonly string[] =
    pickerOptions?.curriculum_options ?? CURRICULUMS;
  const levels: string[] =
    pickerOptions?.level_options?.[curriculum]
    ?? CURRICULUM_LEVELS[curriculum]
    ?? CURRICULUM_LEVELS.ZIMSEC;

  // ── Message renderer ──────────────────────────────────────────────────────
  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';

    return (
      <View style={isUser ? s.rowRight : s.rowLeft}>
        {!isUser && (
          <View style={s.avatar}>
            <Image source={require('../../assets/icon-transparent.png')} style={{ width: 16, height: 16, tintColor: 'white' }} resizeMode="contain" />
          </View>
        )}
        <View style={{ maxWidth: '80%' }}>
          {/* Attachment preview — image inline, file as chip. Always above
              the text bubble so it's visible regardless of caption length. */}
          {item.attachment && (
            item.attachment.media_type === 'image' && item.attachment.uri ? (
              <Image
                source={{ uri: item.attachment.uri }}
                style={isUser ? s.bubbleAttachImageRight : s.bubbleAttachImageLeft}
                resizeMode="cover"
              />
            ) : (
              <View style={isUser ? s.bubbleFileChipRight : s.bubbleFileChipLeft}>
                <Ionicons
                  name={
                    item.attachment.media_type === 'pdf' ? 'document-text-outline' :
                    item.attachment.media_type === 'word' ? 'document-outline' :
                    'attach-outline'
                  }
                  size={18}
                  color={isUser ? AI.userText : AI.teal}
                />
                <Text
                  style={isUser ? s.bubbleFileChipTextRight : s.bubbleFileChipTextLeft}
                  numberOfLines={1}
                >
                  {item.attachment.name}
                </Text>
              </View>
            )
          )}

          {/* Text bubble */}
          {!!item.content && (
            <View style={isUser ? s.bubbleRight : s.bubbleLeft}>
              <Text style={isUser ? s.msgTextUser : s.msgText}>{item.content}</Text>
            </View>
          )}

          {/* Structured output card */}
          {item.structured && item.actionType && (
            <View style={s.structuredCard}>
              {/* Card header */}
              <View style={s.cardHeader}>
                <Ionicons name={cardIcon(item.actionType) as any} size={16} color={AI.teal} />
                <Text style={s.cardType}>{cardLabel(item.actionType)}</Text>
                {item.structured.total_marks != null && (
                  <View style={s.marksBadge}>
                    <Text style={s.marksBadgeTxt}>
                      {String(item.structured.total_marks)} marks
                    </Text>
                  </View>
                )}
              </View>

              {/* Title */}
              {item.structured.title != null && (
                <Text style={s.cardTitle}>{String(item.structured.title)}</Text>
              )}

              {/* Preview of first 2 questions / first section */}
              <Text style={s.cardPreview}>
                {previewLines(item.structured, item.actionType)}
              </Text>

              {/* Export-to-class buttons removed 2026-04-22 along with the
                  export endpoint. Structured homework/quiz cards now render
                  preview-only. */}
            </View>
          )}

          {/* Offline-queue indicator on user bubbles awaiting connectivity. */}
          {item.queued && isUser && (
            <View style={s.queuedRow}>
              <Ionicons name="cloud-offline-outline" size={12} color={AI.sub} />
              <Text style={s.queuedText}>
                {item.queuedReason ? `${item.queuedReason} · ` : ''}
                Will send when online
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }, [sendMessage]);

  return (
    <View style={s.screen}>
      <StatusBar barStyle="light-content" backgroundColor={AI.headerBg} />
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']} keyboardVerticalOffset={0}>
          {/* Dropdown backdrop */}
          {(showCurrDrop || showLvlDrop) && (
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              onPress={closeDrops}
              activeOpacity={1}
            />
          )}

          {/* ── Header ── */}
          {/* Profile avatar removed from this screen — sync status now
              lives on the My Classes header avatar; duplicating it on
              Assistant clutters the chrome. Hairline placeholder keeps
              the title visually centred between the menu button and
              the right edge. */}
          <View style={s.header}>
            <TouchableOpacity style={s.hBtn} onPress={openDrawer}>
              <Ionicons name="menu-outline" size={24} color={AI.userText} />
            </TouchableOpacity>
            <Text style={s.hTitle}>Neriah AI</Text>
            <View style={{ width: 36 }} />
          </View>

          {/* ── Context pills ── */}
          <View style={s.pillRow}>
            {/* Curriculum */}
            <View>
              <TouchableOpacity
                style={s.pill}
                onPress={() => { setShowLvlDrop(false); setShowCurrDrop(v => !v); }}
              >
                <Text style={s.pillTxt}>{curriculum}</Text>
                <Ionicons name={showCurrDrop ? 'chevron-up' : 'chevron-down'} size={12} color={AI.teal} />
              </TouchableOpacity>
              {showCurrDrop && (
                <View style={[s.dropdown, { zIndex: 200 }]}>
                  {curriculums.map(c => (
                    <TouchableOpacity
                      key={c}
                      style={[s.dropItem, c === curriculum && s.dropActive]}
                      onPress={() => {
                        setCurriculum(c);
                        // Default to "All Levels" (first entry) when switching curriculum.
                        const nextLevels =
                          pickerOptions?.level_options?.[c]
                          ?? CURRICULUM_LEVELS[c]
                          ?? CURRICULUM_LEVELS.ZIMSEC;
                        setLevel(DEFAULT_LEVEL[c] ?? nextLevels[0]);
                        setShowCurrDrop(false);
                      }}
                    >
                      <Text style={[s.dropTxt, c === curriculum && s.dropActiveTxt]}>{c}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Level */}
            <View>
              <TouchableOpacity
                style={s.pill}
                onPress={() => { setShowCurrDrop(false); setShowLvlDrop(v => !v); }}
              >
                <Text style={s.pillTxt}>{level}</Text>
                <Ionicons name={showLvlDrop ? 'chevron-up' : 'chevron-down'} size={12} color={AI.teal} />
              </TouchableOpacity>
              {showLvlDrop && (
                <View style={[s.dropdown, { maxHeight: 220, zIndex: 200 }]}>
                  <ScrollView bounces={false}>
                    {levels.map(l => (
                      <TouchableOpacity
                        key={l}
                        style={[s.dropItem, l === level && s.dropActive]}
                        onPress={() => { setLevel(l); setShowLvlDrop(false); }}
                      >
                        <Text style={[s.dropTxt, l === level && s.dropActiveTxt]}>{l}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
          </View>

          {/* ── Chat or empty state ── */}
          {messages.length === 0 && !typing ? (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={s.emptyCont}
              keyboardShouldPersistTaps="handled"
            >
              {/* Hero: centered in the available scroll space */}
              <View style={s.emptyHero}>
                <View style={s.emptyIcon}>
                  <Image
                    source={require('../../assets/icon-transparent.png')}
                    style={{ width: 48, height: 48, tintColor: AI.teal }}
                    resizeMode="contain"
                  />
                </View>
                <Text style={s.emptyTitle}>Neriah AI</Text>
                <Text style={s.emptySub}>Your AI teaching assistant</Text>
              </View>
              {/* Quick actions: sits at the bottom of the scroll area, adjacent to input */}
              <View style={s.quickGrid}>
                {QUICK_ACTIONS.map(({ label, action }) => (
                  <TouchableOpacity
                    key={label}
                    style={s.quickPill}
                    onPress={() => sendMessage(label, action)}
                  >
                    <Ionicons name={cardIcon(action) as any} size={16} color={AI.teal} style={{ marginRight: 8 }} />
                    <Text style={s.quickTxt}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          ) : (
            <FlatList
              ref={flatRef}
              data={messages}
              keyExtractor={m => m.id}
              renderItem={renderMessage}
              contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              removeClippedSubviews
              ListFooterComponent={typing ? <TypingIndicator /> : null}
            />
          )}

          {/* ── Input bar ── */}
          <View style={s.inputArea}>
            <Text style={s.caption}>Neriah can make mistakes. Verify important info.</Text>
            {/* Attachment preview chip */}
            {attachment && (
              <View style={s.attachChip}>
                {attachment.type === 'image' && attachment.uri ? (
                  <Image source={{ uri: attachment.uri }} style={s.attachThumb} />
                ) : (
                  <Ionicons
                    name={attachment.type === 'pdf' ? 'document-text-outline' : 'document-outline'}
                    size={16} color={AI.teal}
                  />
                )}
                <Text style={s.attachChipText} numberOfLines={1}>{attachment.name}</Text>
                <TouchableOpacity onPress={() => setAttachment(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color={AI.sub} />
                </TouchableOpacity>
              </View>
            )}
            <View style={s.inputRow}>
              <TouchableOpacity style={s.attachBtn} onPress={openAttachPicker}>
                <Ionicons name="attach-outline" size={20} color={attachment ? AI.teal : AI.sub} />
              </TouchableOpacity>
              <TextInput
                style={s.input}
                value={input}
                onChangeText={setInput}
                placeholder="Message Neriah AI..."
                placeholderTextColor={AI.sub}
                multiline
                maxLength={2000}
              />
              <TouchableOpacity
                style={[s.sendBtn, ((!input.trim() && !attachment) || typing) && s.sendDisabled]}
                onPress={() => {
                  // Detect action type from input keywords. 'create_homework'
                  // and 'create_quiz' auto-mappings removed 2026-04-22 along
                  // with the export UI — teachers can still get structured
                  // homework/quiz output by explicitly asking the assistant,
                  // but we don't auto-route free-form input to those action
                  // types anymore.
                  const q = input.toLowerCase();
                  let action: AssistantActionType = 'chat';
                  if (q.includes('notes') || q.includes('prepare')) action = 'prepare_notes';
                  else if (q.includes('exam'))   action = 'exam_questions';
                  else if (q.includes('teaching') || q.includes('method')) action = 'teaching_methods';
                  sendMessage(input, action);
                }}
                disabled={(!input.trim() && !attachment) || typing}
              >
                <Ionicons name="arrow-up" size={18} color={AI.userText} />
              </TouchableOpacity>
            </View>
          </View>
      </ScreenContainer>

      {/* In-app camera */}
      <InAppCamera
        visible={showInAppCamera}
        onCapture={async (uri) => {
          setShowInAppCamera(false);
          try {
            const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
            setAttachment({ data: base64, type: 'image', name: 'Photo', uri });
          } catch (e) {
            console.warn('[TeacherAssistant] failed to read base64 from camera URI:', e);
          }
        }}
        onClose={() => setShowInAppCamera(false)}
      />

      {/* Attach media bottom sheet */}
      <Modal
        visible={showAttachSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAttachSheet(false)}
      >
        <TouchableOpacity
          style={s.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowAttachSheet(false)}
        >
          <View style={s.attachSheet} onStartShouldSetResponder={() => true}>
            <Text style={s.attachSheetTitle}>Attach a file</Text>
            {[
              { icon: 'camera-outline',        label: 'Camera',        color: AI.teal, onPress: () => closeSheetAndRun(() => setShowInAppCamera(true)) },
              { icon: 'image-outline',         label: 'Gallery',       color: AI.teal, onPress: () => closeSheetAndRun(pickFromGallery) },
              { icon: 'document-outline',      label: 'PDF',           color: AI.teal, onPress: () => closeSheetAndRun(() => pickDocument('pdf')) },
              { icon: 'document-text-outline', label: 'Word',          color: AI.teal, onPress: () => closeSheetAndRun(() => pickDocument('word')) },
              { icon: 'close-outline',         label: 'Cancel',        color: AI.sub,  onPress: () => setShowAttachSheet(false) },
            ].map(({ icon, label, color, onPress }, idx, arr) => (
              <TouchableOpacity
                key={label}
                style={[s.attachSheetRow, idx < arr.length - 1 && s.attachSheetRowBorder]}
                onPress={onPress}
                activeOpacity={0.7}
              >
                <Ionicons name={icon as any} size={22} color={color} />
                <Text style={[s.attachSheetLabel, label === 'Cancel' && { color: AI.sub }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Class picker modal removed 2026-04-22 (export feature deleted). */}

      {/* Toast */}
      <Toast message={toastMsg} visible={toastVisible} />

      {/* ── Chat History Drawer ── */}
      {showDrawer && (
        <Modal visible transparent animationType="none" onRequestClose={closeDrawer}>
          {/* Re-seed the safe-area context — RN's Modal severs the parent
              SafeAreaProvider, so without this SafeAreaView reads 0 insets. */}
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          {/* Backdrop */}
          <TouchableOpacity
            style={s.drawerBackdrop}
            activeOpacity={1}
            onPress={closeDrawer}
          />
          {/* Slide-in panel */}
          <Animated.View style={[s.drawer, { transform: [{ translateX: drawerAnim }] }]}>
            <SafeAreaView style={s.drawerSafeInner} edges={['top', 'bottom']} mode="margin">
            {/* Drawer header */}
            <View style={s.drawerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Image
                  source={require('../../assets/icon-transparent.png')}
                  style={{ width: 26, height: 26, tintColor: AI.teal }}
                  resizeMode="contain"
                />
                <Text style={s.drawerTitle}>Neriah AI</Text>
              </View>
              <TouchableOpacity style={s.hBtn} onPress={closeDrawer}>
                <Ionicons name="close-outline" size={24} color={AI.sub} />
              </TouchableOpacity>
            </View>

            {/* New Chat button */}
            <View style={s.drawerSection}>
              <TouchableOpacity style={s.newChatBtn} onPress={startNewChat}>
                <Ionicons name="add-outline" size={20} color={AI.userText} />
                <Text style={s.newChatBtnTxt}>New Chat</Text>
              </TouchableOpacity>
            </View>

            {/* Recent Chats */}
            <Text style={s.drawerSectionLabel}>RECENT CHATS</Text>
            <FlatList
              data={chatHistory.slice(0, MAX_DISPLAY)}
              keyExtractor={s => s.chat_id}
              contentContainerStyle={{ paddingBottom: 24 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <Text style={s.drawerEmpty}>No recent chats</Text>
              }
              renderItem={({ item }) => {
                const isActive = item.chat_id === currentChatId;
                return (
                  <TouchableOpacity
                    style={[s.drawerChatItem, isActive && s.drawerChatItemActive]}
                    onPress={() => loadChatSession(item)}
                    onLongPress={() => deleteChatSession(item.chat_id)}
                    delayLongPress={600}
                  >
                    {isActive && <View style={s.drawerActiveBorder} />}
                    <View style={{ flex: 1 }}>
                      <Text style={s.drawerChatPreview} numberOfLines={1}>
                        {item.preview}
                      </Text>
                      <Text style={s.drawerChatTime}>
                        {relativeTime(item.updated_at)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      onPress={() => deleteChatSession(item.chat_id)}
                    >
                      <Ionicons name="trash-outline" size={16} color={AI.sub} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              }}
            />
            </SafeAreaView>
          </Animated.View>
          </SafeAreaProvider>
        </Modal>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: AI.bg },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: AI.headerBg,
  },
  hBtn:   { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 18, fontWeight: '700', color: AI.userText, letterSpacing: 0.3 },

  pillRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    justifyContent: 'center',
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: AI.card, borderWidth: 1.5, borderColor: AI.teal,
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7,
  },
  pillTxt: { fontSize: 13, color: AI.teal, fontWeight: '600' },
  dropdown: {
    position: 'absolute', top: 42, left: 0,
    backgroundColor: AI.card, borderWidth: 1, borderColor: AI.border,
    borderRadius: 12, minWidth: 180, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 8,
  },
  dropItem:      { paddingHorizontal: 16, paddingVertical: 12 },
  dropActive:    { backgroundColor: '#E8F4F4' },
  dropTxt:       { fontSize: 14, color: AI.text },
  dropActiveTxt: { color: AI.teal, fontWeight: '600' },

  rowLeft:  { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14, gap: 8 },
  rowRight: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 14 },
  avatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: AI.teal, alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  bubbleLeft: {
    backgroundColor: AI.card, borderRadius: 18, borderBottomLeftRadius: 4,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: AI.border,
  },
  bubbleRight: {
    backgroundColor: AI.user, borderRadius: 18, borderBottomRightRadius: 4,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  msgText:     { fontSize: 14, color: AI.text,     lineHeight: 21 },
  msgTextUser: { fontSize: 14, color: AI.userText, lineHeight: 21 },

  // In-bubble attachment previews
  bubbleAttachImageLeft:  { width: 200, height: 150, borderRadius: 12, marginBottom: 6, alignSelf: 'flex-start' },
  bubbleAttachImageRight: { width: 200, height: 150, borderRadius: 12, marginBottom: 6, alignSelf: 'flex-end' },
  bubbleFileChipLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: AI.card, borderWidth: 1, borderColor: AI.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 6, alignSelf: 'flex-start', maxWidth: 240,
  },
  bubbleFileChipRight: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: AI.user, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 6, alignSelf: 'flex-end', maxWidth: 240,
  },
  bubbleFileChipTextLeft:  { fontSize: 13, color: AI.text,     flexShrink: 1, fontWeight: '500' },
  bubbleFileChipTextRight: { fontSize: 13, color: AI.userText, flexShrink: 1, fontWeight: '500' },

  // Offline-queue "Will send when online" indicator
  queuedRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, alignSelf: 'flex-end', paddingHorizontal: 4 },
  queuedText: { fontSize: 11, color: AI.sub, fontStyle: 'italic' },

  // Structured card
  structuredCard: {
    backgroundColor: AI.exportCard, borderWidth: 1, borderColor: AI.exportBdr,
    borderRadius: 14, padding: 14, marginTop: 8,
  },
  cardHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  cardType:    { fontSize: 12, color: AI.teal, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 },
  marksBadge:  { backgroundColor: AI.card, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: AI.exportBdr },
  marksBadgeTxt: { fontSize: 11, color: AI.sub },
  cardTitle:   { fontSize: 14, fontWeight: '700', color: AI.text, marginBottom: 6 },
  cardPreview: { fontSize: 12, color: AI.sub, lineHeight: 18 },

  exportRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  exportBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: AI.teal, borderRadius: 10, paddingVertical: 10,
  },
  exportBtnTxt: { fontSize: 13, color: AI.userText, fontWeight: '600' },
  editBtn: {
    borderWidth: 1, borderColor: AI.border, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 14,
  },
  editBtnTxt: { fontSize: 13, color: AI.sub },

  typingRow: { flexDirection: 'row', gap: 5, paddingHorizontal: 2, paddingVertical: 4 },
  dot:       { width: 6, height: 6, borderRadius: 3, backgroundColor: AI.sub },
  slowText:  { marginTop: 6, fontSize: 12, color: AI.sub, fontStyle: 'italic' },

  emptyCont: { flexGrow: 1, padding: 24 },
  emptyHero: { flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%' },
  emptyIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#E8F4F4', borderWidth: 2, borderColor: AI.teal,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: AI.text, marginBottom: 6 },
  emptySub:   { fontSize: 14, color: AI.sub, marginBottom: 24 },
  quickGrid:  { gap: 10, width: '100%' },
  quickPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: AI.card, borderWidth: 1.5, borderColor: AI.teal,
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
  },
  quickTxt: { fontSize: 14, color: AI.teal, fontWeight: '500' },

  inputArea: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: AI.border,
    backgroundColor: AI.card,
    paddingHorizontal: 12, paddingTop: 6, paddingBottom: Platform.OS === 'ios' ? 4 : 12,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: AI.card, borderRadius: 26,
    borderWidth: 1, borderColor: AI.border,
    paddingHorizontal: 4, paddingVertical: 4,
  },
  attachBtn:   { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1, fontSize: 14, color: AI.text,
    paddingHorizontal: 4, paddingVertical: 8, maxHeight: 120,
  },
  sendBtn:      { width: 38, height: 38, borderRadius: 19, backgroundColor: AI.teal, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { backgroundColor: AI.border },
  caption:      { fontSize: 11, color: AI.sub, textAlign: 'center', marginBottom: 6 },
  attachChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: AI.chip, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 6,
    marginBottom: 6, gap: 6,
  },
  attachThumb: { width: 28, height: 28, borderRadius: 4 },
  attachChipText: { flex: 1, fontSize: 12, color: AI.teal },

  // Class picker modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: AI.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 32,
  },
  modalTitle:  { fontSize: 16, fontWeight: '700', color: AI.text, marginBottom: 16 },
  classRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: AI.border,
  },
  classRowName:  { fontSize: 14, fontWeight: '600', color: AI.text },
  classRowLevel: { fontSize: 12, color: AI.sub, marginTop: 2 },
  cancelBtn: { marginTop: 16, alignItems: 'center', paddingVertical: 14 },
  cancelTxt: { fontSize: 14, color: AI.sub },

  // Attach media bottom sheet
  attachSheet: {
    backgroundColor: AI.card,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32,
  },
  attachSheetTitle: {
    fontSize: 13, fontWeight: '600', color: AI.sub,
    textAlign: 'center', marginBottom: 12, letterSpacing: 0.3,
  },
  attachSheetRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 16, gap: 14,
  },
  attachSheetRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AI.border,
  },
  attachSheetLabel: { fontSize: 16, color: AI.text, fontWeight: '500' },

  // Drawer
  drawerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  drawer: {
    position: 'absolute', top: 0, bottom: 0, left: 0,
    width: SCREEN_WIDTH * 0.8,
    // No backgroundColor / shadow here — those live on the inner SafeAreaView
    // so the white panel itself shrinks to fit between the status bar and
    // home indicator. The Animated.View is just a positioning frame.
  },
  drawerSafeInner: {
    flex: 1,
    backgroundColor: AI.card,
    shadowColor: '#000', shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.18, shadowRadius: 12, elevation: 12,
  },
  drawerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AI.border,
  },
  drawerTitle: { fontSize: 17, fontWeight: '700', color: AI.text },
  drawerSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  drawerSectionLabel: {
    fontSize: 11, fontWeight: '700', color: AI.sub,
    letterSpacing: 0.8, paddingHorizontal: 16, paddingBottom: 6,
  },
  newChatBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: AI.teal, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  newChatBtnTxt: { fontSize: 15, fontWeight: '600', color: AI.userText },
  drawerChatItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AI.border,
  },
  drawerChatItemActive: { backgroundColor: AI.chip },
  drawerActiveBorder: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    width: 3, backgroundColor: AI.teal, borderRadius: 2,
  },
  drawerChatPreview: { fontSize: 14, color: AI.text, fontWeight: '500' },
  drawerChatTime:    { fontSize: 12, color: AI.sub, marginTop: 2 },
  drawerEmpty: { fontSize: 13, color: AI.sub, textAlign: 'center', paddingTop: 24 },

  // Toast
  toast: {
    position: 'absolute', bottom: 90, left: 20, right: 20,
    backgroundColor: AI.card, borderWidth: 1, borderColor: AI.exportBdr,
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: AI.teal, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 6, elevation: 6,
  },
  toastTxt: { fontSize: 13, color: AI.text, flex: 1 },
});
