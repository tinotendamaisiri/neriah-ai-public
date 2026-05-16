// src/hooks/useSyncCoordinator.ts
// Single source of truth for "is the app currently syncing offline
// work back to the server?". Used by the avatar component to render
// the animated orange ring + "Syncing…" label.
//
// Why this exists separately from the old NetworkBanner: the banner
// only triggered a replay on offline → online edges. If a teacher
// reopened the app already online with queued items, the queue count
// rendered "Uploading 2 pending scans…" forever because nothing
// kicked off the replay. This hook fixes that — it actively replays
// whenever we're online AND something is pending AND nothing is
// already running.
//
// State machine:
//   isSyncing=false, pending=N, online   → start replay → isSyncing=true
//   isSyncing=true                       → wait for replay to finish
//   replay done                          → re-poll → if pending=0,
//                                          isSyncing=false; if still
//                                          pending (e.g. transient
//                                          failures bumped retry_count
//                                          but kept items in queue),
//                                          loop after a backoff.
//
// Backoff matters because replay can fail repeatedly (server is down,
// items will eventually move to dead-letter). We don't want to spin a
// tight loop hammering the network.

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { getQueueLength, replayQueue } from '../services/offlineQueue';
import {
  getMutationQueueLength,
  replayMutationQueue,
} from '../services/mutationQueue';
import {
  getQueueLength as getStudentSubmissionQueueLength,
  replayQueue as replayStudentSubmissionQueue,
} from '../services/studentSubmissionQueue';

const POLL_MS = 3000;
const RETRY_BACKOFF_MS = 15_000;

// Module-level singletons so multiple useSyncCoordinator() consumers
// (e.g. avatar in the header + status dot rendered elsewhere) share
// one replay run. Without this each consumer would fire its own
// replay and we'd double-submit.
let _replayingGlobal = false;
let _lastFailedAtGlobal = 0;

export interface SyncStatus {
  /** True while replay is in flight. */
  isSyncing: boolean;
  /** Network reachability. */
  isOnline: boolean;
  /** Number of queued items still waiting to be flushed. */
  pending: number;
}

export function useSyncCoordinator(): SyncStatus {
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  // In-flight state lives in module-scoped _replayingGlobal so
  // multiple consumers (avatar + dot + anywhere else) share a
  // single replay run. Per-component isSyncing state is the
  // visual mirror; it flips locally when this hook kicks off /
  // finishes a run.

  // Track connectivity.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => {
      setIsOnline(!!s.isConnected);
    });
    NetInfo.fetch().then((s) => setIsOnline(!!s.isConnected));
    return () => unsub();
  }, []);

  // Poll queue length every POLL_MS.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const [scans, mutations, studentSubs] = await Promise.all([
          getQueueLength(),
          getMutationQueueLength(),
          getStudentSubmissionQueueLength(),
        ]);
        if (alive) setPending(scans + mutations + studentSubs);
      } catch {
        // Best-effort polling — never crash the loop.
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Drive the replay. Re-runs whenever connectivity, pending count, or
  // the in-flight flag changes.
  useEffect(() => {
    if (!isOnline) return;
    if (pending === 0) return;
    if (_replayingGlobal) return;
    if (Date.now() - _lastFailedAtGlobal < RETRY_BACKOFF_MS) return;

    _replayingGlobal = true;
    setIsSyncing(true);
    (async () => {
      try {
        // Run all three queues in parallel — they don't share state.
        // Each one handles its own per-item retry/dead-letter.
        await Promise.all([
          replayQueue(),
          replayMutationQueue(),
          replayStudentSubmissionQueue(),
        ]);
      } catch {
        _lastFailedAtGlobal = Date.now();
      } finally {
        _replayingGlobal = false;
        setIsSyncing(false);
        // Force a fresh poll right after replay so the avatar's
        // "synced" state is visible without waiting up to POLL_MS.
        try {
          const [scans, mutations, studentSubs] = await Promise.all([
            getQueueLength(),
            getMutationQueueLength(),
            getStudentSubmissionQueueLength(),
          ]);
          setPending(scans + mutations + studentSubs);
        } catch {
          // Ignore.
        }
      }
    })();
  }, [isOnline, pending]);

  return { isSyncing, isOnline, pending };
}
