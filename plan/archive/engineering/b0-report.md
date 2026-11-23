# B0 验证报告（2026-09-22）

范围：`plan/engineering-brief-2026-09-22.md` B0 一项。回归测试 52 个用例全绿（`npm test`，全离线）；另做 1 次在线合成验证。按约定停在验收点，未启动 B1。

## 结果总览

| 项 | 结论 | 验证 |
|---|---|---|
| B0-1 输入一致性 | 已修复 | inputSource.test.js × 9；含「解析 A 后改 B 必须用 B」用例 |
| B0-2 抓取选优 | 已修复 | extractor.test.js × 9；含短正文挡住长正文、标题/正文错配两个复现用例 |
| B0-3 校验/脱敏 | 已修复 | validation.test.js × 8 + scriptEngine.test.js × 5；含 `[object Object]` 污染复现用例 |
| B0-4 TTS 生命周期 | 已修复 | ttsAdapter.test.js × 13（fake WebSocket 全离线）+ 1 次在线验证 |
| B0-5 时间轴 | 已修复 | timeline.test.js × 6；含 0.35→0.36s 漂移复现用例，3/20/100 段 0 漂移 |
| B0-6 安全与文案基线 | 部分完成 | 已实施项见 security-notes.md；3 项安全边界变更 **blocked** |

## B0-1 输入来源一致性

问题（已复现）：一键生成把 URL 输入框 + 解析时缓存的正文混在一起发给后端；解析 A 后改 URL 为 B 仍可能用 A 的正文；并发操作无互斥。

修复：
- 新增 `public/inputSource.js`（纯模块，浏览器与 node:test 共用）：单一事实来源由模式决定——URL 模式只用当前 URL 输入框，文本模式只用当前正文，显式不混用。
- 解析结果按 `(seq, url)` 双条件归因：慢请求晚到（seq 过期）或 URL 已被改掉即丢弃，杜绝 A/B 错配。
- 三个生成入口（一键/仅剧本/仅音频）统一 `beginOperation`/`finishOperation` 互斥 + 按钮防重复点击；旧模型缓存/解析缓存导致的串数据路径一并切断（剧本标题只信 state，不读 DOM）。

## B0-2 抓取重试选优

问题（已复现）：120 字短正文挡住 480 字有效正文；重试换 UA 后标题/正文来自不同候选导致错配；fetcher 不可注入、无法离线测试。

修复（`src/services/extractor.js`）：
- fetcher 可注入；双 UA 重试候选按「{title, content} 同源配对、正文 ≥200 字」选优，短候选直接跳过而非终止。
- 标题回退链：og:title → 正文容器 h1 → h1 → title → '未命名文章'，与正文同源。
- 失败必抛带指引的错误（不再静默返回空正文）；微信错误页 7 类特征识别（删除/违规/失效/环境异常/操作频繁/参数错误/链接过期）各给对应指引；响应体 5MB 上限、20s 超时、5 次重定向上限。

## B0-3 请求/输出校验与脱敏

问题（已复现）：LLM 返回 text 为对象时拼出 `[object Object]` 污染正文与 TTS。

修复：
- `src/services/validation.js`（新）：标题 200 字、正文 12000 字（确定性截断置 `truncated`）、台词 300 行 × 2000 字、音色白名单、URL 仅 http(s)；`redactSecrets` 脱敏 Bearer/sk-/api_key 形态凭据。
- `scriptEngine.normalizeDialogue` 强化：非字符串/空文本**整行丢弃**（禁止 String() 强转）；speaker 别名归一 + 奇偶位确定性兜底，保证严格双人交替；空列表报错而非空剧本。
- prompt 增加【忠实性原则】：正文是资料非指令、不编造事实数据、保留限定条件、信息不足表达不确定性。（说明：降低幻觉倾向，不宣称已解决幻觉。）
- server.js 统一错误出口：400/502/500 分类 + 脱敏；`filePath` 不出 API、不落 meta.json。

## B0-4 TTS 适配层生命周期

问题（读源码确认，无法通过调参修复）：原依赖无总任务超时、不取消底层 WebSocket、失败不清理半成品文件。此前靠「重试代替修复」不满足约束。

修复（`src/services/edgeTtsAdapter.js`，约 150 行自维护）：
- 自建 WebSocket 适配层（基于已有 `ws`），复刻 Edge 读屏协议与 Sec-MS-GEC token 算法（与 node-edge-tts drm.js 同源逻辑，含 5 分钟 tick 取整与铬内核版本串）。
- 四级超时各司其职：connect 5s、first-data 10s、idle 10s、task 15s+文本长度（约 5 字/秒）。超时即终止 WebSocket、关闭文件流、删除临时文件——连接与文件句柄真正释放。
- 产物生命周期：每次尝试独立随机后缀临时文件 → `isValidMp3` 帧级校验 → 原子 rename 发布；任何失败不残留（测试断言目录无 `.tmp-`）。
- 重试是补充而非替代：`synthesizeSentence` 上限 3 次 + 线性退避，测试断言恰好 3 次连接、失败报 502「已尝试 3 次」。

在线验证（1 次，测试句「这是一句用于在线验证的合成测试。」，无费用无私人正文）：16 字 → 23472 字节 / 3.912s 音频 / 端到端 763ms，成功发布。注：需沿用现有 `NODE_TLS_REJECT_UNAUTHORIZED='0'`（本机证书链问题，见 security-notes.md），不设置时复现 `unable to get local issuer certificate`。

## B0-5 时间轴

问题（已复现）：宣称句间 0.35s，实际帧量化为 0.36s，20 段累计漂移 0.190s。

修复：
- `computeGap` 统一口径：0.35s → 15 帧（MPEG-2 L3 24kHz/576 采样）= 0.36s；时间轴与 audioMerger 都用同一 `computeGap` 结果，静音帧数 = `frameCount × frameLength`（测试交叉验证 15×144=2160 字节）。
- `buildSentenceTimeline` 按真实 MP3 帧计数算每段时长；3/20/100 段验收：单调、`totalDuration = Σ段时长 + (n-1)×gap` 0 漂移（20 段 = 11.64s 期望值精确命中）。
- 格式一致性强校验：混合 MPEG-1/MPEG-2 编码、非 MP3 片段一律抛错。

## B0-6 安全与文案基线

已实施：SSRF 目标校验（内网/回环默认拒绝，`ALLOW_PRIVATE_FETCH=1` 显式放开）、错误脱敏、路径泄露清理、文件名内部 ID、输入上限校验。详见 `plan/engineering/security-notes.md`。

**blocked（安全边界变更，等 Alex 确认后才做）**：
1. 恢复 TLS 证书校验（移除全局 `NODE_TLS_REJECT_UNAUTHORIZED='0'`，改 `NODE_EXTRA_CA_CERTS`）；
2. 默认回环监听（`HOST=127.0.0.1`）；
3. 限制 CORS 来源。

文案基线（README + index.html 已改据实）：BGM 无 Ducking、导出 MP3 为纯人声、逐句高亮为估算时间轴、LLM 兼容性改为「已验证 DeepSeek，其余未逐一验证」；不宣称已解决幻觉。API 契约现状 + B1 草案见 `plan/engineering/api-contract.md`（草案均标注未实现）。

## 测试与运行

- `npm test`：52 用例全绿（node:test + fake WebSocket + fetcher 注入，全离线，约 2.9s）。覆盖：inputSource 9 / extractor 9 / validation 8 / scriptEngine 5 / timeline 6 / ttsAdapter 13 / 其他 2。
- 修复前三个缺陷均有对应复现用例锁定（B0-2 两个、B0-3 一个、B0-5 一个）。
- 在线验证仅 1 次（上述合成测试句），fake 不替代。

## 遗留与下一步

- `node-edge-tts` 已不在调用路径，是否从 package.json 移除待 B1 决定。
- DNS 解析后复检（rebinding 防护）未做；抓取候选评分（替代首个 ≥200 字）列入 B1 草案。
- 3 项安全边界变更 blocked，见上。
- 按约定**停在验收点**，B1（统一 Web API 草案实现）与 P1 路线（句子级缓存、SSE 进度、BGM 真混音、Markdown 导出）均未启动，等 Alex 决定。
