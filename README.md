# AI 妙听 · 双人对话播客生成器（V1）

将网页长文、微信公众号文章或任意文本，重构为自然生动的双人对话播客（主持人**阿泽** × 常驻嘉宾**小晓**），并生成纯人声完整 MP3 与同步高亮对话字幕。

应用基于 **Node.js + Express 5 + 原生 HTML/CSS/JS** 构建，无需数据库、Redis 或外部 `ffmpeg` 依赖。

---

## 核心能力

- **双通道防串线输入与预览确认**
  - 支持「文章链接解析」与「直接贴正文」，内置 3 组快速试听示例；
  - 超过 12,000 字自动截取前段并给出明确提示，支持「展开全文预览」；
  - 修改链接、正文或切换输入模式时立即作废旧确认草稿，并丢弃过期异步解析结果。
- **异步 4 阶段实时进度与可取消**
  - 提交任务后立刻返回任务 ID，前端按阶段推进展示：`1. 抓取正文` → `2. 剧本重构` → `3. 语音合成` → `4. 音频拼接`；
  - 配音阶段实时展示已完成句数、缓存命中数与当前说话人，不伪造百分比；
  - 运行中可随时取消，真正中断底层 HTTP 请求与 TTS WebSocket 连接。
- **多厂商剧本模型与多语音合成服务商**
  - 右上角 **「模型与语音」** 弹窗提供两页配置，全部凭据仅存在浏览器 `localStorage`，绝不写入任务记录或成品 JSON：
    - **剧本模型**：内置 DeepSeek（推荐）、Kimi、豆包（火山方舟）、通义千问、小米 MiMo、硅基流动与自定义 OpenAI 兼容快捷预设，自动填充 Base URL 与推荐模型并附获取指引，支持 **「测试模型连接」** 实时探活；
    - **语音合成**：支持 **MiniMax Speech**、**火山引擎（豆包语音 V3）**（单 API Key 或 AppID + Access Key，自动筛选 1.0/2.0 兼容音色）与免费 **Microsoft Edge** 一键切换，支持 **「测试语音合成」** 在线合成试听校验；
  - 切换服务商或音色后从断点续跑时，自动清理旧片段但保留已生成剧本。
- **单句 MP3 缓存与断点续跑**
  - 按服务端点、鉴权指纹、model、voiceMapping、语速与文本摘要隔离缓存单句有效 MP3（`data/tts-cache/`）；
  - 合成中断或服务重启导致任务中断时，点击「从断点继续生成」可跳过已落盘剧本与已合成有效单句音频。
- **纯音质放音台与本地历史找回**
  - 双主播活跃声纹指示、兼容 `0.36s` 句间静音的同步高亮字幕、点击或 `Enter` / `Space` 跳转对应句；
  - 支持 `0.8x ~ 2.0x` 倍速切换、快进/快退 10 秒、进度拖拽、下载完整 MP3 与一键复制 Markdown 剧本；
  - 刷新页面后自动恢复未完成/待续跑任务，并从本地加载历史播客列表。

---

## 快速启动与测试

### 1. 安装依赖与启动

```bash
npm install
npm start
```

服务默认监听 `http://127.0.0.1:3000`。打开浏览器后，可在右上角 **「模型与语音」** 中选择大模型快捷预设与语音服务商并填入 API Key（仅存在当前浏览器 `localStorage`，不会写入服务端任务或成品 JSON），或复制 `.env.example` 为 `.env` 提供默认 Key。

> `npm start` 与 `npm run dev` 默认启用了 `--use-bundled-ca`，避免部分 macOS Homebrew Node 环境因缺少 OpenSSL `cert.pem` 导致 HTTPS 证书校验失败，同时保留完整证书校验并兼容 `NODE_EXTRA_CA_CERTS`。

### 2. 便携版下载与一键双击启动（Windows + macOS）

本项目提供同源的 Windows 与 macOS 双端便携启动器，无需数据库、Redis 或 `ffmpeg`：

- **Windows**：解压便携包后直接双击根目录 **`启动 AI 妙听.bat`**（若从源码仓库直接运行，也可运行 `scripts\launchers\start-windows.bat`；会自动检测 Node.js、按需补装依赖、端口占用自动顺延并弹出浏览器）；双击 **`停止 AI 妙听.bat`** 安全停止后台服务。
- **macOS**：解压便携包后直接双击根目录 **`启动 AI 妙听.command`**（源码仓库位于 `scripts/launchers/start-macos.command`，会自动搜索常见 PATH / Homebrew / nvm / Volta / fnm 路径下的 Node.js 并启动打开网页）；双击 **`停止 AI 妙听.command`** 停止服务。也可运行 `bash scripts/build-mac-launcher.sh` 生成 **`启动 AI 妙听.app`** 拖入程序坞使用。
- **命令行常用命令**：
  ```bash
  # 启动后台服务并自动打开浏览器（端口被占用时自动顺延空闲端口）
  npm run launcher
  npm run launcher:stop

  # 开放局域网手机试听（同一 Wi-Fi 下可直接扫码/输 IP 打开）
  node scripts/start-portable.js --lan --open

  # 构建带依赖与 SHA256 校验文件的双端干净便携包（内置发布前隐私与安全门禁）
  npm run release:build -- --with-deps --format both
  ```
  推送 `v*` 标签到 GitHub 时，GitHub Actions 会自动运行全量离线测试、安全门禁并生成 `.zip` / `.tar.gz` 便携包及 `SHA256SUMS.txt` 发布到 GitHub Releases。

### 3. 开发热重载与离线回归测试

```bash
# 开发模式（监听 server.js 改动自动重启）
npm run dev

# 运行全量离线单元测试（不联网、不消耗 LLM 额度）
npm test
```

### 4. 局域网手机浏览器试听

在桌面与手机处于同一局域网（Wi-Fi）时，指定 `HOST=0.0.0.0` 启动即可用手机浏览器访问：

```bash
HOST=0.0.0.0 npm start
```

界面在视口宽度 `≤ 900px` 时会自动切换为单栏触控布局。

> 为保护本机历史播客，在通过 `HOST=0.0.0.0` 开放局域网试听时，非本机（非 loopback）客户端仅被限制删除本地历史播客（`DELETE /api/podcasts/:id` 会返回 `403`，浏览列表、播放试听与任务生成等接口不受影响）。如需允许局域网设备执行删除，请在服务端配置 `ADMIN_TOKEN`，并在请求头中传入 `Authorization: Bearer <token>` 或 `X-Admin-Token`。

---

## 环境变量说明

所有环境变量均为可选，可通过 `.env` 或启动命令传入：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口（`0` 表示由系统分配随机空闲端口） |
| `HOST` | `127.0.0.1` | 服务绑定地址；局域网手机访问可设为 `0.0.0.0` |
| `ADMIN_TOKEN` | 空 | 局域网删除管理令牌；未配置时仅允许本机（loopback）删除播客，配置后局域网客户端需带 `Authorization: Bearer <token>` 或 `X-Admin-Token` 方可执行 `DELETE /api/podcasts/:id` |
| `DATA_DIR` | `./data` | 运行时任务状态（`tasks/*.json`）与单句缓存（`tts-cache/*.mp3`）目录 |
| `PODCASTS_DIR` | `./public/podcasts` | 成品播客音频与 `meta.json` 存放目录 |
| `DEEPSEEK_API_KEY` | 空 | 服务端默认兜底 API Key（仅当浏览器设置留空且未改接口地址时生效） |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 剧本模型 OpenAI 兼容接口地址 |
| `LLM_MODEL` | `deepseek-flash` | 默认剧本生成模型名称 |
| `TTS_PROVIDER` | `edge` | 默认语音合成服务商，可选 `minimax`、`volcengine`、`edge` |
| `MINIMAX_API_KEY` | 空 | 服务端默认 MiniMax Speech API Key |
| `MINIMAX_TTS_MODEL` | `speech-02-hd` | 默认 MiniMax 语音合成模型 |
| `MINIMAX_TTS_ENDPOINT` | `https://api.minimaxi.com/v1/t2a_v2` | MiniMax Speech 合成接口地址 |
| `VOLCENGINE_TTS_API_KEY` | 空 | 服务端默认火山引擎豆包语音单 API Key（`X-Api-Key`） |
| `VOLCENGINE_TTS_APP_ID` | 空 | 火山引擎旧版双字段鉴权 AppID（未配 `VOLCENGINE_TTS_API_KEY` 时生效） |
| `VOLCENGINE_TTS_ACCESS_KEY` | 空 | 火山引擎旧版双字段鉴权 Access Key |
| `VOLCENGINE_TTS_RESOURCE_ID` | `seed-tts-2.0` | 默认火山引擎语音资源版本（`seed-tts-2.0` 或 `seed-tts-1.0`） |
| `VOLCENGINE_TTS_ENDPOINT` | `https://openspeech.bytedance.com/api/v3/tts/unidirectional` | 火山引擎豆包 V3 单向流式接口地址 |
| `ALLOW_PRIVATE_TTS_ENDPOINT` | 未开启 | 默认拒绝连接内网/本机语音接口；设为 `1` 可放开局域网 TTS 调试端点 |
| `ALLOW_INSECURE_TLS` | 未开启 | 仅限本地代理调试；设为 `1` 时跳过 TLS 证书校验（默认 `--use-bundled-ca` 已兼顾完整性，常规企业代理 CA 请优先用 `NODE_EXTRA_CA_CERTS`） |
| `NODE_EXTRA_CA_CERTS` | 未设置 | Node 标准选项：指定额外受信 CA 根证书文件路径 |
| `ALLOW_PRIVATE_FETCH` | 未开启 | 默认拒绝抓取本机及内网地址；设为 `1` 可放开本地源抓取（不影响 TTS 私网策略） |
| `CORS_ORIGIN` | 未开启 | 默认同源访问；需跨域调用时可填逗号分隔的来源白名单 |

---

## 已知限制与扩展说明

1. **配音服务定位**：默认内置 **MiniMax Speech**（拟真度高）、**火山引擎（豆包语音 V3，OPPO AI 妙听同款体系）** 与免费 **Microsoft Edge-TTS**（`edge` 属免费非官方接口，偶发 403 限流，建议仅作快速试用）。
2. **正文截断上限**：为控制生成稳定性与成本，单次导入正文上限为 `12,000` 字（超出部分按确定性截取前 1.2 万字，标题上限 `200` 字）。
3. **字幕同步时间轴**：字幕高亮基于纯 Node 解析的 MP3 帧计数与固定 `0.36s` 句间静音间隔计算，非逐字级 ASR 对齐。
4. **公众号反爬验证**：微信公众号链接偶发返回「环境异常」或「操作频繁」提示时，可点击提示条中的 **「切换到直接贴正文」** 直接粘贴原文继续生成。
5. **网络安全基线**：TTS 端点与连接探测均执行 DNS 解析后 IP 校验与重定向拦截（仅当服务端显式开启 `ALLOW_PRIVATE_TTS_ENDPOINT=1` 才放开内网地址）；文章抓取器默认阻断本机/内网地址。
6. **后续客户端规划**：详见 [ROADMAP.md](ROADMAP.md)。
