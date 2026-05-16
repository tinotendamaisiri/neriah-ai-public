// src/services/prefetch.ts
// Background warm-up of the read cache, so teachers can use the full
// app offline without first having to navigate to every screen
// while online (the original failure mode was: open homework
// offline → "Failed to load students" because that screen had
// never been opened with internet).
//
// Strategy:
//   1. Once at login (when online).
//   2. Again whenever connectivity flips offline → online.
//   3. Best-effort and concurrent — failures are logged, never thrown
//      to the caller. The UI carries on with whatever cache it has.
//
// What we warm:
//   - listClasses                         (1 call)
//   - listStudents(class)                 (N parallel calls)
//   - listAnswerKeys(class)               (N parallel calls)
//   - getTeacherSubmissions({teacher_id}) (1 call — teacher-wide slot
//     also acts as the offline fallback for class/homework-scoped
//     submission views, see api.ts)
//   - getClassesAnalytics                 (1 call — analytics tab landing)
//   - getClassAnalytics(class)            (N parallel calls — analytics
//     drill-down detail per class)
//
// We don't warm per-mark or per-student-analytics endpoints yet —
// those are O(students × marks), too costly to prefetch
// indiscriminately. Cached on access only.

import {
  listClasses,
  listStudents,
  listAnswerKeys,
  getTeacherSubmissions,
  getMarkById,
  getClassesAnalytics,
  getClassAnalytics,
} from './api';

let inFlight: Promise<void> | null = null;

export function warmOfflineCache(teacherId: string | undefined): Promise<void> {
  // Coalesce — multiple triggers (login + network-up) shouldn't
  // launch overlapping warm-up runs.
  if (inFlight) return inFlight;

  const run = async () => {
    try {
      const classes = await listClasses();

      const perClass = classes.flatMap((c) => [
        listStudents(c.id).catch((e) => {
          console.warn('[prefetch] students failed', c.id, e?.message ?? e);
        }),
        listAnswerKeys(c.id).catch((e) => {
          console.warn('[prefetch] answer-keys failed', c.id, e?.message ?? e);
        }),
        // Warm the per-class analytics detail so the drill-down screen
        // renders offline. Modest payload; one call per class.
        getClassAnalytics(c.id).catch((e) => {
          console.warn('[prefetch] class-analytics failed', c.id, e?.message ?? e);
        }),
      ]);

      // Top-level analytics list (Analytics tab landing). Without this
      // the tab shows the "Check your internet, Retry" view on first
      // open offline because withCache has no cache to fall back to.
      const analyticsTop = getClassesAnalytics().catch((e) => {
        console.warn('[prefetch] classes-analytics failed', e?.message ?? e);
      });

      // Teacher-wide submissions slot — broadest, used as the offline
      // fallback for narrower views. We need its result to drive the
      // per-mark prefetch below, so await it inline rather than letting
      // it fan out alongside the per-class calls.
      let submissions: Awaited<ReturnType<typeof getTeacherSubmissions>> = [];
      if (teacherId) {
        try {
          submissions = await getTeacherSubmissions({ teacher_id: teacherId });
        } catch (e: any) {
          console.warn('[prefetch] submissions failed', e?.message ?? e);
        }
      }

      // Fan out the per-class students/answer-keys calls in parallel
      // with the per-mark detail prefetch. Per-mark is gated on having
      // a non-empty submissions list above; without it we skip and
      // let GradingDetailScreen's own cache fill on first open.
      const perMark = submissions
        .filter((s) => !!s.mark_id)
        .map((s) =>
          getMarkById(s.mark_id).catch((e) => {
            console.warn('[prefetch] mark failed', s.mark_id, e?.message ?? e);
          }),
        );

      await Promise.all([...perClass, ...perMark, analyticsTop]);
    } catch (err: unknown) {
      // Top-level (listClasses) failed — usually means we went offline
      // mid-warm-up. Whatever made it into cache before this point is
      // already useful; nothing else to do.
      const msg = err && typeof err === 'object' && 'message' in err ? (err as { message: string }).message : String(err);
      console.warn('[prefetch] cache warm-up aborted:', msg);
    } finally {
      inFlight = null;
    }
  };

  inFlight = run();
  return inFlight;
}
