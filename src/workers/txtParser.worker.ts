/// <reference lib="webworker" />
import { parseTxt, type TxtEncoding, type TxtSplitMode } from '../services/txtParser';

self.onmessage = (event: MessageEvent<{ id: number; buffer: ArrayBuffer; encoding: TxtEncoding; splitMode: TxtSplitMode }>) => {
  try {
    const result = parseTxt(event.data.buffer, event.data.encoding, event.data.splitMode);
    self.postMessage({ id: event.data.id, result });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
