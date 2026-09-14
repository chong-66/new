import { defineStore } from 'pinia';
import { readJson, writeJsonDebounced } from '../services/storage';
import { normalizeTheme, themeById, type ThemeId } from '../themes';

export interface AppSettings {
  /** 隐藏时不透明度 0-30（0 完全隐形） */
  hiddenOpacity: number;
  /** 鼠标移开自动隐藏（老板键） */
  autoHide: boolean;
  /** 窗口置顶 */
  alwaysOnTop: boolean;
  /** 仅显示托盘图标，关闭与最小化均收起窗口 */
  trayOnly: boolean;
  /** 窗口整体不透明度（常态显示时）20-100，默认100 */
  windowOpacity: number;
  /** 窗口背景不透明度 0-100，默认0（全透明） */
  bgOpacity: number;
  /** 阅读器 */
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  textColor: string;
  /** 滚动到底部自动加载下一章 */
  autoNextChapter: boolean;
  /** 点击正文上下半区滚动约 N 行。 */
  clickScrollEnabled: boolean;
  clickScrollLines: number;

  chapterCacheCount: number;
  /** 阅读主题 */
  theme: ThemeId;
  /** 隐藏窗口边框 */
  hideBorder: boolean;
}

const DEFAULTS: AppSettings = {
  hiddenOpacity: 15,
  autoHide: true,
  alwaysOnTop: true,
  trayOnly: false,
  windowOpacity: 100,
  bgOpacity: 0,
  fontSize: 18,
  lineHeight: 1.9,
  fontFamily: '',
  textColor: '',
  autoNextChapter: false,
  clickScrollEnabled: false,
  clickScrollLines: 5,
  chapterCacheCount: 50,
  theme: 'dark',
  hideBorder: false,
};

export const useSettingsStore = defineStore('settings', {
  state: (): AppSettings & { loaded: boolean } => ({ ...DEFAULTS, loaded: false }),
  actions: {
    async load() {
      const raw = await readJson<Partial<AppSettings>>('settings.json', {});
      const saved = raw && typeof raw === 'object' ? raw : {};
      // 只保留已知字段（清理已移除的旧字段残留）
      for (const k of Object.keys(saved)) if (!(k in DEFAULTS)) delete (saved as any)[k];
      Object.assign(this, DEFAULTS, saved);
      this.theme = normalizeTheme(this.theme);
      if (this.textColor === '#d8d8de') this.textColor = '';
      const background = Number(this.bgOpacity);
      this.bgOpacity = Math.min(100, Math.max(themeById(this.theme).minimumBackgroundOpacity, Number.isFinite(background) ? background : 0));
      const opacity = Number(this.windowOpacity);
      this.windowOpacity = Math.min(100, Math.max(20, Number.isFinite(opacity) ? opacity : 100));
      this.fontSize = Math.min(28, Math.max(14, Number(this.fontSize) || 18));
      this.lineHeight = Math.min(2.6, Math.max(1.4, Number(this.lineHeight) || 1.9));
      this.loaded = true;
      this.clickScrollEnabled = this.clickScrollEnabled === true;
      const clickLines = Number(this.clickScrollLines);
      this.clickScrollLines = Number.isInteger(clickLines) ? Math.min(30, Math.max(1, clickLines)) : 5;
      this.chapterCacheCount = Number.isInteger(Number(this.chapterCacheCount)) && Number(this.chapterCacheCount) > 0
        ? Number(this.chapterCacheCount) : 50;
      this.$subscribe((mut, state) => {
        const { loaded, ...data } = state;
        writeJsonDebounced('settings.json', data);
      });
    },
  },
  getters: {
    ghostAlpha(): number {
      return Math.min(30, Math.max(0, this.hiddenOpacity)) / 100;
    },
  },
});
