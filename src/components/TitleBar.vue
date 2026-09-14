<script setup lang="ts">
import { useUiStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { isTauri } from '../utils/env';
import { setInteracting } from '../composables/useWindowBehavior';

const ui = useUiStore();
const isDev = import.meta.env.DEV;
const settings = useSettingsStore();

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

async function onDragStart(e: MouseEvent) {
  if (!isTauri || e.button !== 0) return;
  // 双击标题栏切换最大化
  if (e.detail === 2) {
    (await win()).toggleMaximize().catch(() => {});
    return;
  }
  setInteracting(true);
  const up = () => {
    setInteracting(false);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mouseup', up);
  (await win()).startDragging().catch(() => setInteracting(false));
}

async function minimize() {
  if (settings.trayOnly && ui.trayReady) {
    (await win()).hide().catch(() => ui.showToast('收起窗口失败，请重试'));
    return;
  }
  (await win()).minimize().catch(() => {});
}
async function close() {
  (await win()).close().catch(() => ui.showToast('关闭窗口失败，请重试')); 
}
</script>

<template>
  <header class="titlebar" @mousedown="onDragStart">
    <div class="brand">
      <span v-if="isDev" class="dev-badge">开发版</span>
      <span class="name">透读</span>
    </div>
    <div class="actions" @mousedown.stop>
      <button class="tbtn" title="搜索" @click="ui.openSearch()">⌕</button>
      <button
        class="tbtn"
        :class="{ active: settings.alwaysOnTop }"
        title="置顶"
        @click="settings.alwaysOnTop = !settings.alwaysOnTop"
      >
        ↑
      </button>
      <button class="tbtn" title="设置" @click="ui.openPanel()">⚙︎</button>
      <template v-if="isTauri">
        <button class="tbtn" :title="settings.trayOnly && ui.trayReady ? '收起到托盘' : '最小化'" @click="minimize">—</button>
        <button class="tbtn close" :title="settings.trayOnly && ui.trayReady ? '收起到托盘' : '关闭'" @click="close">✕</button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 36px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--border);
  cursor: grab;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
.dev-badge {
  padding: 1px 5px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0;
}
}
.name {
  font-size: 13px;
  color: var(--text-dim);
  letter-spacing: 2px;
}
.actions {
  display: flex;
  gap: 2px;
}
.tbtn {
  width: 34px;
  height: 28px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
}
.tbtn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tbtn.active {
  color: var(--accent);
  background: var(--accent-dim);
}
.tbtn.close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
