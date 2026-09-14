<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePurificationStore } from '../stores/purification';
import {
  MAX_PURIFICATION_RULES, MAX_SAMPLE_LENGTH, validateRule, type PurificationRule,
} from '../services/textPurification';
import { purifyInWorker } from '../services/purificationTask';
import { registerBeforeQuitHandler } from '../services/pendingChanges';

const store = usePurificationStore();
const enabled = ref(false);
const rules = ref<PurificationRule[]>([]);
const sample = ref('');
const preview = ref('');
const previewMessage = ref('');
const saving = ref(false);
const previewing = ref(false);
let unregisterQuit: (() => void) | undefined;

function snapshot() { return JSON.stringify({ enabled: enabled.value, rules: rules.value }); }
function reset() {
  enabled.value = store.enabled;
  rules.value = store.rules.map((rule) => ({ ...rule }));
  sample.value = store.previewText;
  preview.value = '';
  previewMessage.value = '';
}
function addRule() {
  if (rules.value.length >= MAX_PURIFICATION_RULES) { previewMessage.value = '最多允许 100 条规则'; return; }
  rules.value.push({
    id: crypto.randomUUID(), name: '新规则', enabled: true, mode: 'text',
    find: '', replacement: '', ignoreCase: false, multiline: false, dotAll: false,
  });
}
function removeRule(index: number) { rules.value.splice(index, 1); }
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= rules.value.length) return;
  const item = rules.value[index];
  rules.value.splice(index, 1);
  rules.value.splice(target, 0, item);
}
async function runPreview() {
  const invalid = rules.value.find((rule) => rule.enabled && validateRule(rule));
  if (invalid) { previewMessage.value = (invalid.name || '未命名规则') + '：' + validateRule(invalid); return; }
  const text = (store.previewText || sample.value).slice(0, MAX_SAMPLE_LENGTH);
  if (!text) { previewMessage.value = '请先打开一个章节，或在测试框粘贴文字'; return; }
  previewing.value = true;
  previewMessage.value = '';
  try {
    const result = await purifyInWorker(text, rules.value);
    preview.value = result.text.slice(0, 5000);
    const total = Object.values(result.counts).reduce((sum, value) => sum + value, 0);
    previewMessage.value = '共命中 ' + total + ' 处' + (result.text.length > 5000 ? '，预览仅显示前 5000 字' : '');
  } catch (error) {
    previewMessage.value = error instanceof Error ? error.message : '预览失败';
  } finally { previewing.value = false; }
}
async function save() {
  for (const rule of rules.value) {
    const error = validateRule(rule);
    if (error) { previewMessage.value = (rule.name || '未命名规则') + '：' + error; return false; }
  }
  saving.value = true;
  try {
    await store.saveConfig(enabled.value, rules.value);
    previewMessage.value = '规则已保存';
    return true;
  } catch (error) {
    previewMessage.value = error instanceof Error ? error.message : '规则保存失败';
    return false;
  } finally { saving.value = false; }
}
const hasUnsaved = computed(() => snapshot() !== JSON.stringify({ enabled: store.enabled, rules: store.rules }));
defineExpose({ hasUnsaved: () => hasUnsaved.value, isSaving: () => saving.value, save });
onMounted(() => {
  reset();
  unregisterQuit = registerBeforeQuitHandler(async () => {
    if (!hasUnsaved.value) return;
    if (!window.confirm('净化规则有未保存修改，退出前保存吗？')) return;
    if (!(await save())) throw new Error('净化规则保存失败');
  });
});
onBeforeUnmount(() => unregisterQuit?.());
</script>

<template>
  <div class="purify-manager">
    <h3>正文净化 <span class="dim">全局规则</span></h3>
    <div class="opt">
      <div><div>启用正文净化</div><div class="desc">同时用于书源、离线缓存和本地 TXT，只改变显示，原文会保留</div></div>
      <button class="switch" :class="{ on: enabled }" @click="enabled = !enabled" />
    </div>
    <div class="rule-toolbar">
      <button class="btn" :disabled="rules.length >= 100" @click="addRule">新增规则</button>
      <span class="dim">从上到下依次执行 · {{ rules.length }}/100</span>
    </div>
    <div class="rule-list">
      <section v-for="(rule, i) in rules" :key="rule.id" class="rule-card">
        <div class="rule-head">
          <button class="switch mini" :class="{ on: rule.enabled }" @click="rule.enabled = !rule.enabled" />
          <input v-model="rule.name" maxlength="80" placeholder="规则名称" />
          <button title="上移" :disabled="i === 0" @click="move(i, -1)">↑</button>
          <button title="下移" :disabled="i === rules.length - 1" @click="move(i, 1)">↓</button>
          <button class="danger-text" title="删除" @click="removeRule(i)">删除</button>
        </div>
        <div class="rule-options">
          <select v-model="rule.mode">
            <option value="text">普通文本</option><option value="regex">正则表达式</option>
          </select>
          <label><input v-model="rule.ignoreCase" type="checkbox" /> 忽略大小写</label>
          <label v-if="rule.mode === 'regex'"><input v-model="rule.multiline" type="checkbox" /> 多行</label>
          <label v-if="rule.mode === 'regex'"><input v-model="rule.dotAll" type="checkbox" /> 点号跨行</label>
        </div>
        <textarea v-model="rule.find" rows="2" maxlength="2000" placeholder="查找内容（不能留空）"></textarea>
        <textarea v-model="rule.replacement" rows="2" maxlength="10000" placeholder="替换内容；留空表示删除，$1 按普通文字处理"></textarea>
      </section>
      <p v-if="!rules.length" class="empty-rules">暂无规则。添加后先预览，再保存启用。</p>
    </div>
    <label v-if="!store.previewText" class="sample-field">
      <span>测试文字</span>
      <textarea v-model="sample" rows="3" maxlength="50000" placeholder="也可以粘贴一小段文字预览"></textarea>
    </label>
    <div class="rule-actions">
      <button class="btn" :disabled="previewing" @click="runPreview">{{ previewing ? '正在预览…' : '预览效果' }}</button>
      <button class="btn" :disabled="!hasUnsaved" @click="reset">取消修改</button>
      <button class="btn primary" :disabled="saving || !hasUnsaved" @click="save">{{ saving ? '保存中…' : '保存规则' }}</button>
      <span class="msg">{{ previewMessage }}</span>
    </div>
    <pre v-if="preview" class="rule-preview">{{ preview }}</pre>
  </div>
</template>

<style scoped>
.purify-manager { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.rule-toolbar, .rule-actions, .rule-head, .rule-options { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rule-toolbar { justify-content: space-between; }
.rule-list { display: flex; flex-direction: column; gap: 8px; }
.rule-card { display: flex; flex-direction: column; gap: 7px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-soft); }
.rule-head input { flex: 1; min-width: 120px; padding: 6px 8px; }
.rule-options { font-size: 12px; color: var(--text-dim); }
.rule-options select { padding: 5px 7px; }
.rule-options label { display: flex; gap: 4px; align-items: center; }
textarea { width: 100%; }
.switch.mini { transform: scale(.82); }
.danger-text { color: var(--danger); }
.empty-rules { padding: 16px; text-align: center; color: var(--text-dim); font-size: 12px; }
.sample-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.rule-preview { max-height: 180px; overflow: auto; padding: 9px; border: 1px dashed var(--border); white-space: pre-wrap; user-select: text; font: 12px/1.6 inherit; }
.dim, .desc { color: var(--text-dim); font-size: 12px; }
.msg { color: var(--accent); font-size: 12px; flex: 1; }
.opt { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
</style>
