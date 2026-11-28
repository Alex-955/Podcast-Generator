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
const { createCollectionStore } = require('./src/services/collectionStore');
const { createLanCompanion } = require('./src/services/lanCompanion');
const { suggestCollection } = require('./src/services/collectionSuggester');
const { llmSecrets } = require('./src/services/llmCredentials');
const { createTaskManager, createPodcastCatalog } = require('./src/services/taskManager');
const { checkId, InputError, ttsSecrets } = require('./src/services/validation');
const { createUpdateChecker, offlineResult } = require('./src/services/updateChecker');
const { redactProviderDetail } = require('./src/services/providerHttp');

const { getPublicTtsProviders, resolveDefaultProviderId } = require('./src/services/ttsProvider');

const { testLlmConnection, testTtsConnection } = require('./src/services/connectionTests');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 3456;
const DEFAULT_PORT_FALLBACK_MAX = 3475;
const FRONTEND_FILES = new Set(['/index.html', '/style.css', '/app.js', '/inputSource.js', '/audioEngine.js', '/icon.png']);

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

function createApp({ desktopSessionToken, ...options } = {}, ownerToken) {
  const app = express();
  const { adminToken = process.env.ADMIN_TOKEN?.trim() || '',
    isLoopbackRequest = req => isLoopbackAddress(req.socket?.remoteAddress) } = options;
  const adminDigest = adminToken && tokenDigest(adminToken);
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
  const dataDir = resolveDataDir(options.dataDir);
  const podcastsDir = path.resolve(options.podcastsDir || process.env.PODCASTS_DIR || path.join(publicDir, 'podcasts'));
  const updateChecker = options.updateChecker || createUpdateChecker({ fetcher: options.updateFetcher });
  const extractor = options.extractor || extractArticle;
  const { taskManager } = options;
  const collectionStore = options.collectionStore || createCollectionStore({ dataDir, podcastsDir, adminToken, desktopSessionToken });
  let manager = taskManager;
  function initializeManager(token = ownerToken) {
    ownerToken = token;
    manager ??= createTaskManager({
      ...options, collectionStore, adminToken, extractor, podcastsDir, tasksDir: path.join(dataDir, 'tasks'), cacheDir: path.join(dataDir, 'tts-cache'),
    });
  }
  const companionCatalog = createPodcastCatalog({
    podcastsDir, collectionStore, adminToken, extraSecrets: [desktopSessionToken, dataDir].filter(Boolean).map(String),
  });
  const lanCompanion = options.lanCompanion || createLanCompanion({
    manager: taskManager || companionCatalog, collectionStore, publicDir, podcastsDir,
    getLanInterfaces: options.getLanInterfaces,
    sensitive: [desktopSessionToken, adminToken, dataDir, podcastsDir],
  });
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
    shutdown = Promise.all([lanCompanion.stop(), Promise.resolve().then(() => manager?.shutdown?.(opts))]).then(() => {});
    for (const controller of requests) controller.abort();
    return shutdown;
  };
  function checkAvailable(req, res, next) {
    if (shutdown) return unavailable(req, res);
    next();
  }

  function authorizePodcastWrite(req, res, next) {
    if (isLoopbackRequest(req)) return next();
    const deletion = req.route.path === '/api/podcasts/:id' && req.method === 'DELETE';
    if (!adminDigest) {
      return res.status(403).json({ success: false, error: deletion ? '为保护本地播客，局域网设备默认禁止删除历史播客，请在启动服务的电脑本机删除' : '请在本机操作，或配置管理令牌' });
    }
    const candidates = [req.get('x-admin-token'), bearerToken(req)];
    if (candidates.some(token => token && timingSafeEqual(adminDigest, tokenDigest(token)))) return next();
    return res.status(403).json({ success: false, error: deletion ? '局域网客户端无权删除本地播客，请在本机操作或提供有效管理令牌' : '此操作需要有效管理令牌' });
  }

  function authorizeTaskWrite(req, res, next) {
    if (!isLoopbackRequest(req) && manager.isPodcastEdit(req.params.id)) return authorizePodcastWrite(req, res, next);
    next();
  }

  if (desktopSessionToken !== undefined) {
    if (!desktopSessionToken || typeof desktopSessionToken !== 'string') throw new Error('桌面会话令牌无效');
    const digest = tokenDigest(desktopSessionToken);
    app.use((req, res, next) => {
      const localHost = '127.0.0.1:' + req.socket.localPort;
      const trusted = value => {
        if (value === undefined) return true;
        try {
          const url = new URL(value);
          if (url.username || url.password) return false;
          return (url.protocol === 'http:' && url.host === localHost) ||
            (url.protocol === 'inkcast:' && url.host === 'app');
        } catch { return false; }
      };
      if (req.get('host') === localHost && trusted(req.get('origin')) && trusted(req.get('referer')) &&
          timingSafeEqual(digest, tokenDigest(req.get('x-desktop-session') || ''))) return next();
      res.status(403).json({ success: false, error: '仅允许通过拾声集桌面应用访问本地接口', code: 'DESKTOP_AUTH_REQUIRED' });
    });
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
  app.get('/api/update-check', async (req, res) => {
    const force = req.query?.force === '1' || req.query?.force === 'true';
    let data;
    try {
      data = typeof updateChecker === 'function'
        ? await updateChecker({ force })
        : await updateChecker.checkForUpdates({ force });
    } catch {
      data = offlineResult();
    }
    res.set('Cache-Control', 'no-store').json({ success: true, data });
  });
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
      const data = await handler(req.body || {}, { ...options, signal: controller.signal }, req);
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

  const companionControl = action => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // The portable server has no desktop-session header. A browser page must
    // not inherit local control privileges just because its socket is loopback.
    if (!desktopSessionToken && isLoopbackRequest(req)) {
      const host = req.hostname?.toLowerCase();
      const origin = req.get('origin');
      const localHost = ['localhost', '127.0.0.1', '[::1]', req.socket.localAddress].includes(host);
      if (!localHost || (origin && origin !== req.protocol + '://' + req.get('host')) ||
          req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).json({ success: false, error: '请通过本机拾声集页面操作' });
      }
    }
    res.json({ success: true, data: await action(req.body || {}) });
  };
  app.get('/api/lan-companion/status', authorizePodcastWrite, companionControl(() => lanCompanion.status()));
  app.post('/api/lan-companion/start', authorizePodcastWrite, companionControl(({ host }) => lanCompanion.start({ host })));
  app.post('/api/lan-companion/stop', authorizePodcastWrite, companionControl(() => lanCompanion.stop()));
  app.post('/api/lan-companion/rotate', authorizePodcastWrite, companionControl(() => lanCompanion.rotate()));
  app.post('/api/lan-companion/select-host', authorizePodcastWrite, companionControl(({ host }) => lanCompanion.selectHost(host)));

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
  app.post('/api/tasks/:id/cancel', authorizeTaskWrite, (req, res) => res.json({ success: true, data: manager.cancelTask(req.params.id) }));
  app.post('/api/tasks/:id/resume', authorizeTaskWrite, (req, res) => res.status(202).json({
    success: true, data: manager.resumeTask(req.params.id, req.body || {}),
  }));
  function requestSecrets(req) {
    return [...llmSecrets(req.body || {}, {}), req.get('x-admin-token'), bearerToken(req), req.get('x-desktop-session')];
  }
  app.get('/api/collections', (req, res) => res.json({
    success: true, data: collectionStore.listCollections(manager.listPodcasts().items),
  }));
  app.get('/api/collections/:id', (req, res) => res.json({
    success: true, data: collectionStore.getCollection(req.params.id, manager.listPodcasts().items),
  }));
  app.post('/api/collections', authorizePodcastWrite, (req, res) => res.status(201).json({
    success: true, data: collectionStore.createCollection(req.body || {}, requestSecrets(req)),
  }));
  app.patch('/api/collections/:id', authorizePodcastWrite, (req, res) => res.json({
    success: true, data: collectionStore.updateCollection(req.params.id, req.body || {}, requestSecrets(req)),
  }));
  app.delete('/api/collections/:id', authorizePodcastWrite, (req, res) => res.json({
    success: true, data: collectionStore.deleteCollection(req.params.id),
  }));
  app.post('/api/collections/suggest', authorizePodcastWrite, cancelOnDisconnect((payload, opts, req) =>
    suggestCollection(payload, { ...opts, collectionStore, manager,
      sensitive: [dataDir, podcastsDir, desktopSessionToken, adminToken, ...requestSecrets(req)] })));
  app.patch('/api/podcasts/:id/collection', authorizePodcastWrite, (req, res) => {
    checkId(req.params.id);
    const podcast = manager.getPodcast(req.params.id);
    if (!podcast) throw Object.assign(new Error('播客不存在'), { statusCode: 404 });
    res.json({ success: true, data: collectionStore.setPodcastCollection(podcast.id, req.body?.collectionId) });
  });
  app.get('/api/podcasts', (req, res) => res.json({ success: true, data: manager.listPodcasts() }));
  app.get('/api/podcasts/:id', (req, res) => res.json({ success: true, data: manager.getPodcast(req.params.id) }));
  app.post('/api/podcasts/:id/resynthesize', authorizePodcastWrite, (req, res) => res.status(202).json({
    success: true, data: manager.resynthesizePodcast(req.params.id, req.body || {}),
  }));
  app.delete('/api/podcasts/:id', authorizePodcastWrite,
    (req, res) => res.json({ success: true, data: manager.deletePodcast(req.params.id) }));

  // Only audio is public here. Historical raw meta.json files can contain local paths.
  app.use('/podcasts', withManagerAccess, (req, res, next) => {
    const match = /^\/([a-zA-Z0-9_-]+)\/(?!\.)[^/\\]+\.mp3$/i.exec(decodeURIComponent(req.path));
    if (!match) return res.sendStatus(404);
    manager.reconcilePodcast?.(match[1]);
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
      ...ttsSecrets(req.body?.tts ?? {}), desktopSessionToken, req.get?.('x-desktop-session'), adminToken, req.get?.('x-admin-token'), bearerToken(req), dataDir, podcastsDir];
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
  if (app && createAppOptions.desktopSessionToken !== undefined) throw new Error('请在 createApp 时配置桌面会话令牌');
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
        console.error('拾声集未能完整关闭');
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
    console.log(`拾声集播客服务已启动 http://${host.includes(':') ? '[' + host + ']' : host}:${port}`);
    console.log('局域网手机试听可使用 HOST=0.0.0.0 npm start');
  } catch (error) {
    const code = error.code || 'LISTEN_ERROR';
    if (portable && process.connected) process.send({ error: code }, () => {});
    if (code === 'DATA_DIR_LOCKED') console.error(error.message);
    else console.error('拾声集无法启动（%s）', code);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
