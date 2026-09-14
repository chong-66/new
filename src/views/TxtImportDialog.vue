<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLibraryStore } from '../stores/library';
import { useUiStore } from '../stores/ui';
import { setInteracting } from '../composables/useWindowBehavior';
import { MAX_TXT_BYTES, type ParsedTxt, type TxtEncoding, type TxtSplitMode } from '../services/txtParser';
import { parseTxtInWorker, stopTxtImportTask } from '../services/txtImportTask';
import { hashLocalText, loadLocalToc, readLocalChapter, removeLocalBook, saveLocalBook } from '../services/localBooks';

const emit = defineEmits<{ close: []; imported: [] }>();
const library = useLibraryStore();
const ui = useUiStore();
const fileInput = ref<HTMLInputElement>();
const file = ref<File>();
const bytes = ref<ArrayBuffer>();
const bookName = ref('');
const encoding = ref<TxtEncoding>('auto');
const splitMode = ref<TxtSplitMode>('auto');
const parsed = ref<ParsedTxt>();
const selectedPreview = ref(0);
const parsing = ref(false);
const saving = ref(false);
const message = ref('');
const saved = ref(0);
const saveTotal = ref(0);
let parseJob: ReturnType<typeof parseTxtInWorker> | undefined;
let saveController: AbortController | undefined;
let generation = 0;

const previewSections = computed(() => parsed.value?.sections.slice(0, 20) ?? []);
const previewText = computed(() => {
  const result = parsed.value;
  const section = result?.sections[selectedPreview.value];
  return result && section ? result.text.slice(section.start, Math.min(section.end, section.start + 1200)) : '';
});

async function parseCurrent() {
  if (!bytes.value || parsing.value || saving.value) return;
  const current = ++generation;
  parseJob?.cancel();
  parsing.value = true;
  parsed.value = undefined;
  message.value = '正在识别编码和章节…';
  try {
    parseJob = parseTxtInWorker(bytes.value.slice(0), encoding.value, splitMode.value);
    const result = await parseJob.promise;
    if (current !== generation) return;
    parsed.value = result;
    selectedPreview.value = 0;
    encoding.value = result.encoding;
    message.value = result.warnings.join('；');
  } catch (error) {
    if (current === generation && !(error instanceof DOMException && error.name === 'AbortError')) {
      message.value = error instanceof Error ? error.message : 'TXT 解析失败';
    }
  } finally {
    if (current === generation) parsing.value = false;
  }
}

async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const selected = input.files?.[0];
  input.value = '';
  if (!selected) return;
  generation++;
  parseJob?.cancel();
  parsing.value = false;
  parsed.value = undefined;
  message.value = '';
  if (!/\.txt$/i.test(selected.name) && selected.type !== 'text/plain') {
    message.value = '请选择 TXT 文件';
    return;
  }
  if (selected.size > MAX_TXT_BYTES) {
    message.value = 'TXT 文件不能超过 30 MiB';
    return;
  }
  file.value = selected;
  bookName.value = selected.name.replace(/\.txt$/i, '');
  try {
    bytes.value = await selected.arrayBuffer();
    encoding.value = 'auto';
    splitMode.value = 'auto';
    await parseCurrent();
  } catch (error) {
    message.value = error instanceof Error ? error.message : '读取文件失败';
  }
}

async function reparse() {
  generation++;
  parseJob?.cancel();
  parsing.value = false;
  await parseCurrent();
}

async function commit() {
  const result = parsed.value;
  const selectedFile = file.value;
  if (!result || !selectedFile || saving.value) return;
  if (!bookName.value.trim()) { message.value = '请输入书名'; return; }
  saving.value = true;
  message.value = '正在检查重复内容…';
  saveController = new AbortController();
  try {
    const hash = await hashLocalText(result.text);
    const existing = library.books.find((item) => item.origin === 'local-txt' && item.localTxt?.contentHash === hash);
    if (existing) {
      try {
        const existingToc = await loadLocalToc(existing);
        if (!existingToc.length) throw new Error('目录为空');
        await readLocalChapter(existing, existingToc[0].url);
        message.value = '相同内容已经导入，正在打开原有书籍';
        ui.openBook(existing.id);
        emit('close');
        return;
      } catch {
        if (!window.confirm('已导入的同一本书数据已损坏，要移除旧记录并重新导入吗？')) {
          message.value = '已保留原有记录';
          return;
        }
        await library.remove(existing.id);
      }
    }
    const stored = await saveLocalBook({
      name: bookName.value,
      originalName: selectedFile.name,
      parsed: result,
      signal: saveController.signal,
      onProgress(done, total) { saved.value = done; saveTotal.value = total; message.value = '正在保存章节…'; },
    });
    try {
      await library.addLocalBook(stored.book, stored.chapters);
    } catch (error) {
      await removeLocalBook(stored.book.id).catch(() => {});
      throw error;
    }
    ui.showToast('TXT 已导入书架');
    emit('imported');
    emit('close');
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) message.value = error instanceof Error ? error.message : '导入失败';
  } finally {
    saving.value = false;
  }
}

function close() {
  if (saving.value) {
    saveController?.abort();
    message.value = '正在停止并清理本次导入…';
    return;
  }
  generation++;
  parseJob?.cancel();
  emit('close');
}

onMounted(() => setInteracting(true));
onBeforeUnmount(() => {
  generation++;
  parseJob?.cancel();
  stopTxtImportTask();
  saveController?.abort();
  setInteracting(false);
  bytes.value = undefined;
  parsed.value = undefined;
});
</script>

<template>
  <div class="txt-mask" @click.self="close">
    <div class="txt-panel">
      <div class="txt-head">
        <strong>导入 TXT 小说</strong>
        <button class="btn" :disabled="saving" @click="close">关闭</button>
      </div>
      <div class="txt-body">
        <input ref="fileInput" class="file-input" type="file" accept=".txt,text/plain" @change="chooseFile" />
        <button class="btn primary" :disabled="saving" @click="fileInput?.click()">{{ file ? '重新选择文件' : '选择 TXT 文件' }}</button>
        <span v-if="file" class="dim">{{ file.name }} · {{ (file.size / 1024 / 1024).toFixed(2) }} MiB</span>

        <label class="txt-field"><span>书名</span><input v-model="bookName" :disabled="saving" /></label>
        <div class="txt-grid">
          <label class="txt-field"><span>编码</span>
            <select v-model="encoding" :disabled="!bytes || parsing || saving" @change="reparse">
              <option value="auto">自动识别</option><option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030</option><option value="big5">Big5</option>
              <option value="utf-16le">UTF-16LE</option><option value="utf-16be">UTF-16BE</option>
            </select>
          </label>
          <label class="txt-field"><span>分章方式</span>
            <select v-model="splitMode" :disabled="!bytes || parsing || saving" @change="reparse">
              <option value="auto">自动识别标题</option><option value="length">按长度分段</option>
            </select>
          </label>
        </div>

        <div v-if="parsed" class="txt-preview">
          <div class="txt-summary">识别到 {{ parsed.sections.length }} 章 · {{ parsed.encoding }} · {{ parsed.splitMethod === 'headings' ? '标题分章' : '长度分段' }}</div>
          <div class="preview-layout">
            <div class="chapter-list">
              <button v-for="(section, i) in previewSections" :key="i" :class="{ on: selectedPreview === i }" @click="selectedPreview = i">{{ section.title }}</button>
              <span v-if="parsed.sections.length > 20" class="dim">仅显示前 20 章</span>
            </div>
            <pre class="content-preview">{{ previewText }}</pre>
          </div>
        </div>
        <p v-if="message" class="txt-msg">{{ message }}</p>
        <progress v-if="saving && saveTotal" :value="saved" :max="saveTotal"></progress>
      </div>
      <div class="txt-actions">
        <span class="dim">导入后不再依赖原 TXT 文件，原文件不会被修改。</span>
        <button class="btn primary" :disabled="!parsed || parsing || saving" @click="commit">确认导入</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.txt-mask { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; padding: 40px 24px 24px; background: rgba(0,0,0,.48); }
.txt-panel { width: min(760px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.txt-head, .txt-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.txt-actions { border-top: 1px solid var(--border); border-bottom: 0; }
.txt-body { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 14px; }
.file-input { display: none; }
.txt-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.txt-field input, .txt-field select { padding: 7px 9px; }
.txt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.txt-preview { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.txt-summary { padding: 8px 10px; background: var(--bg-soft); font-size: 12px; }
.preview-layout { display: grid; grid-template-columns: minmax(130px, 35%) 1fr; height: 230px; }
.chapter-list { display: flex; flex-direction: column; gap: 2px; padding: 6px; overflow-y: auto; border-right: 1px solid var(--border); }
.chapter-list button { padding: 6px; text-align: left; border-radius: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-list button.on { color: var(--accent); background: var(--accent-dim); }
.content-preview { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; user-select: text; font: 12px/1.65 inherit; }
.txt-msg { color: var(--accent); font-size: 12px; }
progress { width: 100%; accent-color: var(--accent); }
.dim { color: var(--text-dim); font-size: 12px; }
@media (max-width: 520px) { .txt-grid, .preview-layout { grid-template-columns: 1fr; } .preview-layout { height: 300px; grid-template-rows: 100px 1fr; } .chapter-list { border-right: 0; border-bottom: 1px solid var(--border); } }
</style>
