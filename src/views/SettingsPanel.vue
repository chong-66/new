<script setup lang="ts">
import { computed, reactive, ref, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useSourcesStore } from '../stores/sources';
import { useLibraryStore } from '../stores/library';

const ui = useUiStore();
const settings = useSettingsStore();
const sources = useSourcesStore();
const library = useLibraryStore();

const tabs = [
  { key: 'sources', label: '书源' },
  { key: 'appearance', label: '外观' },
  { key: 'window', label: '窗口' },
  { key: 'data', label: '数据' },
  { key: 'about', label: '关于' },
] as const;

const tab = computed({
  get: () => ui.panelTab,
  set: (v) => (ui.panelTab = v),
});

// ---- 书源导入
import type { BookSource } from '../types';
import { parseSourceText } from '../stores/sources';

const importUrl = ref('');
const pasteText = ref('');
const importing = ref(false);
const importMsg = ref('');
const previewSources = ref<BookSource[]>([]);
const selected = reactive(new Set<number>());
const selectedCount = computed(() => selected.size);

function toggleSelect(i: number) {
  if (selected.has(i)) selected.delete(i);
  else selected.add(i);
}
function selectAll() {
  previewSources.value.forEach((_, i) => selected.add(i));
}
function selectNone() {
  selected.clear();
}

// 解析预览（不导入）
function doPreviewText() {
  const text = pasteText.value.trim();
  if (!text) return;
  previewSources.value = parseSourceText(text);
  selected.clear();
  previewSources.value.forEach((_, i) => selected.add(i));
  importMsg.value = '';
}

// 直接粘贴导入（旧行为）
function doImportText() {
  if (!pasteText.value.trim()) return;
  const r = sources.importText(pasteText.value);
  importMsg.value = r.message;
  if (r.added) pasteText.value = '';
}

// 直接网络导入（旧行为）
async function doImportUrl() {
  const url = importUrl.value.trim();
  if (!url || importing.value) return;
  importing.value = true;
  importMsg.value = '正在拉取…';
  try {
    const r = await sources.importFromUrl(url);
    importMsg.value = r.message;
    if (r.added) importUrl.value = '';
  } catch {
    importMsg.value = '拉取失败：网络错误或不支持的地址';
  } finally {
    importing.value = false;
  }
}

// URL 预览（先拉取展示，不直接导入）
async function doFetchPreview() {
  const url = importUrl.value.trim();
  if (!url || importing.value) return;
  importing.value = true;
  importMsg.value = '正在拉取…';
  try {
    const { fetchText: ft } = await import('../engine/http');
    const text = await ft(url);
    previewSources.value = parseSourceText(text);
    selected.clear();
    previewSources.value.forEach((_, i) => selected.add(i));
    importMsg.value = `拉取成功，解析到 ${previewSources.value.length} 个书源`;
    importUrl.value = '';
  } catch {
    importMsg.value = '拉取失败：网络错误或不支持的地址';
  } finally {
    importing.value = false;
  }
}

// 预览后导入选中
function doImportSelected() {
  if (selectedCount.value === 0) return;
  const toImport = previewSources.value.filter((_, i) => selected.has(i));
  const r = sources.importList(toImport);
  importMsg.value = r.message;
  if (r.added) {
    previewSources.value = [];
    selected.clear();
    pasteText.value = '';
  }
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- 数据
function clearShelf() {
  if (window.confirm('清空书架？阅读进度会一并删除')) library.clear();
}
function clearSources() {
  if (window.confirm('清空全部书源？')) sources.clear();
}

function close() {
  ui.panelOpen = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onUnmounted(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <nav class="side">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
        <div class="spacer" />
        <button class="tab" @click="close">关闭</button>
      </nav>

      <div class="content">
        <!-- 书源管理 -->
        <template v-if="tab === 'sources'">
          <h3>书源 <span class="dim">共 {{ sources.list.length }} 个，启用 {{ sources.enabled.length }} 个</span></h3>
          <div class="row">
            <input v-model="importUrl" placeholder="书源订阅地址 http(s)://…" @keydown.enter="doImportUrl" />
            <button class="btn primary" :disabled="importing" @click="doImportUrl">网络导入</button>
            <button class="btn" :disabled="importing || !importUrl.trim()" @click="doFetchPreview">预览</button>
          </div>
          <textarea
            v-model="pasteText"
            rows="3"
            placeholder="或粘贴阅读 3.0 书源 JSON（数组 / 单条 / 逐行 JSON 均可）"
          ></textarea>
          <div class="row">
            <button class="btn primary" :disabled="!pasteText.trim()" @click="doImportText">粘贴导入</button>
            <button class="btn" :disabled="!pasteText.trim()" @click="doPreviewText">预览</button>
            <span class="msg">{{ importMsg }}</span>
          </div>

          <!-- 预览面板：勾选要导入的书源 -->
          <div v-if="previewSources.length" class="preview-box">
            <div class="preview-head">
              <span>解析到 {{ previewSources.length }} 个书源，已选 {{ selectedCount }}</span>
              <div class="preview-ops">
                <button class="btn" @click="selectAll">全选</button>
                <button class="btn" @click="selectNone">取消</button>
              </div>
            </div>
            <div class="preview-list">
              <label
                v-for="(s, i) in previewSources"
                :key="s.bookSourceUrl"
                class="preview-item"
                :class="{ off: s.bookSourceType && s.bookSourceType !== 0 }"
              >
                <input type="checkbox" :checked="selected.has(i)" @change="toggleSelect(i)" />
                <div class="sinfo">
                  <div class="sname">
                    {{ s.bookSourceName }}
                    <span v-if="s.bookSourceGroup" class="grp">{{ s.bookSourceGroup }}</span>
                    <span v-if="s.bookSourceType && s.bookSourceType !== 0" class="tag">非文本</span>
                  </div>
                  <div class="surl">{{ host(s.bookSourceUrl) }}</div>
                </div>
              </label>
            </div>
            <div class="row">
              <button class="btn primary" :disabled="selectedCount === 0" @click="doImportSelected">
                导入选中 ({{ selectedCount }})
              </button>
              <button class="btn" @click="previewSources = []; selected.clear()">关闭</button>
            </div>
          </div>
          <div class="src-list">
            <div v-for="(s, i) in sources.list" :key="s.bookSourceUrl" class="src" :class="{ off: s.enabled === false }">
              <button class="switch" :aria-label="`${s.enabled === false ? '启用' : '停用'}${s.bookSourceName}`" :class="{ on: s.enabled !== false }" @click="sources.toggle(i)" />
              <div class="sinfo">
                <div class="sname">
                  {{ s.bookSourceName }}
                  <span v-if="s.bookSourceGroup" class="grp">{{ s.bookSourceGroup }}</span>
                </div>
                <div class="surl">{{ host(s.bookSourceUrl) }}</div>
              </div>
              <button class="del" title="删除" @click="sources.remove(i)">✕</button>
            </div>
            <div v-if="!sources.list.length" class="dim empty-tip">还没有书源，先从上方导入</div>
          </div>
          <div class="row end">
            <button class="btn danger" :disabled="!sources.list.length" @click="clearSources">清空书源</button>
          </div>
        </template>

        <!-- 外观 -->
        <template v-else-if="tab === 'appearance'">
          <h3>外观</h3>
          <label class="field">
            <span>隐藏时残影（0 = 完全隐形）</span>
            <div class="slider-row">
              <input v-model.number="settings.hiddenOpacity" type="range" min="0" max="30" />
              <span class="val">{{ settings.hiddenOpacity }}%</span>
            </div>
          </label>
          <label class="field">
            <span>正文字号</span>
            <div class="slider-row">
              <input v-model.number="settings.fontSize" type="range" min="14" max="28" />
              <span class="val">{{ settings.fontSize }}</span>
            </div>
          </label>
          <label class="field">
            <span>正文行高</span>
            <div class="slider-row">
              <input v-model.number="settings.lineHeight" type="range" min="1.4" max="2.6" step="0.1" />
              <span class="val">{{ settings.lineHeight.toFixed(1) }}</span>
            </div>
          </label>
          <label class="field">
            <span>正文颜色</span>
            <div class="row">
              <input :value="settings.textColor || (settings.theme === 'dark' ? '#d8d8de' : settings.theme === 'sepia' ? '#5b4636' : '#1a1a2e')" type="color" class="color" @input="settings.textColor = ($event.target as HTMLInputElement).value" />
              <button class="btn" @click="settings.textColor = ''">跟随主题</button>
            </div>
          </label>
          <label class="field">
            <span>正文字体（留空用系统默认）</span>
            <input v-model="settings.fontFamily" placeholder="如：思源宋体, serif" />
          </label>
          <div
            class="preview"
            :style="{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight, color: settings.textColor || 'var(--text)', fontFamily: settings.fontFamily || undefined }"
          >
            纸上得来终觉浅，绝知此事要躬行。
          </div>
          <label class="field">
            <span>阅读主题</span>
            <div class="theme-row">
              <button class="theme-card" :class="{ on: settings.theme === 'dark' }" @click="settings.theme = 'dark'">
                <span class="swatch dark"></span> 暗色
              </button>
              <button class="theme-card" :class="{ on: settings.theme === 'light' }" @click="settings.theme = 'light'">
                <span class="swatch light"></span> 亮色
              </button>
              <button class="theme-card" :class="{ on: settings.theme === 'sepia' }" @click="settings.theme = 'sepia'">
                <span class="swatch sepia"></span> 护眼
              </button>
            </div>
          </label>
        </template>

        <!-- 窗口 -->
        <template v-else-if="tab === 'window'">
          <h3>窗口行为</h3>
          <div class="opt">
            <div>
              <div>仅显示在系统托盘</div>
              <div class="desc">隐藏任务栏图标；关闭或最小化时收起，点击托盘图标恢复，右键菜单退出。{{ ui.trayReady ? '' : '仅桌面版托盘就绪后可用。' }}</div>
            </div>
            <button class="switch" role="switch" aria-label="仅显示在系统托盘" :aria-checked="settings.trayOnly" :disabled="!ui.trayReady" :class="{ on: settings.trayOnly }" @click="settings.trayOnly = !settings.trayOnly" />
          </div>
          <label class="opt">
            <div>
              <div>鼠标移开自动隐藏</div>
              <div class="desc">光标离开窗口约 0.2 秒后整体变淡，移回立即唤醒</div>
            </div>
            <button class="switch" :class="{ on: settings.autoHide }" @click="settings.autoHide = !settings.autoHide" />
          </label>
          <label class="opt">
            <div>
              <div>窗口置顶</div>
              <div class="desc">始终显示在其他窗口上方</div>
            </div>
            <button class="switch" :class="{ on: settings.alwaysOnTop }" @click="settings.alwaysOnTop = !settings.alwaysOnTop" />
          </label>
          <label class="field">
            <span>窗口不透明度</span>
            <div class="slider-row">
              <input v-model.number="settings.windowOpacity" type="range" min="20" max="100" />
              <span class="val">{{ settings.windowOpacity }}%</span>
            </div>
          </label>
          <label class="field">
            <span>背景不透明度</span>
            <div class="slider-row">
              <input v-model.number="settings.bgOpacity" type="range" min="0" max="100" />
              <span class="val">{{ settings.bgOpacity }}%</span>
            </div>
          </label>
          <label class="opt">
            <div>
              <div>滚动自动下一章</div>
              <div class="desc">阅读正文滚动到底部时自动加载下一章</div>
            </div>
            <button class="switch" :class="{ on: settings.autoNextChapter }" @click="settings.autoNextChapter = !settings.autoNextChapter" />
          </label>
          <label class="opt">
            <div>
              <div>隐藏窗口边框</div>
              <div class="desc">移除圆角边框，实现完全无缝的透明窗口</div>
            </div>
            <button class="switch" :class="{ on: settings.hideBorder }" @click="settings.hideBorder = !settings.hideBorder" />
          </label>
        </template>

        <!-- 数据 -->
        <template v-else-if="tab === 'data'">
          <h3>数据</h3>
          <p class="dim para-tip">
            书架、书源、设置与目录缓存保存在系统应用数据目录（%APPDATA%\com.toudu.app）。
          </p>
          <div class="row">
            <button class="btn danger" :disabled="!library.books.length" @click="clearShelf">清空书架（{{ library.books.length }}）</button>
            <button class="btn danger" :disabled="!sources.list.length" @click="clearSources">清空书源（{{ sources.list.length }}）</button>
          </div>
        </template>

        <!-- 关于 -->
        <template v-else>
          <h3>透读 TouDu</h3>
          <p class="dim para-tip">v0.1.3 · 透明背景极简桌面小说阅读器</p>
          <p class="dim para-tip">兼容阅读 3.0 JSON 书源（文本类型）。支持搜索、目录、正文分页规则与 JS 规则。</p>
          <p class="dim para-tip">快捷键：← 上一章，→ 下一章，Esc 返回书架。</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 24px;
  z-index: 100;
}
.panel {
  width: 100%;
  max-width: 620px;
  height: 100%;
  max-height: 480px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  overflow: hidden;
}
.side {
  width: 92px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-right: 1px solid var(--border);
}
.spacer {
  flex: 1;
}
.tab {
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
  color: var(--text-dim);
}
.tab:hover {
  background: var(--bg-soft);
}
.tab.on {
  background: var(--accent-dim);
  color: var(--accent);
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h3 {
  font-size: 15px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 400;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row input {
  flex: 1;
  padding: 6px 10px;
}
.row.end {
  justify-content: flex-end;
}
textarea {
  resize: vertical;
  padding: 8px 10px;
  font-size: 12px;
  user-select: text;
}
.msg {
  font-size: 12px;
  color: var(--accent);
}
.src-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}
.src {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
}
.src:hover {
  background: var(--bg-soft);
}
.src.off .sname,
.src.off .surl {
  opacity: 0.45;
}
.sinfo {
  flex: 1;
  min-width: 0;
}
.sname {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grp {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.surl {
  font-size: 11px;
  color: var(--text-dim);
}
.del {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: var(--text-dim);
  font-size: 11px;
  opacity: 0;
}
.src:hover .del {
  opacity: 1;
}
.del:hover {
  background: var(--danger);
  color: #fff;
}
.empty-tip {
  padding: 16px;
  text-align: center;
}
.preview-box {
  border: 1px solid var(--accent);
  border-radius: 8px;
  overflow: hidden;
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--accent-dim);
  font-size: 13px;
}
.preview-ops {
  display: flex;
  gap: 4px;
}
.preview-list {
  max-height: 180px;
  overflow-y: auto;
  padding: 4px;
}
.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.preview-item:hover {
  background: var(--bg-soft);
}
.preview-item.off {
  opacity: 0.5;
}
.preview-item input[type='checkbox'] {
  flex: none;
  accent-color: var(--accent);
}
.tag {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.field > span {
  color: var(--text);
}
.color {
  width: 56px;
  height: 28px;
  padding: 2px;
}
.field input:not([type='range']):not([type='color']) {
  padding: 6px 10px;
}
.preview {
  margin-top: 4px;
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  user-select: text;
}
.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--bg-soft);
  cursor: pointer;
}
.desc {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}
.theme-row {
  display: flex;
  gap: 8px;
}
.theme-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  font-size: 13px;
  color: var(--text-dim);
  transition: all 0.15s;
}
.theme-card:hover {
  background: var(--bg-hover);
}
.theme-card.on {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
}
.swatch {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex: none;
}
.swatch.dark { background: #16161c; border: 1px solid rgba(255,255,255,0.15); }
.swatch.light { background: #f5f5f5; border: 1px solid rgba(0,0,0,0.15); }
.swatch.sepia { background: #f4ecd8; border: 1px solid rgba(139,109,70,0.3); }
.para-tip {
  line-height: 1.7;
}
</style>
