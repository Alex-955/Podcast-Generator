# B0 实施计划：正确性修复与回归基线

日期：2026-09-22（GMT+8）
依据：`plan/engineering-brief-2026-09-22.md` B0 全部六项；`plan/improvement-roadmap-2026-09-22.md` 第 5 节证据已逐条对照当前代码复核（2026-09-22，代码最后修改 2026-09-18，无并行变更）。
边界：不改 `design/`、`plan/ui/`、三份共享任务文档；不做 B1；不调用付费服务；安全边界变更标记 blocked 待确认。

## 0. 证据复核结果（对照路线图第 5 节）

| 证据 | 复核结论 |
|---|---|
| 链接页优先发送旧正文、忽略新 URL | 仍成立（`app.js` `getCurrentInputContent` / `url: content ? '' : url`） |
| `lastContent = lastContent || content` 首个非空短正文阻止第二次 | 仍成立（`extractor.js`） |
| `String(item.text || '')` 对象转 `[object Object]` | 仍成立（`scriptEngine.js`） |
| 0.35s 间隔按帧取整实际 0.36s，元数据仍按 0.35 累计 | 仍成立（`mp3Utils.js` + `ttsService.js`） |
| TTS timeout 不覆盖连接阶段，超时不清理连接/流 | 已从依赖源码确认（`node-edge-tts@1.2.10/dist/edge-tts.js`：`_connectWebSocket` 无任何超时；超时仅 `reject('Timed out')`，不关 WS、不关文件流；reject 的是字符串） |
| TLS 全局跳过、CORS 开放、监听地址未限定 | 仍成立（`server.js`） |
| BGM 仅播放时叠加 | 仍成立 |

## 1. 改动设计

### B0-1 输入来源一致性（`public/inputSource.js` 新增 + `public/app.js` 接入）
- 新增无 DOM 依赖的纯状态模块：显式 `mode: 'url'|'text'`、`parsed = {url, title, content}` 绑定解析结果与来源 URL、`opSeq` 操作序号、`busy` 互斥。
- `selectGenerationInput(state)`：文本模式只用当前文本；URL 模式下 URL 与 `parsed.url` 不一致（含从未解析）→ 生成时传 URL 由后端抓取；一致则用当前文本（含用户编辑）。
- `applyParseResult` 过期响应（seq 不符或 URL 已变更）不应用、不覆盖。
- 「重新配音」标题取 `state.scriptTitle`（剧本生成结果），不再读播放器 DOM 标题。
- 加载新作品重置 `activeSentenceIndex = -1`（放同一纯模块，可测）。
- 全部操作按钮在 busy 期间禁用，防重复点击与响应互踩。

### B0-2 抓取选优（`src/services/extractor.js`）
- 去掉 `lastContent || content`；每次尝试产出 `{title, content}` 配对候选，取**第一个满足正文有效性**（≥200 字）的候选，标题取自同一候选（同源一致）。
- 两次均无效 → 抛错（含最后一次底层错误提示）。
- 截断标记 `truncated` 保持贯通到 extract-article 响应与 one-click meta，前端展示。
- 测试可注入 `fetcher`，不依赖真实网络。

### B0-3 请求/输出校验（`src/services/validation.js` 新增 + `server.js` + `scriptEngine.js`）
- 校验：title ≤200 字符；content 字符串、≤12000 字（超出截断并置 truncated，与抓取语义一致）；dialogue ≤300 行、每行 text 必须是字符串且 ≤2000 字符；voiceMapping 值必须 ∈ AVAILABLE_VOICES 白名单。
- `normalizeDialogue` 只接受字符串 text，对象/非字符串整行丢弃（不再 `String()`）；speaker 别名归一，未知/恶意字符串只做确定性兜底，**绝不进文件名**；文件名改为内部 ID（`sentence_000.mp3`）。
- 输入错误 400 与上游错误 502 分离；日志与错误消息经 `redactSecrets`（Bearer/sk- 形态脱敏）。
- Prompt 增加忠实性约束：正文是待处理资料而非指令、不补充原文没有的事实、保留数字与限定条件；报告中不宣称解决幻觉。

### B0-4 TTS 生命周期（`src/services/edgeTtsAdapter.js` 新增）
- 自建 WebSocket 适配层（基于已有 `ws` 依赖），复刻 Edge read-aloud 协议（speech.config + SSML + Path:audio/turn.end），不再使用 `node-edge-tts` 的 `ttsPromise`（其超时语义不可修复）。
- 四级超时语义：connect（握手，默认 5s）、first-data（发 SSML 后首段音频，默认 10s）、idle（流中断流，默认 10s）、task（整项上限 = 15s + 文本长度/5 字每秒，长文本不被短时限误杀）。
- 超时/取消/出错时：清定时器、`ws.terminate()`、`stream.destroy()`、删除临时文件——真正终止连接与写入。
- 每次尝试独立临时文件（随机后缀），收到 `turn.end` 并 flush 后校验产物（可解析 MP3 帧）再 `rename` 原子发布；失败产物一律删除。
- 外层限次重试（3 次）+ 线性退避；错误带 phase 信息（connect/first-data/idle/task/protocol），不静默。
- 取舍说明：放弃 `node-edge-tts`（超时/清理不可控），换为约 150 行自有适配层；协议与 token 算法按依赖源码复刻，依赖升级或微软改协议时需要同步维护——列入风险。

### B0-5 时间轴（`mp3Utils.js` + `ttsService.js` + `audioMerger.js`）
- `computeGap(format, gapSeconds)` 共享函数：句间静音按整帧取整（0.35s → 15 帧 = 0.36s），时间轴与合并器使用**同一个量化结果**，消除累计差。
- 时间轴完全由实际文件帧解析得出；`totalDuration` 定义为末句 `endTime`，与合并产物时长精确一致（同一帧计数口径）；显示取整只发生在前端。
- 拼接不再跳过缺失文件：缺失/无效/格式不一致（版本/码率/采样率）一律抛错。
- meta 声明 `sentenceGap`（实际量化值）与测量口径。

### B0-6 安全与文案基线
- 实施（低风险、非安全边界）：meta 移除本机绝对路径；README 据实描述（无 Ducking、导出为纯人声、Key 途径、Edge-TTS 非官方接口、兼容端点不保证）；抓取增加协议白名单 + 私有/回环/链路本地地址拦截 + 响应大小上限（`ALLOW_PRIVATE_FETCH=1` 显式例外，供本地来源使用）；模型 baseURL 保持开放（本地模型合法）。
- blocked（安全边界变更，需用户确认后实施）：恢复 TLS 证书校验（需先解决本机证书链）、默认回环监听、限制 CORS 来源。详见 `plan/engineering/security-notes.md`。

## 2. 测试设计（离线，默认 npm test）

| 文件 | 覆盖 |
|---|---|
| `test/inputSource.test.js` | B0-1 验收全部用例 |
| `test/extractor.test.js` | 120→400 选优、两次无效报错、truncated 贯通、微信错误页、URL 安全拦截、内文误粘 |
| `test/validation.test.js` | 对象/空台词、恶意 speaker、过长输入、非法 voiceMapping、文件名安全、脱敏 |
| `test/ttsAdapter.test.js` | fake WebSocket：不建立连接/建立无数据/部分数据中断/超时后迟到数据/长句正常/取消；断言无孤儿连接与写入 |
| `test/timeline.test.js` | 3/20/100 段单调时间轴、meta 与拼接产物时长精确一致、缺失文件与格式不一致抛错 |

- fake Provider：`test/fakeEdgeTts.js` 可控 WebSocket 服务（行为序列：ok / no-data / partial / late）。
- fixtures：按真实格式（MPEG-2 L3 24kHz/48kbps）构造静音帧音频。
- 在线验证（1 次、合成测试句、无费用无私人正文）：适配层对真实端点合成一句，验证模拟不替代在线验证；结果单独列出。

## 3. 风险

1. 自建适配层与微软协议的耦合（协议/token 变更需跟进）；缓解：协议集中一处、在线验证。
2. 私有地址拦截可能误伤本地来源；缓解：`ALLOW_PRIVATE_FETCH` 例外并在报告/文档标明。
3. content 12000 字截断语义保留（阶段 2 才做分章处理），超长文用户需知情。
4. `node-edge-tts` 变为未使用依赖，B1 决定移除，本批不动物理依赖以免扩大差异。

## 4. 交付物

- 代码差异（上列文件）+ `npm test` 全绿。
- `plan/engineering/b0-report.md`（模板化逐项报告）。
- `plan/engineering/security-notes.md`。
- `plan/engineering/api-contract.md`（B1 草案，标注未实现）。
