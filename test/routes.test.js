const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { extractArticle } = require('../src/services/extractor');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { completion, response } = require('./helpers/llmFixture');
const { upstreamError } = require('../src/services/providerHttp');

const apiKey = 'offline-credential';
const baseURL = 'https://offline-task.example';
const payload = { mode: 'text', content: '离线文章正文', apiKey, baseURL };
let root, publicDir, server, base, previousEnv;
let generate, llmRequest, observeProbe, synthesizeOverride;
const { getTtsProvider } = require('../src/services/ttsProvider');

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-routes-'));
  publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  for (const file of ['index.html', 'style.css', 'app.js', 'inputSource.js', 'audioEngine.js']) {
    fs.writeFileSync(path.join(publicDir, file), file);
  }
  const settings = {
    DATA_DIR: path.join(root, 'data'), PODCASTS_DIR: path.join(publicDir, 'external-audio'),
    CORS_ORIGIN: 'https://one.example, https://two.example', DEEPSEEK_API_KEY: '', TTS_PROVIDER: '',
  };
  previousEnv = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const { createApp } = require('../server');
  const app = createApp({
    publicDir, dataDir: path.join(publicDir, 'custom-data'),
    llmRequest: (...args) => llmRequest(...args),
    getTtsProviderById(id) {
      const provider = getTtsProvider(id);
      if (!observeProbe) return provider;
      return { ...provider, synthesizeToFile(args) { observeProbe(args); return provider.synthesizeToFile(args); } };
    },
    extractor(params) {
      if (params.url === 'https://offline.example/fail') {
        throw Object.assign(new Error('抓取错误 Bearer private-value'), { statusCode: 502 });
      }
      return extractArticle(params);
    },
    scriptGenerator: args => generate(args),
    ttsProvider: {
      id: 'offline', model: 'test',
      synthesizeToFile(args) {
        if (synthesizeOverride) return synthesizeOverride(args);
        const { outputPath } = args;
        const mp3 = makeMp3(10);
        fs.writeFileSync(outputPath, mp3);
        return { bytes: mp3.length, duration: 0.24 };
      },
    },
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function request(route, status, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + '/api/' + route, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.equal(res.status, status, JSON.stringify(json));
  for (const secret of [apiKey, '"apiKey"', '"baseURL"', '"filePath"', root, 'private-value']) {
    assert.ok(!JSON.stringify(json).includes(secret));
  }
  if (status >= 400) {
    assert.equal(json.success, false);
    assert.ok(json.error);
  }
  return json;
}

test('监听端口在未设置或空白时取 3456，保留显式的 0 和指定端口', () => {
  const { parsePort } = require('../server');
  for (const value of [undefined, '', '   ']) assert.equal(parsePort(value), 3456);
  assert.equal(parsePort('0'), 0);
  assert.equal(parsePort('4000'), 4000);
  for (const value of ['-1', '3.5', 'abc', '65536']) assert.throws(() => parsePort(value), RangeError);
});

test('健康、文章预览、CORS 白名单与上游错误脱敏', async () => {
  assert.equal((await request('health', 200)).status, 'ok');
  assert.deepEqual((await request('extract-article', 200, { rawText: ' 正文 ' })).data,
    { title: '', content: '正文', length: 2, truncated: false });
  await request('extract-article', 400, {});
  await request('extract-article', 400, { url: '这是正文' });
  await request('extract-article', 400, { rawText: 42 });
  await request('extract-article', 502, { url: 'https://offline.example/fail' });
  for (const [origin, allowed] of [['https://one.example', true], ['https://two.example', true], ['https://other.example', false]]) {
    const res = await fetch(base + '/api/health', { headers: { Origin: origin } });
    assert.equal(res.headers.get('access-control-allow-origin'), allowed ? origin : null);
  }
});

test('图片提取接口按顺序发送多张图片并返回结构化正文', async () => {
  const images = ['data:image/png;base64,YQ==', 'data:image/webp;base64,Yg=='];
  const visionBaseURL = 'https://offline-vision.example/API/v1/';
  const visionApiKey = 'offline-request-vision-token';
  let calls = 0;
  llmRequest = async (url, options) => {
    calls++;
    assert.equal(url, 'https://offline-vision.example/API/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + visionApiKey);
    const { model, messages } = JSON.parse(options.body);
    assert.equal(model, 'vision-fixture');
    assert.deepEqual(messages[1].content.filter(item => item.type === 'image_url').map(item => item.image_url.url), images);
    const response = Readable.from([Buffer.from(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: '长截图', content: '第一段\n\n第二段' }) } }],
    }))]);
    return Object.assign(response, { statusCode: 200, headers: {} });
  };
  const result = await request('extract-image', 200, { images, visionApiKey, visionBaseURL, visionModel: 'vision-fixture' });
  assert.deepEqual(result, { success: true, data: { title: '长截图', content: '第一段\n\n第二段', length: 8, truncated: false,
    imageCount: 2, hasIssues: false, issueHint: '' } });
  assert.equal(calls, 1);
});

test('图片提取接口遮盖请求和服务端的视觉配置，拒绝无效请求与超限请求', async t => {
  const visionApiKey = 'offline-request-vision-secret';
  const visionBaseURL = 'https://caller-vision.example/private';
  const VISION_API_KEY = 'offline-server-vision-secret';
  const VISION_BASE_URL = 'https://server-vision.example/private';
  setEnv(t, { VISION_API_KEY, VISION_BASE_URL, VISION_MODEL: 'test-vision' });
  const images = ['data:image/jpeg;base64,YQ=='];
  const body = { images, visionApiKey, visionBaseURL, visionModel: 'test-vision' };
  const sensitive = [visionApiKey, visionBaseURL, VISION_API_KEY, VISION_BASE_URL];
  let calls = 0;
  llmRequest = async () => {
    calls++;
    throw upstreamError('识图失败 ' + sensitive.join(' '));
  };
  const failed = await request('extract-image', 502, body);
  assert.equal(failed.error, '识图失败 *** *** *** ***');
  for (const invalid of [[], '截图', ['data:image/gif;base64,YQ==']]) {
    const result = await request('extract-image', 400, { ...body, images: invalid });
    assert.ok(sensitive.every(value => !JSON.stringify(result).includes(value)));
  }
  const invalidJson = await fetch(base + '/api/extract-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body).slice(0, -1),
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error, '请求体必须是有效 JSON');
  const img = 'data:image/png;base64,' + 'A'.repeat(5.5 * 1024 * 1024);
  await request('extract-image', 502, { ...body, images: [img, img] });
  await request('extract-article', 413, { rawText: img + img });
  const oversized = await request('extract-image', 413, { ...body, padding: 'A'.repeat(25 * 1024 * 1024) });
  assert.ok(sensitive.every(value => !JSON.stringify(oversized).includes(value)));
  assert.equal(calls, 2);
});

test('任务入参、不存在资源、非法 ID 与移除的接口', async () => {
  for (const body of [
    { mode: 'text', content: '正文' }, { ...payload, mode: 'unknown' },
    { ...payload, content: 'https://example.com/a' }, { ...payload, mode: 'url', url: '非链接' },
    { ...payload, voiceMapping: { 阿泽: 'bad' } },
  ]) await request('tasks', 400, body);
  for (const route of ['tasks/missing', 'podcasts/missing']) await request(route, 404);
  for (const action of ['cancel', 'resume']) await request('tasks/missing/' + action, 404, {});
  for (const type of ['tasks', 'podcasts']) await request(type + '/..%2Fprivate', 400);
  for (const route of ['voices', 'bgm-list']) await request(route, 404);
  for (const route of ['generate-script', 'synthesize-podcast', 'one-click-generate']) await request(route, 404, {});
});

test('前端只公开指定的 GET/HEAD 文件，运行目录只通过音频路由公开 MP3', async () => {
  const audioDir = path.join(publicDir, 'external-audio', 'sample');
  const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, 'meta.json'), '{}');
  fs.writeFileSync(path.join(tasksDir, 'sample.json'), '{}');
  const bytes = makeMp3(2);
  fs.writeFileSync(path.join(audioDir, 'clip.mp3'), bytes);

  for (const route of ['/', '/index.html', '/style.css', '/app.js', '/inputSource.js', '/audioEngine.js']) {
    const get = await fetch(base + route);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), route === '/' ? 'index.html' : route.slice(1));
    const head = await fetch(base + route, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const audio = await fetch(base + '/podcasts/sample/clip.mp3');
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), bytes);
  for (const route of ['/external-audio/sample/meta.json', '/custom-data/tasks/sample.json',
    '/EXTERNAL-AUDIO/sample/META.JSON', '/custom-data/tasks/%73ample.json', '/podcasts/sample/meta.json',
    '/external-audio/sample/clip.mp3', '/APP.JS', '/%61pp.js']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  for (const method of ['POST', 'OPTIONS']) assert.equal((await fetch(base + '/app.js', { method })).status, 404);
});

test('创建、单活冲突、取消、续跑、轮询成品、历史与外置静态音频', async () => {
  const invalidStyle = '节目风格仅支持深度主讲（deep_dive）、轻松对谈（dialogue）或正反交锋（debate）';
  const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
  const taskFiles = () => fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
  const before = taskFiles();
  for (const podcastStyle of [null, 123, 'unknown']) {
    assert.equal((await request('tasks', 400, { ...payload, podcastStyle })).error, invalidStyle);
  }
  for (const sourceType of [null, 123, 'other', '', ' \n ']) {
    assert.equal((await request('tasks', 400, { ...payload, sourceType })).error, '来源类型仅支持 url、text 或 image');
  }
  assert.deepEqual(taskFiles(), before);
  generate = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('迟到的上游失败')), { once: true });
  });
  const { data: task } = await request('tasks', 202, { ...payload, podcastStyle: ' DEBATE ', sourceType: 'image' });
  const route = 'tasks/' + task.id;
  assert.equal(task.status, 'queued');
  assert.equal(task.podcastStyle, 'debate');
  assert.equal(task.sourceType, 'image');
  assert.equal((await request('tasks', 409, payload)).code, 'TASK_ALREADY_RUNNING');
  await request(route + '/resume', 409, {});
  assert.equal((await request(route + '/cancel', 200, {})).data.status, 'cancelled');
  await request(route + '/cancel', 409, {});
  assert.equal((await request(route, 200)).data.error, null);
  await request(route + '/resume', 400, {});
  const record = path.join(tasksDir, task.id + '.json');
  const checkpoint = fs.readFileSync(record, 'utf8');
  for (const podcastStyle of [null, 123, 'unknown']) {
    assert.equal((await request(route + '/resume', 400, { apiKey, baseURL, podcastStyle })).error, invalidStyle);
  }
  assert.equal(fs.readFileSync(record, 'utf8'), checkpoint);

  generate = async ({ podcastStyle }) => {
    assert.equal(podcastStyle, 'debate');
    return { podcastTitle: '路由测试', summary: '测试', dialogue: [{ speaker: '阿泽', text: '开场' }] };
  };
  assert.equal((await request(route + '/resume', 202, { apiKey, baseURL })).data.podcastStyle, 'debate');
  const deadline = performance.now() + 5000;
  let completed;
  do {
    completed = (await request(route, 200)).data;
    if (completed.status === 'completed') break;
    await delay(10);
  } while (performance.now() < deadline);
  assert.equal(completed.status, 'completed');
  const detail = (await request('podcasts/' + task.id, 200)).data;
  assert.deepEqual(completed.podcast, detail);
  assert.equal(detail.podcastStyle, 'debate');
  assert.equal(detail.sourceType, 'image');
  const { id, sourceType, ttsProvider, ttsModel, voiceMapping } = (await request('podcasts', 200)).data.items[0];
  assert.deepEqual({ id, sourceType, ttsProvider, ttsModel, voiceMapping }, {
    id: task.id, sourceType: 'image', ttsProvider: 'offline', ttsModel: 'test', voiceMapping: detail.voiceMapping,
  });
  for (const url of [detail.fullAudioUrl, detail.sentences[0].audioUrl]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), makeMp3(10));
  }
  assert.ok(fs.existsSync(record));
  assert.ok(fs.existsSync(path.join(publicDir, 'external-audio', task.id, 'meta.json')));
  await request(route + '/resume', 409, { apiKey, baseURL });
  await request(route + '/cancel', 409, {});
});

test('删除接口只清除指定播客与任务，保留其他播客和语音缓存', async () => {
  const podcastsDir = path.join(publicDir, 'external-audio');
  const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
  const cacheDir = path.join(publicDir, 'custom-data', 'tts-cache');
  const target = path.join(podcastsDir, 'delete-target');
  const sibling = path.join(podcastsDir, 'delete-sibling');
  const taskFile = path.join(tasksDir, 'delete-target.json');
  const siblingFile = path.join(tasksDir, 'delete-sibling.json');
  const cacheFile = path.join(cacheDir, 'delete-retained.mp3');
  const backup = path.join(podcastsDir, 'import-backup');
  const strayTask = path.join(tasksDir, 'import-backup.json');
  const audio = makeMp3(2);
  for (const dir of [target, sibling, tasksDir, cacheDir, backup]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [target, sibling]) {
    fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), audio);
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
  }
  fs.symlinkSync(sibling, path.join(target, 'sibling-link'), 'dir');
  fs.writeFileSync(taskFile, JSON.stringify({ id: 'delete-target', status: 'completed', stage: 'done',
    input: { mode: 'text' }, progress: {}, sourceContent: '离线正文' }));
  fs.writeFileSync(siblingFile, '{}');
  fs.writeFileSync(cacheFile, audio);
  fs.writeFileSync(path.join(backup, 'original.txt'), '备份');
  fs.writeFileSync(strayTask, '{}');

  const remove = (id, status) => request('podcasts/' + id, status, undefined, 'DELETE');
  assert.equal((await remove('..%2Fdelete-target', 400)).error, '无效的资源 ID');
  assert.equal((await remove('delete-missing', 404)).error, '播客不存在');
  assert.equal((await remove('import-backup', 404)).error, '播客不存在');
  assert.equal(fs.readFileSync(path.join(backup, 'original.txt'), 'utf8'), '备份');
  assert.equal(fs.readFileSync(strayTask, 'utf8'), '{}');
  assert.deepEqual(await remove('delete-target', 200), { success: true, data: { id: 'delete-target', deleted: true } });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(taskFile), false);
  assert.deepEqual(fs.readFileSync(path.join(sibling, 'full_podcast.mp3')), audio);
  assert.equal(fs.readFileSync(siblingFile, 'utf8'), '{}');
  assert.deepEqual(fs.readFileSync(cacheFile), audio);
  await remove('delete-target', 404);
  await request('podcasts/delete-target', 404);
  await request('podcasts/delete-sibling', 200);
});

test('生成中的任务拒绝删除，取消后可删除仅有任务记录的播客', async () => {
  generate = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const { data: task } = await request('tasks', 202, payload);
  const route = 'podcasts/' + task.id;
  try {
    assert.equal((await request(route, 409, undefined, 'DELETE')).error, '当前播客正在生成中，请先取消后再删除');
    const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
    const uppercase = task.id.toUpperCase();
    const aliasExists = fs.existsSync(path.join(tasksDir, uppercase + '.json'));
    await request('podcasts/' + uppercase, aliasExists ? 409 : 404, undefined, 'DELETE');
    assert.ok(fs.existsSync(path.join(tasksDir, task.id + '.json')));
  } finally {
    await request('tasks/' + task.id + '/cancel', 200, {});
  }
  assert.deepEqual((await request(route, 200, undefined, 'DELETE')).data, { id: task.id, deleted: true });
  await request('tasks/' + task.id, 404);
});

test('续跑时锁住原来以大写保存的任务文件和播客目录', { timeout: 10000 }, async () => {
  const id = 'restore-lower-id';
  const alias = id.toUpperCase();
  const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
  const podcastsDir = path.join(publicDir, 'external-audio');
  const upperFile = path.join(tasksDir, alias + '.json');
  const lowerFile = path.join(tasksDir, id + '.json');
  const upperDir = path.join(podcastsDir, alias);
  fs.mkdirSync(upperDir, { recursive: true });
  const marker = path.join(upperDir, 'original.mp3');
  fs.writeFileSync(marker, makeMp3(2));
  const record = { id, status: 'failed', stage: 'script', input: { mode: 'text' }, progress: {}, sourceContent: '离线正文' };
  fs.writeFileSync(upperFile, JSON.stringify(record));
  const isAlias = fs.existsSync(lowerFile);
  if (!isAlias) fs.copyFileSync(upperFile, lowerFile);
  let started;
  const enteredScript = new Promise(resolve => { started = resolve; });
  generate = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  });

  await request('tasks/' + id + '/resume', 202, { apiKey, baseURL });
  try {
    await enteredScript;
    if (isAlias) {
      // Atomic checkpoint writes can adopt the lowercase spelling during resume.
      const intermediate = path.join(tasksDir, id + '.tmp');
      fs.renameSync(lowerFile, intermediate);
      fs.renameSync(intermediate, upperFile);
    }
    assert.ok(fs.readdirSync(tasksDir).includes(alias + '.json'));
    const checkpoint = fs.readFileSync(upperFile, 'utf8');
    assert.equal(JSON.parse(fs.readFileSync(lowerFile)).status, 'running');
    assert.equal(JSON.parse(checkpoint).id, id);
    await request('podcasts/' + alias, isAlias ? 409 : 404, undefined, 'DELETE');
    assert.equal(fs.readFileSync(upperFile, 'utf8'), checkpoint);
    assert.deepEqual(fs.readFileSync(marker), makeMp3(2));
  } finally {
    await request('tasks/' + id + '/cancel', 200, {});
  }
});

test('删除鉴权使用套接字回环地址或配置的管理令牌', async t => {
  const { createApp, isLoopbackAddress } = require('../server');
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  for (const address of ['127.0.0.2', '192.168.0.10', '::ffff:192.168.0.10', undefined]) assert.equal(isLoopbackAddress(address), false);
  const configuredToken = 'fixture-admin-secret';
  const wrongToken = 'fixture-incorrect-secret';
  const xHeader = 'fixture-x-secret';
  const authHeader = 'fixture-auth-secret';
  const calls = [];
  async function listen(options) {
    const app = createApp({ ...options, taskManager: {
      deletePodcast(id) {
        calls.push(id);
        if (id === 'redaction') throw Object.assign(new Error([configuredToken, xHeader, authHeader].join(' ')), { statusCode: 409 });
        return { id, deleted: true };
      },
    } });
    const local = app.listen(0, '127.0.0.1');
    await once(local, 'listening');
    t.after(() => new Promise(resolve => local.close(resolve)));
    return async (id, status, headers = {}) => {
      const res = await fetch('http://127.0.0.1:' + local.address().port + '/api/podcasts/' + id, { method: 'DELETE', headers });
      const json = await res.json();
      assert.equal(res.status, status);
      for (const token of [configuredToken, wrongToken, xHeader, authHeader]) assert.ok(!JSON.stringify(json).includes(token));
      return json;
    };
  }
  const local = await listen({ adminToken: configuredToken });
  assert.equal((await local('loopback', 200)).data.deleted, true);
  assert.deepEqual(await local('redaction', 409, { 'X-Admin-Token': xHeader, Authorization: 'Bearer ' + authHeader }),
    { success: false, error: '*** *** ***' });
  const nonLoopback = { isLoopbackRequest: () => false };
  const defaultRemote = await listen({ ...nonLoopback, adminToken: '' });
  const spoofed = { 'X-Forwarded-For': '127.0.0.1', Host: 'localhost' };
  for (const headers of [{}, spoofed]) {
    assert.deepEqual(await defaultRemote('remote', 403, headers), { success: false,
      error: '为保护本地播客，局域网设备默认禁止删除历史播客，请在启动服务的电脑本机删除' });
  }
  setEnv(t, { ADMIN_TOKEN: ` ${configuredToken} ` });
  const managedRemote = await listen(nonLoopback);
  for (const headers of [{}, { 'X-Admin-Token': wrongToken }, { Authorization: 'Bearer ' + wrongToken }, spoofed]) {
    assert.deepEqual(await managedRemote('remote', 403, headers), { success: false,
      error: '局域网客户端无权删除本地播客，请在本机操作或提供有效管理令牌' });
  }
  for (const [id, headers] of [['bearer', { Authorization: 'Bearer ' + configuredToken }],
    ['admin-header', { 'X-Admin-Token': configuredToken }]]) {
    assert.deepEqual(await managedRemote(id, 200, headers), { success: true, data: { id, deleted: true } });
  }
  assert.deepEqual(calls, ['loopback', 'redaction', 'bearer', 'admin-header']);
});

test('语音服务目录实时报告配置状态，创建任务同步拒绝缺失凭据与端点错配', async t => {
  const env = {
    TTS_PROVIDER: 'minimax', MINIMAX_API_KEY: '', MINIMAX_TTS_ENDPOINT: 'https://minimax-private.example/speech',
    VOLCENGINE_TTS_API_KEY: '', VOLCENGINE_TTS_APP_ID: '', VOLCENGINE_TTS_ACCESS_KEY: '',
    VOLCENGINE_TTS_ENDPOINT: 'https://volc-private.example/speech',
  };
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = value;
  }
  const list = async () => {
    const response = await fetch(base + '/api/tts/providers');
    assert.equal(response.status, 200);
    const { success, data } = await response.json();
    assert.equal(success, true);
    assert.equal(data.defaultProvider, 'minimax');
    assert.deepEqual(data.items.map(p => p.id), ['edge', 'minimax', 'volcengine']);
    for (const value of [env.MINIMAX_TTS_ENDPOINT, env.VOLCENGINE_TTS_ENDPOINT, 'fake-mini-key', 'fake-app-id', 'fake-access-key']) {
      assert.ok(!JSON.stringify(data).includes(value));
    }
    return data.items.map(p => p.serverConfigured);
  };
  assert.deepEqual(await list(), [true, false, false]);
  await request('tasks', 400, payload);
  for (const provider of ['minimax', 'volcengine', 'missing']) await request('tasks', 400, { ...payload, tts: { provider } });
  Object.assign(process.env, { MINIMAX_API_KEY: 'fake-mini-key', VOLCENGINE_TTS_APP_ID: 'fake-app-id', VOLCENGINE_TTS_ACCESS_KEY: 'fake-access-key' });
  assert.deepEqual(await list(), [true, true, true]);
  const endpoint = 'https://other-offline.example/audio';
  for (const tts of [{ provider: 'minimax' }, { provider: 'volcengine' }, { provider: 'volcengine', appId: 'own-app' },
    { provider: 'volcengine', accessKey: 'own-access' }]) {
    const error = await request('tasks', 400, { ...payload, tts: { ...tts, endpoint } });
    assert.ok(!JSON.stringify(error).includes(endpoint));
  }
  await request('tasks', 400, { ...payload, tts: { provider: 'minimax', apiKey: 'own-key', endpoint: 'file:///tmp/' } });
});

function setEnv(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    process.env[name] = value;
  }
}

test('模型配置目录屏蔽误填为模型名称的带空白凭据', async t => {
  const secret = 'misconfigured-credential';
  setEnv(t, { MINIMAX_API_KEY: '  ' + secret + '  ', MINIMAX_TTS_MODEL: secret });
  const { data } = await (await fetch(base + '/api/tts/providers')).json();
  assert.equal(data.items.find(item => item.id === 'minimax').defaultModel, 'speech-2.8-turbo');
  assert.ok(!JSON.stringify(data).includes(secret));
});

test('模型连接测试校验绑定与鉴权，404/405 时尝试一个 token 的对话', async t => {
  const endpoint = 'https://llm-service.example/api/v1/';
  setEnv(t, { DEEPSEEK_API_KEY: '', LLM_BASE_URL: endpoint, LLM_MODEL: 'server-model' });
  const calls = [];
  let status = 200;
  llmRequest = async (url, args) => {
    assert.ok(args.signal instanceof AbortSignal);
    calls.push({ url, ...args });
    const chat = url.endsWith('/chat/completions');
    const body = chat ? { choices: [{ message: { content: 'hi' } }] } : { data: [{ id: 'server-model' }], detail: '/Users/private/secret' };
    const response = Readable.from([Buffer.from(JSON.stringify(body))]);
    response.statusCode = chat ? 200 : status;
    response.headers = {};
    return response;
  };
  await request('llm/test', 400, {});
  process.env.DEEPSEEK_API_KEY = apiKey;
  await request('llm/test', 400, { baseURL: 'https://other-service.example' });
  await request('llm/test', 400, { model: apiKey });
  assert.equal(calls.length, 0);
  const result = await request('llm/test', 200, {});
  assert.equal(result.data.ok, true);
  assert.equal(result.data.model, 'server-model');
  assert.equal(result.data.message, '连接成功，模型接口可用');
  assert.ok(result.data.latencyMs >= 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint + 'models');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + apiKey);
  for (status of [404, 405]) {
    calls.length = 0;
    await request('llm/test', 200, { apiKey: 'own-key', baseURL: 'https://own.example', model: 'choice' });
    assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', 'https://own.example/v1/models'], ['POST', 'https://own.example/v1/chat/completions']]);
    assert.equal(calls[0].signal, calls[1].signal);
    assert.equal(JSON.parse(calls[1].body).max_tokens, 1);
    assert.equal(JSON.parse(calls[1].body).model, 'choice');
  }
  status = 401;
  calls.length = 0;
  const failed = await request('llm/test', 502, {});
  assert.equal(calls.length, 1);
  assert.match(failed.error, /401/);
  assert.ok(!JSON.stringify(failed).includes(endpoint));
  llmRequest = () => { throw new Error('private-value /Users/unknown/path'); };
  assert.equal((await request('llm/test', 502, {})).error, '模型接口连接失败');
});

test('verifyChat 为 true 时只发送最小对话并按结果判断模型能否响应', async t => {
  const baseURL = 'https://offline-model.example/service';
  setEnv(t, { LLM_BASE_URL: '', LLM_MODEL: '', DEEPSEEK_API_KEY: '' });
  let status = 200;
  llmRequest = t.mock.fn(async (url, options) => {
    assert.equal(url, baseURL + '/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + apiKey);
    assert.deepEqual(JSON.parse(options.body), { model: 'selected-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    return response(completion('hi'), status);
  });
  const body = { apiKey, baseURL, model: 'selected-model', verifyChat: true };
  const result = await request('llm/test', 200, body);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.model, body.model);
  for (const [invalidStatus, guidance] of [[401, /API Key/], [403, /模型访问权限/], [404, /模型名称/], [405, /支持对话的接口地址/]]) {
    status = invalidStatus;
    const { error } = await request('llm/test', 502, body);
    assert.match(error, new RegExp('HTTP ' + status));
    assert.match(error, guidance);
  }
  assert.equal(llmRequest.mock.callCount(), 5);
});

test('调用方主模型或独立识图 Key 缺少各自接口地址时返回 400，并且不发请求或保存任务', async t => {
  const llmBase = 'https://configured-llm.example/v1/';
  const visionBase = 'https://configured-vision.example/v1/';
  setEnv(t, { LLM_BASE_URL: llmBase, VISION_BASE_URL: visionBase,
    DEEPSEEK_API_KEY: 'configured-llm-key', VISION_API_KEY: 'configured-vision-key' });
  llmRequest = t.mock.fn();
  generate = t.mock.fn();
  const tasksDir = path.join(publicDir, 'custom-data', 'tasks');
  const filesBefore = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
  const article = { mode: 'text', apiKey, content: '正文', images: ['data:image/png;base64,YQ=='] };
  for (const route of ['llm/models', 'llm/test', 'polish-text', 'recommend-style', 'extract-image', 'tasks']) {
    const response = await request(route, 400, article);
    assert.equal(response.error, '填写自定义 API Key 时，请同时填写对应的接口地址（Base URL）');
  }
  for (const route of ['llm/models', 'extract-image']) {
    const imageRequest = { scope: 'vision', images: article.images, visionApiKey: apiKey, baseURL: llmBase };
    const response = await request(route, 400, imageRequest);
    assert.equal(response.error, '填写独立识图 API Key 时，请同时填写对应的识图 Base URL');
  }
  assert.deepEqual(fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [], filesBefore);
  assert.equal(llmRequest.mock.callCount(), 0);
  assert.equal(generate.mock.callCount(), 0);
});

test('连接测试和模型列表拒绝非法或敏感模型字段，并在发请求前校验地址', async t => {
  const configuredSecret = 'configured-vision-secret';
  const callerSecret = 'caller-vision-secret';
  setEnv(t, { VISION_API_KEY: configuredSecret, LLM_BASE_URL: 'http://127.0.0.1:7913/llm/v1/', LLM_MODEL: 'configured-model' });
  llmRequest = t.mock.fn(async (url, args) => {
    assert.equal(url, 'http://127.0.0.1:7913/llm/v1/chat/completions');
    assert.equal(args.allowPrivateEndpoint, true);
    return response(completion('hi'));
  });
  const body = { apiKey, baseURL: 'http://127.0.0.1:7913/llm', verifyChat: true, visionApiKey: callerSecret };
  const badModels = [null, 123, false, {}, 'C:/local/model', 'c:\\local\\model', 'a/../b', ' x',
    'a'.repeat(161), configuredSecret, callerSecret];
  for (const route of ['llm/test', 'llm/models']) {
    for (const fields of [...badModels.map(model => ({ model })), { visionModel: null }]) {
      const result = await request(route, 400, { ...body, ...fields });
      assert.equal(result.error, '模型名称无效或包含敏感配置');
    }
  }
  for (const baseURL of [body.baseURL + '#', body.baseURL + '?', body.baseURL + '/other']) {
    await request('llm/test', 400, { ...body, baseURL });
  }
  assert.equal(llmRequest.mock.callCount(), 0);
  const result = await request('llm/test', 200, { ...body, model: '', visionModel: '' });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.model, 'configured-model');
  assert.equal(llmRequest.mock.callCount(), 1);
});

test('模型列表过滤请求中的 TTS 凭据和冒号后路径，保留 HTTPS 链接及模型标签', async t => {
  const tts = { apiKey: 'offline-tts-credential', accessKey: 'offline-tts-access', appId: 'offline-tts-app',
    endpoint: 'https://offline-tts.example/service' };
  const publicURL = 'https://docs.example/v1/models';
  const secrets = Object.values(tts);
  llmRequest = t.mock.fn(async () => response({ data: [
    ...secrets.map(id => ({ id })),
    { id: 'vendor/model:fast', owned_by: [...secrets, 'path:C:/Users/private', 'path:/Users/private/a', publicURL].join(' ') },
  ] }));
  const result = await request('llm/models', 200, { apiKey, baseURL: 'https://offline-model.example', tts });
  assert.equal(result.data.count, 1);
  assert.deepEqual(result.data.models, [{ id: 'vendor/model:fast', ownedBy: '*** *** *** *** path:*** path:*** ' + publicURL }]);
  assert.equal(llmRequest.mock.callCount(), 1);
});

test('模型列表路由返回模型或手动填写提示，并校验查询范围', async t => {
  setEnv(t, { DEEPSEEK_API_KEY: '', LLM_BASE_URL: '', VISION_API_KEY: '', VISION_BASE_URL: '' });
  const visionBaseURL = 'https://offline-vision.example';
  let status = 200;
  llmRequest = t.mock.fn(async (url, options) => {
    assert.equal(url, visionBaseURL + '/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + apiKey);
    return response({ data: [{ id: 'vision-test', owned_by: 'fixture' }] }, status);
  });
  const body = { scope: 'vision', visionApiKey: apiKey, visionBaseURL };
  const listed = await request('llm/models', 200, body);
  assert.equal(listed.success, true);
  assert.equal(listed.data.supported, true);
  assert.equal(listed.data.count, 1);
  assert.deepEqual(listed.data.models, [{ id: 'vision-test', ownedBy: 'fixture' }]);
  status = 405;
  const unsupported = await request('llm/models', 200, body);
  assert.equal(unsupported.data.supported, false);
  assert.match(unsupported.data.message, /手动填写/);
  await request('llm/models', 400, { ...body, scope: 'other' });
  assert.equal(llmRequest.mock.callCount(), 2);
});

test('正文润色路由返回脱敏结果，并在无正文时不调用上游', async t => {
  const baseURL = 'https://offline-model.example';
  llmRequest = t.mock.fn(async (url, options) => {
    assert.equal(url, baseURL + '/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + apiKey);
    return response(completion(JSON.stringify({ edits: [{ find: '这里是路由测试用的正文', replace: '这里是路由测试用的正文。' }],
      changeSummary: '修正标点 ' + baseURL })));
  });
  const body = { apiKey, baseURL, title: '原始标题', content: '这里是路由测试用的正文' };
  const polished = await request('polish-text', 200, body);
  assert.deepEqual(polished, { success: true, data: {
    title: '原始标题', content: '这里是路由测试用的正文。', length: 12, truncated: false, changeSummary: '修正标点 ***', mode: 'patch', editCount: 1,
  } });
  await request('polish-text', 400, { ...body, content: '' });
  assert.equal(llmRequest.mock.callCount(), 1);
});

test('推荐风格路由返回脱敏结果，无效输入或上游风格分别返回 400 和 502', async t => {
  const baseURL = 'https://offline-model.example';
  let style = 'dialogue';
  llmRequest = t.mock.fn(async (url, options) => {
    assert.equal(url, baseURL + '/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 160);
    return response(completion(JSON.stringify({ style, reason: '适合聊天 ' + apiKey + ' /Users/private/file' })));
  });
  const body = { apiKey, baseURL, title: '原始标题', content: '这里是推荐测试用的正文' };
  assert.deepEqual(await request('recommend-style', 200, body), {
    success: true, data: { style: 'dialogue', reason: '适合聊天 *** ***' },
  });
  await request('recommend-style', 400, { ...body, content: '' });
  assert.equal(llmRequest.mock.callCount(), 1);
  style = apiKey;
  assert.deepEqual(await request('recommend-style', 502, body), {
    success: false, error: '风格推荐接口返回了无效风格',
  });
  assert.equal(llmRequest.mock.callCount(), 2);
});

test('模型列表、润色和推荐风格路由在客户端断开时取消上游请求', { timeout: 10000 }, async () => {
  for (const route of ['llm/models', 'polish-text', 'recommend-style']) {
    const client = new AbortController();
    let ready, stopped;
    const started = new Promise(resolve => { ready = resolve; });
    const abortedUpstream = new Promise(resolve => { stopped = resolve; });
    llmRequest = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason);
        stopped();
      }, { once: true });
      ready();
    });
    const pending = fetch(base + '/api/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: client.signal,
      body: JSON.stringify({ apiKey, baseURL: 'https://offline-model.example', content: '正文' }),
    });
    const failed = assert.rejects(pending, { name: 'AbortError' });
    try {
      await started;
      client.abort();
      await Promise.all([failed, abortedUpstream]);
    } finally {
      client.abort();
    }
  }
});

test('语音连接测试仅在临时目录合成，成功和错误后都清理', async t => {
  const { httpTtsFixture } = require('./helpers/httpTtsFixture');
  let status = 200;
  const { endpoint, requests } = await httpTtsFixture(t, res => {
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: makeMp3(3).toString('hex') } }) :
      'private-value ' + endpoint + ' /Users/private/unknown');
  });
  setEnv(t, { MINIMAX_TTS_ENDPOINT: endpoint, MINIMAX_API_KEY: '', MINIMAX_TTS_MODEL: 'speech-02-hd', ALLOW_PRIVATE_TTS_ENDPOINT: '1' });
  const files = fs.readdirSync(root, { recursive: true });
  let outputPath;
  observeProbe = args => { outputPath = args.outputPath; assert.equal(args.text, '你好'); };
  t.after(() => { observeProbe = undefined; });
  const tts = { provider: 'minimax', model: 'speech-02-turbo', voiceMapping: { 阿泽: 'S_probe' } };
  await request('tts/test', 400, { tts });
  process.env.MINIMAX_API_KEY = apiKey;
  await request('tts/test', 400, { tts: { ...tts, endpoint: 'https://other-service.example' } });
  assert.match((await request('tts/test', 200, { tts: { provider: 'edge' } })).data.message, /未发起/);
  assert.equal(requests.length, 0);
  const result = await request('tts/test', 200, { tts });
  assert.equal(result.data.provider, 'minimax');
  assert.equal(result.data.model, 'speech-02-turbo');
  assert.equal(result.data.duration, 0.072);
  assert.equal(result.data.ok, true);
  assert.equal(requests[0].body.voice_setting.voice_id, 'S_probe');
  assert.equal(requests[0].body.model, 'speech-02-turbo');
  assert.equal(path.dirname(path.dirname(outputPath)), path.resolve(os.tmpdir()));
  assert.ok(!fs.existsSync(path.dirname(outputPath)));
  status = 403;
  const failed = await request('tts/test', 502, { tts });
  assert.match(failed.error, /403/);
  assert.ok(!failed.error.includes('/Users') && !failed.error.includes(endpoint));
  assert.ok(!fs.existsSync(path.dirname(outputPath)));
  assert.deepEqual(fs.readdirSync(root, { recursive: true }), files);
});

test('本地模型服务经实际 HTTP 传输完成 /models 及最小对话探测', async t => {
  const http = require('node:http');
  const { requestProvider } = require('../src/services/providerHttp');
  const calls = [];
  let catalogue, chatStatus;
  let chatBody = { choices: [{ message: { content: 'hi' } }] };
  const fixture = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.method === 'GET') return res.end(catalogue);
    res.writeHead(chatStatus).end(chatStatus === 200 ? JSON.stringify(chatBody) : '{"error":"model not found"}');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  setEnv(t, { LLM_BASE_URL: 'http://127.0.0.1:' + fixture.address().port, DEEPSEEK_API_KEY: apiKey, LLM_MODEL: 'local-model' });
  llmRequest = requestProvider;
  for (const [list, chat, expectedStatus, needsChat] of [
    [{ data: [null, { id: 'local-model' }] }, 404, 200, false],
    [{ error: 'invalid catalogue', data: [{ id: 'local-model' }] }, 404, 502, true],
    [{ data: [{ id: 'other-model' }] }, 404, 502, true],
    [{ data: [{ id: 'other-model' }] }, 200, 200, true],
    [{ data: [] }, 200, 200, true],
    [{ models: [] }, 200, 200, true],
    ['not JSON', 200, 200, true],
  ]) {
    calls.length = 0;
    catalogue = typeof list === 'string' ? list : JSON.stringify(list);
    chatStatus = chat;
    const response = await request('llm/test', expectedStatus, {});
    if (expectedStatus === 502) assert.match(response.error, /模型.*404/);
    else assert.equal(response.data.ok, true);
    assert.equal(calls.length, needsChat ? 2 : 1);
    assert.deepEqual(calls[0], { url: '/v1/models', method: 'GET', auth: 'Bearer ' + apiKey, body: '' });
    if (needsChat) {
      assert.equal(calls[1].url, '/v1/chat/completions');
      assert.equal(calls[1].method, 'POST');
      assert.equal(calls[1].auth, 'Bearer ' + apiKey);
      assert.deepEqual(JSON.parse(calls[1].body), { model: 'local-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    }
  }
  catalogue = JSON.stringify({ data: [] });
  chatStatus = 200;
  for (const first of [null, {}, [], 'hi', { message: { content: 42 } },
    { message: { content: '' } }, { message: { reasoning_content: '   ' } }, { text: '' }]) {
    chatBody = { choices: [first, { text: 'only the first choice counts' }] };
    const result = await request('llm/test', 502, {});
    assert.equal(result.error, '模型接口响应格式无效');
  }
  for (const first of [{ message: { content: '', reasoning_content: ' hi ' } }, { text: 'hi' }]) {
    chatBody = { choices: [first] };
    assert.equal((await request('llm/test', 200, {})).data.ok, true);
  }
  calls.length = 0;
  await request('llm/test', 400, { apiKey, baseURL: process.env.LLM_BASE_URL + '/untrusted' });
  assert.equal(calls.length, 0);
});

test('微调接口只合成改写的一句，清空缓存后复用归档并保持帧时间轴', async t => {
  const lines = Array.from({ length: 10 }, (_, i) => ({
    speaker: i % 2 ? '小晓' : '阿泽', text: '交锋台词' + i, emotion: '认真',
  }));
  let calls = 0;
  let gate;
  synthesizeOverride = async ({ outputPath, text }) => {
    if (gate) await gate.promise;
    calls++;
    const mp3 = makeMp3(2 + text.length);
    fs.writeFileSync(outputPath, mp3);
    return { duration: 1, bytes: mp3.length };
  };
  t.after(() => { synthesizeOverride = undefined; });
  generate = () => ({ podcastTitle: '交锋', summary: '摘要', dialogue: lines });
  const poll = async id => {
    for (let i = 0; i < 300; i++) {
      const { data } = await request('tasks/' + id, 200);
      if (data.status === 'completed') return data;
      assert.notEqual(data.status, 'failed', JSON.stringify(data.error));
      await delay(10);
    }
    assert.fail('任务未完成');
  };
  const { id } = (await request('tasks', 202, { ...payload, sourceType: 'image', podcastStyle: 'debate' })).data;
  const original = (await poll(id)).podcast;
  assert.equal(calls, 10);
  assert.equal(original.audioVersion, undefined);
  const dir = path.join(publicDir, 'external-audio', id);
  const metaFile = path.join(dir, 'meta.json');
  const route = 'podcasts/' + id + '/resynthesize';
  assert.equal((await request(route, 400, { dialogue: lines })).error, '缺少播客版本号，请刷新最新剧本后再微调');
  let previous = original;
  for (const legacy of [true, false]) {
    if (legacy) {
      fs.rmSync(path.join(publicDir, 'custom-data', 'tts-cache'), { recursive: true });
      const meta = JSON.parse(fs.readFileSync(metaFile));
      delete meta.cacheKeys;
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    }
    const before = fs.readFileSync(path.join(dir, 'full_podcast.mp3'));
    const edits = previous.sentences.map(line => ({ ...line }));
    edits[legacy ? 6 : 4].text += '补充论据';
    calls = 0;
    const tts = { apiKey, appId: 'offline-edit-app', accessKey: 'offline-edit-access', endpoint: 'https://edit.example/speech' };
    gate = Promise.withResolvers();
    let queued;
    try {
      queued = (await request(route, 202, { dialogue: edits, baseVersion: previous.audioVersion ?? null, tts })).data;
      await request('podcasts/' + id, 409, undefined, 'DELETE');
      const hidden = '/podcasts/.resynth-' + queued.id + '/sentence_000.mp3';
      assert.equal((await fetch(base + hidden)).status, 404);
    } finally {
      gate.resolve();
      gate = null;
    }
    assert.equal(queued.targetPodcastId, id);
    assert.equal(queued.stage, 'tts');
    const completed = await poll(queued.id);
    assert.equal(calls, 1);
    assert.equal(completed.progress.cachedSegments, 9);
    const detail = completed.podcast;
    const meta = JSON.parse(fs.readFileSync(metaFile));
    const checkpoint = fs.readFileSync(path.join(publicDir, 'custom-data', 'tasks', queued.id + '.json'), 'utf8');
    for (const value of [...Object.values(tts), root]) {
      assert.ok(!JSON.stringify(meta).includes(value));
      assert.ok(!checkpoint.includes(value));
    }
    assert.match(detail.audioVersion, /^[a-zA-Z0-9_-]{1,32}$/);
    assert.notEqual(detail.audioVersion, previous.audioVersion);
    assert.equal(detail.audioVersion, meta.audioVersion);
    assert.ok(Number.isFinite(Date.parse(detail.updatedAt)));
    for (const name of ['createAt', 'podcastStyle', 'id', 'podcastTitle', 'summary', 'sourceType', 'sourceTruncated',
      'ttsModel', 'speechSpeed', 'ttsProvider', 'voiceMapping']) assert.deepEqual(detail[name], original[name]);
    const version = '?v=' + detail.audioVersion;
    assert.equal(detail.fullAudioUrl, original.fullAudioUrl + version);
    const full = Buffer.from(await (await fetch(base + detail.fullAudioUrl)).arrayBuffer());
    assert.notDeepEqual(full, before);
    const duration = require('../src/services/mp3Utils').getMp3DurationSeconds;
    assert.ok(Math.abs(duration(full) - detail.totalDuration) < 1e-9);
    assert.equal(meta.totalDuration, detail.sentences.at(-1).endTime);
    for (const [index, sentence] of detail.sentences.entries()) {
      assert.equal(sentence.text, edits[index].text);
      assert.equal(sentence.audioUrl, original.sentences[index].audioUrl + version);
      const bytes = Buffer.from(await (await fetch(base + sentence.audioUrl)).arrayBuffer());
      assert.ok(Math.abs(duration(bytes) - (sentence.endTime - sentence.startTime)) < 1e-9);
      assert.equal(sentence.startTime, index ? detail.sentences[index - 1].endTime + detail.sentenceGap : 0);
    }
    assert.equal(fs.existsSync(path.join(publicDir, 'external-audio', '.resynth-' + queued.id)), false);
    const stale = await request(route, 409, { dialogue: lines, baseVersion: previous.audioVersion ?? null });
    assert.equal(stale.code, 'PODCAST_VERSION_CONFLICT');
    assert.deepEqual((await request('podcasts/' + id, 200)).data, detail);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'full_podcast.mp3')), full);
    assert.equal(JSON.parse(checkpoint).baseVersion, previous.audioVersion ?? null);
    const cache = path.join(publicDir, 'custom-data', 'tts-cache');
    assert.equal(fs.readdirSync(cache).length, legacy ? 1 : 2);
    previous = detail;
  }
  for (const dialogue of [[], Array(301).fill(lines[0]), [{ speaker: '第三人', text: '正文' }],
    [{ speaker: '阿泽', text: ' ' }], [{ speaker: '小晓', text: '文'.repeat(2001) }]]) {
    await request(route, 400, { baseVersion: previous.audioVersion, dialogue });
  }
  for (const baseVersion of [false, 0, {}, [], '', ' invalid ', 'v'.repeat(33)]) {
    assert.equal((await request(route, 400, { dialogue: lines, baseVersion })).error, '无效的播客版本号');
  }
  await request(route, 400, { baseVersion: previous.audioVersion, dialogue: [{ speaker: '阿泽', text: apiKey }], tts: { apiKey } });
  await request('podcasts/missing/resynthesize', 404, { baseVersion: null, dialogue: lines });
  await request('podcasts/..%2Fprivate/resynthesize', 400, { baseVersion: null, dialogue: lines });
});

test('单期缺失发布备份时服务可启动，健康播客仍可列出和播放', async t => {
  const podcastsDir = path.join(root, 'recovery-podcasts');
  const dataDir = path.join(root, 'recovery-data');
  const audio = makeMp3(2);
  for (const id of ['broken', 'healthy']) {
    const dir = path.join(podcastsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ podcastTitle: id }));
    fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), audio);
  }
  const edit = { baseVersion: null, dialogue: [{ speaker: '阿泽', text: '离线微调' }] };
  const tasksDir = path.join(dataDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'edit.json'), JSON.stringify({
    id: 'edit', targetPodcastId: 'broken', baseVersion: null, status: 'failed', stage: 'tts',
    input: { mode: 'text' }, progress: {}, script: { dialogue: edit.dialogue },
  }));
  const transaction = path.join(podcastsDir, 'broken', '.tmp-publish-edit');
  fs.mkdirSync(transaction);
  fs.writeFileSync(path.join(transaction, 'prepared'), JSON.stringify({
    taskId: 'edit', previousVersion: null, targetVersion: 'target', dialogueCount: 1,
  }));

  const warnings = t.mock.method(console, 'warn', () => {});
  const local = await require('../server').startServer({ port: 0, publicDir, podcastsDir, dataDir });
  t.after(() => local.close());
  assert.equal(warnings.mock.callCount(), 1);
  assert.ok(!JSON.stringify(warnings.mock.calls[0].arguments).includes(root));
  const url = 'http://127.0.0.1:' + local.port;
  const list = await fetch(url + '/api/podcasts');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data.items.map(item => item.id), ['healthy']);
  const detail = await fetch(url + '/api/podcasts/healthy');
  assert.equal(detail.status, 200);
  const playback = await fetch(url + (await detail.json()).data.fullAudioUrl);
  assert.equal(playback.status, 200);
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), audio);

  for (const [route, options] of [
    ['/api/podcasts/broken'], ['/podcasts/broken/full_podcast.mp3'],
    ['/api/podcasts/broken/resynthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) }],
    ['/api/tasks/edit/resume', { method: 'POST' }],
    ['/api/podcasts/broken', { method: 'DELETE' }],
  ]) {
    const res = await fetch(url + route, options);
    assert.equal(res.status, 503, route);
    assert.equal((await res.json()).code, 'PODCAST_RECOVERY_FAILED');
  }
  assert.ok(fs.existsSync(path.join(transaction, 'prepared')));
});

test('局域网微调及其续跑、取消都验证管理令牌', async t => {
  const calls = [];
  const taskManager = {
    isPodcastEdit: () => true,
    resynthesizePodcast: id => { calls.push(id); return { id: 'edit', targetPodcastId: id }; },
    resumeTask: id => { calls.push(id); return { id }; },
    cancelTask: id => { calls.push(id); return { id }; },
  };
  const token = 'offline-edit-admin';
  const app = require('../server').createApp({ taskManager, adminToken: token, isLoopbackRequest: () => false });
  const local = app.listen(0, '127.0.0.1');
  await once(local, 'listening');
  t.after(() => new Promise(resolve => local.close(resolve)));
  for (const [route, ok] of [['podcasts/original/resynthesize', 202], ['tasks/edit/resume', 202], ['tasks/edit/cancel', 200]]) {
    for (const [headers, status] of [[{}, 403], [{ 'x-admin-token': 'invalid' }, 403], [{ authorization: 'Bearer ' + token }, ok]]) {
      const res = await fetch(`http://127.0.0.1:${local.address().port}/api/${route}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: route.endsWith('/resynthesize') ? JSON.stringify({ baseVersion: null }) : undefined,
      });
      assert.equal(res.status, status);
      assert.ok(!(await res.text()).includes(token));
    }
  }
  assert.deepEqual(calls, ['original', 'edit', 'edit']);
});
