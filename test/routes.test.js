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
const { upstreamError } = require('../src/services/providerHttp');

const apiKey = 'offline-credential';
const payload = { mode: 'text', content: '离线文章正文', apiKey };
let root, publicDir, server, base, previousEnv;
let generate, llmRequest, observeProbe;
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
      synthesizeToFile({ outputPath }) {
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

async function request(route, status, body) {
  const res = await fetch(base + '/api/' + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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

test('监听端口在未设置或空白时取 3000，保留显式的 0 和指定端口', () => {
  const { parsePort } = require('../server');
  for (const value of [undefined, '', '   ']) assert.equal(parsePort(value), 3000);
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
  assert.deepEqual(result, { success: true, data: { title: '长截图', content: '第一段\n\n第二段', length: 8, truncated: false, imageCount: 2 } });
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
  generate = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('迟到的上游失败')), { once: true });
  });
  const { data: task } = await request('tasks', 202, payload);
  const route = 'tasks/' + task.id;
  assert.equal(task.status, 'queued');
  assert.equal((await request('tasks', 409, payload)).code, 'TASK_ALREADY_RUNNING');
  await request(route + '/resume', 409, {});
  assert.equal((await request(route + '/cancel', 200, {})).data.status, 'cancelled');
  await request(route + '/cancel', 409, {});
  assert.equal((await request(route, 200)).data.error, null);
  await request(route + '/resume', 400, {});

  generate = async () => ({ podcastTitle: '路由测试', summary: '测试', dialogue: [{ speaker: '阿泽', text: '开场' }] });
  await request(route + '/resume', 202, { apiKey });
  let completed;
  for (let i = 0; i < 100; i++) {
    completed = (await request(route, 200)).data;
    if (completed.status === 'completed') break;
    await delay(10);
  }
  assert.equal(completed.status, 'completed');
  const detail = (await request('podcasts/' + task.id, 200)).data;
  assert.deepEqual(completed.podcast, detail);
  assert.equal((await request('podcasts', 200)).data.items[0].id, task.id);
  for (const url of [detail.fullAudioUrl, detail.sentences[0].audioUrl]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), makeMp3(10));
  }
  assert.ok(fs.existsSync(path.join(publicDir, 'custom-data', 'tasks', task.id + '.json')));
  assert.ok(fs.existsSync(path.join(publicDir, 'external-audio', task.id, 'meta.json')));
  await request(route + '/resume', 409, { apiKey });
  await request(route + '/cancel', 409, {});
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
