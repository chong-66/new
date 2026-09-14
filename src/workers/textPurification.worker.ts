/// <reference lib="webworker" />
import { applyPurificationRules, type PurificationRule } from '../services/textPurification';

self.onmessage = (event: MessageEvent<{ id: number; text: string; rules: PurificationRule[] }>) => {
  try {
    self.postMessage({ id: event.data.id, result: applyPurificationRules(event.data.text, event.data.rules) });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
