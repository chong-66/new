# 透读 TouDu

透明背景的极简桌面小说阅读器（Windows），兼容**阅读 3.0 JSON 书源**。

盖在代码/文档上的摸鱼阅读器：无边框、半透明、鼠标移开自动隐去、移回唤醒。

## 功能

- 📚 书架：最近阅读排序、未读角标、进度记忆
- 🔍 多书源并发搜索：同书聚合、来源选择、停止搜索、超时与失败原因提示
- 📖 阅读器：目录分页、正文分页、下一章预取、章节抽屉、章内进度恢复
- 📥 章节缓存：从当前章起自选数量下载，支持进度、停止、已缓存标记和离线阅读
- 🔄 换源：保留原书架记录，按章节名匹配续读位置；无法唯一匹配时选择章节
- 👻 自动隐藏：鼠标移开窗口约 0.2 秒后整体变淡（可调残影 0–30%），移回立即唤醒
- 🪟 无边框透明窗口：整体不透明度可调、置顶、八向拖拽缩放、标题栏拖动
- 🌐 书源网络层：自动识别 GBK/GB2312/Big5/UTF-8 编码、移动端 UA、封面防盗链处理
- 💾 保存保障：串行写入、临时文件替换、上一版备份、失败提示与重试，关闭桌面窗口前等待保存

## 系统托盘

打开「设置 → 窗口 → 仅显示在系统托盘」即可隐藏任务栏图标，设置会自动保存。开启后，标题栏的最小化、关闭以及 Alt+F4 都只收起窗口。

点击系统托盘中的透读图标恢复窗口，右键可选择显示窗口、收起到托盘、设置或退出透读。「退出透读」会等待阅读进度保存完成；保存失败时保留并显示窗口。

Windows 系统托盘通常在右下角；图标可能位于「向上箭头」折叠区，可以将它拖到外面。关闭此开关可恢复任务栏图标。浏览器预览不支持托盘，托盘创建失败时不会启用此模式。

## 书源兼容性

已适配用户提供的 cooks 小说接口：[可导入书源](sources/cooks.json)。复制文件全部内容，到「设置 → 书源」粘贴导入。该文件已清理粘贴转义；旧版需升级至 v0.1.3。若存在相同地址的旧规则，请先在书源列表删除旧项后导入。

已按 Legado 规则教程补充常用兼容层：URL 支持 `{{java.encodeURI(key)}}`、页码算术/三元表达式；Default 规则支持 class/id/tag 链和位置选择；`@css:` 支持 `:eq()`/`:lt()`/`:gt()`；`@XPath:` 与 `//` 可直接使用；AllInOne `:`/`-:` 支持 `$1` 等捕获组；支持 OnlyOne、`%%`、`jsLib`、JSONPath 后接 JS、详情 `init`、`cache.putMemory/getFromMemory`，以及 `java.ajax/get/post`。内存变量按书源及书籍隔离，重启后不保留。仅支持文字小说，仍不是完整的 Legado 运行环境。

创建自己的书源：见 [创建书源说明](docs/创建书源.md)、[通用模板](sources/template.json) 和 [本地可运行示例](sources/local-example.json)。

实现阅读 3.0 规则子集（见 `src/engine/rule.ts` 头部注释）：

- 支持：Default/CSS 位置规则、`tag@attr`、`@text`/`@ownText`/`@html`/`textNodes`/`all`、`@XPath:`/`//`、`@JSon:`、`@Regex:`、AllInOne、OnlyOne、`<js>…</js>` / `@JS:`、`||`/`&&`/`%%`、`##正则##替换`、关键词及页码表达式、`url,{options}`（method/body/headers/charset）
- 支持 `ruleSearch` 搜索分页（滚动或点击后继续请求 `{{page}}`）/ `ruleBookInfo` / `ruleToc`（含 `nextTocUrl`）/ `ruleContent`（含 `nextContentUrl`、`replaceRegex`）
- 不支持：音频/图片类型书源（导入时自动禁用）、`@put`/`@get` 跨规则传值（忽略）、登录/Cookie 复杂场景

## 开发

### 环境要求

| 依赖 | 安装 |
| --- | --- |
| Node.js ≥ 18 | https://nodejs.org |
| Rust 工具链 | `winget install Rustlang.Rustup`（装完重开终端） |
| MSVC C++ 生成工具 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 | Windows 11 一般自带；没有则装 [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |

### 命令

```bash
npm install          # 安装前端依赖
npm run icon         # 生成应用图标（scripts/icon-source.png → src-tauri/icons/）
npm run dev          # 纯浏览器预览界面（无原生能力，请求受 CORS 限制，仅供调 UI）
npm run tauri:dev    # 桌面模式开发运行（需要 Rust 工具链）
npm run tauri:build  # 打包 NSIS 安装包（src-tauri/target/release/bundle/）
npm test            # 本地回归测试，无需真实书源或网络
npm run typecheck   # TypeScript 检查（.ts 文件）
```

## 使用

1. 首次打开 → 右上角 ⚙️ → 书源 → 网络导入订阅地址或粘贴书源 JSON
2. 🔍 搜索书名 → 加入书架 / 直接阅读
3. 阅读页：`←` 上一章，`→` 下一章，`Esc` 返回书架；点“缓存”可从当前章起选择缓存数量
4. 搜索/设置/目录打开时，`Esc` 优先关闭弹层；输入框编辑不触发阅读快捷键
5. 正文加载失败可点“重试”强制刷新，或换源。失败不会覆盖上次成功阅读的进度
6. 外观中的“跟随主题”会让正文颜色随暗色、亮色或护眼主题变化，也可自选颜色

数据保存在 `%APPDATA%\com.toudu.app\`（书架/书源/设置/目录缓存 JSON）。
`.bak` 是上一版有效数据，损坏的原文件在后续保存时留为 `.damaged`。保存失败时窗口会保留并显示提示，可修复磁盘问题后重试。

## 本地界面测试

启动 `npm run dev`，另开终端运行 `node scripts/fixture-server.mjs`，在浏览器预览的书源设置中导入 `http://127.0.0.1:1422/sources.json`。
两份本地书源提供同一本测试小说，可验证搜索聚合、换源续读、章节进度和主题。测试服务仅监听本机；浏览器预览数据与桌面版数据分开。

章内位置按滚动比例恢复。跨书源匹配只自动接受唯一章节名，不猜测重名或缺失章节。正文缓存仍为内存缓存，尚不支持离线下载。

## 技术栈

Tauri v2 + Vue 3 + Pinia + Vite + TypeScript。书源规则在前端 JS 环境执行（与阅读 APP 的 JS 规则天然兼容）；网络请求经 Rust 侧 `tauri-plugin-http` 发出，绕开 WebView CORS 与防盗链。
