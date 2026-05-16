// src/services/router.ts
// AI inference router — every AI request (grading, tutoring, scheme generation)
// must pass through here before dispatching to cloud or on-device inference.
//
// Decision logic:
//   isOnline                       → "cloud"       always prefer 26B Gemma when connected
//   !isOnline  AND  modelLoaded    → "on-device"   E4B (teacher) / E2B (student) via LiteRT
//   !isOnline  AND  !modelLoaded   → "unavailable" show "Connect to continue", queue if possible
//
// Web is always "cloud" — short-circuits before any hardware or network check.

import { Platform, Alert } from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import {
  getLiteRTState,
  generateResponse,
  generateResponseWithImage,
  isMultimodalSupported,
  buildGradingPrompt,
  buildTutorPrompt,
  buildAssistantPrompt,
  ModelVariant,
  type OnDeviceUserContext,
  type OcrPageInput,
  type AssistantOnDeviceActionType,
} from './litert';

export type { OnDeviceUserContext };
import { enqueue } from './offlineQueue';
import type { QueuedScan } from './offlineQueue';
import { isOcrAvailable, recognizePages, recognizeTextInImage } from './ocr';
import { extractAttachmentText } from './clientFileExtract';
import { track } from './analytics';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AIRoute = 'cloud' | 'on-device' | 'unavailable';

/** Which kind of AI operation is being requested. */
export type AIRequestType =
  | 'grading'
  | 'tutoring'
  | 'scheme'
  | 'teacher_assistant'
  /** Play lesson generation (Gemma 4 emits MCQ batches from notes/OCR). */
  | 'play_lesson_gen';

/** Message shown when no route is available. */
export const CONNECT_TO_CONTINUE = 'Connect to continue';
export const CONNECT_DETAIL =
  "You're offline and no on-device model is loaded. Connect to use Neriah AI.";

// ── Pure routing decision ─────────────────────────────────────────────────────

/**
 * Pure, side-effect-free routing decision.
 *
 * @param isOnline     Whether the device currently has internet access.
 * @param modelLoaded  Whether the relevant on-device LiteRT model is loaded.
 * @returns            The route to take for this AI request.
 */
export function routeRequest(isOnline: boolean, modelLoaded: boolean): AIRoute {
  // Web has no on-device inference capability — always route to cloud.
  if (Platform.OS === 'web') return 'cloud';

  if (isOnline) return 'cloud';
  if (modelLoaded) return 'on-device';
  return 'unavailable';
}

// ── Model variant mapping ─────────────────────────────────────────────────────

/**
 * Returns the LiteRT model variant needed for a given request type.
 *
 * As of the E4B-removal pass, both teacher and student paths use E2B
 * regardless of request type. Math grading is gated separately in
 * PageReviewScreen — when offline + math, the submission is queued for
 * cloud replay rather than fed to E2B (which can't reliably grade
 * multi-step math).
 *
 * Kept as a function (not a const) so callers can be retrofitted later
 * if we re-introduce per-task model selection.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function modelVariantForRequest(_requestType: AIRequestType): ModelVariant {
  return 'e2b';
}

// ── Async route resolution ────────────────────────────────────────────────────

/**
 * Resolve the current route by reading live connectivity and LiteRT model state.
 * Call this just before dispatching any AI request.
 *
 * @param requestType  Determines which model variant must be loaded for on-device.
 */
export async function resolveRoute(requestType: AIRequestType): Promise<AIRoute> {
  if (Platform.OS === 'web') {
    track('router.decision', { kind: requestType, route: 'cloud', reason: 'web_platform' }, { surface: 'router' });
    return 'cloud';
  }

  const netState = await NetInfo.fetch();
  // isInternetReachable can be null when unknown — treat null as reachable
  const isOnline =
    (netState.isConnected ?? false) &&
    (netState.isInternetReachable !== false);

  const { loadedModel } = getLiteRTState();
  const needed = modelVariantForRequest(requestType);
  const modelLoaded = loadedModel === needed;

  const route = routeRequest(isOnline, modelLoaded);
  // Emit decision with the reason a dashboard would want to see — why
  // we picked this route over the alternatives.
  let reason: string;
  if (route === 'cloud') {
    reason = 'online';
  } else if (route === 'on-device') {
    reason = 'offline_with_model';
  } else {
    reason = isOnline ? 'unknown' : 'offline_no_model';
  }
  track(
    'router.decision',
    { kind: requestType, route, reason, is_online: isOnline, model_loaded: modelLoaded, model_variant: needed },
    { surface: 'router' },
  );
  return route;
}

// ── Unavailable helpers ───────────────────────────────────────────────────────

/**
 * Show the "Connect to continue" alert.
 *
 * @param onQueue  Optional callback called when the user chooses to save the
 *                 request for later (e.g. queue a marking scan). When omitted,
 *                 only an OK button is shown.
 */
export function showUnavailableAlert(onQueue?: () => void): void {
  const buttons: Array<{ text: string; style?: 'cancel' | 'default'; onPress?: () => void }> = [];

  if (onQueue) {
    buttons.push({ text: 'Save for later', onPress: onQueue });
  }
  buttons.push({ text: 'OK', style: 'cancel' });

  Alert.alert(CONNECT_TO_CONTINUE, CONNECT_DETAIL, buttons);
}

/**
 * Queue a marking scan so it is replayed automatically when connectivity
 * is restored. Delegates to offlineQueue.ts.
 */
export async function queueMarkingScan(
  scan: Omit<QueuedScan, 'id' | 'queued_at' | 'retry_count'>,
): Promise<void> {
  await enqueue(scan);
}

// ── On-device execution helpers ───────────────────────────────────────────────

/**
 * Run grading via the on-device E4B LiteRT model against already-OCR'd pages.
 *
 * Callers that have image URIs (not pre-extracted text) should use
 * gradeScanOffline() instead — it runs OCR first, then calls this.
 *
 * User context is serialized and prepended to the prompt because LiteRT has
 * no access to Firestore or the vector DB. The caller is responsible for
 * passing whatever context is available (country, curriculum, subject, level).
 *
 * @param questions      Answer key questions (number, correct_answer, max_marks).
 * @param pages          Per-page OCR text; order + page_index must match the
 *                       original page order so annotations land on the right page.
 * @param educationLevel e.g. "Form 3" — calibrates grading intensity.
 * @param userContext    Profile-derived context (country, curriculum, weak areas…).
 * @returns              Raw JSON string from the model (parse with JSON.parse).
 */
export async function gradeOnDevice(
  questions: Array<{ number: number; correct_answer: string; max_marks: number; marking_notes?: string }>,
  pages: OcrPageInput[],
  educationLevel: string,
  userContext?: OnDeviceUserContext,
): Promise<string> {
  const prompt = buildGradingPrompt(questions, pages, educationLevel, userContext);
  return generateResponse(prompt);
}

// ── Offline verdict shape ────────────────────────────────────────────────────

/**
 * Parsed verdict from the on-device grading call, matching
 * shared/models.py:GradingVerdict + the optional page_index we tag in the
 * prompt for the annotator.
 */
export interface OfflineVerdict {
  question_number: number;
  page_index: number;
  student_answer: string;
  expected_answer: string;
  verdict: 'correct' | 'incorrect' | 'partial';
  awarded_marks: number;
  max_marks: number;
  feedback?: string;
}

/**
 * Apply the same dedup + clamp rules the backend enforces (see
 * functions/mark.py) so an offline-graded mark can never produce a score
 * above the answer key's total — even if the local model hallucinates.
 */
export function dedupeAndClampVerdicts(
  raw: Array<Record<string, unknown>>,
  answerKey: { questions: Array<{ number?: number; question_number?: number; marks?: number }>; total_marks?: number },
): { verdicts: OfflineVerdict[]; score: number; max_score: number; percentage: number } {
  // Build per-question max from the answer key.
  const maxPerQ: Record<number, number> = {};
  for (const q of answerKey.questions ?? []) {
    const qn = q.question_number ?? q.number;
    if (qn != null) maxPerQ[Number(qn)] = Number(q.marks ?? 0) || 0;
  }
  const totalMax = Number(answerKey.total_marks) || Object.values(maxPerQ).reduce((s, n) => s + n, 0) || 1;

  // Dedupe by question_number, keeping highest awarded_marks.
  const deduped: Record<number, OfflineVerdict> = {};
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const qnRaw = (v as Record<string, unknown>).question_number;
    const qn = qnRaw == null ? null : Number(qnRaw);
    if (qn == null || Number.isNaN(qn) || !(qn in maxPerQ)) continue;
    const awarded = Number((v as Record<string, unknown>).awarded_marks ?? 0) || 0;
    const prev = deduped[qn];
    if (prev == null || awarded > prev.awarded_marks) {
      deduped[qn] = {
        question_number: qn,
        page_index: Number((v as Record<string, unknown>).page_index ?? 0) || 0,
        student_answer: String((v as Record<string, unknown>).student_answer ?? ''),
        expected_answer: String((v as Record<string, unknown>).expected_answer ?? ''),
        verdict: (['correct', 'incorrect', 'partial'] as const).includes(
          (v as Record<string, unknown>).verdict as 'correct' | 'incorrect' | 'partial',
        )
          ? ((v as Record<string, unknown>).verdict as OfflineVerdict['verdict'])
          : 'incorrect',
        awarded_marks: awarded,
        max_marks: maxPerQ[qn],
        feedback:
          typeof (v as Record<string, unknown>).feedback === 'string'
            ? ((v as Record<string, unknown>).feedback as string)
            : undefined,
      };
    }
  }

  // Clamp per question and sort.
  const verdicts = Object.values(deduped)
    .map((v) => ({
      ...v,
      awarded_marks: Math.max(0, Math.min(v.awarded_marks, v.max_marks)),
    }))
    .sort((a, b) => a.question_number - b.question_number);

  const score = Math.min(
    verdicts.reduce((s, v) => s + v.awarded_marks, 0),
    totalMax,
  );
  const percentage = totalMax > 0 ? Math.round((score / totalMax) * 1000) / 10 : 0;

  return { verdicts, score, max_score: totalMax, percentage };
}

/**
 * Full offline grading pipeline: OCR each page, send the text to the local
 * E4B model, parse + sanitise the JSON response, apply dedup + clamp rules.
 *
 * Returns the same shape the cloud would (minus image URLs — those are
 * filled in by the local annotator in Phase D).
 *
 * Throws:
 *   - OcrUnavailableError   if MLKit isn't linked
 *   - Error('No model loaded') if the E4B model hasn't been loaded yet
 *   - Error on JSON parse failure
 */
export async function gradeScanOffline(args: {
  pageUris: string[];
  answerKey: {
    questions: Array<{ number?: number; question_number?: number; correct_answer?: string; marks?: number; marking_notes?: string }>;
    total_marks?: number;
  };
  educationLevel: string;
  userContext?: OnDeviceUserContext;
}): Promise<{
  verdicts: OfflineVerdict[];
  score: number;
  max_score: number;
  percentage: number;
  page_texts: string[];
}> {
  // 1. OCR every page in order.
  const ocrPages = await recognizePages(args.pageUris);

  // 2. Shape answer key for the prompt.
  const promptQuestions = (args.answerKey.questions ?? []).map((q) => ({
    number: Number(q.question_number ?? q.number ?? 0),
    correct_answer: String(q.correct_answer ?? ''),
    max_marks: Number(q.marks ?? 0) || 0,
    marking_notes: q.marking_notes,
  }));

  // 3. Local LLM grading call.
  const raw = await gradeOnDevice(
    promptQuestions,
    ocrPages.map((p) => ({ page_index: p.page_index, text: p.text })),
    args.educationLevel,
    args.userContext,
  );

  // 4. Parse JSON — Gemma sometimes wraps the array in ```json fences.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Local model returned non-JSON output: ${(err as Error).message}`);
  }
  const rawVerdicts = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];

  // 5. Dedupe + clamp (same rules as functions/mark.py).
  const { verdicts, score, max_score, percentage } = dedupeAndClampVerdicts(rawVerdicts, args.answerKey);

  return {
    verdicts,
    score,
    max_score,
    percentage,
    page_texts: ocrPages.map((p) => p.text),
  };
}

/**
 * Run a Socratic tutoring turn via the on-device E2B LiteRT model.
 *
 * User context is serialized and prepended to the prompt because LiteRT has
 * no access to Firestore or the vector DB. Pass weakness_topics so the tutor
 * gives extra patience on the student's known problem areas.
 *
 * @param history     Prior conversation turns (last ~3 exchanges are used).
 * @param userMessage The student's current message.
 * @param userContext Profile-derived context (curriculum, subject, weak areas…).
 * @param onToken     Optional streaming callback — called with each partial token.
 * @returns           The tutor's full response text.
 */
export async function tutorOnDevice(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
  userContext?: OnDeviceUserContext,
  onToken?: (partial: string) => void,
): Promise<string> {
  const prompt = buildTutorPrompt(history, userMessage, userContext);
  const raw = await generateResponse(prompt, onToken);
  return cleanLitertReply(raw);
}

/**
 * Run a teaching-assistant turn via the on-device E2B LiteRT model.
 *
 * Mirrors tutorOnDevice but uses the assistant prompt template, which
 * supports four action types: chat, prepare_notes, teaching_methods,
 * exam_questions. The cloud version's data-aware action_type
 * 'class_performance' is intentionally not supported here — class weak
 * topics are surfaced via the analytics cache instead.
 */
export async function assistantOnDevice(
  action: AssistantOnDeviceActionType,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
  userContext?: OnDeviceUserContext,
  onToken?: (partial: string) => void,
): Promise<string> {
  const prompt = buildAssistantPrompt(action, history, userMessage, userContext);
  const raw = await generateResponse(prompt, onToken);
  return cleanLitertReply(raw);
}

// ── Multimodal counterparts (Gemma 4 vision) ─────────────────────────────────
//
// Same prompt builders as text-only, but dispatched via
// generateResponseWithImage so the model attends to the image alongside the
// templated chat. Caller must guard with isMultimodalSupported() — these
// throw on iOS until the XCFramework rebuild lands.

/**
 * Vision-aware tutor turn. Same prompt template as tutorOnDevice; the image
 * is delivered to the model as a parallel input.
 */
export async function tutorOnDeviceWithImage(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
  imagePath: string,
  userContext?: OnDeviceUserContext,
): Promise<string> {
  const prompt = buildTutorPrompt(history, userMessage, userContext);
  const raw = await generateResponseWithImage(prompt, imagePath);
  return cleanLitertReply(raw);
}

/**
 * Vision-aware assistant turn. Same prompt template as assistantOnDevice;
 * the image is delivered to the model as a parallel input.
 */
export async function assistantOnDeviceWithImage(
  action: AssistantOnDeviceActionType,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
  imagePath: string,
  userContext?: OnDeviceUserContext,
): Promise<string> {
  const prompt = buildAssistantPrompt(action, history, userMessage, userContext);
  const raw = await generateResponseWithImage(prompt, imagePath);
  return cleanLitertReply(raw);
}

/**
 * Result of an offline image-to-text flow used by the tutor / assistant
 * screens. `kind: 'replied'` means OCR extracted readable text and LiteRT
 * produced an answer — show it directly. `kind: 'no_text'` means OCR
 * returned nothing useful (object photo, blurry image, decorative meme)
 * — caller should fall back to the offline queue. `kind: 'unavailable'`
 * means the OCR module isn't linked at all (Expo Go) — caller should
 * also fall back to the queue.
 */
export type OfflineImageResult =
  | { kind: 'replied'; reply: string; extractedText: string }
  | { kind: 'no_text' }
  | { kind: 'unavailable' }
  | { kind: 'extraction_error'; error: string }
  | { kind: 'runner_error';     error: string };

/** Minimum OCR'd characters we treat as "this image has readable content".
 *  Below this we fall back to the offline queue rather than feeding the
 *  model a 3-character snippet that produces a hallucinated answer. */
const _OCR_MIN_USEFUL_CHARS = 12;

/**
 * Try to answer an image-attached message fully offline.
 *
 * Strategy:
 *   1. If the loaded model supports multimodal (Gemma 4 vision) AND the
 *      caller supplied a `multimodalRunner`, send the image directly to
 *      the model — no OCR step. This is what handles photos of objects,
 *      scenery, anything without readable text. Android does this today;
 *      iOS will pick it up automatically once our XCFramework rebuild
 *      links the vision ops.
 *   2. Otherwise fall back to OCR + text-only LiteRT: extract text from
 *      the image with ML Kit, fold it into the user's message, dispatch
 *      via the text `runner`. Works for homework page photos and
 *      anything text-bearing.
 *   3. If neither path produces a reply, return one of the non-'replied'
 *      result kinds so the caller can queue for cloud.
 *
 * `runner` is the text-only fallback path (tutorOnDevice / assistantOnDevice).
 * `multimodalRunner` is the vision path (tutorOnDeviceWithImage etc.).
 */
export async function imageToOnDeviceReply(
  imageUri: string,
  userMessage: string,
  runner: (combinedMessage: string) => Promise<string>,
  multimodalRunner?: (msg: string, imagePath: string) => Promise<string>,
): Promise<OfflineImageResult> {
  // ── Vision path — preferred when the model + platform supports it ────────
  if (multimodalRunner && isMultimodalSupported()) {
    try {
      const userText = userMessage?.trim() || 'Describe what you see in this image.';
      const reply = await multimodalRunner(userText, imageUri);
      return { kind: 'replied', reply, extractedText: '' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[router] multimodal LiteRT call failed, falling back to OCR:', msg);
      // Fall through to OCR — gives us a second chance for text-bearing
      // images even if the vision call had a transient error.
    }
  }

  // ── OCR fallback path — used on iOS today, and on Android when the
  //    vision call failed or the caller didn't provide a multimodalRunner.
  if (!isOcrAvailable()) return { kind: 'unavailable' };

  let extracted = '';
  try {
    extracted = await recognizeTextInImage(imageUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[ocr] image OCR threw:', msg);
    return { kind: 'extraction_error', error: msg };
  }

  console.log(`[ocr] image OCR extracted ${extracted.length} chars`);

  if (!extracted || extracted.length < _OCR_MIN_USEFUL_CHARS) {
    return { kind: 'no_text' };
  }

  const capped = extracted.slice(0, 4000);
  const trailing = extracted.length > 4000 ? '\n[...attachment truncated]' : '';

  const combined = userMessage
    ? `${userMessage}\n\n[Text extracted from the attached image]\n${capped}${trailing}`
    : `Please help me with what's in this image.\n\n[Text extracted from the attached image]\n${capped}${trailing}`;

  try {
    const reply = await runner(combined);
    return { kind: 'replied', reply, extractedText: extracted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[router] LiteRT runner failed for image:', msg);
    return { kind: 'runner_error', error: msg };
  }
}

/**
 * Try to answer a PDF/Word-attached message fully offline:
 *   1. Extract text client-side via clientFileExtract.
 *   2. If extraction yields substantial text, fold it into the user
 *      message and call the supplied LiteRT runner.
 *   3. Otherwise return 'no_text' so the caller can queue.
 *
 * Same shape as imageToOnDeviceReply so screens can use one pattern for
 * all attachment types.
 */
export async function documentToOnDeviceReply(
  base64: string,
  mediaType: 'pdf' | 'word',
  fileName: string,
  userMessage: string,
  runner: (combinedMessage: string) => Promise<string>,
): Promise<OfflineImageResult> {
  let extracted = '';
  try {
    extracted = await extractAttachmentText(base64, mediaType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[clientFileExtract] ${mediaType} extraction threw:`, msg);
    return { kind: 'extraction_error', error: msg };
  }

  console.log(`[clientFileExtract] ${mediaType} ${fileName}: extracted ${extracted.length} chars`);

  if (!extracted || extracted.length < _OCR_MIN_USEFUL_CHARS) {
    return { kind: 'no_text' };
  }

  const capped = extracted.slice(0, 4000);
  const trailing = extracted.length > 4000 ? '\n[...attachment truncated]' : '';

  const label = mediaType === 'pdf' ? 'PDF' : 'Word document';
  const combined = userMessage
    ? `${userMessage}\n\n[Text extracted from the attached ${label} "${fileName}"]\n${capped}${trailing}`
    : `Please help me with the attached ${label}.\n\n[Text extracted from "${fileName}"]\n${capped}${trailing}`;

  try {
    const reply = await runner(combined);
    return { kind: 'replied', reply, extractedText: extracted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[router] LiteRT runner failed for ${mediaType}:`, msg);
    return { kind: 'runner_error', error: msg };
  }
}

/**
 * Strip artefacts that LiteRT prompts can leak into the visible reply.
 *
 * The on-device prompts end with a speaker tag (e.g. "Neriah:" or
 * "Teacher: ... \nNeriah:") to anchor the model's continuation. Gemma
 * occasionally echoes the tag back at the start of the reply; users see
 * "Neriah: Hello..." instead of "Hello...". It also sometimes generates
 * a follow-up "Student:" turn that we want to truncate.
 *
 * Conservative: only strip well-known prefixes/suffixes, never modify
 * the model's actual content.
 */
function cleanLitertReply(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // 1. Truncate at the first STOP token. Anything after a closing turn
  //    is a hallucinated next turn that we don't want to show.
  const firstStop = cleaned.search(/<\/?\s*(?:end_of_turn|eos|end)\b/i);
  if (firstStop !== -1) cleaned = cleaned.slice(0, firstStop);

  // 2. GLOBAL strip of every chat-template token, in any of the forms
  //    Gemma can emit when its tokenizer didn't fold them into special
  //    tokens at decode time:
  //      <start_of_turn>     <end_of_turn>
  //      </start_of_turn>    </end_of_turn>
  //      <start_of_turn>user <start_of_turn>model
  //      <bos> <eos>
  //    Match literal angle-bracketed tokens and bare-tag variants, both
  //    case-insensitive. A second pass handles role labels left behind
  //    on their own line ("model\n" / "user\n").
  cleaned = cleaned
    .replace(/<\s*\/?\s*(?:start_of_turn|end_of_turn|bos|eos|sot|eot)(?:\s+[a-z]+)?\s*>/gi, '')
    .replace(/<\s*\/?\s*(?:start_of_turn|end_of_turn|bos|eos|sot|eot)\b/gi, '')
    .replace(/(?:^|\n)\s*(?:model|user|assistant)\s*\n/gi, '\n');

  // 3. Strip leading speaker tags Gemma sometimes echoes ("Neriah:", "Tutor:").
  cleaned = cleaned.replace(/^\s*(?:neriah|tutor|assistant|model)\s*:\s*/i, '');

  // 4. Defensive: if a free-form "Student:" / "Teacher:" prefix slips in
  //    from old-format history, cut at the first one.
  const turnMatch = cleaned.match(/\n\s*(?:student|teacher|user)\s*:/i);
  if (turnMatch && turnMatch.index !== undefined) {
    cleaned = cleaned.slice(0, turnMatch.index);
  }

  return cleaned.trim();
}

// ── React hook ────────────────────────────────────────────────────────────────

/**
 * Reactive hook that exposes the current routing state.
 *
 * ```tsx
 * const { getRoute } = useAIRouter();
 * const route = getRoute('grading'); // 'cloud' | 'on-device' | 'unavailable'
 * ```
 *
 * Re-renders when network connectivity changes. LiteRT model state is read
 * once on mount (model loads are infrequent and driven by explicit user action).
 */
export function useAIRouter() {
  const [isOnline, setIsOnline] = useState(true);
  const [loadedModel, setLoadedModel] = useState<ModelVariant | null>(null);

  useEffect(() => {
    // Read initial connectivity
    NetInfo.fetch().then((state) => {
      setIsOnline(
        (state.isConnected ?? true) && (state.isInternetReachable !== false),
      );
    });

    // Subscribe to connectivity changes
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      setIsOnline(
        (state.isConnected ?? true) && (state.isInternetReachable !== false),
      );
    });

    // Read LiteRT model state (updates when model is loaded/unloaded)
    const { loadedModel: lm } = getLiteRTState();
    setLoadedModel(lm);

    return unsubscribe;
  }, []);

  /**
   * Return the current routing decision for a given request type.
   * Synchronous — reads from React state, no I/O.
   */
  const getRoute = useCallback(
    (requestType: AIRequestType): AIRoute => {
      const needed = modelVariantForRequest(requestType);
      return routeRequest(isOnline, loadedModel === needed);
    },
    [isOnline, loadedModel],
  );

  return { isOnline, loadedModel, getRoute };
}
