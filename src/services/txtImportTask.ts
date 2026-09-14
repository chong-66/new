import type { ParsedTxt, TxtEncoding, TxtSplitMode } from './txtParser';

let activeWorker: Worker | undefined;
let requestId = 0;
let activeCancel: (() => void) | undefined;

export function parseTxtInWorker(buffer: ArrayBuffer, encoding: TxtEncoding, splitMode: TxtSplitMode) {
  const id = ++requestId;
  let rejectTask: (reason?: unknown) => void = () => {};
  const worker = new Worker(new URL('../workers/txtParser.worker.ts', import.meta.url), { type: 'module' });
  activeCancel?.();
  activeWorker = worker;
  const promise = new Promise<ParsedTxt>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<{ id: number; result?: ParsedTxt; error?: string }>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (activeWorker === worker) activeWorker = undefined;
      if (activeCancel === cancel) activeCancel = undefined;
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error('TXT 解析没有返回结果'));
    };
    worker.onerror = () => {
      worker.terminate();
      if (activeWorker === worker) activeWorker = undefined;
      if (activeCancel === cancel) activeCancel = undefined;
      reject(new Error('TXT 解析进程启动失败'));
    };
    worker.postMessage({ id, buffer, encoding, splitMode }, [buffer]);
  });
  const cancel = () => {
    if (activeWorker === worker) activeWorker = undefined;
    if (activeCancel === cancel) activeCancel = undefined;
    worker.terminate();
    rejectTask(new DOMException('已取消', 'AbortError'));
  };
  activeCancel = cancel;
  return { promise, cancel };
}

export function stopTxtImportTask() {
  requestId++;
  activeCancel?.();
  activeWorker = undefined;
}
