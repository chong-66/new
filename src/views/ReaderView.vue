<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { useLibraryStore } from '../stores/library';
import { useSourcesStore } from '../stores/sources';
import { useSettingsStore } from '../stores/settings';
import * as engine from '../engine/source';
import { isLocalBook, type Book, type Chapter } from '../types';
import { cachedChapterUrls } from '../services/chapterCache';
import { startChapterCacheTask, type ChapterCacheProgress, type ChapterCacheTask } from '../services/chapterCacheTask';
import { loadLocalToc, readLocalChapter } from '../services/localBooks';
import { usePurificationStore } from '../stores/purification';
import { purifyInWorker, stopAllPurificationTasks } from '../services/purificationTask';

const ui = useUiStore();
const library = useLibraryStore();
const sources = useSourcesStore();
const settings = useSettingsStore();

const purification = usePurificationStore();
const book = computed<Book | undefined>(() => (ui.readingId ? library.byId(ui.readingId) : undefined));
const source = computed(() => (book.value ? sources.findByUrl(book.value.sourceUrl) : undefined));

const localBook = computed(() => isLocalBook(book.value));
const toc = ref<Chapter[]>([]);
const tocLoading = ref(false);
const tocError = ref('');
const idx = ref(0);
const content = ref('');
const loading = ref(false);
const rawContent = ref('');
const displaySourceContent = ref('');
const loadError = ref('');
const showToc = ref(false);
const showCache = ref(false);
const cacheCountInput = ref(String(settings.chapterCacheCount));
const showOriginal = ref(false);
const purificationError = ref('');
const purifying = ref(false);
let purificationPaused = false;
const cachedUrls = ref(new Set<string>());
const cacheProgress = ref<ChapterCacheProgress | null>(null);
const taskRange = ref<{ start: number; end: number; total: number } | null>(null);
const bodyEl = ref<HTMLElement>();
let disposed = false;
let chapterRequest = 0;
let chapterController: AbortController | undefined;
let tocController: AbortController | undefined;
let prefetchController: AbortController | undefined;
let cacheJob: ChapterCacheTask | undefined;
let renderedSource = '';
let renderedUrl = '';
let restoring = false;
let lastScrollTop = 0;

const cacheRunning = computed(() => cacheProgress.value?.status === 'running');
let layoutVersion = 0;
let resizeObserver: ResizeObserver | undefined;
let pointerGesture: { id: number; x: number; y: number; maxMove: number; layout: number } | undefined;
let clickReady: { y: number; layout: number } | undefined;

const cacheCount = computed(() => {
  const raw = cacheCountInput.value.trim();
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
});
const cacheRange = computed(() => {
  if (!cacheCount.value || !toc.value.length) return null;
  const start = Math.min(Math.max(0, idx.value), toc.value.length - 1);
  const end = Math.min(toc.value.length - 1, start + cacheCount.value - 1);
  return { start, end, total: end - start + 1 };
});
const displayCacheRange = computed(() => cacheRunning.value ? taskRange.value : cacheRange.value);

function savePosition() {
  const b = book.value;
  const el = bodyEl.value;
  if (!b || !el || loading.value || purifying.value || restoring || !rawContent.value || loadError.value) return;
  if (b.sourceUrl !== renderedSource || b.progress.chapterUrl !== renderedUrl) return;
  const max = el.scrollHeight - el.clientHeight;
  library.updatePosition(b, max > 0 ? el.scrollTop / max : 0);
}

async function refreshCacheStatus() {
  const b = book.value;
  const s = source.value;
  if (!b || !s || !toc.value.length) { cachedUrls.value = new Set(); return; }
  const sourceUrl = b.sourceUrl;
  const urls = await cachedChapterUrls(b, s, toc.value);
  if (!disposed && book.value?.id === b.id && book.value.sourceUrl === sourceUrl) cachedUrls.value = urls;
  if (localBook.value) { cachedUrls.value = new Set(); return; }
}

function openCache() {
  showToc.value = false;
  showCache.value = true;
  void refreshCacheStatus();
}
function chooseCacheCount(value: number) { if (!cacheRunning.value) cacheCountInput.value = String(value); }
function stopCaching() { cacheJob?.cancel(); }

function startCaching() {
  const b = book.value;
  const s = source.value;
  const range = cacheRange.value;
  if (!b || !s || !range || cacheRunning.value || tocLoading.value) {
    ui.showToast(cacheCount.value ? '目录尚未准备好' : '缓存章数必须是正整数');
    return;
  }
  taskRange.value = { ...range };
  settings.chapterCacheCount = cacheCount.value;
  prefetchController?.abort();
  const bookId = b.id;
  const chapters = [...toc.value];
  cacheProgress.value = { status: 'running', total: range.total, processed: 0, saved: 0, skipped: 0, failed: 0, currentTitle: '', message: '' };
  const job = startChapterCacheTask({
    book: b, source: s, chapters, start: range.start, count: cacheCount.value,
    persistToc: () => library.persistToc(b, chapters),
    onProgress(progress) {
      if (disposed || book.value?.id !== bookId || cacheJob !== job) return;
      cacheProgress.value = progress;
      if (progress.cachedUrl) cachedUrls.value = new Set([...cachedUrls.value, progress.cachedUrl]);
    },
  });
  cacheJob = job;
  void job.done.finally(() => {
    if (cacheJob === job) cacheJob = undefined;
    void refreshCacheStatus();
  });
}

async function ensureToc(force = false) {
  const b = book.value;
  const s = source.value;
  if (!b || disposed) return;
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
    if (isLocalBook(b)) {
      const list = await loadLocalToc(b);
      controller.signal.throwIfAborted();
      if (!list.length) throw new Error('本地 TXT 没有章节');
      toc.value = list;
      library.tocCache[b.id] = list;
      return;
    }
    if (!s) throw new Error('该书的书源已被删除，请换源后继续阅读');
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

async function displayText(text: string, request: number): Promise<string> {
  purificationError.value = '';
  if (!purification.enabled || showOriginal.value || purificationPaused || !purification.rules.some((rule) => rule.enabled)) return text;
  purifying.value = true;
  try {
    const result = await purifyInWorker(text, purification.rules.map((rule) => ({ ...rule })));
    if (disposed || request !== chapterRequest) throw new DOMException('已取消', 'AbortError');
    return result.text;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    purificationPaused = true;
    purificationError.value = (error instanceof Error ? error.message : '净化失败') + '，正在显示原文';
    return text;
  } finally {
    if (request === chapterRequest) purifying.value = false;
  }
}

function contentForDisplay(text: string, currentBook: Book, chapter: Chapter) {
  if (!isLocalBook(currentBook)) return text;
  const newline = text.indexOf('\n');
  const firstLine = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (firstLine !== chapter.title.trim()) return text;
  return newline < 0 ? '' : text.slice(newline + 1);
}

async function reapplyPurification() {
  if (!rawContent.value || loading.value || disposed) return;
  savePosition();
  const el = bodyEl.value;
  const max = el ? el.scrollHeight - el.clientHeight : 0;
  const ratio = el && max > 0 ? el.scrollTop / max : (book.value?.progress.scrollRatio ?? 0);
  const request = ++chapterRequest;
  restoring = true;
  clickReady = undefined;
  pointerGesture = undefined;
  content.value = await displayText(displaySourceContent.value, request).catch(() => displaySourceContent.value);
  await nextTick();
  if (disposed || request !== chapterRequest) return;
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight) * ratio;
    lastScrollTop = el.scrollTop;
  }
  requestAnimationFrame(() => { if (request === chapterRequest) restoring = false; });
}

function openPurification() {
  purification.previewText = rawContent.value;
  purification.previewLabel = chapterTitle.value;
  ui.openPanel('purification');
}

async function loadChapter(i: number, force = false, restoreRatio = 0) {
  const b = book.value;
  const s = source.value;
  if (!b || (!s && !isLocalBook(b)) || !toc.value.length || disposed) return;
  savePosition();
  rawContent.value = '';
  displaySourceContent.value = '';
  chapterController?.abort();
  showOriginal.value = false;
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
    const text = isLocalBook(b) ? await readLocalChapter(b, chapter.url) : await engine.getContent(s!, chapter.url, b, { signal: controller.signal, force });
    if (disposed || request !== chapterRequest || controller.signal.aborted) return;
    if (!text.trim()) throw new Error(isLocalBook(b) ? '本地章节正文为空' : '正文为空，请重试或换源');
    rawContent.value = text;
    displaySourceContent.value = contentForDisplay(text, b, chapter);
    content.value = await displayText(displaySourceContent.value, request);
    if (disposed || request !== chapterRequest || controller.signal.aborted) return;
    renderedSource = b.sourceUrl;
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
    if (nextCh && s && !isLocalBook(b) && !cacheRunning.value) {
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
      if (!rawContent.value) restoring = false;
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
  stopCaching();
  ui.closeReading();
}
function changeSource() {
  savePosition();
  stopCaching();
  if (book.value) ui.openSearch(book.value.name, book.value.id);
}
async function openToc() {
  showCache.value = false;
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
  stopCaching();
  savePosition();
  const progress = { ...book.value?.progress };
  chapterController?.abort();
  chapterRequest++;
  await ensureToc(true);
  await refreshCacheStatus();
  if (disposed || !toc.value.length) return;
  const found = toc.value.findIndex((c) => c.url === progress.chapterUrl);
  await loadChapter(found >= 0 ? found : (progress.chapterIndex ?? idx.value), false, found >= 0 ? progress.scrollRatio ?? 0 : 0);
}

function interactionBlocked(target?: EventTarget | null) {
  return loading.value || purifying.value || restoring || !!loadError.value || !rawContent.value ||
    ui.ghostHidden || ui.searchOpen || ui.panelOpen || showToc.value || showCache.value ||
    !!(target as HTMLElement | null)?.closest?.('button, a, input, textarea, select, [contenteditable="true"], [data-no-page-click]');
}
function hasTextSelection() {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed;
}
function cancelPointer() { pointerGesture = undefined; clickReady = undefined; }
function onPointerDown(e: PointerEvent) {
  clickReady = undefined;
  if (!settings.clickScrollEnabled || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || interactionBlocked(e.target) || hasTextSelection()) return;
  pointerGesture = { id: e.pointerId, x: e.clientX, y: e.clientY, maxMove: 0, layout: layoutVersion };
  bodyEl.value?.setPointerCapture?.(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!pointerGesture || pointerGesture.id !== e.pointerId) return;
  pointerGesture.maxMove = Math.max(pointerGesture.maxMove, Math.hypot(e.clientX - pointerGesture.x, e.clientY - pointerGesture.y));
}
function onPointerUp(e: PointerEvent) {
  const gesture = pointerGesture;
  pointerGesture = undefined;
  bodyEl.value?.releasePointerCapture?.(e.pointerId);
  if (!gesture || gesture.id !== e.pointerId || gesture.maxMove > 6 || gesture.layout !== layoutVersion || hasTextSelection() || interactionBlocked(e.target)) return;
  clickReady = { y: e.clientY, layout: gesture.layout };
}
function onBodyClick(e: MouseEvent) {
  const ready = clickReady;
  clickReady = undefined;
  const el = bodyEl.value;
  if (!ready || e.detail > 1 || ready.layout !== layoutVersion || !el || !settings.clickScrollEnabled || interactionBlocked(e.target) || hasTextSelection()) return;
  const rect = el.getBoundingClientRect();
  const insideX = e.clientX - rect.left - el.clientLeft;
  const insideY = ready.y - rect.top - el.clientTop;
  if (insideX < 0 || insideX > el.clientWidth || insideY < 0 || insideY > el.clientHeight) return;
  const paragraph = el.querySelector<HTMLElement>('.para');
  const lineHeight = Number.parseFloat(getComputedStyle(paragraph ?? el).lineHeight) || settings.fontSize * settings.lineHeight;
  const direction = insideY < el.clientHeight / 2 ? -1 : 1;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const target = Math.min(max, Math.max(0, el.scrollTop + direction * lineHeight * settings.clickScrollLines));
  if (target === el.scrollTop) return;
  el.scrollTop = target;
  savePosition();
}
function onLayoutChanged() {
  layoutVersion++;
  cancelPointer();
  requestAnimationFrame(() => { if (bodyEl.value) lastScrollTop = bodyEl.value.scrollTop; });
}
async function toggleOriginal() {
  showOriginal.value = !showOriginal.value;
  await reapplyPurification();
}
async function retryPurification() {
  purificationPaused = false;
  showOriginal.value = false;
  await reapplyPurification();
}

watch(() => [settings.fontSize, settings.lineHeight], onLayoutChanged);
watch(() => [purification.enabled, purification.revision], () => {
  purificationPaused = false;
  void reapplyPurification();
});

function onKey(e: KeyboardEvent) {
  if (ui.searchOpen || ui.panelOpen || e.defaultPrevented || e.isComposing) return;
  if (showCache.value) {
    if (e.key === 'Escape') { e.preventDefault(); showCache.value = false; }
    return;
  }
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
  if (!e.ctrlKey || ui.searchOpen || ui.panelOpen || showToc.value || showCache.value || !bodyEl.value?.contains(e.target as Node)) return;
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
  if (!settings.autoNextChapter || restoring || purifying.value || !downward || loading.value || loadError.value || ui.searchOpen || ui.panelOpen || showToc.value || showCache.value || idx.value >= toc.value.length - 1) return;
  if (scrollHeight - scrollTop - clientHeight <= 4 && !autoNextLock) {
    autoNextLock = true;
    loadChapter(idx.value + 1).finally(() => { autoNextLock = false; });
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', cancelPointer);
  if (typeof ResizeObserver !== 'undefined' && bodyEl.value) {
    resizeObserver = new ResizeObserver(onLayoutChanged);
    resizeObserver.observe(bodyEl.value);
  }
  const b = book.value;
  if (!b) {
    ui.closeReading();
    return;
  }
  if (!isLocalBook(b) && !source.value) { tocError.value = '该书的书源已被删除，请换源后继续阅读'; return; }
  const saved = { ...b.progress };
  idx.value = b.totalChapters ? Math.min(b.progress.chapterIndex, b.totalChapters - 1) : b.progress.chapterIndex;
  await ensureToc();
  await refreshCacheStatus();
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
  stopCaching();
  stopAllPurificationTasks();
  cancelPointer();
  resizeObserver?.disconnect();
  window.removeEventListener('blur', cancelPointer);
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
        <button v-if="!localBook" class="btn" title="换源" @click="changeSource">换源</button>
        <button v-if="!localBook" class="btn" title="缓存章节" :disabled="!toc.length || tocLoading" @click="openCache">缓存</button>
        <button class="btn" title="管理正文净化规则" @click="openPurification">净化</button>
        <button v-if="purification.enabled && rawContent" class="btn" @click="toggleOriginal">{{ showOriginal ? '恢复净化' : '查看原文' }}</button>
        <button class="btn" title="目录" @click="openToc">目录</button>
      </div>
    </div>

    <div ref="bodyEl" class="body"
      :style="{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight, color: settings.textColor || 'var(--text)', fontFamily: settings.fontFamily || undefined }"
      @scroll="onBodyScroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="cancelPointer"
      @click="onBodyClick"
    >
      <div v-if="tocLoading" class="state">正在加载目录…</div>
      <div v-else-if="tocError" class="state">
        <p>{{ tocError }}</p>
        <button class="btn" @click="refreshToc">重试</button>
        <button v-if="!localBook" class="btn" @click="changeSource">换源</button>
      </div>
      <div v-else-if="loading" class="state">加载中…</div>
      <div v-else-if="loadError" class="state">
        <p>{{ loadError }}</p>
        <button class="btn" @click="loadChapter(idx, true)">重试</button>
        <button v-if="!localBook" class="btn" @click="changeSource">换源</button>
      </div>
      <template v-else>
        <h2 class="ch-title">{{ chapterTitle }}</h2>
        <div v-if="purificationError" class="purification-notice">
          {{ purificationError }}
          <button class="btn" @click="retryPurification">重试</button>
          <button class="btn" @click="openPurification">管理规则</button>
        </div>
        <div v-if="displaySourceContent.trim() && !content.trim()" class="purified-empty">本章内容已被净化规则全部隐藏。<button class="btn" @click="toggleOriginal">查看原文</button></div>
        <p v-else v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</p>
        <div v-if="rawContent" class="end-pager">
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
          <button v-if="!localBook" class="btn" :disabled="tocLoading" title="重新拉取目录" @click="refreshToc">{{ tocLoading ? '刷新中…' : '刷新' }}</button>
        </div>
        <div class="toc-list">
          <div
            v-for="(c, i) in toc"
            :key="c.url + i"
            class="toc-item"
            :class="{ cur: i === idx }"
            @click="jump(i)"
          >
            <span>{{ c.title }}</span>
            <span v-if="!localBook && cachedUrls.has(c.url)" class="cached-mark">已缓存</span>
          </div>
        </div>
      </aside>
    </div>

    <div v-if="showCache" class="toc-mask cache-mask" @click.self="showCache = false">
      <aside class="cache-panel">
        <div class="toc-head">
          <span>缓存章节</span>
          <button class="btn" @click="showCache = false">关闭</button>
        </div>
        <div class="cache-body">
          <p>从当前第 {{ idx + 1 }} 章开始，包含当前章</p>
          <label class="cache-input-row">
            <span>缓存章数</span>
            <input v-model="cacheCountInput" class="cache-input" inputmode="numeric" :disabled="cacheRunning" aria-label="缓存章数">
          </label>
          <div class="cache-presets">
            <button v-for="n in [10, 50, 100]" :key="n" class="btn" :disabled="cacheRunning" @click="chooseCacheCount(n)">{{ n }}</button>
          </div>
          <p v-if="displayCacheRange" class="cache-note">本次范围：第 {{ displayCacheRange.start + 1 }}～{{ displayCacheRange.end + 1 }} 章，共 {{ displayCacheRange.total }} 章</p>
          <p v-else class="cache-error">请输入正整数章数</p>
          <p class="cache-note">本书当前书源已缓存：{{ cachedUrls.size }} 章</p>
          <template v-if="cacheProgress">
            <progress class="cache-progress" :max="cacheProgress.total" :value="cacheProgress.processed"></progress>
            <p>{{ cacheProgress.status === 'running' ? '缓存中' : cacheProgress.status === 'completed' ? '缓存完成' : cacheProgress.status === 'cancelled' ? '已停止' : '缓存失败' }}：{{ cacheProgress.processed }} / {{ cacheProgress.total }}</p>
            <p class="cache-note">新保存 {{ cacheProgress.saved }} 章 · 已有 {{ cacheProgress.skipped }} 章 · 失败 {{ cacheProgress.failed }} 章</p>
            <p v-if="cacheProgress.currentTitle" class="cache-note">正在缓存：{{ cacheProgress.currentTitle }}</p>
            <p v-if="cacheProgress.message" :class="cacheProgress.status === 'error' ? 'cache-error' : 'cache-note'">{{ cacheProgress.message }}</p>
          </template>
          <button v-if="cacheRunning" class="btn cache-main" @click="stopCaching">停止缓存</button>
          <button v-else class="btn cache-main" :disabled="!cacheRange || tocLoading" @click="startCaching">开始缓存</button>
          <p class="cache-hint">关闭此面板仍会继续；离开阅读页会停止任务，已保存章节会保留。</p>
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
  background: var(--overlay);
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.toc-item:hover {
  background: var(--bg-soft);
  color: var(--text);
}
.toc-item.cur {
  color: var(--accent);
  background: var(--accent-dim);
}
.toc-item > span:first-child { overflow: hidden; text-overflow: ellipsis; }
.cached-mark { flex: none; color: var(--accent); font-size: 11px; }
.cache-mask { z-index: 55; }
.cache-panel {
  width: min(330px, calc(100% - 24px));
  max-height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.cache-body { padding: 14px; overflow-y: auto; font-size: 13px; }
.cache-input-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cache-input {
  width: 96px;
  padding: 6px 8px;
  color: var(--text);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.cache-presets { display: flex; gap: 6px; margin: 10px 0; }
.cache-note, .cache-hint { color: var(--text-dim); }
.cache-error { color: var(--danger); }
.cache-progress { width: 100%; margin-top: 8px; accent-color: var(--accent); }
.cache-main { width: 100%; margin: 4px 0 10px; }
.cache-hint { font-size: 11px; line-height: 1.5; }
.purification-notice, .purified-empty {
  margin-bottom: 14px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-soft);
  color: var(--text-dim);
  font-size: 12px;
}
.purification-notice .btn, .purified-empty .btn { margin-left: 8px; }
</style>
