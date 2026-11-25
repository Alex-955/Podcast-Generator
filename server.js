require('dotenv').config();
if (process.env.ALLOW_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️  [security] ALLOW_INSECURE_TLS=1 已开启，当前进程跳过 TLS 证书校验（仅限本地代理调试）');
}

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { version: APP_VERSION } = require('./package.json');
const { extractArticle } = require('./src/services/extractor');
const { extractTextFromImages } = require('./src/services/imageExtractor');
const { fetchLlmModels } = require('./src/services/llmModels');
const { polishArticleText } = require('./src/services/textPolisher');
const { createTaskManager } = require('./src/services/taskManager');
const { InputError, redactSecrets, ttsSecrets } = require('./src/services/validation');

const { getPublicTtsProviders, resolveDefaultProviderId } = require('./src/services/ttsProvider');

const { testLlmConnection, testTtsConnection } = require('./src/services/connectionTests');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FRONTEND_FILES = new Set(['/index.html', '/style.css', '/app.js', '/inputSource.js', '/audioEngine.js']);

function parsePort(value) {
  const text = value?.trim();
  if (!text) return 3000;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) throw new RangeError('PORT 必须是 0 至 65535 的整数');
  return port;
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function bearerToken(req) {
  return req.get?.('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
}

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function createApp(options = {}) {
  const app = express();
  const { adminToken = process.env.ADMIN_TOKEN?.trim() || '',
    isLoopbackRequest = req => isLoopbackAddress(req.socket?.remoteAddress) } = options;
  const adminDigest = adminToken && tokenDigest(adminToken);
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const podcastsDir = path.resolve(options.podcastsDir || process.env.PODCASTS_DIR || path.join(publicDir, 'podcasts'));
  const extractor = options.extractor || extractArticle;
  const manager = options.taskManager || createTaskManager({
    ...options, extractor, podcastsDir, tasksDir: path.join(dataDir, 'tasks'), cacheDir: path.join(dataDir, 'tts-cache'),
  });

  function authorizeDeletion(req, res, next) {
    if (isLoopbackRequest(req)) return next();
    if (!adminDigest) {
      return res.status(403).json({ success: false, error: '为保护本地播客，局域网设备默认禁止删除历史播客，请在启动服务的电脑本机删除' });
    }
    const candidates = [req.get('x-admin-token'), bearerToken(req)];
    if (candidates.some(token => token && timingSafeEqual(adminDigest, tokenDigest(token)))) return next();
    return res.status(403).json({ success: false, error: '局域网客户端无权删除本地播客，请在本机操作或提供有效管理令牌' });
  }

  const origins = process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean);
  if (origins?.length) {
    app.use(cors({ origin: origins, preflightContinue: true }));
    app.options(/^\/api\//, (req, res) => res.sendStatus(204));
  }
  const cancelOnDisconnect = handler => async (req, res) => {
    if (res.destroyed) return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const data = await handler(req.body || {}, { ...options, signal: controller.signal });
      if (!controller.signal.aborted) res.json({ success: true, data });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      res.removeListener('close', cancel);
    }
  };
  app.post('/api/extract-image', express.json({ limit: '25mb' }), cancelOnDisconnect(extractTextFromImages));
  app.use('/api', express.json({ limit: '10mb' }));

  app.post('/api/llm/test', async (req, res) => {
    res.json({ success: true, data: await testLlmConnection(req.body || {}, options) });
  });
  app.post('/api/llm/models', cancelOnDisconnect(fetchLlmModels));
  app.post('/api/polish-text', cancelOnDisconnect(polishArticleText));
  app.post('/api/tts/test', async (req, res) => {
    res.json({ success: true, data: await testTtsConnection(req.body || {}, options) });
  });
  app.get('/api/tts/providers', (req, res) => res.json({
    success: true, data: { items: getPublicTtsProviders(), defaultProvider: resolveDefaultProviderId() },
  }));
  app.get('/api/health', (req, res) => res.json({
    status: 'ok', app: 'ai-podcast-generator', version: APP_VERSION, time: new Date(),
  }));
  app.post('/api/extract-article', async (req, res) => {
    const { url, rawText } = req.body || {};
    if (url !== undefined && typeof url !== 'string') throw new InputError('url 必须是文本');
    if (rawText !== undefined && typeof rawText !== 'string') throw new InputError('rawText 必须是文本');
    const { title, content, length, truncated } = await extractor({ url, rawText });
    if (!content?.trim()) throw new InputError('未能提取到文章正文，请直接粘贴文章正文');
    res.json({ success: true, data: { title, content, length, truncated } });
  });
  app.post('/api/tasks', (req, res) => res.status(202).json({ success: true, data: manager.createTask(req.body || {}) }));
  app.get('/api/tasks/:id', (req, res) => res.json({ success: true, data: manager.getTask(req.params.id) }));
  app.post('/api/tasks/:id/cancel', (req, res) => res.json({ success: true, data: manager.cancelTask(req.params.id) }));
  app.post('/api/tasks/:id/resume', (req, res) => res.status(202).json({
    success: true, data: manager.resumeTask(req.params.id, req.body || {}),
  }));
  app.get('/api/podcasts', (req, res) => res.json({ success: true, data: manager.listPodcasts() }));
  app.get('/api/podcasts/:id', (req, res) => res.json({ success: true, data: manager.getPodcast(req.params.id) }));
  app.delete('/api/podcasts/:id', authorizeDeletion,
    (req, res) => res.json({ success: true, data: manager.deletePodcast(req.params.id) }));

  // Only audio is public here. Historical raw meta.json files can contain local paths.
  app.use('/podcasts', (req, res, next) => {
    if (!/^\/[a-zA-Z0-9_-]+\/[^/]+\.mp3$/i.test(decodeURIComponent(req.path))) return res.sendStatus(404);
    next();
  }, express.static(podcastsDir, { fallthrough: false }));
  app.use((req, res, next) => {
    const file = req.path === '/' ? '/index.html' : req.path;
    if (!['GET', 'HEAD'].includes(req.method) || !FRONTEND_FILES.has(file)) return next();
    res.sendFile(file.slice(1), { root: publicDir });
  });
  app.use('/api', (req, res) => res.status(404).json({ success: false, error: '接口不存在' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || err.status || (err instanceof URIError ? 400 : 500);
    let detail = err.message;
    if (status === 500 || err.path) detail = '本地服务未能完成请求';
    if (err.type === 'entity.parse.failed') detail = '请求体必须是有效 JSON';
    const sensitive = [req.body?.apiKey, req.body?.baseURL, process.env.DEEPSEEK_API_KEY, process.env.LLM_BASE_URL,
      req.body?.visionApiKey, req.body?.visionBaseURL, process.env.VISION_API_KEY, process.env.VISION_BASE_URL,
      ...ttsSecrets(req.body?.tts ?? {}), adminToken, req.get?.('x-admin-token'), bearerToken(req), dataDir, podcastsDir];
    const error = redactSecrets(detail, sensitive);
    const code = typeof err.code === 'string' ? redactSecrets(err.code, sensitive) : undefined;
    res.status(status).json({ success: false, error, code });
  });
  return app;
}

const app = createApp();
app.createApp = createApp;
app.parsePort = parsePort;
app.isLoopbackAddress = isLoopbackAddress;
module.exports = app;

if (require.main === module) {
  const HOST = process.env.HOST || '127.0.0.1';
  const PORT = parsePort(process.env.PORT);
  const portable = process.send && process.argv[2]?.startsWith('--portable-instance=');
  const server = app.listen(PORT, HOST, error => {
    if (error) {
      const code = error.code || 'LISTEN_ERROR';
      if (portable && process.connected) process.send({ error: code }, () => {});
      console.error('AI 妙听无法启动（%s）', code);
      process.exitCode = 1;
      return;
    }
    if (portable && process.connected) process.send({ port: server.address().port }, () => {});
    console.log(`AI 妙听播客服务已启动 http://${HOST}:${server.address().port}`);
    console.log('局域网手机试听可使用 HOST=0.0.0.0 npm start');
  });
}
