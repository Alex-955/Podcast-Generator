require('dotenv').config();
if (process.env.ALLOW_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️  [security] ALLOW_INSECURE_TLS=1 已开启，当前进程跳过 TLS 证书校验（仅限本地代理调试）');
}

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { extractArticle } = require('./src/services/extractor');
const { createTaskManager } = require('./src/services/taskManager');
const { InputError, redactSecrets } = require('./src/services/validation');

const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp(options = {}) {
  const app = express();
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const podcastsDir = path.resolve(options.podcastsDir || process.env.PODCASTS_DIR || path.join(PUBLIC_DIR, 'podcasts'));
  const extractor = options.extractor || extractArticle;
  const manager = options.taskManager || createTaskManager({
    ...options, extractor, podcastsDir, tasksDir: path.join(dataDir, 'tasks'), cacheDir: path.join(dataDir, 'tts-cache'),
  });

  const origins = process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean);
  if (origins?.length) app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
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

  // Only audio is public here. Historical raw meta.json files can contain local paths.
  app.use('/podcasts', (req, res, next) => {
    if (!/^\/[a-zA-Z0-9_-]+\/[^/]+\.mp3$/i.test(decodeURIComponent(req.path))) return res.sendStatus(404);
    next();
  }, express.static(podcastsDir, { fallthrough: false }));
  // Exclude aliases of the podcasts directory from the general static mount, including on macOS.
  app.use((req, res, next) => {
    const relative = path.posix.resolve('/', decodeURIComponent(req.path));
    if (/^\/podcasts(?:\/|$)/i.test(relative)) return res.sendStatus(404);
    next();
  });
  app.use(express.static(PUBLIC_DIR));
  app.use('/api', (req, res) => res.status(404).json({ success: false, error: '接口不存在' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || err.status || (err instanceof URIError ? 400 : 500);
    let detail = err.message;
    if (status === 500 || err.path) detail = '本地服务未能完成请求';
    if (err.type === 'entity.parse.failed') detail = '请求体必须是有效 JSON';
    const sensitive = [req.body?.apiKey, req.body?.baseURL, process.env.DEEPSEEK_API_KEY, dataDir, podcastsDir];
    const error = redactSecrets(detail, sensitive);
    const code = typeof err.code === 'string' ? redactSecrets(err.code, sensitive) : undefined;
    res.status(status).json({ success: false, error, code });
  });
  return app;
}

const app = createApp();
app.createApp = createApp;
module.exports = app;

if (require.main === module) {
  const HOST = process.env.HOST || '127.0.0.1';
  const PORT = process.env.PORT ?? 3000;
  const server = app.listen(Number(PORT), HOST, () => {
    console.log(`AI 妙听播客服务已启动 http://${HOST}:${server.address().port}`);
    console.log('局域网手机试听可使用 HOST=0.0.0.0 npm start');
  });
}
