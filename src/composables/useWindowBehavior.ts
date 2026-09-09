import { watch, onMounted, onUnmounted } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { isTauri } from '../utils/env';
import { getCurrentWindow } from '@tauri-apps/api/window';

let interacting = false;
export function setInteracting(v: boolean) { interacting = v; }

/** 鼠标移开后进入幽灵态的延迟（老板键要敏捷，但别快到掠过窗口就闪） */
const HIDE_DELAY = 200;

export function useWindowBehavior() {
  const settings = useSettingsStore();
  const ui = useUiStore();
  const win = isTauri ? getCurrentWindow() : undefined;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  async function setIgnore(v: boolean) {
    try { await win?.setIgnoreCursorEvents(v); } catch { /* ok */ }
  }

  function onLeave() {
    if (interacting || !settings.autoHide) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (settings.autoHide && !interacting) ui.ghostHidden = true;
    }, HIDE_DELAY);
  }

  function onEnter() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (ui.ghostHidden) { ui.ghostHidden = false; setIgnore(false); }
  }

  onMounted(() => {
    if (!isTauri) return;
    document.documentElement.addEventListener('mouseleave', onLeave);
    document.documentElement.addEventListener('mouseenter', onEnter);
    window.addEventListener('toudu:restore', onEnter);
  });

  // 不透明度：正常状态用 windowOpacity（背景透明，只显示文字）；幽灵态整体变淡
  watch(
    () => [ui.ghostHidden, settings.ghostAlpha, settings.windowOpacity] as const,
    ([hidden, ghost, opacity]) => {
      document.documentElement.style.setProperty('--app-alpha', String(hidden ? ghost : opacity / 100));
    },
    { immediate: true },
  );

  // 背景不透明度：0 = 全透明，100 = 主题色实底
  watch(
    () => settings.bgOpacity,
    (v) => {
      document.documentElement.style.setProperty('--bg-alpha', String(v / 100));
    },
    { immediate: true },
  );

  // 置顶
  watch(() => settings.alwaysOnTop, (v) => win?.setAlwaysOnTop(v).catch(() => {}), { immediate: true });
  watch(() => settings.autoHide, (enabled) => {
    if (!enabled) onEnter();
  });

  onUnmounted(() => {
    if (hideTimer) clearTimeout(hideTimer);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    document.documentElement.removeEventListener('mouseenter', onEnter);
    window.removeEventListener('toudu:restore', onEnter);
  });
}
