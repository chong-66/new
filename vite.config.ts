import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  // 防止 vite 掩盖 tauri 控制台的报错
  clearScreen: false,
  server: {
    // tauri 约定的开发端口
    port: 1420,
    strictPort: true,
  },
  build: {
    // webview2 (chromium) 支持较新的语法
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
  },
});
