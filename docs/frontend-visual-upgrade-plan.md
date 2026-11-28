# 拾声集前端视觉与动效升级方案

已确认方向：**官网采用方案 B（墨色对比）**，**应用端采用方案 B（几何插画空状态）**。

目标有两个：审美更高级；动效更灵动，但不增加性能负担。

## 参考实现（原型，不是生产代码）

原型在分支 `cursor/design-previews-90f6` 的 `design-previews/` 目录。它通过符号链接复用 `public/` 与 `website/`，只叠加预览用 CSS / HTML，可以直接照着抄。

| 内容 | 文件 |
|---|---|
| 官网方案 B 页面 | `design-previews/website/index-b.html` |
| 官网共用样式（纸纹、按钮、Hero 排版、数据带、字幕聚焦、Bento） | `design-previews/website/styles/preview-shared.css` |
| 官网方案 B 专属样式（两栏 Hero、深色三处） | `design-previews/website/styles/preview-b.css` |
| 应用端方案 B 页面 | `design-previews/app/index-b.html` |
| 应用端空状态样式与插画 | `design-previews/app/preview-app.css`、`design-previews/app/preview-app.js` |

查看方式：在仓库根目录运行 `python3 -m http.server 8810`，打开 `http://127.0.0.1:8810/design-previews/`。

原型里有三处是为了预览而写的权宜做法，落地时要换掉：

1. `preview-app.js` 用 `MutationObserver` 把空状态替换成插画，并桩掉 `/api` 请求。落地时应直接改 `public/app.js` 里生成空状态的代码。
2. 字体栈里额外加了 `Noto Serif CJK SC`，只为了在 Linux 上渲染出宋体效果。生产环境不需要。
3. 原型中 `.listening-stage:has(...)` 用来隐藏灰态播放器。落地时建议在 JS 里给容器加 `is-empty` 类，不依赖 `:has()`。

---

## 一、官网端（`website/`）

### 1.1 先修的问题（不涉及视觉改版）

| 问题 | 位置 | 做法 |
|---|---|---|
| 播放时进度条每帧改 `width` 和 `left`，触发布局 | `website/scripts/player.js` 的 `updateProgressUI`（约 537–540 行）；`website/styles/main.css` 的 `.progress-fill`、`.progress-thumb` | 填充条改 `transform: scaleX(pct)`，`transform-origin: left`；滑块改 `translateX`。拖拽命中区域用 `getBoundingClientRect`，逻辑不变 |
| 按钮按下时过渡 `border-bottom-width`，触发布局 | `main.css` 约 105、912 行 | 去掉该属性的过渡，改用 `box-shadow` 与 `transform`（`preview-shared.css` 里有现成写法） |
| 手机端顶栏品牌名被"复制网址"盖住 | `main.css` 的 `@media (max-width: 480px)` 附近 | 560px 以下隐藏 `.copy-site-url-btn`（已在 `preview-shared.css` 末尾） |
| 固定顶栏 `backdrop-filter: blur(14px)` 在整页滚动时持续重算 | `main.css` 约 266 行 | 背景改为 96% 不透明纯色，去掉 blur；弹窗遮罩的 blur 可保留，降到 4–6px |

### 1.2 视觉改版（方案 B）

**Hero 两栏**
- 左栏：版本标签（三个徽章减为一个）、标题、副标题、功能一行字、按钮、元信息。
- 右栏：倾斜的工作台截图，叠加阿泽 / 小晓两个浮动对话气泡和一个声纹胶囊。
- 标题放大到 `clamp(2rem, 3.7vw, 3.3rem)`，波浪线改为青蓝到朱砂的渐变（SVG `linearGradient`）。
- 按钮区：主按钮"下载 macOS 桌面版"；次按钮"先听 45 秒样片"，带圆形播放图标；"切到 Windows 版"降为文字链接。
- 必须保留的 id：`heroDownloadBtn`、`heroDownloadLabel`、`heroSwitchOsBtn`、`heroListenBtn`，`interactions.js` 依赖它们（约 278–281、334、957 行）。

**页面中部**
- 在样片试听台和核心特性之间插入数据带（通栏深色）。
- 数字：`3 种双人对话风格`、`0 云端账号`、`秒级 缓存复用`、`2 个桌面平台`。其中"秒级"来自现有文案，发布前请再确认准确性。

**深色只用 3 处**
1. 数据带：墨底，两侧各一团青蓝 / 朱砂的静态径向渐变。
2. Bento 第 1 张"缓存复用"卡：墨底。`.sim-pill` 的各状态（运行、完成、缓存命中、出错）需要单独配深色版，`preview-b.css` 已写好。
3. 页尾 CTA：墨底加两团色晕和一条静态声纹剪影。

**通用质感**（`preview-shared.css`）
- 纸纹噪点：内联 SVG `feTurbulence`，只叠在 `.stage-deck`、`.bento-card`、`.closing-cta`，透明度 0.22。
- 阴影改为"内高光 + 接触阴影 + 环境阴影"三层。
- 主按钮：去掉厚底边，改渐变加内高光；播放大按钮同理。
- Bento 跨栏改为 7 / 5 / 7 / 5 的错落布局，截图卡变大并用 `object-fit: cover`。
- 字幕：有当前句时，其余句降到 58% 不透明度，悬停恢复。

**文案改动（需要你确认）**
- 副标题缩短为两句，功能清单拆成一行小字。
- 元信息栏合并为"免装 Node.js · 无云端账号 · API Key 仅留在你的本机"，另保留 Releases 与 SHA256 链接。

### 1.3 动效

| 项 | 做法 | 成本 |
|---|---|---|
| 对话气泡浮动 | `translateY(±5px)`，6s 往返，两个气泡错开 3s | 仅合成层 |
| 声纹胶囊 | 9 根柱 `scaleY` 循环，错开相位 | 仅合成层 |
| 滚动入场错峰 | 在 `main.js` 的 `IntersectionObserver` 回调里给同一行元素设 `--i`，CSS 用 `transition-delay: calc(var(--i) * 50ms)` | 极低 |
| 减少动态 | 已有 `prefers-reduced-motion` 规则，原型额外把气泡与声纹动画关掉 | — |

补充要求：Hero 滚出视口后，应暂停气泡和声纹动画（`IntersectionObserver` 切换 `animation-play-state`）。原型里没有做这一步，落地时要加。

### 1.4 顺手的加载优化

- 页面下方三个区块加 `content-visibility: auto` 和 `contain-intrinsic-size`。
- 截图从 PNG 转 WebP / AVIF（每张约 150–250KB，可省一半以上），补 `decoding="async"` 与明确的宽高。
- 两个样片 mp3 各约 740KB，使用 `preload="none"`。
- Hero 右侧截图中的文字很小，建议另做一张裁剪过的首屏专用图，不要直接缩小整屏截图。

### 1.5 兼容性与风险

- `preview-shared.css` 里字幕聚焦用了 `:has()`（Chrome 105+、Safari 15.4+、Firefox 121+）。不支持时只是不降低透明度，不影响功能。
- 反色卡片里的模拟器状态由 JS 切换 class，改样式时不要动 class 名。
- 官网目录不会进安装包（`electron-builder.yml` 已排除 `website/**`），但 `test/release.test.js` 把 `website/index.html` 列为发布包中的内部文件（不进发布包），改动官网后建议跑一遍 `npm test` 确认没有影响。

---

## 二、应用端（`public/`）

### 2.1 先修的问题

| 问题 | 位置 | 做法 |
|---|---|---|
| 任务进度、识图进度、润色进度、迷你进度条都在改 `style.width` | `public/app.js` 约 890、928、995、1433、1456、1495、1795、1800、1811、3242、4942 行；`public/style.css` 约 664、1282、3706 行有对应的 `transition: width` | 填充元素改为 `transform: scaleX()` 加 `transform-origin: left`，过渡属性同步改成 `transform`。标签页指示器（约 713、3833 行）按 `offsetWidth` 设宽度，更新频率低，可以暂不动 |
| 设置弹窗输入框聚焦是整圈朱砂边，在 API Key 等长期停留的字段上偏刺眼 | `public/style.css` | 改为 1px 朱砂淡边加 `0 0 0 3px var(--accent-soft)` 光晕（`preview-app.css` 末尾有写法） |
| 无限动画在元素隐藏后可能仍在运行 | `thumbScanSweep`、`barShimmer`、`activityPulse`、`glideIndeterminate`（`style.css` 约 575–690、1288 行） | 确保任务结束时移除对应元素或 class，不只用 `display: none`；必要时加 `animation-play-state: paused` |
| 顶栏 `backdrop-filter: blur(12px)` | `style.css` 约 129 行 | 与官网同样处理：改为接近不透明的纯色 |

### 2.2 右栏空状态（方案 B：几何插画）

**要实现的效果**
- 隐藏灰态播放器（头像、波形、标题、进度、按钮）和"对话字幕"标题栏。
- 右栏居中显示欢迎面板：
  - 插画：浅色圆形底，叠一张倾斜纸页，左边青蓝圆里写"泽"，右边朱砂圆里写"晓"，下方 17 根声纹柱（左 8 根青蓝，其余朱砂）。
  - 标题"粘贴一篇文章，生成你的第一期"（衬线体），副标题"几分钟，在本机变成阿泽 × 小晓的双人对话播客"。
  - 三步引导：粘贴链接或正文、选择对话风格、生成并收听。
  - 三张内置示例卡片（AI 智能体工作流、DeepSeek 技术剖析、数字游民的自律），点击触发左栏同名 `.sample-pill` 的点击。

**落地方式**
1. 在 `public/app.js` 里新增一个函数（例如 `renderWelcomeEmpty()`），用 DOM API 创建上述结构。现有生成空状态的位置在约 2311 行（清空当前播客）和 3113 行（暂无字幕，这一处不要换成欢迎面板，保持原样）。
2. 初始 HTML（`public/index.html` 约 512 行的 `.subtitles-empty`）也同步改成欢迎面板，避免首屏闪一下旧样式。
3. 切换到"有播客"和"无播客"时，在 `.listening-stage` 上切换 `is-empty` 类，由它控制隐藏播放器和字幕头，不要用 `:has()`。
4. 内置示例卡片的点击处理复用现有 `dom.samplePills` 的逻辑（约 4761 行），不要重复实现解析流程。
5. 插画 SVG 的文本使用 `var(--font-serif)`，避免硬编码字体。

**动效**（只用 `transform`）
- 两个圆分别做 `translateY(±3px)` 往返，周期 5.5s，错开 2.7s。
- 声纹柱用 `scaleY` 往返，1.2s，逐根错开相位。设置了 `transform-box: fill-box` 保证缩放以自身中心为基准。
- 示例卡片悬停上浮 2px，箭头右移 3px。
- 欢迎面板不可见时（已有播客被选中），确保 DOM 被移除，动画不再占用合成。

**响应式**
- 900px 以下示例卡片改为单列。
- 手机端欢迎面板位于导入区下方，插画宽度取 `min(380px, 84%)`。

### 2.3 原型里没有做、但建议后续评估的项

这些是之前分析里提到、这次没有做原型的内容，是否做请你决定。

| 项 | 说明 |
|---|---|
| 左栏层级 | 输入框加高到 52px；"内置试听示例"三个标签降级为文字链接（与右栏欢迎卡片功能重复） |
| 对话舞台 | 头像加波形做成顶部一整块；说话人被点亮时放大 1.08 倍并加光环（已有 `data-speaker`，主要是 CSS） |
| 真实音频驱动波形 | 在 `audioEngine.js` 接 `AnalyserNode`，每帧只写 24 个 `transform`；页面不可见或暂停时必须停止 |
| 手机端迷你播放条 | 只保留封面、标题、播放键，点开再展开完整放音台；小按钮点击区至少 40px |
| 暗色模式 | 把 `:root` 变量复制一套"暖墨夜读"；需要逐个检查写死的 `rgba(255,255,255,…)` |
| 页面转场 | 用 View Transitions API 做标签切换和历史列表变化，作为渐进增强 |
| 脚本拆分 | `app.js` 5348 行单文件同步加载，可按功能拆成模块并 `defer`，低频的设置弹窗与合集管理延迟加载 |

---

## 三、落地顺序建议

1. **官网先修**（1.1）：进度条改 `transform`、按钮去 `border-bottom-width` 过渡、手机端顶栏。风险低，可以单独一个提交。
2. **官网视觉改版**（1.2、1.3）：Hero 两栏、数据带、反色卡片、页尾 CTA、质感与字幕聚焦。
3. **应用端先修**（2.1）：进度条改 `transform`、输入框聚焦样式。
4. **应用端空状态**（2.2）：按"落地方式"1–5 步改 `app.js` 与 `index.html`。
5. **加载优化**（1.4）与 **后续评估项**（2.3）：视情况决定。

## 四、验证清单

- `npm test` 通过（尤其 `test/release.test.js`）。
- 官网：桌面 1440、平板 820、手机 390 三个宽度截图对比；样片播放、点击字幕跳转、模拟器、下载弹窗、OS 联动都能正常使用。
- 应用端：无播客时欢迎面板正常；点击示例卡片能触发解析；选中一期播客后欢迎面板消失，播放器与字幕恢复；删除最后一期后欢迎面板回来。
- 动效：开启系统"减少动态效果"后，气泡、声纹、浮动圆全部静止；Chrome 性能面板录一段，进度条播放期间没有 Layout。
