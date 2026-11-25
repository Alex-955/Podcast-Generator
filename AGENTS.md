# 项目开发分工与工程红线

> 本文件作为本项目永久本地协作规范，所有主控与子代理必须严格遵守。

## 1. 角色分工（严格执行，不得越界）

- **Antigravity（主控 / 架构与前端负责）**
  - 负责系统架构规划、API 契约与安全红线设计；
  - 负责全部前端页面、样式与交互动效实现（`public/index.html`、`public/style.css`、`public/app.js` 等），按 `oil-ui` 规范做实景截图与视觉验收；
  - 负责向 Codex 子代理派发开发与独立审查任务，并统筹最终全量回归与交付。
  - **未经用户明确许可，主控不得绕过 Codex 直接修改后端代码或运维脚本。**

- **Codex（后端开发、脚本实现与独立代码审查，经 `delegate_task` 调度）**
  - 负责全部后端服务、TTS/LLM 适配、路由逻辑（`server.js`、`src/services/*`）、本机自动化脚本（`scripts/*`）及后端离线单元测试（`test/*`）的开发与缺陷修复；
  - 负责在后端改动提交后，由独立的 Codex 审查子代理执行只读代码审计（重点查凭据防泄露、协议边界、异常流、状态机与测试覆盖）：
    - **同一批次内合并审查与复用**：同一批次的相关改动合并提交后再统一派审，同一批次内的复审直接通过 `t3_thread_send` **复用同一个** Codex 审查子代理线程；进入下一批新任务开发时再新建新的审查子代理；
    - **轮次上限**：每批审查最多不超过 **2 轮**（初审 + 最多 1 轮复审即收口，发现 P0/P1 问题打回修复，不因边缘文案无止境加轮）。

## 2. 项目硬红线

1. **分支与发布纪律**：严禁未经用户明确授权合并到 `main` 或执行 `git push`。
2. **凭据与隐私零泄露**：
   - 任何 LLM / TTS 密钥（`apiKey`、`accessKey`、`appId`、自定义 `baseURL`/`endpoint`）严禁持久化写入 `data/tasks/*.json`、`public/podcasts/*/meta.json` 或日志；
   - 所有错误消息、DTO 与响应必须经过 `redactSecrets` 脱敏且不含服务器本地绝对路径。
3. **保护现有数据**：严禁删除或破坏 `public/podcasts/` 下用户已有的完整历史播客目录。
4. **离线测试原则**：所有 `npm test` 回归必须 100% 离线运行并隔离在 `os.tmpdir()`，不得消耗用户真实 API 额度。
5. **轻量技术栈边界**：保持纯 Node.js + Express 5 + 原生 HTML/CSS/JS，不擅自引入 React/Vue、数据库/Redis 或 `ffmpeg`。
6. **冻结与防回退规则**：不破坏 `src/services/edgeTtsAdapter.js` 核心 WebSocket 生命周期与 `public/inputSource.js` 既有单测契约；不给 `extractor.js` / `scriptEngine.js` 超时定时器加 `.unref()`。
