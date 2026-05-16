// src/screens/StudentTutorScreen.tsx
// AI Tutor for students — mirrors TeacherAssistantScreen UI.
// Socratic method: guides students toward answers, never gives them directly.
//
// Features:
//   - Hamburger drawer with session history (identical to Teacher AI)
//   - New chat / load session / delete session
//   - Subject + level pills (read-only, from student's class)
//   - Quick action buttons on empty state
//   - Camera + gallery + PDF attach via sheet
//   - Animated 3-dot typing indicator
//   - Daily usage counter (50/day)
//   - Greeting message on first open (weak-area personalised)

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
import {
  SafeAreaView,
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import {
  getMyWeaknesses,
  sendTutorMessage,
  StudentSelfAnalytics,
  TutorChatMessage,
} from '../services/api';
import { readCacheOnly } from '../services/readCache';
import {
  documentToOnDeviceReply,
  imageToOnDeviceReply,
  resolveRoute,
  showUnavailableAlert,
  tutorOnDevice,
  tutorOnDeviceWithImage,
} from '../services/router';
import {
  enqueueChatRequest,
  getQueuedIdsForChat,
  onNetworkRestore,
  replayChatQueue,
  type ChatReplaySender,
} from '../services/chatOfflineQueue';
import { detectCountryFromPhone } from '../utils/country';
import InAppCamera from '../components/InAppCamera';
import AvatarWithStatus from '../components/AvatarWithStatus';
import { COLORS } from '../constants/colors';

// ── Palette (matches Teacher AI exactly) ──────────────────────────────────────

const AI = {
  bg:       '#FAFAFA',
  card:     '#FFFFFF',
  user:     '#0D7377',
  userText: '#FFFFFF',
  border:   '#E8E8E8',
  text:     '#2C2C2A',
  sub:      '#6B7280',
  chip:     '#E8F4F4',
  chipText: '#0D7377',
  teal:     '#0D7377',
  headerBg: '#0D7377',
} as const;

// ── Quick actions (student-specific) ──────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: 'Explain this concept',      icon: 'bulb-outline' },
  { label: 'Help me practice',          icon: 'barbell-outline' },
  { label: "I don't understand this",   icon: 'help-circle-outline' },
  { label: 'Quiz me on this topic',     icon: 'checkbox-outline' },
  { label: 'What are my weak areas?',   icon: 'analytics-outline' },
  { label: 'Help me prepare for exams', icon: 'school-outline' },
] as const;

// ── Constants ─────────────────────────────────────────────────────────────────

const DAILY_LIMIT  = 50;
const MAX_HISTORY  = 10;
const MAX_SESSIONS = 50;
const MAX_DISPLAY  = 20;
const SCREEN_WIDTH = Dimensions.get('window').width;

const sessionsKey = (id: string) => `student_tutor_sessions_${id}`;
const usageKey    = (id: string) => `tutor_usage_${id}_${new Date().toISOString().slice(0, 10)}`;
const makeId      = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Strip basic markdown the model leaks into chat bubbles. RN Text doesn't
// parse markdown so users see literal '**' chars. Same helper as the
// teacher Assistant — keep them in sync if either changes.
function stripMarkdown(text: string): string {
  if (!text) return text;
  return text
    // fenced code block: ```json ... ``` (or any lang). Strip the fence
    // markers but keep the content — never show literal ```...``` to users.
    .replace(/```[a-zA-Z]*\s*\n?/g, '')
    .replace(/\n?```\s*/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\*\s+/gm, '• ');
}

// ── Weakness query helpers ────────────────────────────────────────────────────

const WEAKNESS_QUICK_LABEL = 'What are my weak areas?';
const WEAKNESS_QUERY_PATTERNS = [
  'weak area',
  'weak spot',
  'what am i bad at',
  'what am i struggling',
  'what do i need to work on',
  'where do i need help',
  'where am i weak',
  'my weaknesses',
  'my weak points',
  'what should i practice',
  'what should i study',
  'what topics should i',
];

function isWeaknessQuery(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return WEAKNESS_QUERY_PATTERNS.some(p => lower.includes(p));
}

/**
 * Build a deterministic offline weakness report from cached analytics data.
 * Used when the device is offline and the cloud tutor is unreachable, so the
 * student still gets their data. Mirrors the cloud "weakness report mode"
 * prompt instructions so the tone matches.
 */
function buildOfflineWeaknessReport(
  data: StudentSelfAnalytics | null,
  firstName: string,
): string {
  if (!data || !data.has_data || !data.weaknesses_aggregated?.length) {
    return (
      `Hi ${firstName}! I don't have enough graded work yet to show you specific ` +
      `weak areas — I need at least 2 graded attempts on a topic to spot a pattern. ` +
      `Once your teacher grades a few more submissions, I'll be able to point them ` +
      `out. In the meantime, what subject would you like to practice?`
    );
  }
  const top = data.weaknesses_aggregated.slice(0, 5);
  const lines = top.map(
    w => `- ${w.topic}: ${w.accuracy_pct}% accuracy (${w.correct}/${w.attempts} correct)`,
  );
  const weakest = top[0];
  return (
    `Hi ${firstName}! Here are the topics where you've struggled the most so far:\n\n` +
    lines.join('\n') +
    `\n\nWant to practice ${weakest.topic}? I can quiz you and walk you through it step by step.`
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hrs  = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24)  return `${hrs}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id:        string;
  role:      'user' | 'assistant';
  content:   string;
  timestamp: string;
  imageUri?: string;
  attachment?: { media_type: string; name: string };
  /** Set on user messages whose request is currently sitting in the
   *  offline queue waiting for connectivity. Cleared by replay logic. */
  queued?:   boolean;
  /** Optional reason shown next to the queued indicator. Helps the user
   *  understand why a message couldn't be answered locally. */
  queuedReason?: string;
}

interface ChatSession {
  chat_id:    string;
  created_at: string;
  updated_at: string;
  preview:    string;
  messages:   ChatMessage[];
}

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 150),
        Animated.timing(dot, { toValue: -6, duration: 300, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0,  duration: 300, useNativeDriver: true }),
        Animated.delay(600 - i * 150),
      ])),
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ alignSelf: 'flex-start', marginLeft: 38, backgroundColor: AI.card, borderRadius: 16, borderWidth: 1, borderColor: AI.border, padding: 12, flexDirection: 'row', gap: 5, alignItems: 'center' }}>
      {dots.map((dot, i) => (
        <Animated.View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: AI.sub, transform: [{ translateY: dot }] }} />
      ))}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function StudentTutorScreen() {
  const { user } = useAuth();
  const navigation = useNavigation();
  const studentId = user?.id ?? 'demo';
  const firstName = user?.first_name ?? 'there';

  // Chat state
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState('');
  const [typing, setTyping]               = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);

  // Session drawer
  const [showDrawer, setShowDrawer]       = useState(false);
  const [chatHistory, setChatHistory]     = useState<ChatSession[]>([]);
  const drawerAnim = useRef(new Animated.Value(-SCREEN_WIDTH * 0.8)).current;

  // Attachment
  const [attachment, setAttachment]       = useState<{ data: string; type: 'image' | 'pdf' | 'word'; name: string; uri?: string } | null>(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  const [showCamera, setShowCamera]       = useState(false);

  // Usage
  const [usageCount, setUsageCount]       = useState(DAILY_LIMIT);

  // Cached personal weakness data — refreshed on mount, served offline as a
  // fallback when the cloud tutor can't be reached.
  const weaknessRef = useRef<StudentSelfAnalytics | null>(null);

  const flatRef      = useRef<FlatList>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Student's class context (read-only pills)
  const classSubject = (user as any)?.class_subject ?? null;
  const classLevel   = (user as any)?.education_level ?? null;

  // ── Load sessions + usage on mount ──────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(sessionsKey(studentId));
        if (raw) {
          const sessions: ChatSession[] = JSON.parse(raw);
          setChatHistory(sessions);
          // Load most recent session
          if (sessions.length > 0) {
            setMessages(sessions[0].messages);
            setCurrentChatId(sessions[0].chat_id);
          }
        }
      } catch {}
      try {
        const used = await AsyncStorage.getItem(usageKey(studentId));
        setUsageCount(DAILY_LIMIT - (used ? parseInt(used, 10) : 0));
      } catch {}
      // Warm the personal weakness cache. withCache returns cached data even
      // when offline, so this also seeds weaknessRef from a previous session.
      try {
        weaknessRef.current = await getMyWeaknesses();
      } catch {
        // Offline + no cache yet — try cache-only as a last resort.
        try {
          weaknessRef.current = await readCacheOnly<StudentSelfAnalytics>('analytics:me');
        } catch {}
      }
    })();
  }, [studentId]);

  // ── Greeting on first open (no sessions) ────────────────────────────────────

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (messages.length > 0) return;
      setTyping(true);
      try {
        const res = await sendTutorMessage({ message: '', is_greeting: true });
        const msg: ChatMessage = {
          id: makeId(), role: 'assistant', content: stripMarkdown(res.response),
          timestamp: new Date().toISOString(),
        };
        setConversationId(res.conversation_id);
        const chatId = makeId();
        setCurrentChatId(chatId);
        setMessages([msg]);
        saveSession([msg], chatId);
      } catch {
        // Greeting fetch failed — don't fabricate an AI greeting on the
        // user's screen. Leave messages empty so the quick-action empty
        // state takes over.
      } finally {
        setTyping(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Offline queue replay ────────────────────────────────────────────────────
  // Track currentChatId in a ref so the sender callback (captured by
  // useEffect deps) doesn't have to re-create on every chat switch — that
  // would burn CPU when the network is flapping.
  const currentChatIdRef = useRef(currentChatId);
  useEffect(() => { currentChatIdRef.current = currentChatId; }, [currentChatId]);

  const replayQueueOnce = useCallback(async () => {
    const sender: ChatReplaySender = async (item) => {
      try {
        const res = await sendTutorMessage(item.payload as any);
        const aiMsg: ChatMessage = {
          id: makeId(), role: 'assistant',
          content: stripMarkdown(res.response),
          timestamp: new Date().toISOString(),
        };

        // Clear `queued` on the user message + append AI reply, persisted
        // directly to storage so the change survives even if this chat
        // isn't currently rendered.
        try {
          const raw = await AsyncStorage.getItem(sessionsKey(studentId));
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
            await AsyncStorage.setItem(sessionsKey(studentId), JSON.stringify(sessions));
            setChatHistory(sessions);
            // If this chat is open, mirror to React state.
            if (item.chat_id === currentChatIdRef.current) {
              setMessages(updatedMsgs);
            }
          }
        } catch {
          // Storage write failed — replay still succeeded; the AI reply
          // is just lost. Better than retrying forever and triggering
          // the daily rate limit.
        }
        return { ok: true, response: res };
      } catch (err: any) {
        const status = err?.response?.status ?? err?.status;
        // 4xx that we know is permanent — drop the queued item.
        // 408 (timeout) and 429 (rate limit) keep retrying.
        const permanent = typeof status === 'number' &&
          status >= 400 && status < 500 && status !== 408 && status !== 429;
        return { ok: false, permanent, error: err };
      }
    };
    try {
      await replayChatQueue('tutor', sender);
    } catch {
      // Best-effort — never crash the screen over replay.
    }
  }, [studentId]);

  // Replay any stale queue when the screen mounts.
  useEffect(() => { void replayQueueOnce(); }, [replayQueueOnce]);

  // Replay every time the network transitions back to online.
  useEffect(() => onNetworkRestore(() => { void replayQueueOnce(); }), [replayQueueOnce]);

  // ── Session persistence (debounced 500ms) ───────────────────────────────────

  const saveSession = useCallback((msgs: ChatMessage[], chatId: string) => {
    if (msgs.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const raw = await AsyncStorage.getItem(sessionsKey(studentId));
        let sessions: ChatSession[] = raw ? JSON.parse(raw) : [];
        const now = new Date().toISOString();
        const preview = (msgs.find(m => m.role === 'user')?.content ?? 'Chat').slice(0, 60);
        const existing = sessions.find(s => s.chat_id === chatId);
        const session: ChatSession = {
          chat_id: chatId,
          created_at: existing?.created_at ?? now,
          updated_at: now,
          preview,
          messages: msgs,
        };
        sessions = [session, ...sessions.filter(s => s.chat_id !== chatId)];
        if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(0, MAX_SESSIONS);
        await AsyncStorage.setItem(sessionsKey(studentId), JSON.stringify(sessions));
        setChatHistory(sessions);
      } catch {}
    }, 500);
  }, [studentId]);

  // ── Increment usage ─────────────────────────────────────────────────────────

  const incrementUsage = useCallback(async () => {
    const key = usageKey(studentId);
    const current = await AsyncStorage.getItem(key);
    const used = (current ? parseInt(current, 10) : 0) + 1;
    await AsyncStorage.setItem(key, String(used));
    setUsageCount(DAILY_LIMIT - used);
  }, [studentId]);

  // ── Send message ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text && !attachment) return;
    if (usageCount <= 0) return;

    const chatId = currentChatId ?? makeId();
    if (!currentChatId) setCurrentChatId(chatId);

    const userMsg: ChatMessage = {
      id: makeId(), role: 'user', content: text,
      timestamp: new Date().toISOString(),
      imageUri: attachment?.uri,
      attachment: attachment ? { media_type: attachment.type, name: attachment.name } : undefined,
    };

    const history: TutorChatMessage[] = messages.slice(-MAX_HISTORY).map(m => ({
      role: m.role, content: m.content,
    }));

    const nextMsgs = [...messages, userMsg];
    setMessages(nextMsgs);
    setInput('');
    const sentAttachment = attachment;
    setAttachment(null);
    saveSession(nextMsgs, chatId);

    const weaknessQuery = text === WEAKNESS_QUICK_LABEL || isWeaknessQuery(text);

    setTyping(true);
    try {
      // Route to cloud, on-device, or offline-fallback. Mirrors the teacher
      // assistant routing pattern; LiteRT E2B is text-only so attachments
      // can't be analysed when offline.
      const route = await resolveRoute('tutoring');

      if (route === 'on-device') {
        if (sentAttachment) {
          // Offline + attachment: extract text client-side and feed it
          // into the on-device tutor. Works fully offline for:
          //   • Images with readable text (ML Kit OCR)
          //   • DOCX  (jszip + word/document.xml)
          //   • PDFs with embedded text streams (regex on raw bytes,
          //     pako-inflated FlateDecode streams)
          // For each: if extraction yields substantial text we run
          // LiteRT and reply directly; if not, fall back to the queue
          // for cloud replay when reconnected.
          let attachmentReason: string | undefined;
          try {
            const onDeviceHistoryForFile = history.map(m => ({
              role: m.role as 'user' | 'assistant', content: m.content,
            }));
            const tutorContext = {
              education_level: classLevel ?? undefined,
              subject:         classSubject ?? undefined,
              country:         detectCountryFromPhone((user as any)?.phone),
              weakness_topics: weaknessRef.current?.weaknesses_aggregated?.slice(0, 5).map(w => w.topic),
            };
            const runner = (combined: string) => tutorOnDevice(
              onDeviceHistoryForFile,
              combined,
              tutorContext,
            );
            // Vision-capable runner — used when the platform supports
            // multimodal (Android today; iOS once the XCFramework rebuild
            // adds vision ops). When unavailable, imageToOnDeviceReply
            // ignores this and falls back to OCR + the text runner.
            const multimodalRunner = (msg: string, imagePath: string) => tutorOnDeviceWithImage(
              onDeviceHistoryForFile,
              msg,
              imagePath,
              tutorContext,
            );

            let result: Awaited<ReturnType<typeof imageToOnDeviceReply>> | null = null;
            if (sentAttachment.type === 'image' && sentAttachment.uri) {
              result = await imageToOnDeviceReply(sentAttachment.uri, text, runner, multimodalRunner);
            } else if (sentAttachment.type === 'pdf' || sentAttachment.type === 'word') {
              result = await documentToOnDeviceReply(
                sentAttachment.data,
                sentAttachment.type,
                sentAttachment.name,
                text,
                runner,
              );
            }

            if (result && result.kind === 'replied') {
              const aiMsg: ChatMessage = {
                id: makeId(), role: 'assistant',
                content: stripMarkdown(result.reply),
                timestamp: new Date().toISOString(),
              };
              const withAi = [...nextMsgs, aiMsg];
              setMessages(withAi);
              saveSession(withAi, chatId);
              return;
            }
            // Map every non-replied result to a human-readable reason
            // so the user can see why the offline path didn't answer.
            if (result?.kind === 'no_text') {
              attachmentReason = sentAttachment.type === 'image'
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

          // Guaranteed default — proves to the user that the new build
          // is running AND tells us this code path was reached even if
          // none of the result.kind branches matched.
          if (!attachmentReason) attachmentReason = 'fell through to queue';

          // Queue: image with no readable text, PDFs, Word docs, or any
          // case where the on-device path didn't produce a reply.
          await enqueueChatRequest({
            kind:        'tutor',
            chat_id:     chatId,
            user_msg_id: userMsg.id,
            payload: {
              message:           text,
              conversation_id:   conversationId,
              file_data:         sentAttachment.data,
              media_type:        sentAttachment.type,
              history,
              is_weakness_query: weaknessQuery || undefined,
            },
          });
          const queuedMsgs = nextMsgs.map(m =>
            m.id === userMsg.id ? { ...m, queued: true, queuedReason: attachmentReason } : m,
          );
          setMessages(queuedMsgs);
          saveSession(queuedMsgs, chatId);
          return;
        }

        // Offline weakness query: use the cached data path before invoking LiteRT.
        if (weaknessQuery) {
          const cached = weaknessRef.current ??
            (await readCacheOnly<StudentSelfAnalytics>('analytics:me').catch(() => null));
          if (cached) {
            weaknessRef.current = cached;
            const offlineText = buildOfflineWeaknessReport(cached, firstName);
            const offlineMsg: ChatMessage = {
              id: makeId(), role: 'assistant', content: stripMarkdown(offlineText),
              timestamp: new Date().toISOString(),
            };
            const withOffline = [...nextMsgs, offlineMsg];
            setMessages(withOffline);
            saveSession(withOffline, chatId);
            return;
          }
        }

        const onDeviceHistory = history.map(m => ({
          role: m.role as 'user' | 'assistant', content: m.content,
        }));
        const responseText = await tutorOnDevice(
          onDeviceHistory,
          text,
          {
            education_level: classLevel ?? undefined,
            subject:         classSubject ?? undefined,
            country:         detectCountryFromPhone((user as any)?.phone),
            weakness_topics: weaknessRef.current?.weaknesses_aggregated?.slice(0, 5).map(w => w.topic),
          },
        );
        const aiMsg: ChatMessage = {
          id: makeId(), role: 'assistant', content: stripMarkdown(responseText),
          timestamp: new Date().toISOString(),
        };
        const withAi = [...nextMsgs, aiMsg];
        setMessages(withAi);
        saveSession(withAi, chatId);
        return;
      }

      if (route === 'unavailable') {
        showUnavailableAlert();
        return;
      }

      // Cloud path
      const res = await sendTutorMessage({
        message: text,
        conversation_id: conversationId,
        ...(sentAttachment ? {
          file_data:  sentAttachment.data,
          media_type: sentAttachment.type,
        } : {}),
        history,
        is_weakness_query: weaknessQuery || undefined,
      });
      setConversationId(res.conversation_id);
      const aiMsg: ChatMessage = {
        id: makeId(), role: 'assistant', content: stripMarkdown(res.response),
        timestamp: new Date().toISOString(),
      };
      const withAi = [...nextMsgs, aiMsg];
      setMessages(withAi);
      saveSession(withAi, chatId);
      await incrementUsage();
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;

      // Offline weakness-query fallback: if the cloud tutor is unreachable
      // but the student is asking about weak areas, render the cached data
      // directly so they still get an answer. Same pattern as the teacher's
      // class weak topics — surfaced via the analytics cache.
      if (weaknessQuery && (!status || status >= 500 || status === 0)) {
        const cached = weaknessRef.current ??
          (await readCacheOnly<StudentSelfAnalytics>('analytics:me').catch(() => null));
        if (cached) {
          weaknessRef.current = cached;
          const offlineText = buildOfflineWeaknessReport(cached, firstName);
          const offlineMsg: ChatMessage = {
            id: makeId(), role: 'assistant', content: stripMarkdown(offlineText),
            timestamp: new Date().toISOString(),
          };
          const withOffline = [...nextMsgs, offlineMsg];
          setMessages(withOffline);
          saveSession(withOffline, chatId);
          return;
        }
      }

      const errText = status === 429
        ? "You've used all your messages for today. They reset at midnight!"
        : 'Something went wrong. Please try again.';
      const errMsg: ChatMessage = {
        id: makeId(), role: 'assistant', content: stripMarkdown(errText),
        timestamp: new Date().toISOString(),
      };
      const withErr = [...nextMsgs, errMsg];
      setMessages(withErr);
      saveSession(withErr, chatId);
    } finally {
      setTyping(false);
    }
  }, [input, messages, conversationId, usageCount, currentChatId, attachment, saveSession, incrementUsage, firstName, classLevel, classSubject, user]);

  // ── Drawer controls ─────────────────────────────────────────────────────────

  const openDrawer = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(sessionsKey(studentId));
      if (raw) setChatHistory(JSON.parse(raw));
    } catch {}
    setShowDrawer(true);
    Animated.timing(drawerAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start();
  }, [studentId, drawerAnim]);

  const closeDrawer = useCallback(() => {
    Animated.timing(drawerAnim, { toValue: -SCREEN_WIDTH * 0.8, duration: 220, useNativeDriver: true })
      .start(() => setShowDrawer(false));
  }, [drawerAnim]);

  const startNewChat = useCallback(() => {
    if (messages.length > 0 && currentChatId) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveSession(messages, currentChatId);
    }
    setMessages([]);
    setConversationId(undefined);
    setCurrentChatId(null);
    closeDrawer();
  }, [messages, currentChatId, saveSession, closeDrawer]);

  const loadSession = useCallback((session: ChatSession) => {
    setMessages(session.messages);
    setCurrentChatId(session.chat_id);
    setConversationId(undefined);
    closeDrawer();
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 80);
  }, [closeDrawer]);

  const deleteSession = useCallback(async (chatId: string) => {
    try {
      const raw = await AsyncStorage.getItem(sessionsKey(studentId));
      let sessions: ChatSession[] = raw ? JSON.parse(raw) : [];
      sessions = sessions.filter(s => s.chat_id !== chatId);
      await AsyncStorage.setItem(sessionsKey(studentId), JSON.stringify(sessions));
      setChatHistory(sessions);
      if (chatId === currentChatId) { setMessages([]); setCurrentChatId(null); }
    } catch {}
  }, [studentId, currentChatId]);

  // ── Attachment handling ─────────────────────────────────────────────────────

  // Wait for the attach-sheet Modal to finish dismissing before opening a
  // native picker. Without this, iOS silently no-ops because the Modal is
  // still animating out when the picker tries to present.
  const closeSheetAndRun = useCallback((fn: () => void | Promise<void>) => {
    setShowAttachSheet(false);
    setTimeout(() => { void fn(); }, 350);
  }, []);

  const pickGallery = useCallback(() => {
    closeSheetAndRun(async () => {
      try {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            'Photos permission needed',
            'Allow Neriah to read your photos so you can attach images. Open Settings to enable it.',
          );
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          base64: true, quality: 0.85,
        });
        if (!result.canceled && result.assets?.[0]) {
          const a = result.assets[0];
          setAttachment({ data: a.base64!, type: 'image', name: a.fileName ?? 'photo.jpg', uri: a.uri });
        }
      } catch (err: any) {
        Alert.alert('Could not open the gallery', err?.message ?? 'Please try again.');
      }
    });
  }, [closeSheetAndRun]);

  const pickDocument = useCallback((docType: 'pdf' | 'word') => {
    closeSheetAndRun(async () => {
      try {
        const mimeTypes = docType === 'pdf'
          ? ['application/pdf']
          : ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        const result = await DocumentPicker.getDocumentAsync({ type: mimeTypes, copyToCacheDirectory: true });
        if (!result.canceled && result.assets?.[0]) {
          const f = result.assets[0];
          try {
            const b64 = await FileSystem.readAsStringAsync(f.uri, { encoding: FileSystem.EncodingType.Base64 });
            setAttachment({ data: b64, type: docType, name: f.name ?? `Document.${docType}` });
          } catch {
            Alert.alert('Could not read the file', 'Try a different document.');
          }
        }
      } catch (err: any) {
        Alert.alert(
          docType === 'pdf' ? 'Could not open PDF picker' : 'Could not open Word picker',
          err?.message ?? 'Please try again.',
        );
      }
    });
  }, [closeSheetAndRun]);

  const handleCapture = useCallback(async (uri: string) => {
    setShowCamera(false);
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
      setAttachment({ data: base64, type: 'image', name: `photo_${Date.now()}.jpg`, uri });
    } catch (e) {
      console.warn('[StudentTutor] failed to read base64 from camera URI:', e);
    }
  }, []);

  // ── Render message ──────────────────────────────────────────────────────────

  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[s.row, isUser ? s.rowRight : s.rowLeft]}>
        {!isUser && (
          <View style={s.avatar}>
            <Image source={require('../../assets/icon-transparent.png')} style={{ width: 17, height: 17, tintColor: 'white' }} resizeMode="contain" />
          </View>
        )}
        <View style={{ alignItems: isUser ? 'flex-end' : 'flex-start', flex: 1 }}>
          <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAI]}>
            {item.imageUri ? (
              <Image source={{ uri: item.imageUri }} style={s.bubbleImage} />
            ) : item.attachment && item.attachment.media_type !== 'image' ? (
              <View style={isUser ? s.bubbleFileChipRight : s.bubbleFileChipLeft}>
                <Ionicons
                  name={item.attachment.media_type === 'pdf' ? 'document-text-outline' : 'document-outline'}
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
            ) : null}
            {item.content ? <Text style={isUser ? s.bubbleTextUser : s.bubbleTextAI}>{item.content}</Text> : null}
          </View>
          {item.queued && (
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
  }, []);

  // ── Usage color ─────────────────────────────────────────────────────────────

  const usageColor = usageCount <= 0 ? COLORS.error : usageCount < 10 ? '#F5A623' : AI.sub;

  return (
    <View style={s.screen}>
      <StatusBar barStyle="light-content" backgroundColor={AI.headerBg} />
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']} keyboardVerticalOffset={0}>

          {/* ── Header ── */}
          <View style={s.header}>
            <TouchableOpacity style={s.hBtn} onPress={openDrawer}>
              <Ionicons name="menu-outline" size={24} color={AI.userText} />
            </TouchableOpacity>
            <Text style={s.hTitle}>Neriah</Text>
            <AvatarWithStatus
              variant="light"
              initial={firstName[0].toUpperCase()}
              onPress={() => (navigation as any).navigate('StudentSettings')}
            />
          </View>

          {/* ── Context pills (read-only) ── */}
          {(classSubject || classLevel) && (
            <View style={s.pillRow}>
              {classSubject && (
                <View style={s.pill}><Text style={s.pillTxt}>{classSubject}</Text></View>
              )}
              {classLevel && (
                <View style={s.pill}><Text style={s.pillTxt}>{classLevel}</Text></View>
              )}
              <Text style={[s.usageText, { color: usageColor }]}>
                {usageCount} left
              </Text>
            </View>
          )}

          {/* ── Empty state or chat ── */}
          {messages.length === 0 && !typing ? (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={s.emptyCont} keyboardShouldPersistTaps="handled">
              <View style={s.emptyHero}>
                <View style={s.emptyIcon}>
                  <Image source={require('../../assets/icon-transparent.png')} style={{ width: 48, height: 48, tintColor: AI.teal }} resizeMode="contain" />
                </View>
                <Text style={s.emptyTitle}>Neriah</Text>
                <Text style={s.emptySub}>Your AI study assistant</Text>
              </View>
              <View style={s.quickGrid}>
                {QUICK_ACTIONS.map(({ label, icon }) => (
                  <TouchableOpacity key={label} style={s.quickPill} onPress={() => sendMessage(label)}>
                    <Ionicons name={icon as any} size={16} color={AI.teal} style={{ marginRight: 8 }} />
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

          {/* ── Input area ── */}
          <View style={s.inputArea}>
            <Text style={s.caption}>Neriah can make mistakes. Verify important info.</Text>
            {attachment && (
              <View style={s.attachChip}>
                {attachment.type === 'image' && attachment.uri ? (
                  <Image source={{ uri: attachment.uri }} style={s.attachThumb} />
                ) : (
                  <Ionicons
                    name={attachment.type === 'pdf' ? 'document-text-outline' : 'document-outline'}
                    size={16}
                    color={AI.teal}
                  />
                )}
                <Text style={s.attachChipText} numberOfLines={1}>{attachment.name}</Text>
                <TouchableOpacity onPress={() => setAttachment(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color={AI.sub} />
                </TouchableOpacity>
              </View>
            )}
            <View style={s.inputRow}>
              <TouchableOpacity style={s.attachBtn} onPress={() => setShowAttachSheet(true)}>
                <Ionicons name="attach-outline" size={20} color={attachment ? AI.teal : AI.sub} />
              </TouchableOpacity>
              <TextInput
                style={s.input}
                value={input}
                onChangeText={setInput}
                placeholder="Ask Neriah..."
                placeholderTextColor={AI.sub}
                multiline
                maxLength={2000}
                editable={!typing && usageCount > 0}
              />
              <TouchableOpacity
                style={[s.sendBtn, (!input.trim() && !attachment || typing || usageCount <= 0) && s.sendBtnOff]}
                onPress={() => sendMessage()}
                disabled={(!input.trim() && !attachment) || typing || usageCount <= 0}
              >
                {typing
                  ? <ActivityIndicator size="small" color={AI.userText} />
                  : <Ionicons name="arrow-up" size={18} color={AI.userText} />
                }
              </TouchableOpacity>
            </View>
          </View>

      </ScreenContainer>

      {/* ── In-app camera ── */}
      <InAppCamera visible={showCamera} onCapture={handleCapture} onClose={() => setShowCamera(false)} quality={0.85} />

      {/* ── Attach picker sheet ── */}
      <Modal visible={showAttachSheet} transparent animationType="fade" onRequestClose={() => setShowAttachSheet(false)}>
        <TouchableOpacity style={s.sheetBackdrop} activeOpacity={1} onPress={() => setShowAttachSheet(false)}>
          <View style={s.sheetContent}>
            {[
              { icon: 'camera-outline', label: 'Camera', onPress: () => closeSheetAndRun(() => setShowCamera(true)) },
              { icon: 'image-outline', label: 'Gallery', onPress: pickGallery },
              { icon: 'document-text-outline', label: 'PDF', onPress: () => pickDocument('pdf') },
              { icon: 'document-outline', label: 'Word', onPress: () => pickDocument('word') },
            ].map(opt => (
              <TouchableOpacity key={opt.label} style={s.sheetRow} onPress={opt.onPress}>
                <Ionicons name={opt.icon as any} size={22} color={AI.teal} />
                <Text style={s.sheetRowTxt}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[s.sheetRow, { marginTop: 8, borderTopWidth: 1, borderTopColor: AI.border }]} onPress={() => setShowAttachSheet(false)}>
              <Text style={[s.sheetRowTxt, { color: AI.sub }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Chat History Drawer ── */}
      {showDrawer && (
        <Modal visible transparent animationType="none" onRequestClose={closeDrawer}>
          {/* Modal severs the parent SafeAreaProvider on iOS — re-seed it. */}
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <TouchableOpacity style={s.drawerBackdrop} activeOpacity={1} onPress={closeDrawer} />
          <Animated.View style={[s.drawer, { transform: [{ translateX: drawerAnim }] }]}>
            <SafeAreaView style={s.drawerSafeInner} edges={['top', 'bottom']} mode="margin">
            <View style={s.drawerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Image source={require('../../assets/icon-transparent.png')} style={{ width: 26, height: 26, tintColor: AI.teal }} resizeMode="contain" />
                <Text style={s.drawerTitle}>Neriah</Text>
              </View>
              <TouchableOpacity style={s.hBtn} onPress={closeDrawer}>
                <Ionicons name="close-outline" size={24} color={AI.sub} />
              </TouchableOpacity>
            </View>
            <View style={s.drawerSection}>
              <TouchableOpacity style={s.newChatBtn} onPress={startNewChat}>
                <Ionicons name="add-outline" size={20} color={AI.userText} />
                <Text style={s.newChatBtnTxt}>New Chat</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.drawerSectionLabel}>RECENT CHATS</Text>
            <FlatList
              data={chatHistory.slice(0, MAX_DISPLAY)}
              keyExtractor={item => item.chat_id}
              contentContainerStyle={{ paddingBottom: 32 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={<Text style={s.drawerEmpty}>No recent chats</Text>}
              renderItem={({ item }) => {
                const isActive = item.chat_id === currentChatId;
                return (
                  <TouchableOpacity
                    style={[s.drawerItem, isActive && s.drawerItemActive]}
                    onPress={() => loadSession(item)}
                    onLongPress={() => deleteSession(item.chat_id)}
                    delayLongPress={600}
                  >
                    {isActive && <View style={s.drawerActiveBorder} />}
                    <View style={{ flex: 1 }}>
                      <Text style={s.drawerPreview} numberOfLines={1}>{item.preview || 'Chat'}</Text>
                      <Text style={s.drawerTime}>{relativeTime(item.updated_at)}</Text>
                    </View>
                    <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={() => deleteSession(item.chat_id)}>
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

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: AI.headerBg,
  },
  hBtn:   { padding: 6 },
  hTitle: { fontSize: 18, fontWeight: '800', color: AI.userText },
  headerAvatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerAvatarText: { color: AI.userText, fontSize: 16, fontWeight: '700' },

  // Pills
  pillRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 10, paddingHorizontal: 16,
    backgroundColor: AI.card, borderBottomWidth: 1, borderBottomColor: AI.border,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: AI.chip, borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  pillTxt:   { fontSize: 13, fontWeight: '600', color: AI.chipText },
  usageText: { fontSize: 12, fontWeight: '600', marginLeft: 'auto' },

  // Empty state
  emptyCont: { flexGrow: 1, justifyContent: 'space-between', padding: 24 },
  emptyHero: { alignItems: 'center', marginTop: 40 },
  emptyIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#E8F4F4', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: AI.text, marginBottom: 4 },
  emptySub:   { fontSize: 14, color: AI.sub },
  quickGrid:  { gap: 8, paddingBottom: 8 },
  quickPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: AI.card, borderRadius: 12, borderWidth: 1, borderColor: AI.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  quickTxt: { fontSize: 14, color: AI.text, fontWeight: '500' },

  // Messages
  row:      { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 8 },
  rowLeft:  { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  avatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: AI.teal, alignItems: 'center', justifyContent: 'center',
  },
  bubble: { maxWidth: '78%', borderRadius: 16, padding: 12, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  bubbleUser:     { backgroundColor: AI.user, borderBottomRightRadius: 4 },
  bubbleAI:       { backgroundColor: AI.card, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: AI.border },
  bubbleTextUser: { color: AI.userText, fontSize: 15, lineHeight: 21 },
  bubbleTextAI:   { color: AI.text,     fontSize: 15, lineHeight: 21 },
  bubbleImage:    { width: 180, height: 140, borderRadius: 10, marginBottom: 8 },
  queuedRow:      { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingHorizontal: 4 },
  queuedText:     { fontSize: 11, color: AI.sub, fontStyle: 'italic' },
  bubbleFileChipLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#F1F5F9', borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
    alignSelf: 'flex-start', maxWidth: 220,
  },
  bubbleFileChipRight: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
    alignSelf: 'flex-start', maxWidth: 220,
  },
  bubbleFileChipTextLeft:  { fontSize: 13, color: AI.text,     flexShrink: 1, fontWeight: '500' },
  bubbleFileChipTextRight: { fontSize: 13, color: AI.userText, flexShrink: 1, fontWeight: '500' },

  // Input area
  inputArea: { backgroundColor: AI.card, borderTopWidth: 1, borderTopColor: AI.border, paddingBottom: Platform.OS === 'ios' ? 4 : 8 },
  caption:   { fontSize: 11, color: AI.sub, textAlign: 'center', paddingTop: 6, paddingBottom: 4 },
  inputRow:  { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  attachBtn: { padding: 8 },
  input: {
    flex: 1, backgroundColor: '#F1F5F9', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 15, color: AI.text, maxHeight: 100,
  },
  sendBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: AI.teal, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { backgroundColor: '#E5E7EB' },

  // Attach chip
  attachChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginBottom: 6,
    backgroundColor: AI.chip, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6,
  },
  attachThumb:    { width: 28, height: 28, borderRadius: 6 },
  attachChipText: { flex: 1, fontSize: 13, color: AI.text },

  // Attach sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheetContent:  { backgroundColor: AI.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
  sheetRow:      { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  sheetRowTxt:   { fontSize: 16, color: AI.text, fontWeight: '500' },

  // Drawer
  drawerBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  drawer: {
    position: 'absolute', top: 0, bottom: 0, left: 0,
    width: SCREEN_WIDTH * 0.8,
    // Background + shadow live on the inner SafeAreaView so the white panel
    // shrinks to fit between the status bar and home indicator inside Modal.
  },
  drawerSafeInner: {
    flex: 1, backgroundColor: AI.card,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 2, height: 0 },
    elevation: 8,
  },
  drawerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: AI.border,
  },
  drawerTitle: { fontSize: 18, fontWeight: '800', color: AI.text },
  drawerSection: { padding: 16, paddingTop: 12 },
  newChatBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: AI.teal, borderRadius: 10, paddingVertical: 12,
  },
  newChatBtnTxt:    { fontSize: 15, fontWeight: '700', color: AI.userText },
  drawerSectionLabel: { fontSize: 11, fontWeight: '700', color: AI.sub, letterSpacing: 0.5, paddingHorizontal: 16, marginBottom: 8 },
  drawerEmpty:      { fontSize: 13, color: AI.sub, paddingHorizontal: 16, paddingVertical: 20, fontStyle: 'italic' },
  drawerItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  drawerItemActive: { backgroundColor: '#F0FDFA' },
  drawerActiveBorder: { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, backgroundColor: AI.teal, borderRadius: 2 },
  drawerPreview: { fontSize: 14, color: AI.text, fontWeight: '500' },
  drawerTime:    { fontSize: 11, color: AI.sub, marginTop: 2 },
});
