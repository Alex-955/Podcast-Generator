# UI 设计交接与返修验证报告 (Task A1 收尾)

> **文档版本**: v2.1 (基于 2026-09-22 联合复核报告第 6 节完成最终收尾)  
> **状态**: A1 已收尾封板，严格限定在 `design/` 与 `plan/ui/`，未改动生产 `public/` 与后端服务，等待用户验收确认。

---

## 一、A1 收尾问题逐项整改与验证证据

根据《联合复核报告》（`plan/handoff-review-2026-09-22.md`）第 6 节要求，针对 **A-F1、A-F2、A-D1、A-D2、A-D3、A-D4** 进行了彻底修复与端到端实测验证。

### 1. A-F1：消除原型脚本未定义加载报错（ReferenceError）
- **问题根因**：旧版 `prototype.js` 尾部导出了不存在的函数名（如 `initPrototype`、`handleUrlInputChange`、`handleParseUrl` 等），在干净环境或无 DOM 桩环境下加载会抛出 `ReferenceError: initPrototype is not defined`。
- **修复方案**：
  1. 补齐 `function initPrototype()` 统一初始化入口；
  2. 梳理全部真实函数名，移除虚构导出，统一挂载；
  3. 尾部增加 `typeof window !== 'undefined'` 运行环境判断，同时支持浏览器与 Node.js 模块环境（`module.exports`）。
- **验证证据**：
  在无 DOM 依赖的 Node.js 桩环境下执行 `require('./design/web-mvp/prototype.js')`：
  ```text
  Loaded prototype successfully, export keys: [
    'initPrototype', 'triggerScenario', 'switchInputTab',
    'handleInputChange', 'handleParseArticle', 'handleParseRawText',
    'handleStartGenerate', 'handleCancelGeneration',
    'loadPodcastToPlayer', 'escapeHtml'
  ]
  Keys count: 10, ReferenceError: 0
  ```
  在受管浏览器控制台中加载，控制台 0 报错，页面成功初始化。

---

### 2. A-F2：消除“输入 A 篡改至 B 后仍能以 A 启动生成”的状态串线
- **问题根因**：用户输入变更时仅作为普通事件触发，未使已确认的草稿状态失效，全局变量仍然持有旧正文 A。
- **修复方案**：
  1. 建立草稿版本机：`inputDraftVersion`，并在 `handleInputChange()` 中执行 `currentConfirmedDraft = null` 并立即隐藏确认卡（`display: none`）；
  2. 在“开始生成”按钮入口加入严格前置守卫：若当前输入未显式点击解析确认，直接拦截并提示：“*当前输入尚未解析或已发生变更，请先点击“解析”确认后再开始生成*”；
  3. 生成启动瞬间通过 `Object.freeze(JSON.parse(JSON.stringify(currentConfirmedDraft)))` 冻结不可变快照，后续全流程仅消费该快照。
- **实测证据**（受管浏览器真实自动化执行结果）：
  ```json
  {
    "afterParseA": {
      "confirmDisplay": "block",
      "title": "【正文A】深度学习在大模型对话领域的理论突破与架构设计...",
      "words": "检测到 38 字"
    },
    "afterChangeToB": {
      "confirmDisplay": "none",
      "hasDraft": false
    },
    "attemptStartWithB": {
      "progressDisplay": "none",
      "validationMsg": "当前输入尚未解析或已发生变更，请先点击“解析”确认后再开始生成"
    },
    "afterParseB": {
      "confirmDisplay": "block",
      "title": "【正文B】完全不同的主题：前端 Web Audio 播放器的帧率...",
      "words": "检测到 42 字"
    }
  }
  ```
  输入 A 改为 B 后，未重新解析前完全禁止生成，且确认卡不残留，A-F2 串线彻底消除。

---

### 3. A-D1：真实 DOM ID 与布局选择器逐项校对
校对并修正旧文档中 8 处伪 ID / 错误类名映射，保证交接表格 100% 对应 `design/web-mvp/index.html` 与 `prototype.css`：

| 规范/交接文档原伪名称 | 实际 DOM ID / 选择器 | 所属功能模块 | 状态 |
| :--- | :--- | :--- | :--- |
| `#btn-parse-url` | `#btn-parse-article` | URL 解析按钮 | 已核正为实际 ID |
| `#btn-parse-text` | `#btn-parse-raw-text` | 正文解析按钮 | 已核正为实际 ID |
| `#player-container` | `.card-panel` / 内部各控件 ID | 播放器整体容器 | 已更正说明 |
| `#dialogue-scroll` | `#dialogue-container` | 字幕滚动视图 | 已核正为实际 ID |
| `#progress-summary` | `#progress-msg` | 流水线阶段文案 | 已核正为实际 ID |
| `#progress-step-1 ~ 4` | `#step-fetch`, `#step-script`, `#step-tts`, `#step-merge` | 4阶段指示节点 | 已核正为实际 ID |
| `#summary-full` | `#confirm-summary` | 确认卡正文预览容器 | 已核正为实际 ID |
| `.workspace-grid` | `.main-layout` | 桌面双栏网格与 960px 响应式断点 | 已核正为实际 CSS 类名 |

---

### 4. A-D2：进度语义真实化（移除伪百分比，改用不定进度条与阶段内严格分母计数）
- **问题根因**：旧原型写死了 20%、25%、30%、96% 等无依据的百分比宽度。
- **修复方案**：
  1. 阶段 1（抓取）、阶段 2（剧本重构）、阶段 4（音频拼接）：将进度条置为 `.progress-bar-fill.indeterminate`，展现纯 CSS 流光动画，右侧计数器显示真实耗时（如 `耗时 1.1s`）；
  2. 阶段 3（TTS 语音合成）：移除流光动画，进度条宽度严格为 `(completedSegments / totalSegments) * 100%`，并在文案中明确标注：“`正在合成第 1/6 句 (阿泽: 好奇开场)`”，右侧标明“`已完成 0/6 句`”至“`已完成 6/6 句`”。
- **实测证据**（受管浏览器实测）：
  - 阶段 1：`isIndeterminate: true`，`counter: "耗时 1.1s"`，`msg: "阶段 1/4: 抓取与清洗正文"`。
  - 阶段 3：`isIndeterminate: false`，`counter: "已完成 0/6 句"`，`fillWidth: "0%"`，随合成递增。

---

### 5. A-D3：全文展开真正切换 fullText 与摘要截断
- **问题根因**：旧原型展开按钮只切换了 CSS 高度类，容器文本依然是截断的 150 字，没有替换内容。
- **修复方案**：
  1. `renderConfirmBox` 在正文对象上保留 `fullText` 与 `summary`；
  2. 字数 <= 150 字时，自动隐藏展开按钮；字数 > 150 字时，初始展示前 150 字与“展开全文预览 ▼”；
  3. 点击展开时，`summaryEl.innerText` 真实替换为 `fullText`，按钮文字变为“收起全文 ▲”；再次点击还原为摘要。
- **实测证据**（受管浏览器对 192 字长文实测）：
  - 初始态：`initialLen: 153`，`buttonText: "展开全文预览 ▼"`；
  - 展开后：`expandedLen: 192`，`buttonText: "收起全文 ▲"`，内容与输入的 192 字全文完全一致；
  - 收起后：`collapsedLen: 153`，`buttonText: "展开全文预览 ▼"`。

---

### 6. A-D4：待定功能标记、取消文案与 XSS 安全防护
- **对谈风格与背景音选项**：在 `index.html` 中将 `#select-style` 与 `#select-bgm` 设置 `disabled`，并明确添加标签说明：“`(候选·暂未生效)`”与“`(待工程接入)`”，杜绝向用户传递未实现能力的错觉。
- **取消任务文案**：点击“取消生成”后提示文案已从“后台资源已释放”修改为诚实的：“*已取消当前播客生成。模拟任务已停止。*”。
- **XSS 安全防注入**：实现严格的 `escapeHtml(str)` 函数，将台词、说话人与语气标签中的 `<`、`>`、`&`、`"`、`'` 全部转义后再插入 DOM，并已通过自动化脚本注入测试。

---

## 二、未完成项与边界声明 (Honest Boundary)

以下项目严格按照收尾约定，**不宣称完成，诚实列为待后续阶段处理**：
1. **真实网络与工程 API**：原型未连接后端，未改动任何生产代码（`public/` 与后端服务未触碰）。
2. **页面刷新后的持久化恢复**：当前原型未实现基于 `localStorage` / `IndexedDB` 的持久化草稿与断点存储，刷新浏览器将重置为初始待命态。
3. **音频频谱跳动 Web Audio API 接入**：中间声波柱仍为 CSS 模拟跳动，未接入真实音频频域分析。
4. **浅色模式 (Light Mode)**：目前仅提供符合广播室沉浸感的高对比深色电台主题。

---

## 三、A1 交付文件清单

1. `design/web-mvp/index.html`：双栏沉浸式工作台、无障碍表单、禁用候选功能、校对真实 DOM ID。
2. `design/web-mvp/prototype.css`：夜间深色主题、不定进度条关键帧流光动画、960px 响应式断点。
3. `design/web-mvp/mockData.js`：4 套完整独立历史任务对白、防爬异常数据、TTS 超时中断数据。
4. `design/web-mvp/prototype.js`：统一导出、草稿版本机与不可变快照、不定进度条与 TTS 严格分母计数、fullText 展开、XSS 安全转义。
5. `plan/ui/design-spec.md`：解耦后端通信、更新真实 DOM 映射与状态机契约。
6. `plan/ui/handoff.md`：本交接文档。
