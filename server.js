require('dotenv').config();
if (process.env.ALLOW_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️  [security] ALLOW_INSECURE_TLS=1 已开启，当前进程跳过 TLS 证书校验（仅限本地代理调试）');
}

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { version: APP_VERSION } = require('./package.json');
const { extractArticle } = require('./src/services/extractor');
const { extractTextFromImages } = require('./src/services/imageExtractor');
const { fetchLlmModels } = require('./src/services/llmModels');
const { polishArticleText } = require('./src/services/textPolisher');
const { recommendPodcastStyle } = require('./src/services/styleRecommender');
const { acquireInstanceLock, withDataDirLock } = require('./src/services/instanceLock');
const { createTaskManager } = require('./src/services/taskManager');
const { InputError, ttsSecrets } = require('./src/services/validation');
const { redactProviderDetail } = require('./src/services/providerHttp');

const { getPublicTtsProviders, resolveDefaultProviderId } = require('./src/services/ttsProvider');

const { testLlmConnection, testTtsConnection } = require('./src/services/connectionTests');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 3456;
const DEFAULT_PORT_FALLBACK_MAX = 3475;
const FRONTEND_FILES = new Set(['/index.html', '/style.css', '/app.js', '/inputSource.js', '/audioEngine.js']);

function parsePort(value) {
  if (value == null) return DEFAULT_PORT;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (!text) return DEFAULT_PORT;
    const port = Number(text);
    if (/^\d+$/.test(text) && port <= 65535) return port;
  }
  throw new RangeError('PORT 必须是 0 至 65535 的整数');
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

const appStartup = new WeakMap();

function resolveDataDir(directory) {
  return path.resolve(directory || process.env.DATA_DIR || path.join(__dirname, 'data'));
}

function createApp(options = {}, ownerToken) {
  const app = express();
  const { adminToken = process.env.ADMIN_TOKEN?.trim() || '',
    isLoopbackRequest = req => isLoopbackAddress(req.socket?.remoteAddress) } = options;
  const adminDigest = adminToken && tokenDigest(adminToken);
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
  const dataDir = resolveDataDir(options.dataDir);
  const podcastsDir = path.resolve(options.podcastsDir || process.env.PODCASTS_DIR || path.join(publicDir, 'podcasts'));
  const extractor = options.extractor || extractArticle;
  const { taskManager } = options;
  let manager = taskManager;
  function initializeManager(token = ownerToken) {
    ownerToken = token;
    manager ??= createTaskManager({
      ...options, extractor, podcastsDir, tasksDir: path.join(dataDir, 'tasks'), cacheDir: path.join(dataDir, 'tts-cache'),
    });
  }
  appStartup.set(app, { dataDir, initializeManager });
  const requests = new Set();
  let shutdown;
  function unavailable(req, res) {
    res.set('Connection', 'close').status(503);
    if ((req.baseUrl + req.path).toLowerCase().replace(/\/$/, '') === '/api/health') {
      return res.json({ status: 'shutting_down', app: 'ai-podcast-generator', version: APP_VERSION });
    }
    return res.json({ success: false, error: '服务正在关闭，暂不接收新请求', code: 'SERVER_SHUTTING_DOWN' });
  }
  app.shutdown = opts => {
    if (shutdown) return shutdown;
    shutdown = Promise.resolve().then(() => manager?.shutdown?.(opts));
    for (const controller of requests) controller.abort();
    return shutdown;
  };
  function checkAvailable(req, res, next) {
    if (shutdown) return unavailable(req, res);
    next();
  }

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
  }
  function withManagerAccess(req, res, next) {
    if (taskManager) return next();
    withDataDirLock(dataDir, ownerToken, () => {
      initializeManager();
      next();
    });
  }
  app.use('/api', checkAvailable);
  if (origins?.length) app.options(/^\/api\//, withManagerAccess, (req, res) => res.sendStatus(204));
  const cancelOnDisconnect = handler => async (req, res) => {
    if (res.destroyed) return;
    if (shutdown) return unavailable(req, res);
    const controller = new AbortController();
    requests.add(controller);
    const cancel = () => {
      requests.delete(controller);
      controller.abort();
    };
    res.once('close', cancel);
    try {
      const data = await handler(req.body || {}, { ...options, signal: controller.signal });
      if (!controller.signal.aborted) res.json({ success: true, data });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      requests.delete(controller);
      res.removeListener('close', cancel);
      if (shutdown && !res.destroyed && !res.headersSent) unavailable(req, res);
    }
  };
  app.post('/api/extract-image', express.json({ limit: '25mb' }), withManagerAccess, cancelOnDisconnect((payload, opts) => {
    try {
      return extractTextFromImages(payload, opts);
    } finally {
      delete payload.images;
    }
  }));
  app.use('/api', express.json({ limit: '10mb' }), checkAvailable, withManagerAccess);

  app.post('/api/llm/test', cancelOnDisconnect(testLlmConnection));
  app.post('/api/llm/models', cancelOnDisconnect(fetchLlmModels));
  app.post('/api/polish-text', cancelOnDisconnect(polishArticleText));
  app.post('/api/recommend-style', cancelOnDisconnect(recommendPodcastStyle));
  app.post('/api/tts/test', cancelOnDisconnect(testTtsConnection));
  app.get('/api/tts/providers', (req, res) => res.json({
    success: true, data: { items: getPublicTtsProviders(), defaultProvider: resolveDefaultProviderId() },
  }));
  app.get('/api/health', (req, res) => res.json({
    status: 'ok', app: 'ai-podcast-generator', version: APP_VERSION, time: new Date(),
  }));
  app.post('/api/extract-article', cancelOnDisconnect(async ({ url, rawText }, { signal }) => {
    if (url !== undefined && typeof url !== 'string') throw new InputError('url 必须是文本');
    if (rawText !== undefined && typeof rawText !== 'string') throw new InputError('rawText 必须是文本');
    const { title, content, length, truncated } = await extractor({ url, rawText }, { signal });
    if (!content?.trim()) throw new InputError('未能提取到文章正文，请直接粘贴文章正文');
    return { title, content, length, truncated };
  }));
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
    if (shutdown && /^\/api(?:\/|$)/i.test(req.path)) return unavailable(req, res);
    const status = err.statusCode || err.status || (err instanceof URIError ? 400 : 500);
    let detail = err.message;
    if (status === 500 || err.path) detail = '本地服务未能完成请求';
    if (err.type === 'entity.parse.failed') detail = '请求体必须是有效 JSON';
    const sensitive = [req.body?.apiKey, req.body?.baseURL, process.env.DEEPSEEK_API_KEY, process.env.LLM_BASE_URL,
      req.body?.visionApiKey, req.body?.visionBaseURL, process.env.VISION_API_KEY, process.env.VISION_BASE_URL,
      ...ttsSecrets(req.body?.tts ?? {}), adminToken, req.get?.('x-admin-token'), bearerToken(req), dataDir, podcastsDir];
    const error = redactProviderDetail(detail, sensitive);
    const code = typeof err.code === 'string' ? redactProviderDetail(err.code, sensitive) : undefined;
    res.status(status).json({ success: false, error, code });
  });
  return app;
}

function listen(app, host, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function startServer({
  app, host = '127.0.0.1', port, allowPortFallback = port == null || String(port).trim() === '',
  maxFallbackPort = DEFAULT_PORT_FALLBACK_MAX, allowEphemeralFallback = true, ...createAppOptions
} = {}) {
  const preferredPort = parsePort(port);
  const lastPort = Math.min(65535, Math.floor(maxFallbackPort));
  let candidate = preferredPort;
  let server;
  const dataDir = appStartup.get(app)?.dataDir ?? resolveDataDir(createAppOptions.dataDir);
  const release = await acquireInstanceLock(dataDir);
  try {
    app ??= createApp({ ...createAppOptions, dataDir });
    appStartup.get(app)?.initializeManager(release);
    for (;;) {
      try {
        server = await listen(app, host, candidate);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || !allowPortFallback || candidate === 0) throw error;
        if (candidate < lastPort) candidate++;
        else if (allowEphemeralFallback !== false) candidate = 0;
        else throw error;
      }
    }
  } catch (error) {
    release();
    throw error;
  }

  const actualPort = server.address().port;
  let closing;
  async function drain(timeoutMs) {
    let appClosed;
    try {
      appClosed = app.shutdown?.({ timeoutMs });
    } catch (error) {
      appClosed = Promise.reject(error);
    }
    const serverClosed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    let timer, drained = false;
    try {
      await Promise.race([
        Promise.all([appClosed, serverClosed]).then(() => { drained = true; }),
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (!drained) server.closeAllConnections?.();
      await serverClosed;
    }
  }

  function close({ timeoutMs = 5000 } = {}) {
    if (closing) return closing;
    const completion = Promise.withResolvers();
    closing = completion.promise;
    drain(timeoutMs).finally(release).then(completion.resolve, completion.reject);
    return closing;
  }
  return { app, server, host, port: actualPort, preferredPort, fellBack: preferredPort !== 0 && actualPort !== preferredPort, close };
}

module.exports = { createApp, startServer, parsePort, isLoopbackAddress, DEFAULT_PORT, DEFAULT_PORT_FALLBACK_MAX };

async function main() {
  const host = process.env.HOST || '127.0.0.1';
  const explicitPort = Boolean(process.env.PORT?.trim());
  const portable = process.send && process.argv[2]?.startsWith('--portable-instance=');
  try {
    const { port, preferredPort, fellBack, close } = await startServer({
      host, port: process.env.PORT, allowPortFallback: !explicitPort,
    });
    async function stop() {
      try {
        await close();
      } catch {
        console.error('AI 妙听未能完整关闭');
        process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (portable && process.connected) process.send({ port }, () => {});
    if (fellBack) console.log(`首选端口 ${preferredPort} 已被占用，当前监听端口为 ${port}`);
    console.log(`AI 妙听播客服务已启动 http://${host.includes(':') ? '[' + host + ']' : host}:${port}`);
    console.log('局域网手机试听可使用 HOST=0.0.0.0 npm start');
  } catch (error) {
    const code = error.code || 'LISTEN_ERROR';
    if (portable && process.connected) process.send({ error: code }, () => {});
    if (code === 'DATA_DIR_LOCKED') console.error(error.message);
    else console.error('AI 妙听无法启动（%s）', code);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
