import { nextTick, watch } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defaultWindowIcon } from '@tauri-apps/api/app';
import { Menu } from '@tauri-apps/api/menu';
import { TrayIcon } from '@tauri-apps/api/tray';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { flushStorage } from './storage';
import { createWindowCloseController } from './windowClose';
import { stopAllChapterCacheTasks } from './chapterCacheTask';

import { stopAllPurificationTasks } from './purificationTask';
import { waitForLocalBookWrites } from './localBooks';
import { stopTxtImportTask } from './txtImportTask';
import { preparePendingChangesForQuit } from './pendingChanges';
export async function initializeTray() {
  const win = getCurrentWindow();
  const settings = useSettingsStore();
  const ui = useUiStore();
  async function restore() {
    window.dispatchEvent(new Event('toudu:restore'));
    ui.ghostHidden = false;
    await win.setIgnoreCursorEvents(false);
    await win.show();
    await win.unminimize();
    await win.setFocus();
  }
  const controller = createWindowCloseController({
    trayOnly: () => ui.trayReady && settings.trayOnly,
    hide: () => win.hide(),
    save: async () => { await preparePendingChangesForQuit(); stopTxtImportTask(); stopAllPurificationTasks(); await Promise.all([stopAllChapterCacheTasks(), waitForLocalBookWrites()]); await nextTick(); await flushStorage(); },
    // 保存完成后直接销毁，避免重复触发关闭事件。
    close: () => win.destroy(),
    failed: async () => {
      await restore().catch(() => {});
      ui.showToast('关闭未完成，窗口已保留，请检查保存提示后重试', 6000);
    },
  });
  await win.onCloseRequested(controller.onCloseRequested);
  const run = (action: () => Promise<unknown>) => () => {
    void action().catch(() => ui.showToast('窗口操作失败，请重试'));
  };
  try {
    const icon = await defaultWindowIcon();
    if (!icon) throw new Error('缺少托盘图标');
    const menu = await Menu.new({ items: [
      { id: 'show', text: '显示窗口', action: run(restore) },
      { id: 'hide', text: '收起到托盘', action: run(() => win.hide()) },
      { id: 'settings', text: '设置', action: run(async () => { await restore(); ui.openPanel('window'); }) },
      { id: 'quit', text: '退出透读', action: run(() => controller.request(true)) },
    ] });
    await TrayIcon.new({
      id: 'toudu-tray', icon, menu, tooltip: '透读 · 点击显示，右键打开菜单',
      showMenuOnLeftClick: false,
      action: (event) => {
        if (event.type === 'Click' && event.button === 'Left' && event.buttonState === 'Up') run(restore)();
      },
    });
    ui.trayReady = true;
  } catch (error) {
    console.error('托盘初始化失败', error);
    settings.trayOnly = false;
    ui.showToast('系统托盘创建失败，已保留任务栏图标', 6000);
    return;
  }
  // 串行更新，快速切换时最终状态始终与设置一致。
  let pending = Promise.resolve();
  let applied = false;
  watch(() => settings.trayOnly, (enabled) => {
    pending = pending.then(async () => {
      if (enabled === applied) return;
      try { await win.setSkipTaskbar(enabled); applied = enabled; }
      catch {
        if (settings.trayOnly === enabled) settings.trayOnly = applied;
        ui.showToast('任务栏显示设置失败，已恢复原设置', 5000);
      }
    });
  }, { immediate: true });
}
