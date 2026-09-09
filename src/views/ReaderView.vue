<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { useUiStore } from '../stores/ui';
import { useLibraryStore } from '../stores/library';
import { useSourcesStore } from '../stores/sources';
import { useSettingsStore } from '../stores/settings';
import * as engine from '../engine/source';
import type { Book, Chapter } from '../types';

const ui = useUiStore();
const library = useLibraryStore();
const sources = useSourcesStore();
const settings = useSettingsStore();

const book = computed<Book | undefined>(() => (ui.readingId ? library.byId(ui.readingId) : undefined));
const source = computed(() => (book.value ? sources.findByUrl(book.value.sourceUrl) : undefined));

const toc = ref<Chapter[]>([]);
const tocLoading = ref(false);
const tocError = ref('');
const idx = ref(0);
const content = ref('');
const loading = ref(false);
const loadError = ref('');
const showToc = ref(false);
const bodyEl = ref<HTMLElement>();
let disposed = false;
let chapterRequest = 0;
let chapterController: AbortController | undefined;
let tocController: AbortController | undefined;
let prefetchController: AbortController | undefined;
let renderedSource = '';
let renderedUrl = '';
let restoring = false;
let lastScrollTop = 0;

function savePosition() {
  const b = book.value;
  const el = bodyEl.value;
  if (!b || !el || loading.value || restoring || !content.value || loadError.value) return;
  if (b.sourceUrl !== renderedSource || b.progress.chapterUrl !== renderedUrl) return;
  const max = el.scrollHeight - el.clientHeight;
  library.updatePosition(b, max > 0 ? el.scrollTop / max : 0);
}

async function ensureToc(force = false) {
  const b = book.value;
  const s = source.value;
  if (!b || !s || disposed) return;
  tocController?.abort();
  const controller = new AbortController();
  tocController = controller;
  tocLoading.value = true;
  tocError.value = '';
  try {
    if (!force) {
      const cached = await library.getToc(b);
      controller.signal.throwIfAborted();
      if (cached?.length) {
        toc.value = cached;
        return;
      }
    }
    // 部分书源的目录页地址藏在书籍详情页规则里
    if (!b.tocUrl && s.ruleBookInfo?.tocUrl) {
      try {
        const info = await engine.getBookInfo(s, b.bookUrl, b, controller.signal);
        controller.signal.throwIfAborted();
        const patch: Partial<Book> = {};
        if (info.tocUrl) patch.tocUrl = info.tocUrl;
        if (info.coverUrl && !b.coverUrl) patch.coverUrl = info.coverUrl;
        if (info.intro && !b.intro) patch.intro = info.intro;
        if (Object.keys(patch).length) library.updateMeta(b, patch);
      } catch {
        controller.signal.throwIfAborted();
        /* 详情页失败不阻塞目录 */
      }
    }
    const list = await engine.getToc(s, b, controller.signal);
    controller.signal.throwIfAborted();
    if (!list.length) throw new Error('未解析到章节');
    await library.setToc(b, list);
    controller.signal.throwIfAborted();
    toc.value = list;
  } catch (e) {
    if (!controller.signal.aborted) {
      const message = e instanceof Error ? e.message : '目录加载失败';
      if (toc.value.length) ui.showToast(`刷新失败，继续使用原目录：${message}`);
      else tocError.value = message;
    }
  } finally {
    if (tocController === controller && !disposed) tocLoading.value = false;
  }
}

async function loadChapter(i: number, force = false, restoreRatio = 0) {
  const b = book.value;
  const s = source.value;
  if (!b || !s || !toc.value.length || disposed) return;
  savePosition();
  chapterController?.abort();
  prefetchController?.abort();
  const controller = new AbortController();
  chapterController = controller;
  const request = ++chapterRequest;
  const target = Math.min(Math.max(0, i), toc.value.length - 1);
  const chapter = toc.value[target];
  idx.value = target;
  restoring = true;
  loading.value = true;
  loadError.value = '';
  content.value = '';
  try {
    const text = await engine.getContent(s, chapter.url, b, { signal: controller.signal, force });
    if (disposed || request !== chapterRequest || controller.signal.aborted) return;
    if (!text.trim()) throw new Error('正文为空，请重试或换源');
    content.value = text;
    renderedSource = s.bookSourceUrl;
    renderedUrl = chapter.url;
    library.updateProgress(b, target, chapter, restoreRatio);
    loading.value = false;
    await nextTick();
    if (disposed || request !== chapterRequest) return;
    const el = bodyEl.value;
    if (el) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight) * restoreRatio;
      lastScrollTop = el.scrollTop;
    }
    requestAnimationFrame(() => { if (request === chapterRequest) restoring = false; });
    const nextCh = toc.value[target + 1];
    if (nextCh) {
      prefetchController = new AbortController();
      void engine.getContent(s, nextCh.url, b, { signal: prefetchController.signal }).catch(() => {});
    }
  } catch (e) {
    if (!disposed && request === chapterRequest && !controller.signal.aborted) {
      loadError.value = e instanceof Error ? e.message : '正文加载失败';
    }
  } finally {
    if (!disposed && request === chapterRequest) {
      loading.value = false;
      if (!content.value) restoring = false;
    }
  }
}

const paragraphs = computed(() => content.value.split('\n').filter(Boolean));
const chapterTitle = computed(() => toc.value[idx.value]?.title ?? '');

function prev() {
  if (idx.value > 0 && !loading.value) loadChapter(idx.value - 1);
}
function next() {
  if (idx.value < toc.value.length - 1 && !loading.value) loadChapter(idx.value + 1);
}
function back() {
  savePosition();
  ui.closeReading();
}
function changeSource() {
  savePosition();
  if (book.value) ui.openSearch(book.value.name, book.value.id);
}
async function openToc() {
  showToc.value = true;
  await nextTick();
  document.querySelector('.toc-list .cur')?.scrollIntoView({ block: 'center' });
}
function jump(i: number) {
  showToc.value = false;
  loadChapter(i);
}
async function refreshToc() {
  if (tocLoading.value) return;
  savePosition();
  const progress = { ...book.value?.progress };
  chapterController?.abort();
  chapterRequest++;
  await ensureToc(true);
  if (disposed || !toc.value.length) return;
  const found = toc.value.findIndex((c) => c.url === progress.chapterUrl);
  await loadChapter(found >= 0 ? found : (progress.chapterIndex ?? idx.value), false, found >= 0 ? progress.scrollRatio ?? 0 : 0);
}

function onKey(e: KeyboardEvent) {
  if (ui.searchOpen || ui.panelOpen || e.defaultPrevented || e.isComposing) return;
  if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (showToc.value) {
    if (e.key === 'Escape') { e.preventDefault(); showToc.value = false; }
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
  else if (e.key === 'Escape') back();
}

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey || ui.searchOpen || ui.panelOpen || showToc.value || !bodyEl.value?.contains(e.target as Node)) return;
  e.preventDefault();
  const step = e.deltaY > 0 ? -1 : 1;
  settings.fontSize = Math.min(28, Math.max(14, settings.fontSize + step));
}

// 滚动到底部自动下一章
let autoNextLock = false;
function onBodyScroll() {
  savePosition();
  if (!bodyEl.value) return;
  const { scrollTop, scrollHeight, clientHeight } = bodyEl.value;
  const downward = scrollTop > lastScrollTop;
  lastScrollTop = scrollTop;
  if (!settings.autoNextChapter || restoring || !downward || loading.value || loadError.value || ui.searchOpen || ui.panelOpen || showToc.value || idx.value >= toc.value.length - 1) return;
  if (scrollHeight - scrollTop - clientHeight <= 4 && !autoNextLock) {
    autoNextLock = true;
    loadChapter(idx.value + 1).finally(() => { autoNextLock = false; });
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('wheel', onWheel, { passive: false });
  const b = book.value;
  if (!b) {
    ui.closeReading();
    return;
  }
  if (!source.value) { tocError.value = '该书的书源已被删除，请换源后继续阅读'; return; }
  const saved = { ...b.progress };
  idx.value = b.totalChapters ? Math.min(b.progress.chapterIndex, b.totalChapters - 1) : b.progress.chapterIndex;
  await ensureToc();
  const found = toc.value.findIndex((c) => c.url === saved.chapterUrl);
  if (toc.value.length) await loadChapter(found >= 0 ? found : idx.value, false, saved.scrollRatio ?? 0);
});
onBeforeUnmount(() => {
  savePosition();
  disposed = true;
  chapterRequest++;
  chapterController?.abort();
  tocController?.abort();
  prefetchController?.abort();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('wheel', onWheel);
});
</script>

<template>
  <div class="reader">
    <div class="subbar">
      <button class="btn" title="返回书架 (Esc)" @click="back">‹ 书架</button>
      <div class="titles">
        <div class="book">{{ book?.name }}</div>
        <div class="chapter">{{ chapterTitle }}</div>
      </div>
      <div class="ops">
        <button class="btn" title="换源" @click="changeSource">换源</button>
        <button class="btn" title="目录" @click="openToc">目录</button>
      </div>
    </div>

    <div ref="bodyEl" class="body" :style="{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight, color: settings.textColor || 'var(--text)', fontFamily: settings.fontFamily || undefined }" @scroll="onBodyScroll">
      <div v-if="tocLoading" class="state">正在加载目录…</div>
      <div v-else-if="tocError" class="state">
        <p>{{ tocError }}</p>
        <button class="btn" @click="refreshToc">重试</button>
        <button class="btn" @click="changeSource">换源</button>
      </div>
      <div v-else-if="loading" class="state">加载中…</div>
      <div v-else-if="loadError" class="state">
        <p>{{ loadError }}</p>
        <button class="btn" @click="loadChapter(idx, true)">重试</button>
        <button class="btn" @click="changeSource">换源</button>
      </div>
      <template v-else>
        <h2 class="ch-title">{{ chapterTitle }}</h2>
        <p v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</p>
        <div v-if="paragraphs.length" class="end-pager">
          <button class="btn" :disabled="idx === 0" @click="prev">‹ 上一章</button>
          <span class="pg">{{ idx + 1 }} / {{ toc.length }}</span>
          <button class="btn" :disabled="idx >= toc.length - 1" @click="next">下一章 ›</button>
        </div>
      </template>
    </div>

    <div v-if="showToc" class="toc-mask" @click.self="showToc = false">
      <aside class="toc-panel">
        <div class="toc-head">
          <span>目录 · {{ toc.length }} 章</span>
          <button class="btn" :disabled="tocLoading" title="重新拉取目录" @click="refreshToc">{{ tocLoading ? '刷新中…' : '刷新' }}</button>
        </div>
        <div class="toc-list">
          <div
            v-for="(c, i) in toc"
            :key="c.url + i"
            class="toc-item"
            :class="{ cur: i === idx }"
            @click="jump(i)"
          >
            {{ c.title }}
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.reader {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}
.subbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.titles {
  flex: 1;
  min-width: 0;
  text-align: center;
}
.book {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chapter {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ops {
  display: flex;
  gap: 6px;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 26px 40px;
  user-select: text;
  /* 窗口全透明后，给文字加衬影避免与下层窗口内容糊在一起 */
  text-shadow: 0 0 3px var(--text-glow), 0 1px 2px var(--text-glow);
}
.ch-title {
  font-size: 1.15em;
  margin-bottom: 1em;
}
.para {
  margin-bottom: 0.7em;
  text-indent: 2em;
  text-align: justify;
  word-break: break-all;
}
.state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-dim);
}
.end-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 2em;
}
.pg {
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.toc-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.toc-panel {
  width: 260px;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.toc-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.toc-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.toc-item {
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}
.toc-item:hover {
  background: var(--bg-soft);
  color: var(--text);
}
.toc-item.cur {
  color: var(--accent);
  background: var(--accent-dim);
}
</style>
