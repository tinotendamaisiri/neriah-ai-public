// src/services/playLessonCache.ts
//
// Lightweight per-lesson cache for cloud-built Play lessons. Whenever a
// cloud lesson is fetched (PlayLibrary list, PlayPreview, PlayGame), we
// write its full body here so the same lesson can be played later
// while offline. Without this, any lesson the student created on Wi-Fi
// would be unreachable the moment connectivity drops — even though the
// list view still shows it via the cached library response.
//
// This is read-through only. The cache is best-effort; cloud is always
// the source of truth when reachable.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PlayLesson } from '../play/types';

const KEY_PREFIX = 'neriah_play_cloud_cache_v1_';

export async function cacheCloudLesson(lesson: PlayLesson): Promise<void> {
  try {
    if (!lesson?.id) return;
    await AsyncStorage.setItem(
      `${KEY_PREFIX}${lesson.id}`,
      JSON.stringify({ at: new Date().toISOString(), lesson }),
    );
  } catch {
    // Cache write is best-effort — never break the read path.
  }
}

export async function getCachedCloudLesson(id: string): Promise<PlayLesson | null> {
  try {
    if (!id) return null;
    const raw = await AsyncStorage.getItem(`${KEY_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lesson?: PlayLesson };
    return parsed?.lesson ?? null;
  } catch {
    return null;
  }
}

export async function dropCachedCloudLesson(id: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${KEY_PREFIX}${id}`);
  } catch {
    /* ignore */
  }
}
