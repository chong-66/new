import { reactive } from 'vue';
import { isTauri } from '../utils/env';

export const storageStatus = reactive({ error: '', recovered: '' });
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
const queues = new Map<string, Promise<void>>();
const failed = new Map<string, string>();

async function readText(name: string): Promise<string | null> {
  if (!isTauri) return localStorage.getItem(`toudu:${name}`);
  const { readTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
  if (!(await exists(name, { baseDir: BaseDirectory.AppData }))) return null;
  return readTextFile(name, { baseDir: BaseDirectory.AppData });
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const text = await readText(name);
    if (text !== null) return JSON.parse(text) as T;
    const backup = await readText(`${name}.bak`);
    if (backup === null) return fallback;
    const data = JSON.parse(backup) as T;
    storageStatus.recovered = `${name} 已从备份恢复`;
    return data;
  } catch {
    try {
      const backup = await readText(`${name}.bak`);
      if (backup !== null) {
        const data = JSON.parse(backup) as T;
        storageStatus.recovered = `${name} 已从备份恢复`;
        return data;
      }
    } catch { /* 保留原文件，显示错误 */ }
    storageStatus.error = `${name} 读取失败，请先备份应用数据目录并检查文件`;
    return fallback;
  }
}

async function writeText(name: string, text: string): Promise<void> {
  if (!isTauri) {
    const old = localStorage.getItem(`toudu:${name}`);
    if (old !== null) {
      let valid = true;
      try { JSON.parse(old); } catch { valid = false; }
      localStorage.setItem(`toudu:${name}.${valid ? 'bak' : 'damaged'}`, old);
    }
    localStorage.setItem(`toudu:${name}`, text);
    return;
  }
  const { writeTextFile, mkdir, rename, copyFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
  const baseDir = BaseDirectory.AppData;
  await mkdir('', { baseDir, recursive: true });
  await writeTextFile(`${name}.tmp`, text, { baseDir });
  const old = await readText(name);
  let valid = false;
  if (old !== null) { try { JSON.parse(old); valid = true; } catch { /* 保留上一次有效备份 */ } }
  if (valid) await copyFile(name, `${name}.bak`, { fromPathBaseDir: baseDir, toPathBaseDir: baseDir });
  else if (old !== null) await copyFile(name, `${name}.damaged`, { fromPathBaseDir: baseDir, toPathBaseDir: baseDir });
  await rename(`${name}.tmp`, name, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
}

/** 同一文件串行写入，避免较早的异步写入覆盖新进度。 */
function enqueue(name: string, text: string): Promise<void> {
  const task = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(() => writeText(name, text));
  queues.set(name, task);
  task.then(() => {
    if (queues.get(name) === task) {
      queues.delete(name);
      failed.delete(name);
      if (!failed.size && storageStatus.error.includes('保存失败')) storageStatus.error = '';
    }
  }, (e) => {
    if (queues.get(name) === task) {
      queues.delete(name);
      failed.set(name, text);
      storageStatus.error = `${name} 保存失败：${e instanceof Error ? e.message : String(e)}`;
    }
  });
  return task;
}

export function writeJson(name: string, data: unknown): Promise<void> {
  const old = pending.get(name);
  if (old) { clearTimeout(old.timer); pending.delete(name); }
  return enqueue(name, JSON.stringify(data));
}

export function writeJsonDebounced(name: string, data: unknown, delay = 500): void {
  const old = pending.get(name);
  if (old) clearTimeout(old.timer);
  const text = JSON.stringify(data);
  pending.set(name, {
    text,
    timer: setTimeout(() => {
      pending.delete(name);
      void enqueue(name, text).catch(() => {});
    }, delay),
  });
}

/** 关闭窗口及手动重试时等待全部写入；失败数据留在内存中供重试。 */
export async function flushStorage(): Promise<void> {
  for (const [name, text] of failed) {
    if (!pending.has(name) && !queues.has(name)) void enqueue(name, text).catch(() => {});
  }
  while (pending.size || queues.size) {
    for (const [name, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(name);
      void enqueue(name, item.text).catch(() => {});
    }
    const results = await Promise.allSettled([...queues.values()]);
    if (results.some((r) => r.status === 'rejected')) throw new Error(storageStatus.error || '保存失败');
  }
  if (failed.size) throw new Error(storageStatus.error || '保存失败');
}
