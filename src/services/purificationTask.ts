import type { PurificationResult, PurificationRule } from './textPurification';
import { PURIFICATION_TIMEOUT_MS } from './textPurification';

const active = new Map<Worker, () => void>();
let nextId = 0;

export function purifyInWorker(text: string, rules: PurificationRule[]): Promise<PurificationResult> {
  const snapshot = rules.map((rule) => ({ ...rule }));
  if (!snapshot.some((rule) => rule.enabled)) return Promise.resolve({ text, counts: {} });
  if (typeof Worker === 'undefined') return Promise.reject(new Error('当前环境不支持安全的正文净化'));
  const id = ++nextId;
  const worker = new Worker(new URL('../workers/textPurification.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); active.delete(worker); worker.terminate(); };
    const cancel = () => { finish(); reject(new DOMException('已取消', 'AbortError')); };
    active.set(worker, cancel);
    timer = setTimeout(() => { finish(); reject(new Error('净化规则执行超时')); }, PURIFICATION_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ id: number; result?: PurificationResult; error?: string }>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error('净化没有返回结果'));
    };
    worker.onerror = () => { finish(); reject(new Error('正文净化进程启动失败')); };
    worker.postMessage({ id, text, rules: snapshot });
  });
}

export function stopAllPurificationTasks() {
  for (const cancel of [...active.values()]) cancel();
}
