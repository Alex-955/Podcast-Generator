# API 契约（现状，2026-09-22）+ B1 草案

> 上半部分是 B0 后**已实现**的契约；「B1 草案」一节标注**未实现**，仅作下一步规划。

## 公共约定（已实现）

- 请求体 JSON（`express.json`，上限 10MB）。
- 成功：`{ "success": true, "data": { ... } }`。
- 失败：`{ "success": false, "error": "<可读消息>" }`，HTTP 状态码分类：
  - `400` 输入错误（InputError：标题/正文/行数/音色/URL 格式）；
  - `502` 上游错误（抓取失败、微信错误页、LLM/TTS 上游故障）；
  - `500` 其他内部错误。
- 错误消息经 `redactSecrets` 脱敏，响应与日志均不含凭据与服务器内部路径。
- 音频产物：`public/podcasts/<podcastId>/`，经静态服务 `/podcasts/<podcastId>/<file>` 访问。

## 端点（已实现）

### GET /api/health
`{ status: 'ok', time }`

### GET /api/voices
`data.voices`: 可用音色列表（白名单，见 `AVAILABLE_VOICE_IDS`）。

### GET /api/bgm-list
`data`: 可用背景音乐列表。

### POST /api/extract-article
请求：`{ url: string }`（仅 http(s)；内网目标默认拒绝，见 security-notes）
响应：`data: { title, content, length, truncated }`
- 抓取双 UA 重试，候选按「≥200 字且标题正文同源」选优；正文确定性截断至 12000 字并置 `truncated`。
- 微信错误页（删除/违规/过期/环境异常等）返回 502 并附明确指引。

### POST /api/generate-script
请求：`{ title?, url?, content?, apiKey, baseURL?, model? }`（`url` 与 `content` 至少其一；`content` 不能是整段 URL）
响应：`data: { podcastTitle, summary, dialogue: [{ speaker: '阿泽'|'小晓', text, emotion? }], sourceTruncated, usage? }`
- 剧本经 `normalizeDialogue`：非字符串/空文本整行丢弃，speaker 别名归一，奇数行确定性兜底补位，保证严格双人交替。

### POST /api/synthesize-podcast
请求：`{ podcastTitle?, dialogue: [{speaker, text, emotion?}], voiceMapping? }`
- 校验：台词 ≤300 行 × 2000 字；`voiceMapping` 值必须在音色白名单内。
响应：`data: { id, podcastTitle, createAt, totalDuration, sentenceGap, measurement, fullAudioUrl, sentences: [{index, speaker, text, emotion?, startTime, endTime, duration, audioUrl, fileName}] }`
- `measurement` 固定为 `'mp3-frame-count'`（估算时间轴口径，MP3 帧计数 + 帧量化 gap 0.36s）。
- `sentences` 不含服务器内部 `filePath`。

### POST /api/one-click-generate
请求：`{ title?, url?, rawText?, apiKey, baseURL?, model?, voiceMapping? }`（URL 模式只传 `url`，文本模式只传 `title?`+`rawText`，不混用）
响应：`data` = 剧本字段（podcastTitle/summary）+ 合成字段（同 synthesize-podcast）+ `sourceTruncated` + `usage?`。

## B1 草案（未实现）

> 以下全部**未实现**，归属 B1（统一 Web API 设计），实施前需 Alex 确认范围。

1. **统一错误结构**：`{ success: false, error: { type: 'input'|'upstream'|'internal', message, code? } }`；旧字段 `error: string` 过渡期保留。
2. **SSE 进度流** `POST /api/generate-stream`：分阶段事件 `fetch → script → tts(<i>/<n>) → merge → done`，替代一键端点的长时间盲等；失败事件带 `type`。
3. **句子级 TTS 缓存**：按 (text, voice, rate, pitch) 内容寻址的片段缓存目录，跳过重复合成；缓存失效策略与上限。
4. **URL 别名规范化**：`/s?__biz=...` 等分享短链展开为规范链接后再抓取；抓取候选评分（正文长度/结构密度）替代「首个 ≥200 字」。
5. **产物保留策略**：`podcasts/` 目录按数量或 TTL 清理；`DELETE /api/podcast/:id`。
6. **VoiceMapping 扩展**：rate/pitch 每角色可配（当前固定 `rate: '+0%'`, `pitch: '+0Hz'`）。
