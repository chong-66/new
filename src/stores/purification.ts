import { defineStore } from 'pinia';
import { readJson, storageStatus, writeJson } from '../services/storage';
import {
  MAX_FIND_LENGTH, MAX_PURIFICATION_RULES, MAX_REPLACEMENT_LENGTH,
  type PurificationRule,
} from '../services/textPurification';

interface StoredPurification {
  schemaVersion: 1;
  enabled: boolean;
  rules: PurificationRule[];
}

function validRule(value: unknown): value is PurificationRule {
  const r = value as Partial<PurificationRule> | null;
  return !!r && typeof r.id === 'string' && typeof r.name === 'string' &&
    typeof r.enabled === 'boolean' && (r.mode === 'text' || r.mode === 'regex') &&
    typeof r.find === 'string' && typeof r.replacement === 'string' &&
    typeof r.ignoreCase === 'boolean' && typeof r.multiline === 'boolean' && typeof r.dotAll === 'boolean' &&
    r.find.length > 0 && r.find.length <= MAX_FIND_LENGTH && r.replacement.length <= MAX_REPLACEMENT_LENGTH;
}

export const usePurificationStore = defineStore('purification', {
  state: () => ({
    enabled: false,
    rules: [] as PurificationRule[],
    loaded: false,
    revision: 0,
    previewText: '',
    previewLabel: '',
  }),
  actions: {
    async load() {
      const raw = await readJson<Partial<StoredPurification>>('purification-rules.json', {});
      const seen = new Set<string>();
      const candidates = Array.isArray(raw.rules) ? raw.rules : [];
      const rules = candidates.filter((rule) => {
        if (!validRule(rule) || seen.has(rule.id)) return false;
        seen.add(rule.id);
        return true;
      }).slice(0, MAX_PURIFICATION_RULES);
      if (raw.schemaVersion !== undefined && (raw.schemaVersion !== 1 || candidates.length !== rules.length)) {
        storageStatus.recovered = '正文净化配置包含无效规则，已使用可识别的部分';
      }
      this.enabled = raw.enabled === true;
      this.rules = rules;
      this.loaded = true;
      this.revision++;
    },
    async saveConfig(enabled: boolean, rules: PurificationRule[]) {
      if (rules.length > MAX_PURIFICATION_RULES) throw new Error('净化规则不能超过 100 条');
      if (rules.some((rule) => !validRule(rule))) throw new Error('净化规则包含无效内容');
      const ids = new Set<string>();
      for (const rule of rules) {
        if (ids.has(rule.id)) throw new Error('净化规则标识重复');
        ids.add(rule.id);
      }
      await writeJson('purification-rules.json', { schemaVersion: 1, enabled, rules });
      this.enabled = enabled;
      this.rules = rules.map((rule) => ({ ...rule }));
      this.revision++;
    },
    setPreview(text: string, label = '当前章节') {
      this.previewText = text;
      this.previewLabel = label;
    },
  },
});
