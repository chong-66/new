# CLAUDE.md — 透读 (TouDu) 开发文档

> Tauri v2 + Vue 3 透明桌面小说阅读器。兼容阅读 3.0 JSON 书源。仅 Windows / 仅文本小说。

## 快速启动

```bash
cd d:/toudu
npm install && npm run icon && npm run tauri:dev
```

环境：Node ≥18、Rust 1.97+（MSVC）、VS 2022 Build Tools（C++ + Win11 SDK）、Win11 自带 WebView2。
Cargo 国内镜像：`~/.cargo/config.toml` → `rsproxy.cn`。

## 目录结构

```
d:/toudu/
├── package.json / tsconfig.json / vite.config.ts / index.html
├── src/
│   ├── main.ts              # 入口：createApp + Pinia + 异步加载3个store
│   ├── App.vue              # 根：TitleBar + 视图切换(readingId) + 弹窗 + 边框控制
│   ├── style.css            # 全局 CSS变量 + 3套主题(dark/light/sepia) + 通用组件
│   ├── types.ts             # BookSource / Book / Chapter / SearchResult
│   ├── engine/              # 书源引擎
│   │   ├── rule.ts          # 规则解析：CSS管道链 / XPath / JSONPath / JS / 过滤器
│   │   ├── source.ts        # 业务编排：搜索/详情/目录/正文 + 去重
│   │   ├── http.ts          # Tauri HTTP + GBK嗅探
│   │   ├── template.ts      # URL模板 {{key}} + 逗号options
│   │   ├── jsonpath.ts      # JSONPath子集
│   │   └── cover.ts         # 封面图缓存 + 防盗链
│   ├── stores/              # Pinia (都持久化到 %APPDATA%/com.toudu.app/)
│   │   ├── library.ts       # 书架 + 目录缓存
│   │   ├── sources.ts       # 书源管理 + parseSourceText
│   │   ├── settings.ts      # 外观/窗口/阅读设置
│   │   └── ui.ts            # 瞬时UI状态(仅内存)
│   ├── services/storage.ts  # Tauri FS + localStorage降级 + 防抖写入
│   ├── composables/
│       │   └── useWindowBehavior.ts  # 窗口：自动隐藏/置顶/不透明度
│   ├── components/          # TitleBar / ResizeHandles / BookCover
│   └── views/               # Bookshelf / Reader / SearchOverlay / SettingsPanel
└── src-tauri/               # Rust端（最小化）
    ├── Cargo.toml / tauri.conf.json / capabilities/default.json
    ├── icons/               # 各尺寸图标
    └── src/main.rs          # 10行：注册http+fs插件
```

## 窗口行为（重要）

`useWindowBehavior.ts` 是整个透明窗口的核心。**当前方案使用原生 DOM 事件，不依赖 Tauri 的 cursorPosition API**：

```
mouseleave on <html>  —→ 200ms延迟 → ghostHidden=true → 窗口变淡(ghostAlpha)
mouseenter on <html>  —→ 立即 ghostHidden=false → 窗口恢复(完全不透明)

窗口背景完全透明（.app-root background: transparent），只渲染文字与控件
正文带 --text-glow 衬影（随主题切换）保证在任意背景下可读
弹窗类（搜索/设置/目录）保留不透明面板底色，不受影响

窗口不响应任何鼠标穿透（setIgnoreCursorEvents 永不启用）
幽灵态不设穿透，保证 mouseenter 能正常触发唤醒

alwaysOnTop 跟随 settings.alwaysOnTop
--app-alpha 跟随 ghostHidden ? ghostAlpha : windowOpacity/100
```

**注意：** 这是 `mouseleave`/`mouseenter` 方案，不是轮询方案。窗口保持可交互，不会出现"醒不来"的死锁。

### 已知限制

- `setIgnoreCursorEvents(true)` 永不启用（穿透模式已移除：该模式下窗口收不到任何事件，无法操作）
- "隐藏时鼠标穿透"设置已移除（该方案会导致 mouseenter 无法触发）

## 设置字段 (settings.json)

```typescript
{
  hiddenOpacity: number;    // 隐藏时残影 0-30，默认15
  autoHide: boolean;        // 鼠标移开自动隐藏，默认true
  alwaysOnTop: boolean;     // 窗口置顶，默认true
  windowOpacity: number;    // 窗口整体不透明度 20-100，默认100
  bgOpacity: number;        // 窗口背景不透明度 0-100，默认0（全透明）
  fontSize: number;         // 正文字号 14-28，默认18
  lineHeight: number;       // 行高 1.4-2.6，默认1.9
  fontFamily: string;       // 字体，默认系统
  textColor: string;        // 文字颜色，默认#d8d8de
  autoNextChapter: boolean; // 滚动自动下一章，默认false
  theme: 'dark'|'light'|'sepia'; // 阅读主题，默认dark
  hideBorder: boolean;      // 隐藏窗口边框+圆角，默认false
}
```

## 规则引擎

### 支持语法

| 语法 | 示例 | 说明 |
|------|------|------|
| `\|\|` | `div.list\|\|div.result` | 回退 |
| `&&` | `a&&b` | 拼接 |
| `##` | `rule##正##替换` | 正则替换 |
| 管道链 `@` | `ul@li!-1@a` | 取子元素 |
| `.N` / `.-N` | `tag.dd.1` | 位置索引(0-based) |
| `!N` / `!-N` | `!2`=跳过前2个 | 过滤器 |
| `@XPath:` | `@XPath://div[@class]` | XPath |
| `@JSon:` / `@JSON:` | `@JSon:$.data[*]` | JSONPath |
| `@JS:` | `@JS:result.map(...)` | JS代码 |
| `<js>...</js>` | `<js>java.ajax(url)</js>` | 整段JS |
| `{$.path}` | `/api?id={$.id}` | JSONPath URL占位符 |
| `class.`/`id.`/`tag.` | `class.books`→`.books` | CSS简写 |
| `@text`/`@href`/`@html` | `a@href` | 属性提取 |

### JS API

```
java.ajax(url) / java.base64Encode(s) / java.base64Decode(s)
java.toast(msg) / java.put(k,v) / java.get(k)
java.md5Encode(s) → 未实现，抛异常
source.getKey() → bookSourceUrl
source.getVariable() / source.setVariable() → 桩
source.getLoginInfoMap() → {}
getServerHost() → 源host
key, page, result, baseUrl → 上下文变量
```

### 已知限制

- `java.md5Encode` 未实现
- `@put`/`@get` 跨规则传值不支持
- cookie 持久化不支持
- `text.` 文本节点前缀不支持

## 搜索流程

```
SearchOverlay → searchAll(list, key, onResult, sourceFilter?)
  → 4并发 searchSource(source, key)
    → JS URL执行 / 模板展开 / 相对URL解析 / ,{options}拆分
    → fetchText → parseResponse → evalRuleList(bookList)
    → 提取字段 → bookUrl fallback (Element.href / JSON字段)
  → 去重(书名+作者)
  → 增量显示：首屏10条 + 滚动加载
```

## 阅读流程

```
ReaderView → ensureToc()
  → getToc(source, book) → fetchText(tocUrl||bookUrl)
    → evalRuleList(chapterList) → 回退全页<a>扫描
    → evalRule(chapterName/chapterUrl)
    → 目录分页(nextTocUrl)
  → getContent(source, chapterUrl)
    → evalRule(content) → HTML→纯文本转换
    → 正文分页(nextContentUrl) → LRU缓存(30条)
  → 渲染 + 后台预取下一章
```

## 已完成功能

- [x] CSS管道链 + 过滤器 + 位置索引
- [x] JSONPath + `{$.path}` URL占位符
- [x] JS搜索URL执行 + 隐式返回
- [x] 相对URL解析 + 模板展开
- [x] GBK/UTF-8自动编码嗅探
- [x] HTML正文→纯文本转换
- [x] bookUrl fallback (Element href + JSON字段)
- [x] TOC全页`<a>`回退扫描
- [x] 搜索结果去重(书名+作者)
- [x] 指定书源搜索(下拉)
- [x] 阅读主题(暗色/亮色/护眼)
- [x] Ctrl+滚轮调字号
- [x] 滚动自动下一章
- [x] 隐藏窗口边框
- [x] 自动隐藏(老板键)
- [x] 书源导入(直接+预览)
- [x] 搜索结果增量显示(10条+滚动)
- [x] Rust编译(419 crates, 零错误)

## 待实现

| 功能 | 优先级 |
|------|--------|
| 书架导出/导入JSON | P2 |
| 系统托盘最小化 | P2 |
| 多窗口阅读 | P3 |
| 自定义快捷键 | P3 |

## 调试

```bash
npm run build           # 前端构建检查（~1s）
cd src-tauri && cargo check  # Rust编译检查
explorer %APPDATA%/com.toudu.app  # 查看数据文件
```

## 设计约束

1. 仅Windows · 仅文本小说 · Tauri v2 + Vue 3
2. 书源规则在JS侧执行 · 数据在%APPDATA%本地JSON
3. 无边框透明窗口 · 自绘标题栏/缩放
4. 防抖持久化 writeJsonDebounced(500ms)
