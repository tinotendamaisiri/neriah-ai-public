// src/services/chatOfflineQueue.ts
// AsyncStorage-backed queue for AI chat messages (student tutor + teacher
// assistant) that were composed while offline.
//
// Mental model — same as WhatsApp:
//   1. User sends a message with an attachment while offline.
//   2. The user bubble appears immediately with a "Will send when online"
//      indicator. The request payload is persisted in this queue.
//   3. When the device reconnects, replayQueue() walks the queue, fires
//      each request, and on success calls back into the screen so the AI
//      reply can be appended to the matching chat.
//   4. On success → remove from queue. On a 4xx that signals a permanent
//      problem (rate limit, daily cap, eligibility) → also drop. Other
//      failures bump retry_count; after 5 attempts we drop too rather
//      than retrying forever.
//
// The queue is a single AsyncStorage slot containing a JSON array. Two
// `kind`s are supported: 'tutor' for /api/tutor/chat and
// 'teacher_assistant' for /api/teacher/assistant. Each screen calls
// replayQueue with its own kind and a `send` callback that knows how to
// fire the request and append the AI reply on success.

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

const KEY = 'neriah_chat_offline_queue_v1';
const MAX_RETRIES = 5;

export type ChatQueueKind = 'tutor' | 'teacher_assistant';

export interface QueuedChatRequest {
  id:           string;
  kind:         ChatQueueKind;
  /** ISO timestamp when this was queued. */
  queued_at:    string;
  /** Conversation/session id this message belongs to. Used by the screen
   *  to append the AI reply to the right chat. */
  chat_id:      string;
  /** The user message id we already rendered in the chat. Used by the
   *  screen to clear the "queued" indicator and attach the AI reply. */
  user_msg_id:  string;
  /** API payload, sent verbatim when replayed. */
  payload:      Record<string, unknown>;
  retry_count:  number;
}

// ── Storage primitives ────────────────────────────────────────────────────────

async function readQueue(): Promise<QueuedChatRequest[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedChatRequest[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedChatRequest[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(queue));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enqueueChatRequest(
  item: Omit<QueuedChatRequest, 'id' | 'queued_at' | 'retry_count'>,
): Promise<string> {
  const queue = await readQueue();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  queue.push({
    ...item,
    id,
    queued_at:   new Date().toISOString(),
    retry_count: 0,
  });
  await writeQueue(queue);
  return id;
}

export async function getChatQueue(kind?: ChatQueueKind): Promise<QueuedChatRequest[]> {
  const all = await readQueue();
  return kind ? all.filter(q => q.kind === kind) : all;
}

export async function getQueuedIdsForChat(
  kind: ChatQueueKind,
  chatId: string,
): Promise<Set<string>> {
  const queue = await getChatQueue(kind);
  return new Set(queue.filter(q => q.chat_id === chatId).map(q => q.user_msg_id));
}

export async function removeFromChatQueue(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter(q => q.id !== id));
}

async function bumpRetry(id: string): Promise<number> {
  const queue = await readQueue();
  const idx = queue.findIndex(q => q.id === id);
  if (idx < 0) return Infinity;
  queue[idx].retry_count += 1;
  await writeQueue(queue);
  return queue[idx].retry_count;
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Result returned by the caller-supplied `send` callback. `permanent: true`
 * tells the queue to drop the item rather than retrying — used for 4xx
 * responses where retrying is futile (e.g. daily limit, blocked input).
 */
export type ChatReplayResult =
  | { ok: true;  response: unknown }
  | { ok: false; permanent?: boolean; error?: unknown };

export type ChatReplaySender = (item: QueuedChatRequest) => Promise<ChatReplayResult>;

/**
 * Walk the queue and replay everything matching `kind`. Skips when the
 * device is offline. Items that exceed MAX_RETRIES are dropped. Returns a
 * count of successes / failures for telemetry.
 */
export async function replayChatQueue(
  kind: ChatQueueKind,
  send: ChatReplaySender,
): Promise<{ replayed: number; dropped: number; deferred: number }> {
  const net = await NetInfo.fetch();
  const online =
    (net.isConnected ?? false) && (net.isInternetReachable !== false);
  if (!online) {
    return { replayed: 0, dropped: 0, deferred: 0 };
  }

  // Snapshot now so concurrent enqueues during replay don't get processed
  // mid-walk; they'll be picked up on the next replay tick instead.
  const all = await readQueue();
  const matching = all.filter(q => q.kind === kind);

  let replayed = 0;
  let dropped  = 0;
  let deferred = 0;

  for (const item of matching) {
    try {
      const result = await send(item);
      if (result.ok) {
        await removeFromChatQueue(item.id);
        replayed++;
      } else if (result.permanent) {
        await removeFromChatQueue(item.id);
        dropped++;
      } else {
        const newCount = await bumpRetry(item.id);
        if (newCount >= MAX_RETRIES) {
          await removeFromChatQueue(item.id);
          dropped++;
        } else {
          deferred++;
        }
      }
    } catch {
      const newCount = await bumpRetry(item.id);
      if (newCount >= MAX_RETRIES) {
        await removeFromChatQueue(item.id);
        dropped++;
      } else {
        deferred++;
      }
    }
  }

  return { replayed, dropped, deferred };
}

/**
 * Subscribe to network reconnects and call `onReconnect` whenever the
 * device transitions to online. Returns an unsubscribe function. Useful
 * for the screen to fire replayChatQueue on reconnect.
 */
export function onNetworkRestore(onReconnect: () => void): () => void {
  let wasOnline =
    // Best-effort initial state; the listener will give us a fresh value.
    true;
  NetInfo.fetch().then(state => {
    wasOnline = (state.isConnected ?? false) && (state.isInternetReachable !== false);
  });
  return NetInfo.addEventListener(state => {
    const online = (state.isConnected ?? false) && (state.isInternetReachable !== false);
    if (online && !wasOnline) {
      onReconnect();
    }
    wasOnline = online;
  });
}
