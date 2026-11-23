# UI A1 返修与工程 B0：联合交接复核

日期：2026-09-22（GMT+8，用户 12:39 提交后检查）  
评审对象：`plan/ui/handoff.md`、`plan/engineering/b0-report.md` 及对应磁盘代码。  
边界：仅评审与离线测试，未修改业务代码或原交付物；未调用真实模型/线上 TTS，未启动生产服务。

## 1. 结论

两边都有实际进展，但目前不能按报告直接判定整体通过，也不宜进入 UI 集成或 B1 新功能。

- **UI A1：局部修正有效，仍需小范围返修。** 反爬主动作与样例按钮已分开；历史有独立数据；播放器禁用态、损坏态、标签和键盘支持已有代码。但存在脚本加载异常、旧正文仍被生成、交接 ID 不符等问题。
- **工程 B0：既有测试通过，新增边界复核不通过。** `npm test` 输出 52 项全部通过，耗时约 2.86 秒；其中两个发现项是 `test/fakeEdgeTts.js` 和 `test/helpers/mp3Fixtures.js` 辅助模块，实际显式测试为 50 项。补测发现 TTS 握手超时/取消会导致进程退出，产物完整性校验也不足。
- **三项安全边界整改仍 blocked。** 不替用户批准恢复 TLS、调整监听地址或 CORS。已明确列为 blocked 是正确做法，但不应宣布安全验收完成。

下一批应只修本报告中的现有交付缺口，不增加功能、不重写技术栈。

## 2. 已独立复现的阻塞项

### B-F1：连接未建立时终止 WebSocket 会造成未捕获异常（最高优先级）

位置：`src/services/edgeTtsAdapter.js` 的 `teardownResources()`。

代码先调用 `ws.removeAllListeners()`，再 `ws.terminate()`。在 CONNECTING 状态下，ws 会异步触发 `error`；此时已没有错误监听器，try/catch 不能捕获异步的未处理事件。

补测方法：在隔离子进程中启动仅接受 TCP、不完成 WebSocket 握手的本地服务器，调用真实 EdgeTtsAdapter。

结果：
1. connectTimeoutMs=200，触发握手超时：子进程 exit code 1。
2. connectTimeoutMs=200，30ms 时 AbortController.abort()：子进程 exit code 1。

两者均输出：

```text
Unhandled 'error' event
Error: WebSocket was closed before the connection was established
    at WebSocket.terminate (.../ws/lib/websocket.js:496:7)
    at teardownResources (.../src/services/edgeTtsAdapter.js:173:16)
```

现有 `task` 超时测试在已经建立 WebSocket 的 no-data 服务器上运行，不覆盖握手挂起；测试文件中也未见 AbortController 取消用例。因此，现有测试全绿不能证明这两条路径安全。

要求：保留必要错误处理直到连接确实结束；让关闭、取消、超时幂等；检查 flush/publish 期间异常也能 settle，而不是提前置 settled 后忽略写入错误。不要用全局 uncaughtException 吞错代替修复。

验收：新增子进程级握手挂起/握手期间取消测试，进程正常退出、Promise 明确拒绝、无临时文件及未关闭连接。已有 52 项继续通过。

### B-F2：残缺 MP3 可以被当成有效产物发布

位置：`src/services/mp3Utils.js` 的 `getMp3DurationSeconds` / `isValidMp3`。

补测：取现有测试 fixture 的首帧，仅保留前 5 字节。

```text
bytes: 5
frameLength: 144
isValidMp3: true
duration: 0.024
```

解析器识别到帧头后，没有先确认整帧在 buffer 内就累计采样数。因此“可解析出正时长”不足以证明音频完整；适配层的原子发布前校验会接受这类残片。

要求：检查完整帧边界、截断尾帧与必要的帧序列一致性；不能只提高最小字节数。补充假 TTS 发送截断 MP3 后 turn.end 的拒绝发布测试。时间轴目前证明的是帧计数口径一致，不是实际解码听感已经验证。

### A-F1：原型加载有确定的 ReferenceError

位置：`design/web-mvp/prototype.js:915`（本次检查版本）。

```javascript
window.initPrototype = initPrototype;
```

`initPrototype` 未定义。文件尾还有多个未定义的导出名，例如 handleUrlInputChange、handleParseUrl、handleStartGeneration、loadHistoryTask。对原脚本做无 DOM 执行依赖的加载检查，得到：

```text
ReferenceError: initPrototype is not defined
```

此前已经注册的事件和已声明函数可能仍使部分页面可操作，不能据此断言整页空白；但这不是可交接的无错误原型。

要求：统一实际函数名和初始化入口，删除或补齐不一致导出；增加脚本运行时加载检查。`node --check` 只能查语法，不能覆盖未定义变量的运行时错误。

### A-F2：修改输入后，仍可用旧正文开始生成

位置：`prototype.js` 的 `handleInputChange`、`switchInputTab`、`handleStartGenerate`。

报告称“输入变化清除旧确认卡”，实际函数只显示警告，没有清空 parsedDraftArticle、隐藏确认卡或禁止生成。切 Tab 也没有使解析结果失效。

离线 DOM 桩复现：解析 A 正文 → 改成 B 正文 → 调用输入变更处理 → 点击生成。结果：
- 确认卡仍是 display:block；
- parsedDraftArticle 仍为 A；
- 模拟流程完成后播放器标题仍为 A。

要求：解析结果绑定来源及版本；修改输入或来源后使旧确认失效；生成启动时保存不可变任务快照，不能在定时回调中反复读取可变全局草稿。重新解析时也要推进运行版本或取消旧解析回调。

## 3. UI 报告与当前实现仍不一致

### A-D1 交接 DOM 映射错误

报告声称全部为真实 DOM ID，但以下 7 项在 HTML 中不存在：

| 报告 | 实际 |
|---|---|
| `#confirm-title` | `#confirm-article-title` |
| `#confirm-word-count` | `#confirm-words` |
| `#progress-phase-text` | `#progress-msg` / `#progress-counter` 等，需定义映射 |
| `#progress-bar-fill` | `#progress-fill` |
| `#btn-play` | `#btn-play-toggle` |
| `#audio-scrubber` | `#player-scrubber` |
| `#list-dialogues` | `#dialogue-container` |

实际响应式选择器是 `.main-layout`，不是报告中的 `.workspace-grid`。将 handoff 的选择器与 HTML 自动比对后再交付，避免依靠手写记忆。

### A-D2 “真实进度”并未按报告实现

当前代码仍写死：解析 20%/25%、剧本 30%、拼接 96%；阶段耗时为固定的“1.8s”“0.5s”。TTS 计算式为 `30 + round(N/M * 60)`，不是报告中的完成数/总数百分比，而且当前合成序号不等于已完成数。

Mock 可以模拟时间和事件，但必须表达正确的产品语义。要求未知进度阶段用不定进度/阶段与模拟时钟；TTS 进度以 completedSegments 计数，明确显示这是阶段内进度。不要只删除数字标签而保留伪精确的条宽。

### A-D3 “全文展开”没有显示全文

正文模式保留了 fullText，但 renderConfirmBox 只写入截取 180 字的 summary，展开按钮仅改变 CSS 类。因此长文展开后仍然只有摘要。

要求：展开切换到 fullText；如果当前 fixture 没有全文，诚实标“展开摘要”，并补充源文截断/不完整提示。刷新恢复场景也仍未见实现，不能把这些已要求的内容隐含移到后续版本。

### A-D4 待确认功能仍留在主流程

多种风格与新增背景音仍作为可选项，但未连接到当前业务能力。应移除、禁用并注明候选，或等待单独批准；不能写“替换 API 后无需调整交互结构”。取消按钮在模拟中应写“模拟任务已停止”，不能用“后台资源已释放”给实际服务作保证。

新原型将粘贴内容插入对白后使用 innerHTML 渲染（`renderDialogues`），集成前必须改用安全文本节点或可靠转义，避免将用户文本解释成 HTML。

## 4. 工程需收尾的校验与文档问题

### B-F3 SSRF 基线遗漏不止 DNS

本地仅调用 `assertSafeFetchTarget`，在未启用 ALLOW_PRIVATE_FETCH 的情况下：

```text
http://[::ffff:127.0.0.1]/ → ACCEPTED
```

URL 规范化会将映射地址改成十六进制，现有检查仍按带点 IPv4 前缀匹配。另：defaultFetcher 自动跟随最多 5 次重定向，没有逐跳检查目标；此项由源码确认，本轮未访问任何内网目标或构造真实重定向请求。

要求：补 IPv4-mapped IPv6 规范化和逐跳目标校验的离线测试；DNS 解析后的地址校验仍作为独立未完成项明确列出。不要把当前基线写成完整 SSRF 防护。安全策略本身的变化继续按用户确认流程处理。

### B-D1 API 契约与入口实现不完全一致

- `/api/voices` 实际返回顶层 voices/defaultMapping，不是 data.voices；`/api/bgm-list` 返回顶层 bgmList。
- scriptEngine 的 LLM 异常没有附 statusCode=502，server 默认按 500 返回，和报告“LLM 上游错误 502”不一致。
- synthesize-podcast 在 validateDialogueList 前先 normalizeDialogue，会丢弃无效行；全无效时抛普通 Error，不能确保按用户输入错误返回 400。
- 一键生成的 LLM 对话没有经过同等行数/长度校验，不能宣称所有 TTS 入参都受该上限保护。
- normalizeDialogue 只对未知角色按奇偶兜底，已知连续同一角色会保留；不应宣称“保证严格双人交替”。保留正确角色比强制交替更重要，建议修正文案而不是为了文案改数据。

要求：以实际 HTTP 边界补最小路由测试，区分模型输出清洗和用户输入拒绝语义；让契约与实现一致，不扩大成 API 重构。

### B-D2 安全说明需精确

`server.js` 内设置 NODE_TLS_REJECT_UNAUTHORIZED 影响当前进程及继承该环境的子进程，不是“本机所有 Node 进程”。显式传 rejectUnauthorized:false 的 extractor 也需在恢复 TLS 时单独整改。

`app.listen(PORT)` 未限定回环不等于已经验证局域网可达，还受系统网络/防火墙影响；“ALLOW_PRIVATE_FETCH 当前开发环境在用”的声明也应给出不泄密的配置证据，否则改为条件说明。

## 5. B1 草案应回到已定路线

现有工程草案把重点转向 POST SSE 流、URL 别名、自动清理/DELETE 和音色参数，却没有明确持久化任务、重启恢复、重复请求去重、取消语义与最近任务读取。这不能替代原路线中的 B1。

下一阶段建议仍是：
1. 稳定任务 ID 与中间结果持久化；
2. 查询状态、真实进度、恢复与取消；
3. 句子缓存（键包含 Provider、模型/版本及实际生效声音参数）；
4. 最近任务入口；
5. 集成批准后的 UI。

首版轮询即可；SSE 是可选传输，不是目标。暂不做自动清理、混音、Markdown 导出、URL 智能评分、额外音色参数。清理历史作品涉及删除，不能随 B1 默认启用。

## 6. 建议下一批（可并行，不自动开工）

### A：只做 A1 收尾

先修 A-F1、A-F2；再对齐 A-D1—A-D4。提交无启动异常、输入 A→B 不串线、准确 DOM 映射、正确阶段进度的证据。若刷新恢复/截断场景未做，明确列未完成，不宣称 R1—R6 全部通过。仍只写 design/ 与 plan/ui/。

### B：只做 B0.1 缺口修复

先修 B-F1、B-F2；补 B-F3 校验及 B-D1 最小路由测试，更新报告。三项已 blocked 安全配置继续单列，等待确认，不混在功能修复中偷偷调整。暂不实现 B1。

共同通过条件：原测试继续通过；新增复现用例通过；报告可映射到当前文件与实际命令；失败状态不导致服务退出或输入串线。无需追求全部功能一次完成，但不能把未验证项写成已完成。
