<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useUiStore } from '../stores/ui';
import { useSourcesStore } from '../stores/sources';
import { useLibraryStore } from '../stores/library';
import { searchAll, getBookInfo, getToc, searchResultKey } from '../engine/source';
import { matchChapter } from '../services/reading';
import type { SearchResult, Chapter } from '../types';
import BookCover from '../components/BookCover.vue';

const ui = useUiStore();
const sources = useSourcesStore();
const library = useLibraryStore();

const key = ref(ui.searchPreset);
const searching = ref(false);
const done = ref(0);
const total = ref(0);
const allResults = ref<SearchResult[]>([]);
const failed = ref<string[]>([]);
const sourceFilter = ref('');  // 空=全部，否则为 bookSourceUrl
const searched = ref(false);
const displayCount = ref(10);
const inputEl = ref<HTMLInputElement>();
const listEl = ref<HTMLElement>();
const searchTerm = ref('');
const cancelled = ref(false);
const switching = ref(false);
const switchError = ref('');
const changeBook = computed(() => ui.changeSourceBookId ? library.byId(ui.changeSourceBookId) : undefined);
const selectedSources = ref<Record<string, string>>({});
const prepared = ref<{ result: SearchResult; chapters: Chapter[]; tocUrl: string; bookId: string; originalSource: string; originalUrl: string }>();
const selectedChapter = ref(0);
let searchController: AbortController | undefined;
let switchController: AbortController | undefined;
let searchRun = 0;
let disposed = false;

const groupKey = searchResultKey;
const variantKey = (r: SearchResult) => `${r.source.bookSourceUrl}|${r.bookUrl}`;

// 当前展示的结果（受 displayCount 控制）
const results = computed(() => allResults.value.slice(0, displayCount.value).map((group) => {
  const selected = group.alternatives?.find((r) => variantKey(r) === selectedSources.value[groupKey(group)]);
  return selected ? { ...selected, alternatives: group.alternatives } : group;
}));
const hasMore = computed(() => allResults.value.length > displayCount.value);

function inShelf(r: SearchResult) {
  return library.has(r.bookUrl, r.source.bookSourceUrl);
}

function loadMore() {
  displayCount.value = Math.min(allResults.value.length, displayCount.value + 10);
}

async function doSearch() {
  const k = key.value.trim();
  if (!k || switching.value) return;
  if (!sources.enabled.length) {
    ui.showToast('没有可用书源，请先在设置中导入');
    return;
  }
  searching.value = true;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const run = ++searchRun;
  cancelled.value = false;
  searchTerm.value = k;
  selectedSources.value = {};
  prepared.value = undefined;
  switchError.value = '';
  searched.value = true;
  allResults.value = [];
  failed.value = [];
  displayCount.value = 10;
  done.value = 0;
  total.value = sources.enabled.length;
  try {
    const r = await searchAll(sources.list, k, (_fresh, all, d, t) => {
      if (disposed || run !== searchRun) return;
      done.value = d;
      total.value = t;
      allResults.value = all;
    }, sourceFilter.value || undefined, controller.signal);
    if (disposed || run !== searchRun) return;
    allResults.value = r.results;
    failed.value = r.failed;
  } catch (e) {
    if (!controller.signal.aborted && !disposed && run === searchRun) ui.showToast(e instanceof Error ? e.message : '搜索失败');
  } finally {
    if (run === searchRun) searching.value = false;
  }
}

function stopSearch() {
  searchController?.abort();
  searchRun++;
  if (searching.value) cancelled.value = true;
  searching.value = false;
}

// 滚动到底部自动加载更多
function onScroll() {
  if (!listEl.value || !hasMore.value) return;
  const { scrollTop, scrollHeight, clientHeight } = listEl.value;
  if (scrollHeight - scrollTop - clientHeight < 80) {
    loadMore();
  }
}

function add(r: SearchResult) {
  library.addFromSearch(r);
  ui.showToast(`《${r.name}》已加入书架`);
}

async function read(r: SearchResult) {
  if (switching.value) return;
  if (changeBook.value) {
    const b = changeBook.value;
    if (b.sourceUrl === r.source.bookSourceUrl && b.bookUrl === r.bookUrl) {
      ui.showToast('当前正在使用此书源');
      return;
    }
    stopSearch();
    switching.value = true;
    switchError.value = '';
    prepared.value = undefined;
    const controller = new AbortController();
    switchController = controller;
    try {
      const originalSource = b.sourceUrl;
      const originalUrl = b.bookUrl;
      const oldToc = await library.getToc(b);
      controller.signal.throwIfAborted();
      const candidate = { ...b, bookUrl: r.bookUrl, sourceUrl: r.source.bookSourceUrl, tocUrl: '' };
      const info = await getBookInfo(r.source, r.bookUrl, candidate, controller.signal);
      candidate.tocUrl = info.tocUrl || '';
      const chapters = await getToc(r.source, candidate, controller.signal);
      controller.signal.throwIfAborted();
      if (!chapters.length) throw new Error('新书源没有解析到目录，已保留原书源');
      const title = b.progress.chapterTitle || oldToc?.[b.progress.chapterIndex]?.title || '';
      const index = matchChapter(chapters, title);
      prepared.value = { result: r, chapters, tocUrl: candidate.tocUrl, bookId: b.id, originalSource, originalUrl };
      selectedChapter.value = index >= 0 ? index : Math.min(b.progress.chapterIndex, chapters.length - 1);
      if (index >= 0 || (!b.lastReadTime && b.progress.chapterIndex === 0)) await commitSource();
    } catch (e) {
      if (!controller.signal.aborted && !disposed) switchError.value = e instanceof Error ? e.message : '换源失败，已保留原书源';
    } finally {
      if (!disposed) switching.value = false;
    }
    return;
  }
  const b = library.addFromSearch(r);
  close();
  ui.openBook(b.id);
}

async function commitSource() {
  const p = prepared.value;
  if (!p) return;
  const b = library.byId(p.bookId);
  if (!b || b.sourceUrl !== p.originalSource || b.bookUrl !== p.originalUrl) {
    switchError.value = '书籍状态已改变，请重新选择书源';
    return;
  }
  switching.value = true;
  try {
    await library.changeSource(b, p.result, p.tocUrl, p.chapters, selectedChapter.value);
    ui.readerRevision++;
    ui.openBook(b.id);
    prepared.value = undefined;
    switching.value = false;
    close();
    ui.showToast(`已换源，继续阅读第 ${selectedChapter.value + 1} 章`);
  } catch (e) {
    switchError.value = e instanceof Error ? e.message : '换源保存失败';
  } finally {
    switching.value = false;
  }
}

function close() {
  if (switching.value && prepared.value) return;
  stopSearch();
  switchController?.abort();
  ui.searchOpen = false;
  ui.searchPreset = '';
  ui.changeSourceBookId = null;
}

function onKey(e: KeyboardEvent) {
  if (!ui.panelOpen && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); }
}

onMounted(() => {
  inputEl.value?.focus();
  window.addEventListener('keydown', onKey, true);
  // 换源模式：预填书名直接搜
  if (key.value.trim()) doSearch();
});
onUnmounted(() => {
  disposed = true;
  stopSearch();
  switchController?.abort();
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <div class="bar">
        <select v-model="sourceFilter" class="srcsel" :disabled="searching || switching" aria-label="搜索书源">
          <option value="">全部书源 ({{ sources.enabled.length }})</option>
          <option v-for="s in sources.enabled" :key="s.bookSourceUrl" :value="s.bookSourceUrl">
            {{ s.bookSourceName }}
          </option>
        </select>
        <input
          ref="inputEl"
          v-model="key"
          :disabled="switching"
          class="kw"
          placeholder="书名 / 作者"
          @keydown.enter="doSearch"
        />
        <button class="btn primary" :disabled="switching" @click="searching ? stopSearch() : doSearch()">
          {{ searching ? '停止' : '搜索' }}
        </button>
        <button class="btn" @click="close">✕</button>
      </div>
      <div v-if="changeBook" class="status">为《{{ changeBook.name }}》换源 · 保留书架记录，匹配当前章节</div>
      <div v-if="switching" class="status" role="status">正在准备新书源…</div>
      <div v-if="switchError" class="status" role="alert">{{ switchError }}</div>
      <div v-if="prepared && !switching" class="chapter-choice">
        <p>未能唯一匹配当前章节，请选择继续阅读的位置：</p>
        <select v-model.number="selectedChapter" aria-label="换源后继续阅读的章节">
          <option v-for="(chapter, i) in prepared.chapters" :key="chapter.url" :value="i">{{ i + 1 }} · {{ chapter.title }}</option>
        </select>
        <button class="btn primary" @click="commitSource">确认换源</button>
        <button class="btn" @click="prepared = undefined">取消</button>
      </div>

      <div v-if="searching && allResults.length === 0" class="status">正在搜索 {{ done }}/{{ total }} 个书源…</div>
      <div v-else-if="searched && !allResults.length && !searching" class="status">
        {{ cancelled ? '搜索已停止' : `没有找到「${searchTerm}」` }}
        <span v-if="failed.length" class="dim">（{{ failed.length }} 个书源请求失败）</span>
      </div>
      <div v-else-if="searching || allResults.length" class="status">
        {{ searching ? `已搜 ${done}/${total} 个源 · ` : '' }}共 {{ allResults.length }} 条结果
        <span v-if="searching" class="dim">（仍在搜索...）</span>
        <span v-else-if="failed.length" class="dim">（{{ failed.length }} 个源失败）</span>
        <span v-if="cancelled" class="dim">（搜索已停止）</span>
      </div>
      <details v-if="failed.length" class="status">
        <summary>查看 {{ failed.length }} 个书源的失败原因</summary>
        <div v-for="(message, i) in failed" :key="i">{{ message }}</div>
      </details>

      <div ref="listEl" class="results" @scroll="onScroll">
        <div v-for="(r, i) in results" :key="r.source.bookSourceUrl + r.bookUrl + i" class="item">
          <div class="cover-wrap">
            <BookCover :url="r.coverUrl" :referer="r.bookUrl" :name="r.name" />
          </div>
          <div class="info">
            <div class="name">{{ r.name }}</div>
            <div class="meta">
              {{ r.author || '佚名' }}
              <span v-if="r.kind" class="kind">{{ r.kind }}</span>
            </div>
            <div class="intro">{{ r.intro || '暂无简介' }}</div>
            <select v-if="(r.alternatives?.length ?? 0) > 1" class="src" :value="variantKey(r)" :disabled="switching" aria-label="选择这本书的来源" @change="selectedSources[groupKey(r)] = ($event.target as HTMLSelectElement).value">
              <option v-for="variant in r.alternatives" :key="variantKey(variant)" :value="variantKey(variant)">{{ variant.source.bookSourceName }}</option>
            </select>
            <div v-else class="src">{{ r.source.bookSourceName }}</div>
          </div>
          <div class="ops">
            <template v-if="!changeBook">
              <button v-if="inShelf(r)" class="btn" disabled>已在架</button>
              <button v-else class="btn" @click="add(r)">＋书架</button>
            </template>
            <button class="btn primary" :disabled="switching" @click="read(r)">{{ changeBook ? '使用此源' : '阅读' }}</button>
          </div>
        </div>

        <button v-if="hasMore" class="more-row btn" @click="loadMore">加载更多（{{ displayCount }}/{{ allResults.length }}）</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chapter-choice { padding: 12px; display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
.chapter-choice p { width: 100%; }
.chapter-choice select { width: 100%; padding: 8px; }
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 60px 24px 24px;
  z-index: 100;
}
.panel {
  width: 100%;
  max-width: 560px;
  max-height: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}
.srcsel {
  max-width: 160px;
  padding: 6px 8px;
  font-size: 12px;
  flex: none;
}
.kw {
  flex: 1;
  min-width: 100px;
  padding: 6px 10px;
}
.status {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.dim {
  opacity: 0.7;
}
.results {
  overflow-y: auto;
  padding: 6px;
}
.item {
  display: flex;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
}
.item:hover {
  background: var(--bg-soft);
}
.cover-wrap {
  width: 46px;
  height: 62px;
  flex: none;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: var(--text-dim);
}
.kind {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  font-size: 11px;
}
.intro {
  font-size: 12px;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.src {
  font-size: 11px;
  color: var(--accent);
  opacity: 0.8;
}
.ops {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: center;
}
.more-row {
  padding: 10px;
  text-align: center;
}
</style>
