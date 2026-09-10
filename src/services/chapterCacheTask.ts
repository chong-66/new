import type { Book, BookSource, Chapter } from '../types';
import { getContent } from '../engine/source';
import { readCachedChapter, waitForChapterCacheWrites, writeCachedChapter } from './chapterCache';

export type ChapterCacheTaskStatus = 'running' | 'completed' | 'cancelled' | 'error';
export interface ChapterCacheProgress {
  status: ChapterCacheTaskStatus;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  failed: number;
  currentTitle: string;
  message: string;
  cachedUrl?: string;
}

export interface ChapterCacheTaskOptions {
  book: Book;
  source: BookSource;
  chapters: Chapter[];
  start: number;
  count: number;
  persistToc: () => Promise<void>;
  onProgress?: (progress: ChapterCacheProgress) => void;
  delayMs?: number;
}

export interface ChapterCacheTask {
  cancel: () => void;
  done: Promise<ChapterCacheProgress>;
}

const activeTasks = new Set<ChapterCacheTask>();

function copyProgress(value: ChapterCacheProgress): ChapterCacheProgress { return { ...value }; }
function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function startChapterCacheTask(options: ChapterCacheTaskOptions): ChapterCacheTask {
  if (!Number.isInteger(options.count) || options.count <= 0) throw new Error('缓存章数必须是正整数');
  if (!options.chapters.length || options.start < 0 || options.start >= options.chapters.length) throw new Error('缓存范围无效');
  const controller = new AbortController();
  const book = snapshot(options.book);
  const source = snapshot(options.source);
  const chapters = snapshot(options.chapters.slice(options.start, options.start + options.count));
  const progress: ChapterCacheProgress = {
    status: 'running', total: chapters.length, processed: 0, saved: 0,
    skipped: 0, failed: 0, currentTitle: '', message: '',
  };
  const report = (cachedUrl?: string) => options.onProgress?.(copyProgress({ ...progress, cachedUrl }));
  const task = {} as ChapterCacheTask;
  task.cancel = () => controller.abort(new DOMException('已停止', 'AbortError'));
  task.done = (async () => {
    try {
      await options.persistToc();
      let consecutiveFailures = 0;
      for (let i = 0; i < chapters.length; i++) {
        controller.signal.throwIfAborted();
        const chapter = chapters[i];
        progress.currentTitle = chapter.title;
        report();
        if (await readCachedChapter(book, source, chapter.url)) {
          progress.skipped++;
          progress.processed++;
          consecutiveFailures = 0;
          report(chapter.url);
          continue;
        }
        try {
          const content = await getContent(source, chapter.url, book, { signal: controller.signal });
          controller.signal.throwIfAborted();
          try { await writeCachedChapter(book, source, chapter, content); }
          catch (error) { throw new Error(`正文保存失败：${error instanceof Error ? error.message : String(error)}`); }
          progress.saved++;
          progress.processed++;
          consecutiveFailures = 0;
          report(chapter.url);
          if (i < chapters.length - 1) await abortableDelay(options.delayMs ?? 300, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('正文保存失败')) throw error;
          progress.failed++;
          progress.processed++;
          progress.message = message;
          consecutiveFailures++;
          report();
          if (/HTTP\s+(403|429)\b/.test(message) || consecutiveFailures >= 3) {
            throw new Error(/HTTP\s+(403|429)\b/.test(message) ? `服务器拒绝批量请求：${message}` : `连续 3 章缓存失败：${message}`);
          }
        }
      }
      progress.status = 'completed';
      progress.currentTitle = '';
      progress.message = progress.failed ? `缓存完成，${progress.failed} 章失败` : '缓存完成';
    } catch (error) {
      progress.currentTitle = '';
      if (controller.signal.aborted) {
        progress.status = 'cancelled';
        progress.message = '缓存已停止，已保存章节会保留';
      } else {
        progress.status = 'error';
        progress.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      report();
    }
    return copyProgress(progress);
  })();
  activeTasks.add(task);
  task.done.finally(() => activeTasks.delete(task)).catch(() => {});
  return task;
}

export async function stopAllChapterCacheTasks(): Promise<void> {
  const tasks = [...activeTasks];
  tasks.forEach((task) => task.cancel());
  await Promise.allSettled(tasks.map((task) => task.done));
  await waitForChapterCacheWrites();
}
