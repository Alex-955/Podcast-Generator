# AI 妙听双人播客生成器 · 第一版（V1）精简重构施工蓝图

> **定位**：面向执行端的完整施工说明书（照图施工，无需临场猜测产品决策）。  
> **目标**：把当前分裂、半成品状态的项目收口为一个**本机极简、稳定、天天可用**的“长文/公众号 → 双人对话播客”最小闭环；并按「**V1 本机 Web → V2 桌面端安装包（供朋友电脑试用）→ 手机跨设备 → 独立移动端 App**」的演进路径，以零过度设计的轻量方式留出纯 API、外部数据目录与可插拔 TTS 底座。  
> **技术栈约束**：保持现有 **Node.js + Express 5 + 原生 HTML/CSS/JS**，不引入 React/Vue、不引入数据库/Redis、不引入 ffmpeg。

---

## 0. 产品边界与架构原则（先对齐，绝不跑偏）

### 0.1 第一版（V1）必须闭环的能力
1. **文章输入与防串线确认**：支持「粘贴网页/公众号链接解析」与「直接粘贴正文」（保留 3 个内置示例方便一键试跑）；解析后展示标题、字数、超长截断提示与可展开预览，修改输入或切 Tab 立即作废旧确认卡。
2. **异步任务与真实 4 阶段进度**：提交生成立刻返回 `taskId`，前端轮询获取真实阶段（抓取正文 → 剧本重构 → 逐句语音合成 → 音频拼接），其中配音阶段展示精确的 `completedSegments / totalSegments` 与缓存命中数，**严禁伪造百分比**。
3. **单句音频缓存 + 失败断点续跑 + 任务取消**：
   - 相同 `(provider, model, voice, rate, pitch, text)` 命中本地有效 MP3 缓存直接复用；
   - 中途任意一句失败或服务重启中断，可点击“从断点继续生成”跳过已完成剧本与有效句，不重复花钱和耗时；
   - 运行中支持取消任务，真正中断底层请求/WebSocket，不留孤儿写入。
4. **沉浸式播放与历史找回**：
   - 双人头像发声态、真实 `<audio>` 播放/暂停/快退10s/快进10s/进度拖拽/倍速（`0.8x ~ 2.0x`）；
   - 双人对话字幕同步高亮滚动 + 点击/键盘跳转播放；
   - 一键下载完整 MP3 + 一键复制 Markdown 剧本；
   - **本地历史列表**：刷新页面、关闭重开后直接看到并加载播放历史播客，且刷新时若存在未完成任务可自动恢复进度视图。
5. **桌面端与跨端演进预留（轻设计、零过度工程）**：
   - **演进路径**：V1 本机 Web 稳定闭环 → V2 打包为桌面应用（如 Electron / Tauri 套壳内置本地服务，方便朋友在电脑前双击试用）→ 后续再扩展手机浏览器与独立移动端 App；
   - 后端彻底作为纯 REST JSON + 静态 MP3 服务，前端零服务端耦合，且**前端所有请求与音频链接一律使用相对路径（`/api/...`、`/podcasts/...`）**，严禁写死 `http://localhost:3000`（方便桌面壳动态分配空闲端口）；
   - **所有运行时可写目录支持环境变量注入（`DATA_DIR`、`PODCASTS_DIR`）**：默认落在项目内 `./data` 与 `./public/podcasts`，但绝不写死不可覆盖（桌面端打包后安装目录只读，外壳可直接指向系统用户数据目录）；
   - TTS 通过极简 `ttsProvider` 接口解耦（V1 默认插免费 Edge-TTS，未来公开发布桌面端/App 切换付费 CosyVoice/MiniMax/火山只需新增单个 Provider 文件）；
   - 前端响应式兼容桌面双栏与手机单栏（`≤900px`），默认监听 `127.0.0.1:3000`，通过 `HOST=0.0.0.0` 可随时在家庭 Wi-Fi 下用手机浏览器访问。

### 0.2 第一版明确砍掉 / 延后的功能（严禁擅自加回）
- ❌ 剧本在线编辑与“修改后重新配音”
- ❌ 背景轻音乐（BGM）生成、叠加与混音（移除 `bgmGenerator.js`、`public/audio/bgm/`、`/api/bgm-list`）
- ❌ 音色切换 UI（V1 固定阿泽 `zh-CN-YunxiNeural` + 小晓 `zh-CN-XiaoxiaoNeural`，后端保留音色白名单与映射参数供后续扩展）
- ❌ 旧生产页面与 `design/web-mvp/` 假原型并存（彻底消灭两套前端，只留一套全新 `public/`）
- ❌ 桌面端打包（Electron/Tauri 外壳，留待 V2）、用户登录、云端部署、SSE 流式推送（V1 用轮询）、流式边生成边播、自动删除历史播客

### 0.3 安全与数据红线
- **绝不持久化密钥**：`apiKey` 仅存在浏览器 `localStorage`（或服务端 `.env` 兜底），绝不写入 `data/tasks/*.json`、`public/podcasts/*/meta.json` 或日志；日志与错误响应一律过 `redactSecrets`。
- **绝不泄露内部路径**：API 响应与落盘 JSON 一律不含服务器本地绝对路径 `filePath`。
- **绝不误删用户已有完好音频**：保留 `public/podcasts/` 现有文件，历史列表只扫描同时具备合法 `meta.json` 与 `full_podcast.mp3` 的目录，并自动过滤旧 `meta.json` 里的 `filePath`。
- **TLS 与监听收敛**：移除代码里无条件关闭 TLS 校验的写法，改为显式环境变量 `ALLOW_INSECURE_TLS=1` 开关（并文档说明推荐 `NODE_EXTRA_CA_CERTS`）；移除全局通配 `cors()`（同源无需 CORS，提供可选 `CORS_ORIGIN` 环境变量）；默认仅监听 `127.0.0.1`。

---

## 1. 目标目录结构

完成所有阶段后，项目目录收敛为：

```text
/Users/alex/Podcast Generator/
├── .gitignore
├── Plan.md
├── README.md
├── package.json
├── server.js                        # 极简 Express 入口：中间件、静态资源、V1 REST 路由
├── data/                            # [gitignored] 运行时持久化数据
│   ├── tasks/<taskId>.json          # 任务状态、进度、剧本、分段状态（绝不含 apiKey）
│   └── tts-cache/<sha256>.mp3       # 单句音频内容寻址缓存
├── src/
│   └── services/
│       ├── extractor.js             # [保留+微修] 网页/微信正文抓取、SSRF、支持外部 AbortSignal
│       ├── scriptEngine.js          # [保留+微修] LLM 剧本生成与清洗、支持外部 AbortSignal
│       ├── edgeTtsAdapter.js        # [保留] 自建 Edge-TTS WS 适配层（四级超时+原子发布）
│       ├── ttsProvider.js           # [新增] 极简 TTS Provider 抽象与注册表（默认注册 edge）
│       ├── ttsCache.js              # [新增] 单句 MP3 内容寻址缓存（命中前过 isValidMp3）
│       ├── ttsService.js            # [扩展] 保持旧导出兼容，新增 provider/cache/signal/progress/resume 支持
│       ├── mp3Utils.js              # [保留] 严格 MP3 帧校验、精确时长、帧量化静音
│       ├── audioMerger.js           # [保留] 纯 Node 无损拼接 MP3（插真实静音帧）
│       ├── validation.js            # [保留] 输入边界校验、音色白名单、凭据脱敏
│       └── taskManager.js           # [新增] 异步任务状态机、落盘持久化、取消、断点续跑、历史读取
├── public/                          # 唯一生产前端（桌面双栏 + 手机自适应）
│   ├── index.html
│   ├── style.css
│   ├── inputSource.js               # [保留] 单一事实来源与防串线状态机（与 node:test 共用）
│   ├── app.js                       # [重写] 直连 V1 REST API 的极简控制器
│   └── podcasts/<podcastId>/        # [gitignored] 成品 MP3 与 meta.json
├── test/
│   ├── extractor.test.js            # [保留]
│   ├── inputSource.test.js          # [保留]
│   ├── llmDeadline.test.js          # [保留，修复后全绿]
│   ├── mp3Utils.test.js             # [保留]
│   ├── scriptEngine.test.js         # [保留]
│   ├── timeline.test.js             # [保留]
│   ├── ttsAdapter.test.js           # [保留]
│   ├── ttsAdapterLifecycle.test.js  # [保留]
│   ├── validation.test.js           # [保留]
│   ├── ttsCache.test.js             # [新增] 缓存命中/损坏跳过/原子写入测试
│   ├── taskManager.test.js          # [新增] 全流程/进度/取消/断点续跑/重启恢复/历史扫描/无Key落盘测试
│   ├── routes.test.js               # [重写] V1 REST 路由与错误码完整离线回归
│   ├── fakeEdgeTts.js               # 辅助模块（不再被 test glob 误跑）
│   └── helpers/                     # 辅助脚本
└── plan/
    └── archive/                     # 原 plan/ 下 15 份历史协调/复核文档整体归档
```

---

## 2. V1 REST API 契约（面向 Web 与未来移动端/App）

所有接口均返回 JSON：
- 成功：`{ "success": true, "data": ... }`（`/api/health` 保持 `{ "status": "ok", "time": "..." }`）
- 失败：`{ "success": false, "error": "<脱敏后的中文可读提示>", "code": "<可选机器可读错误码>" }`
- HTTP 状态码：`400` 输入错误、`404` 资源不存在、`409` 状态冲突（如已有任务运行中/状态不允许续跑）、`502` 上游失败、`500` 内部错误。

| 方法与路径 | 用途 | 请求体 | 响应 `data` 结构 |
|---|---|---|---|
| `GET /api/health` | 健康检查 | 无 | `{ status: 'ok', time }` |
| `POST /api/extract-article` | 解析链接或校验正文（供确认预览卡使用） | `{ url?, rawText? }` | `{ title, content, length, truncated }` |
| `POST /api/tasks` | 创建并启动异步生成任务 | `{ mode: 'url'\|'text', url?, title?, content?, apiKey?, baseURL?, model?, voiceMapping? }` | 立刻返回 `202 Accepted` + 完整 `TaskDTO` |
| `GET /api/tasks/:id` | 轮询任务阶段、句数进度、错误或成品 | 无 | `TaskDTO`（已完成时含 `podcast` 字段） |
| `POST /api/tasks/:id/cancel` | 取消运行中的任务 | 无 | 更新后的 `TaskDTO` |
| `POST /api/tasks/:id/resume` | 从失败/取消断点续跑 | `{ apiKey?, baseURL?, model? }`（若剧本已落盘则无需传） | `202 Accepted` + 更新后的 `TaskDTO` |
| `GET /api/podcasts` | 获取本地已完成历史播客列表（按时间倒序） | 无 | `{ items: PodcastSummaryDTO[] }` |
| `GET /api/podcasts/:id` | 获取单个播客完整详情（含字幕时间轴与音频 URL） | 无 | `PodcastDetailDTO` |

### 关键数据结构定义

#### `TaskDTO`（落盘与接口返回同构，**严禁含 `apiKey` / `baseURL` / `filePath`**）
```json
{
  "id": "uuid",
  "status": "queued | running | completed | failed | cancelled",
  "stage": "extract | script | tts | merge | done",
  "input": {
    "mode": "url | text",
    "url": "https://...",
    "title": "文章标题",
    "contentLength": 3200,
    "sourceTruncated": false
  },
  "progress": {
    "stageIndex": 3,
    "totalStages": 4,
    "stageLabel": "语音合成",
    "message": "正在合成第 5/14 句（阿泽）",
    "completedSegments": 4,
    "totalSegments": 14,
    "cachedSegments": 2,
    "currentSpeaker": "阿泽",
    "stageStartedAt": "2026-11-23T10:00:05.000Z"
  },
  "hasScript": true,
  "podcastTitle": "单集标题",
  "summary": "一句话核心摘要",
  "podcastId": "uuid",
  "podcast": null,
  "error": null,
  "createdAt": "2026-11-23T10:00:00.000Z",
  "updatedAt": "2026-11-23T10:00:12.000Z"
}
```
> 当 `status === 'failed'` 时，`error` 为 `{ stage: 'extract'|'script'|'tts'|'merge', message: '...', retryable: true, failedSegmentIndex: number|null }`；  
> 落盘的 `data/tasks/<id>.json` 额外保存 `sourceContent`（用于从 script 阶段续跑）、`script`（`{ podcastTitle, summary, dialogue }`，用于跳过 LLM 从 tts 阶段续跑）与 `voiceMapping`，但 `GET /api/tasks/:id` 不必把整篇 `sourceContent` 重复回传给前端（保持轮询轻量）。

#### `PodcastDetailDTO`（与 `public/podcasts/<id>/meta.json` 对齐）
```json
{
  "id": "uuid",
  "podcastTitle": "单集标题",
  "summary": "一句话核心摘要",
  "sourceTruncated": false,
  "createAt": "2026-11-23T10:01:00.000Z",
  "totalDuration": 182.4,
  "sentenceGap": 0.36,
  "measurement": "mp3-frame-count",
  "fullAudioUrl": "/podcasts/<id>/full_podcast.mp3",
  "sentences": [
    {
      "index": 0,
      "speaker": "阿泽",
      "text": "台词正文",
      "emotion": "好奇",
      "startTime": 0,
      "endTime": 6.48,
      "duration": 6.48,
      "fileName": "sentence_000.mp3",
      "audioUrl": "/podcasts/<id>/sentence_000.mp3"
    }
  ]
}
```

---

## 3. 分阶段施工步骤（Phase 0 → Phase 5）

执行端必须严格按阶段顺序推进，每完成一个阶段先通过该阶段的验证命令，再进入下一阶段。

---

### Phase 0：Git 基线快照与目录整理

**目标**：建立安全回滚点、清理无用历史负担与废弃模块，不改动现存用户有效音频。

1. **创建 `.gitignore`**：
   - 忽略 `node_modules/`、`.env`、`.env.*`、`.DS_Store`、`data/`、`public/podcasts/`、`*.log`。
2. **初始化 Git 并打基线快照**：
   - 执行 `git init`；
   - 执行 `git add -A && git commit -m "chore: initial baseline snapshot before V1 refactor"`（保留重构前完整代码状态作为回滚点）；
   - **GitHub 远端说明**：本阶段执行端仅做本地 Git 初始化与提交，**严禁未经用户确认擅自 push 到任何远端或公开仓库**；后续由用户在 GitHub 创建 **Private（私有）仓库** 后再关联推送（并确保 `.gitignore` 已拦截 `.env`、`data/`、`public/podcasts/`）。
3. **归档与删除废弃文件**：
   - 将 `plan/` 下现有的 15 个文档及子目录（`plan/engineering/`、`plan/ui/` 及所有 `plan/*.md`）整体移入 `plan/archive/`（保留原始相对结构）；
   - 删除 `design/` 整个目录（假原型不再保留）；
   - 删除 `src/services/bgmGenerator.js` 与 `public/audio/bgm/`（若 `public/audio/` 为空则一并删除）。
4. **清理 `package.json`**：
   - 移除未使用的依赖 `"node-edge-tts"`（编辑 `package.json` 并在可能时同步清理锁文件；若离线环境 `npm uninstall` 尝试联网报错，则直接从 `package.json` 移除，记录说明）；
   - 将 `scripts.test` 修改为：
     ```json
     "test": "node --test test/*.test.js"
     ```
     避免把 `test/fakeEdgeTts.js` 与 `test/helpers/*.js` 误算为测试用例。

**Phase 0 验收**：
- `git status` 可用且 `git log -n 1` 存在初始快照 commit；
- `design/`、`src/services/bgmGenerator.js`、`public/audio/bgm/` 不存在；
- `plan/archive/` 包含原 `plan/` 全部历史文档；
- `public/podcasts/` 目录保持完好未被删除。

---

### Phase 1：修复既有测试 Bug、收敛 TLS 开关与抽离 TTS Provider

**目标**：让现有全部底层单测 100% 全绿，为后续任务引擎和付费 TTS 扩展打好接口底座。

1. **修复 `.unref()` 导致的 `llmDeadline.test.js` 失败**：
   - `src/services/extractor.js`（`defaultFetcher` 中第 208 行附近）：删除 `if (typeof hopTimer.unref === 'function') hopTimer.unref();`（`finally { clearTimeout(hopTimer); }` 已确保无定时器泄漏）；
   - `src/services/scriptEngine.js`（`generatePodcastScript` 中第 144 行附近）：删除 `if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();`（同理 `finally { clearTimeout(deadlineTimer); }` 已确保释放）。
2. **为 `extractor.js` 和 `scriptEngine.js` 增加外部 `signal` 取消透传**：
   - `defaultFetcher(url, headers, { request, timeoutMs = FETCH_TIMEOUT_MS, signal } = {})` 与 `extractArticleFromUrl(rawUrl, options = {})` / `extractArticle(params, options = {})`：
     - 若传入外部 `signal`，若已 `aborted` 立即抛取消错误（`name = 'AbortError'`）；
     - 监听 `signal` 的 `abort` 事件，同步触发内部 `controller.abort()`，并在 `finally` 中 `removeEventListener`；
     - 区分「超时中止（报 502 超时）」与「外部取消中止（抛 `AbortError`，不重试第二 UA）」。
   - `generatePodcastScript({ ..., signal })`：同理监听外部 `signal`，触发内部 `controller.abort()` 并在 `finally` 清理，区分外部取消（抛 `AbortError`）与超时（报 502）。
3. **收敛 TLS 证书校验开关**：
   - `src/services/extractor.js`：将顶部的 `new https.Agent({ rejectUnauthorized: false })` 改为函数按环境变量动态判断：仅当 `process.env.ALLOW_INSECURE_TLS === '1'` 时传入 `httpsAgent: new https.Agent({ rejectUnauthorized: false })`，默认使用 Node 正常 TLS 校验。
   - （`server.js` 中的全局 `NODE_TLS_REJECT_UNAUTHORIZED` 在 Phase 3 同步改为仅当 `ALLOW_INSECURE_TLS === '1'` 时设置并打印醒目本地警告）。
4. **新增极简 TTS Provider 抽象 `src/services/ttsProvider.js`**：
   - 统一 Provider 契约：
     ```js
     // 每个 Provider 对象需提供：
     // { id, model, defaultVoices, availableVoices, synthesizeToFile({ text, voice, outputPath, rate, pitch, signal, adapterOptions }) }
     ```
   - 内置注册默认 Provider `'edge'`：内部直接调用现有 `EdgeTtsAdapter`（不修改 `src/services/edgeTtsAdapter.js` 本身），`id: 'edge'`、`model: 'edge-readaloud-24k48k'`；
   - 导出：`getTtsProvider(id = 'edge')`、`registerTtsProvider(provider)`、`listTtsProviders()`、`DEFAULT_PROVIDER_ID`。

**Phase 1 验收**：
- 运行 `node --test test/extractor.test.js test/inputSource.test.js test/llmDeadline.test.js test/mp3Utils.test.js test/scriptEngine.test.js test/timeline.test.js test/ttsAdapter.test.js test/ttsAdapterLifecycle.test.js test/validation.test.js`；
- 预期：**0 fail、0 cancelled，全部用例绿色通过**，总耗时 < 5 秒。

---

### Phase 2：实现单句缓存、异步任务引擎与历史记录

**目标**：彻底取代“单次同步 HTTP 死等”，实现可落盘、可查真实进度、可取消、可复用缓存、可断点续跑、服务重启不卡死的任务系统。

#### 2.1 新增 `src/services/ttsCache.js`
- 职责：按内容寻址缓存单句 MP3，避免重试或相同台词重复调用 TTS。
- 核心函数：
  - `buildCacheKey({ provider, model, voice, rate, pitch, text })`：返回 64 位 SHA-256 十六进制字符串（所有字段规范化后 `JSON.stringify`）。
  - `createTtsCache(cacheDir)`：返回 `{ get(key, targetPath), put(key, sourcePath), getPath(key) }`：
    - `get(key, targetPath)`：检查 `cachePath` 存在 → 读取并过 `isValidMp3(buffer)`（防脏缓存污染）→ 原子复制到 `targetPath`（先写 `.tmp-...` 再 `renameSync`）→ 返回 `{ hit: true, filePath: targetPath, bytes, duration }`；若文件损坏则删除脏缓存并返回 `{ hit: false }`。
    - `put(key, sourcePath)`：校验源 MP3 有效后原子写入 `cachePath`。
- 不写入任何凭据或用户信息。

#### 2.2 扩展 `src/services/ttsService.js`
- **严格保持现有导出完全兼容**：`DEFAULT_VOICES`, `AVAILABLE_VOICES`, `AVAILABLE_VOICE_IDS`, `SENTENCE_GAP_SECONDS`, `sentenceFileName`, `synthesizeSentence`, `synthesizeDialogueScript`, `buildSentenceTimeline`。
- 扩展 `synthesizeSentence(options)`：
  - 支持新增可选参数：`provider`（默认 `getTtsProvider('edge')`）、`signal`（`AbortSignal`）、`onAttempt` 回调；
  - 若遇到 `TtsCancelledError` / `AbortError` 或 `signal?.aborted`，**立刻终止，绝不重试**；
  - 退避等待 `sleep(ms, signal)` 也响应取消信号。
- 扩展 `synthesizeDialogueScript(dialogueList, workDir, voiceMapping = DEFAULT_VOICES, options = {})`：
  - 支持 `options`: `{ provider, cache, signal, onProgress, adapterOptions }`；
  - 逐句处理逻辑（支持断点复用 + 缓存复用）：
    1. 每句开始前先检查 `signal?.aborted`，已取消直接抛 `TtsCancelledError`；
    2. 优先检查 `outputPath`（即 `workDir/sentence_XXX.mp3`）是否已存在且 `isValidMp3` 为真 → 若有效则直接复用（断点续跑核心），计入 `reused`；
    3. 否则若提供 `cache`，按 `{ provider: provider.id, model: provider.model, voice, rate, pitch, text }` 查缓存 → 命中则复制到 `outputPath`，计入 `cachedSegments`；
    4. 未命中则调 `synthesizeSentence`（透传 `provider`、`signal`、`adapterOptions`），成功后写入 `cache`；
    5. 每完成一句立即触发 `onProgress({ index, completedSegments, totalSegments, cachedSegments, speaker, text })`；
  - 全部完成后继续复用现有 `buildSentenceTimeline(synthEntries)` 计算零漂移时间轴。

#### 2.3 新增 `src/services/taskManager.js`
- 工厂函数：`createTaskManager({ tasksDir, podcastsDir, cacheDir, extractor, scriptGenerator, ttsSynthesizer, audioMerger, ttsProvider })`（支持依赖注入，方便全离线单测！生产默认绑定 `src/services/*`）。
- **目录与落盘规则**：
  - 任务文件：`path.join(tasksDir, `${taskId}.json`)`，采用 `writeFileSync(tmp)` + `renameSync(tmp, dest)` 原子落盘，防止崩溃写坏 JSON；
  - 成品音频目录：`path.join(podcastsDir, podcastId)`（V1 中令 `podcastId = taskId`，一任务一目录，简单直观，续跑天然复用同一目录中的 `sentence_XXX.mp3`！）；
  - **字段净化**：任务 JSON 绝不存 `apiKey`、`baseURL`、`model` 凭据信息（`model` 如无敏感性可只做内存态使用；`apiKey` 绝不能出现在落盘文件和任何返回体里）。
- **启动自愈（服务重启不留僵尸 `running` 任务）**：
  - `createTaskManager` 初始化时扫描 `tasksDir/*.json`：凡状态为 `'queued'` 或 `'running'` 的历史任务，自动改为 `'failed'`，写入 `error: { stage: task.stage, message: '服务已重启，上次生成被中断，可点击「从断点继续生成」恢复', retryable: true, failedSegmentIndex: null }` 并落盘。
- **单活互斥控制**：
  - 本机单用户场景同时只允许 1 个活跃运行中的任务（`activeTaskId`）。若已有任务在跑时调用 `createTask` 或 `resumeTask`，抛出 `409 Conflict`（`InputError` 或带 `statusCode = 409` 的错误：「当前已有任务正在生成，请等待完成或先取消当前任务」）。
- **核心方法**：
  1. `createTask(payload)`：
     - 校验入参：`mode` 必为 `'url'` 或 `'text'`；
       - `'url'` 模式：必有合法 `url`（走 `assertValidUrl` + `assertSafeFetchTarget`）；
       - `'text'` 模式：必有非空 `content`（拦截裸 URL `assertNotRawUrl`，走 `validateScriptRequest` 确定性截断至 12,000 字）；
     - 校验 `voiceMapping`（白名单）与 `apiKey`（若入参和 `process.env.DEEPSEEK_API_KEY` 都缺失，立刻同步拒绝 `400`「缺少 API Key」，不等到异步阶段才报错！）；
     - 创建任务记录并原子落盘，启动后台异步执行 `runPipeline(taskId, runtimeCreds)`（**不阻塞 HTTP 返回**），立刻返回 `toPublicTaskDTO(task)`。
  2. `runPipeline(taskId, runtimeCreds)`（四阶段状态机）：
     - 为该次运行创建新的 `AbortController` 存入 `activeControllers.set(taskId, controller)`；
     - **阶段 1 `extract`**：若已有 `task.sourceContent` 则跳过（如 text 模式或断点续跑）；否则更新阶段为 `extract`、调用 `extractArticle({ url }, { signal })`，成功后把 `title`、`sourceContent`、`sourceTruncated` 立刻落盘；
     - **阶段 2 `script`**：若已有 `task.script` 则跳过（断点续跑核心！不重复调 LLM）；否则校验有可用 `apiKey`（缺失报 `400/failed`），更新阶段为 `script`，调用 `generatePodcastScript({ title, content, apiKey, baseURL, model, signal })`，成功后立刻将 `script: { podcastTitle, summary, dialogue }` 落盘，同时把 `progress.totalSegments = dialogue.length`；
     - **阶段 3 `tts`**：更新阶段为 `tts`，调用 `synthesizeDialogueScript(task.script.dialogue, podcastWorkDir, voiceMapping, { provider, cache, signal, onProgress })`，每句完成更新 `progress.completedSegments` / `cachedSegments` / `message` 并落盘；
     - **阶段 4 `merge`**：更新阶段为 `merge`，调用 `concatenateAudioFiles(audioFileList, fullAudioPath)`，生成 `meta.json`（调用 `serializeSentences` 剔除 `filePath`）并原子写入 `podcastWorkDir/meta.json`；
     - **完成 `done`**：更新 `status = 'completed'`, `stage = 'done'`, `podcastId = task.id`, `error = null`，原子落盘；
     - **异常处理**：
       - 若为取消（`error.name === 'AbortError'` / `TtsCancelledError` / `controller.signal.aborted`）：置 `status = 'cancelled'`，`error = null`，落盘；
       - 否则置 `status = 'failed'`，记录脱敏后的 `error: { stage, message: redactSecrets(error.message), retryable: true, failedSegmentIndex }` 并落盘；
     - `finally`：清理 `activeControllers` 与 `activeTaskId`。
  3. `getTask(taskId)`：读取任务并转为 `TaskDTO`（若已完成则附带读取 `getPodcast(task.podcastId)`）；不存在抛 `404`。
  4. `cancelTask(taskId)`：若任务正在运行，触发 `controller.abort()` 并更新状态为 `'cancelled'`；若任务已结束则返回当前状态或 `409`（明确可预测语义）。
  5. `resumeTask(taskId, runtimeCreds)`：
     - 仅允许 `status === 'failed' || status === 'cancelled'`；运行中/已完成抛 `409`；
     - 若 `!task.script` 且无可用 `apiKey`（请求体与环境变量均无），直接同步抛 `400`「尚未生成剧本，请先配置 API Key 后再继续」；
     - 若 `task.script` 已存在，即使未传 `apiKey` 也允许直接从 TTS 断点续跑！
     - 重置 `status = 'running'`, `error = null`，异步启动 `runPipeline(taskId, runtimeCreds)` 并立刻返回 `TaskDTO`。
  6. `listPodcasts()` & `getPodcast(podcastId)`：
     - 校验 `podcastId` 格式（严防路径穿越，仅允许安全字符 `^[a-zA-Z0-9_-]+$`，非法报 `400/404`）；
     - `listPodcasts()`：扫描 `podcastsDir` 下所有子目录，仅收录同时存在合法 JSON `meta.json` 且存在非空 `full_podcast.mp3` 的目录；按 `createAt` 降序排列，返回 `{ items }`（每条含 `id, podcastTitle, summary, createAt, totalDuration, sentenceCount, fullAudioUrl`）；
     - `getPodcast(podcastId)`：读取 `meta.json` 并确认 `full_podcast.mp3` 存在，剔除历史旧数据里可能存在的 `filePath` 字段后返回 `PodcastDetailDTO`。

#### 2.4 新增离线单测
- `test/ttsCache.test.js`：验证缓存 key 一致性、写入后命中、损坏 MP3 缓存自动剔除重算、原子落盘不留 `.tmp-`。
- `test/taskManager.test.js`：全离线（注入假 extractor / 假 scriptGenerator / 本地 `fakeEdgeTts`），覆盖：
  1. 正常全流程（url 模式 & text 模式）进度推进与成品 `meta.json` / `full_podcast.mp3` 一致性；
  2. 断点续跑：模拟第 3 句 TTS 失败 → `resumeTask` 跳过 LLM（断言 LLM 调用次数仍为 1）且复用前 2 句已落盘 MP3（断言第 0、1 句不再调 TTS）→ 最终拼接完整零漂移；
  3. 任务取消：TTS 进行中调用 `cancelTask` → 状态变 `cancelled`，不留半成品 `.tmp-`；
  4. 服务重启自愈：预置一个 `status: 'running'` 的任务文件 → 新建 `TaskManager` 后自动转为 `failed` 且可续跑；
  5. 安全校验：落盘的 `data/tasks/<id>.json` 与 `meta.json` 中绝不包含测试传入的 `sk-secret-test-key` 与绝对路径 `filePath`；
  6. 历史列表：自动忽略残缺目录（无 `meta.json` 或无 `full_podcast.mp3`），正确返回完好历史并剥离旧 `filePath`。

**Phase 2 验收**：
- `npm test` 中新增 `ttsCache.test.js` 与 `taskManager.test.js` 全部通过（且既有底层测试全部保持绿色）。

---

### Phase 3：重构 `server.js` 为极简 V1 API 服务

**目标**：消除 `server.js` 重复代码与历史包袱，收紧安全边界，落地第 2 节定义的全部 V1 接口。

1. **安全与监听收敛**：
   - 移除 `server.js:5` 无条件执行的 `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`；改为：
     ```js
     if (process.env.ALLOW_INSECURE_TLS === '1') {
       process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
       console.warn('⚠️  [security] ALLOW_INSECURE_TLS=1 已开启，当前进程跳过 TLS 证书校验（仅限本地代理调试）');
     }
     ```
   - 移除无条件 `app.use(cors())`；仅在显式配置 `process.env.CORS_ORIGIN` 时挂载白名单 CORS（生产同源无需 CORS）。
   - 监听地址改为 `const HOST = process.env.HOST || '127.0.0.1'; app.listen(PORT, HOST, ...)`，启动日志打印 `http://${HOST}:${PORT}`，并提示局域网手机试听可用 `HOST=0.0.0.0 npm start`。
   - 移除 `bgmGenerator` 引用与默认 WAV 生成逻辑。
2. **工厂化、可测试性与桌面端目录解耦**：
   - 运行时目录优先读 `options` → 环境变量（`process.env.DATA_DIR`、`process.env.PODCASTS_DIR`）→ 默认项目路径（`./data`、`./public/podcasts`）；
   - 导出 `createApp(options)`（支持测试注入自定义 `taskManager` / 临时目录 `dataDir` / `podcastsDir`，避免测试污染工作区 `public/podcasts/` 与 `data/`）以及默认 `app` 实例；保留 `if (require.main === module)` 启动守卫。
3. **注册 V1 路由（严格对齐第 2 节契约）**：
   - `GET /api/health`
   - `POST /api/extract-article`（保持与现有提取逻辑和错误处理一致）
   - `POST /api/tasks`
   - `GET /api/tasks/:id`
   - `POST /api/tasks/:id/cancel`
   - `POST /api/tasks/:id/resume`
   - `GET /api/podcasts`
   - `GET /api/podcasts/:id`
   - 静态资源：显式挂载 `app.use('/podcasts', express.static(podcastsDir))`（必须挂在 `express.static(PUBLIC_DIR)` 之前，确保未来桌面端将 `PODCASTS_DIR` 指向系统用户目录时音频 URL 依然生效），再挂载 `express.static(PUBLIC_DIR)`。
   - 移除已砍掉的旧路由：`/api/bgm-list`、`/api/voices`、`/api/generate-script`、`/api/synthesize-podcast`、`/api/one-click-generate`。
4. **重写 `test/routes.test.js`**：
   - 使用临时目录隔离 `createApp({ dataDir, podcastsDir, ... })`，离线覆盖全部 8 个 V1 端点：
     - `health` 200；
     - `extract-article` 空输入 400、裸正文进链接框 400；
     - `POST /api/tasks` 缺 API Key 400、裸 URL 当正文 400、并发冲突 409、正常创建返回 202 + `taskId` 并最终完成；
     - `GET /api/tasks/:id` 不存在 404、完成后含 `podcast`；
     - `POST /api/tasks/:id/cancel` 与 `POST /api/tasks/:id/resume` 状态流转与 409 拒绝；
     - `GET /api/podcasts` & `GET /api/podcasts/:id` 返回成品、路径穿越 ID 拒绝（400/404）、响应不含 `apiKey`/`filePath`。

**Phase 3 验收**：
- `npm test` 全部通过（0 fail、0 cancelled）。

---

### Phase 4：重写单一极简生产前端 `public/`

**目标**：只保留一套清爽、可靠、直连 V1 真实接口的前端（桌面双栏 + 手机端自适应），彻底解决旧页面简陋与新原型造假/崩溃问题。

#### 4.1 视觉与结构蓝本
- 视觉采用**夜间电台深色工作台**风格（参考原 `design/web-mvp/prototype.css` 的色板与卡片层次：`#0b0f19` 背景、`#111827` 卡片、`#6366f1` 主色、`#38bdf8` 阿泽蓝、`#fb7185` 小晓粉），**彻底删除**所有模拟演示工具栏、禁用态假下拉框（对谈风格/BGM）和假定时数据。
- **响应式断点**：`≤900px` 自动切为单栏垂直排布，按钮点击热区高度 ≥ 44px，手机浏览器（Android / iPhone）打开无横向溢出。

#### 4.2 页面模块清单（`public/index.html` + `public/style.css`）
1. **顶部 Header**：
   - 左侧：Logo `🎙️ AI 妙听` + 副标题 `把长文变成轻松好听的双人播客`；
   - 右侧：固定主播标识 `阿泽 · 小晓` + `⚙️ 设置` 按钮（带绿/橙配置状态圆点）。
2. **左栏：输入、进度与历史**
   - **输入区**：Tab 切换 `文章链接` / `直接贴正文`；
     - 链接 Tab：URL 输入框 + `解析文章` 按钮 + 3 个内置示例快捷芯片（点击自动切到正文 Tab 并填入示例，便于快速体验）；
     - 正文 Tab：可选标题输入框 + 正文多行文本框 + 实时字数统计 + `预览并确认` 按钮。
   - **确认预览卡**（解析/确认后显示）：
     - 标题、来源标记、字数、截断提示（若超过 12,000 字明确标出「已截取前 1.2 万字」）；
     - 摘要预览 + 真实切换全文的 `展开全文预览 / 收起全文` 按钮（≤150 字自动隐藏）；
     - `修改输入` 按钮（真正存在并清空草稿聚焦输入框） + 主按钮 `⚡ 开始生成双人播客`。
   - **4 阶段真实进度卡**（运行中 / 失败 / 已取消时显示）：
     - 4 个步骤节点：`1. 抓取正文`、`2. 剧本重构`、`3. 语音合成`、`4. 音频拼接`；
     - 进度条：阶段 1/2/4 使用不定流光动画 + 真实已耗时秒数（客户端按 `stageStartedAt` 计算），阶段 3 严格按 `completedSegments / totalSegments * 100%` 推进并显示 `已完成 X/Y 句（缓存命中 K 句）`；
     - 运行中显示 `取消生成` 按钮；
     - 失败时显示可读错误横幅与分级动作：
       - 抓取失败：`切换到粘贴正文` + `原链接重试`；
       - 剧本/配音/拼接失败：`▶ 从断点继续生成` + `放弃`。
   - **最近播客历史列表**：
     - 页面初始化调用 `GET /api/podcasts` 渲染；点击任意条目直接调用 `GET /api/podcasts/:id` 载入右侧播放器，不触发生成。
3. **右栏：播放器与同步对话字幕**
   - **播放卡片**：标题、一句话摘要、句数与总时长、双人头像舞台（根据当前播放字幕说话人高亮阿泽或小晓，播放时带柔和呼吸动效）；
   - **真实 `<audio>` 控件**：进度滑块、当前/总时长、后退 10s、播放/暂停、快进 10s、倍速切换（`0.8x / 1.0x / 1.25x / 1.5x / 1.75x / 2.0x`）；
   - **导出操作**：`⬇️ 下载 MP3`（直链 `fullAudioUrl`）与 `📋 复制 Markdown 剧本`（格式化 `**阿泽**：...` 写入剪贴板并弹 toast 反馈）；
   - **同步对话字幕流**：
     - 点击或键盘 `Enter`/`Space` 跳转到 `s.startTime` 并开播；
     - 高亮算法兼容 `0.36s` 句间静音间隙（落在两句间隙时保持上一句高亮，不闪烁），切换句子时 `scrollIntoView({ behavior: 'smooth', block: 'nearest' })`。
4. **API 设置弹窗**：
   - 配置 `API Key`（`type="password"`）、`Base URL`（默认 `https://api.deepseek.com`）、`模型名称`（默认 `deepseek-flash`）；
   - 仅存 `localStorage`，明确提示不会写入服务器任务文件；启动生成前若未配置则自动弹窗引导（同时允许服务端已配 `.env` 兜底，可加一句提示或在后端校验）。

#### 4.3 状态管理与防错（`public/inputSource.js` + `public/app.js`）
- 保留 `public/inputSource.js` 现有 API 与单测不破坏；
- **防串线铁律**：
  - 用户修改 URL、修改标题/正文或切换 Tab，立刻作废 `confirmedDraft` 并隐藏确认卡；
  - 异步解析返回时严格校验 `seq`、模式与当前输入值，过期结果直接丢弃；
  - 启动生成时冻结本次确认快照提交给 `POST /api/tasks`。
- **刷新恢复**：
  - 任务创建后把 `activeTaskId` 存入 `localStorage`；
  - 页面加载时若 `localStorage` 有 `activeTaskId`，自动 `GET /api/tasks/:id`：
    - 若仍在进行中 → 恢复进度卡并继续轮询（每 1000ms）；
    - 若已完成 → 清除 `activeTaskId`、刷新历史列表并自动载入该播客；
    - 若失败/取消 → 恢复错误卡供用户点击“从断点继续生成”。
- **XSS 与健壮性**：
  - 所有动态文本严格使用 `textContent` 或 `escapeHtml`（转义 `& < > " '`）；
  - 不使用内联 `onclick="..."`，全部用 `addEventListener` 统一绑定，杜绝 `ReferenceError`；
  - 播放完成后正确恢复播放按钮图标与头像状态。

**Phase 4 验收**：
- `node --check public/inputSource.js && node --check public/app.js` 无语法错误；
- `test/inputSource.test.js` 全部通过；
- 启动本地服务并做冒烟检查：`GET /` 返回 200，`GET /app.js`、`GET /style.css`、`GET /inputSource.js` 均返回 200 且无旧 `bgm` 或死链引用。

---

### Phase 5：更新文档、全量回归与收尾交付

1. **重写 `README.md`**（完全据实，零虚假宣传）：
   - 介绍当前 V1 真实功能（链接/正文输入、4 阶段实时进度、单句缓存与断点续跑、本地历史恢复、点击字幕跳转、MP3 下载与 Markdown 剧本复制）；
   - 启动与测试命令：`npm start`、`npm run dev`、`npm test`；
   - 环境变量说明：`PORT`、`HOST`（含局域网手机浏览器试听方法 `HOST=0.0.0.0 npm start`）、`DATA_DIR`、`PODCASTS_DIR`、`DEEPSEEK_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`ALLOW_INSECURE_TLS`、`NODE_EXTRA_CA_CERTS`、`ALLOW_PRIVATE_FETCH`、`CORS_ORIGIN`；
   - 明确列出已知限制（Edge-TTS 为免费非官方接口仅适合个人使用、12,000 字截断、公众号反爬时切贴正文）及扩展新付费 TTS Provider 的入口位置（`src/services/ttsProvider.js`）。
2. **全量验证命令**：
   - `npm test`（必须 **0 fail、0 cancelled**，且输出中不再混入辅助脚本文件）；
   - `node --check server.js public/app.js public/inputSource.js src/services/*.js`；
   - 启动冒烟测试：拉起服务检查 `/api/health`、`/`、`/api/podcasts` 后干净关闭进程；
   - 检查 `public/podcasts/` 已有完好音频仍在，且 `git status` 中不含任何 `data/`、`public/podcasts/`、`.env` 敏感文件。
3. **Git 提交**：按阶段或最终收口做清晰 commit，确保工作区干净。

---

## 4. 关键避坑清单（执行端必读）

1. **不要动 `src/services/edgeTtsAdapter.js` 的核心 WS 生命周期逻辑**：里面刚修好 CONNECTING 状态 `terminate()` 未捕获异常（B-F1），只需在 `ttsProvider.js` 外层包装调用。
2. **不要在 `extractor.js` / `scriptEngine.js` 里给超时器加 `.unref()`**：`finally { clearTimeout(...) }` 已经清除了定时器；加 `.unref()` 会导致离线 mock 测试事件循环提前退出。
3. **`test/routes.test.js` 必须使用临时目录（`os.tmpdir()`）**：绝不能往项目真实的 `data/` 或 `public/podcasts/` 写入测试垃圾数据。
4. **不要删除 `public/podcasts/` 现有文件夹**：`GET /api/podcasts` 遇到历史残缺目录（缺 `meta.json` 或 `full_podcast.mp3`）静默跳过即可；读取旧 `meta.json` 时要剔除里面的 `filePath` 字段。
5. **续跑时可能没有传 `apiKey`**：如果任务已经过了 `script` 阶段（`task.script` 已落盘），`POST /api/tasks/:id/resume` 即使不传 `apiKey` 也必须放行直接跑 TTS 与拼接。
6. **避免内联 `onclick` 与散落的全局函数**：原 `design/web-mvp/` 崩掉的根因就是 HTML 内联 `onclick="resetParseState()"` 和 `mockData` 字段对不上；新 `public/app.js` 全部用 `addEventListener` 并集中在单模块闭包内管理状态。
7. **不要在离线测试之外擅自发起消耗用户 API 费用的真实 LLM 调用**：所有自动化验证必须全离线完成；真实联网生成留给用户自己填入 Key 后体验。

---

## 5. 需要中止并回退重新规划的信号（Re-plan if）

出现以下任一情况时，执行端应停止 improvisations 并汇报给架构师/用户重新拍板：
- 本机环境在默认 TLS 校验下无法启动或测试出现非预期证书阻塞，需要确认用户的系统 CA 配置方案；
- 任何既有核心单元测试（`mp3Utils`、`timeline`、`ttsAdapter`、`ttsAdapterLifecycle`、`extractor`、`scriptEngine`、`validation`、`inputSource`）出现无法解释的破坏性失败；
- 发现现有目录中存在计划未涵盖的隐藏业务文件或端口/进程冲突；
- 范围出现膨胀（例如发现需要引入新第三方 npm 包或数据库才能完成某功能）。
