import { defineStore } from 'pinia';

/** 全局 UI 状态（不持久化） */
export const useUiStore = defineStore('ui', {
  state: () => ({
    /** 老板键状态：窗口处于幽灵隐藏中 */
    ghostHidden: false,
    trayReady: false,
    /** 设置面板 */
    panelOpen: false,
    panelTab: 'sources' as 'sources' | 'appearance' | 'window' | 'data' | 'about',
    /** 搜索弹窗 */
    searchOpen: false,
    /** 换源模式：带着书名预填搜索 */
    searchPreset: '',
    changeSourceBookId: null as string | null,
    readerRevision: 0,
    /** 轻提示 */
    toast: '',
    /** 正在阅读的书 id（null = 书架视图） */
    readingId: null as string | null,
  }),
  actions: {
    openBook(id: string) {
      this.readingId = id;
    },
    closeReading() {
      this.readingId = null;
    },
    showToast(msg: string, ms = 2200) {
      this.toast = msg;
      setTimeout(() => {
        if (this.toast === msg) this.toast = '';
      }, ms);
    },
    openPanel(tab?: typeof this.panelTab) {
      if (tab) this.panelTab = tab;
      this.panelOpen = true;
    },
    openSearch(preset = '', changeSourceBookId: string | null = null) {
      this.searchPreset = preset;
      this.changeSourceBookId = changeSourceBookId;
      this.searchOpen = true;
    },
  },
});
