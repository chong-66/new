import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import { useSettingsStore } from './stores/settings';
import { useSourcesStore } from './stores/sources';
import { useLibraryStore } from './stores/library';
import { flushStorage } from './services/storage';
import { useUiStore } from './stores/ui';
import { isTauri } from './utils/env';
import { initializeTray } from './services/tray';
import { usePurificationStore } from './stores/purification';
import { stopAllPurificationTasks } from './services/purificationTask';
import { waitForLocalBookWrites } from './services/localBooks';
import { stopTxtImportTask } from './services/txtImportTask';
import { stopAllChapterCacheTasks } from './services/chapterCacheTask';

const app = createApp(App);
app.use(createPinia());
async function start() {
  // 加载完成后才允许操作，避免初始化覆盖刚导入的书源或阅读进度。
  await Promise.all([useSettingsStore().load(), useSourcesStore().load(), useLibraryStore().load(), usePurificationStore().load()]);
  if (isTauri) {
    await initializeTray();
  }
  window.addEventListener('pagehide', () => {
    stopAllPurificationTasks();
    stopTxtImportTask();
    void Promise.all([stopAllChapterCacheTasks(), waitForLocalBookWrites()]).then(() => flushStorage()).catch(() => {});
  });
  app.mount('#app');
}

void start().catch((e) => {
  console.error('初始化失败', e);
  app.mount('#app');
  useUiStore().showToast('初始化未完成，请检查本地数据后重新打开', 8000);
});
