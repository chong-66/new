/** 是否运行在 Tauri 环境中（浏览器预览时为 false，所有原生调用需先做此判断） */
export const isTauri = !!(window as any).__TAURI_INTERNALS__;
