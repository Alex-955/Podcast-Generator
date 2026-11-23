# B0-6 安全说明与待确认项（2026-09-22）

## 已实施（B0 范围内）

1. **SSRF 防护**（`src/services/extractor.js` → `assertSafeFetchTarget`）
   - 文章抓取默认拒绝：回环（127.0.0.0/8、::1）、私网（10/8、172.16/12、192.168/16、fc00::/7）、链路本地（169.254/16、fe80::/10、[::ffff:...] 映射地址）、localhost / *.local / *.internal 主机名。
   - 显式例外：`ALLOW_PRIVATE_FETCH=1` 可放开（当前开发环境在用，例如抓内网测试页）。
   - 已知限制：仅校验主机名字面量，未做 DNS 解析后复检（DNS rebinding 防护留待后续）。
   - 范围声明：仅约束 extractor 的文章抓取；LLM baseURL 不受限（用户自己的 API 端点）。
2. **错误脱敏**（`src/services/validation.js` → `redactSecrets`）：所有 5xx 错误消息经正则脱敏 `Bearer` / `sk-` / `api_key|token|secret` 形态凭据后才返回与落日志；日志不输出堆栈。
3. **路径不泄露**：`meta.json` 与 API 响应剔除 `filePath` 等服务器内部绝对路径（`serializeSentences`）。
4. **产物文件名内部安全 ID**：`sentence_000.mp3` 序号命名，speaker 文本绝不进文件路径。
5. **输入校验**（`src/services/validation.js`）：标题 200 字 / 正文 12000 字（超出确定性截断并置 `truncated`）/ 台词 300 行 × 2000 字 / 音色白名单 / URL 仅 http(s)。

## 待用户确认（安全边界变更，状态：blocked）

以下三项都属于安全边界变更，**未实施**，需 Alex 明确确认后才做：

| # | 事项 | 现状 | 建议方案 | 状态 |
|---|------|------|---------|------|
| 1 | 恢复 TLS 证书校验 | `server.js` 入口全局 `NODE_TLS_REJECT_UNAUTHORIZED='0'`（本机证书链问题所需） | `NODE_EXTRA_CA_CERTS` 挂载本机代理/自签 CA，或修复系统证书链后删除该行 | blocked |
| 2 | 默认回环监听 | `app.listen(PORT)` 监听所有网卡，局域网内其他设备可访问 | `HOST=127.0.0.1` 默认回环，`HOST=0.0.0.0` 显式放开 | blocked |
| 3 | 限制 CORS 来源 | `app.use(cors())` 全开 | 收敛为本站 origin | blocked |

> 第 1 项风险最实际：全局关闭证书校验意味着本机所有 Node 进程的 HTTPS 都不再验证对端证书，公网部署前必须移除。当前仅限本地个人使用。

## 依赖说明

- `node-edge-tts@1.2.10` 自 B0-4 起不再是运行时调用路径（TTS 走自建 `src/services/edgeTtsAdapter.js`），仅留作 token 算法参照。是否移除依赖待 B1 决定。
- 自建适配层约 150 行自维护代码：微软 Edge 读屏协议与 Sec-MS-GEC token 算法若变更需跟进（`DEFAULT_OUTPUT_FORMAT`、`TRUSTED_CLIENT_TOKEN`、`Sec-MS-GEC-Version`）。
