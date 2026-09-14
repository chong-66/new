<script setup lang="ts">
import { ref, watch } from 'vue';
import { useUiStore } from './stores/ui';
import { useSettingsStore } from './stores/settings';
import TitleBar from './components/TitleBar.vue';
import ResizeHandles from './components/ResizeHandles.vue';
import BookshelfView from './views/BookshelfView.vue';
import ReaderView from './views/ReaderView.vue';
import SearchOverlay from './views/SearchOverlay.vue';
import SettingsPanel from './views/SettingsPanel.vue';
import { useWindowBehavior } from './composables/useWindowBehavior';
import { storageStatus, flushStorage } from './services/storage';

const ui = useUiStore();
const settings = useSettingsStore();
const readerChromeVisible = ref(false);

function trackReaderChrome(event: PointerEvent) {
  if (!ui.readingId) return;
  readerChromeVisible.value = event.clientY <= 96;
}

watch(() => ui.readingId, (readingId) => {
  readerChromeVisible.value = !!readingId;
});


// 透明窗口行为
useWindowBehavior();

// 主题切换
watch(() => settings.theme, (t) => {
  document.documentElement.dataset.theme = t;
}, { immediate: true });
</script>

<template>
  <div class="app-root" :class="{ ghost: ui.ghostHidden, 'no-border': settings.hideBorder, 'reader-mode': !!ui.readingId, 'reader-chrome-visible': readerChromeVisible }" @pointermove="trackReaderChrome" @pointerleave="readerChromeVisible = false">
    <TitleBar />
    <main class="main">
      <BookshelfView v-if="!ui.readingId" />
      <ReaderView v-else :key="ui.readingId + ':' + ui.readerRevision" />
    </main>

    <SearchOverlay v-if="ui.searchOpen" />
    <SettingsPanel v-if="ui.panelOpen" />
    <ResizeHandles v-if="!ui.ghostHidden" />
    <div v-if="storageStatus.error" class="storage-notice" role="alert">
      {{ storageStatus.error }}
      <button class="btn" @click="flushStorage().catch(() => {})">重试保存</button>
    </div>
    <div v-else-if="storageStatus.recovered" class="storage-notice" role="status">
      {{ storageStatus.recovered }}
      <button class="btn" @click="storageStatus.recovered = ''">知道了</button>
    </div>

    <transition name="fade">
      <div v-if="ui.toast" class="toast">{{ ui.toast }}</div>
    </transition>
  </div>
</template>

<style>
.storage-notice { position: fixed; bottom: 8px; left: 8px; right: 8px; padding: 10px; background: var(--bg); color: var(--text); border: 1px solid var(--danger); border-radius: 6px; z-index: 250; font-size: 12px; }
.app-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  /* 背景默认全透明：只显示文字与控件，透出下层窗口；bgOpacity>0 时叠加主题色底 */
  background: rgba(var(--bg-rgb), var(--bg-alpha));
  border: var(--app-border, 1px solid var(--border));
  border-radius: var(--app-radius, var(--radius));
  overflow: hidden;
  opacity: var(--app-alpha);
  transition: opacity 0.18s ease;
}
.app-root.ghost {
  border-color: transparent;
}
.app-root.reader-mode > .titlebar {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.app-root.reader-mode.reader-chrome-visible > .titlebar {
  opacity: 1;
  pointer-events: auto;
}
.app-root.reader-mode .subbar {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.app-root.reader-mode.reader-chrome-visible .subbar {
  opacity: 1;
  pointer-events: auto;
}

/* 隐藏边框：去掉外框、圆角以及标题栏/副栏分隔线，完全无缝 */
.app-root.no-border {
  border: none;
  border-radius: 0;
}
.app-root.no-border .titlebar,
.app-root.no-border .subbar {
  border-bottom-color: transparent;
}
.main {
  flex: 1;
  min-height: 0;
  position: relative;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 8px;
  background: var(--toast-bg);
  border: 1px solid var(--border);
  color: var(--toast-text);
  font-size: 13px;
  z-index: 200;
  pointer-events: none;
  white-space: nowrap;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
