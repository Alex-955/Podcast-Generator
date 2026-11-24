const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { extractArticle } = require('../src/services/extractor');
const { makeMp3 } = require('./helpers/mp3Fixtures');

const apiKey = 'offline-credential';
const payload = { mode: 'text', content: '离线文章正文', apiKey };
let root, server, base, previousEnv;
let generate;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-routes-'));
  const settings = {
    DATA_DIR: path.join(root, 'data'), PODCASTS_DIR: path.join(root, 'external-audio'),
    CORS_ORIGIN: 'https://one.example, https://two.example', DEEPSEEK_API_KEY: '',
  };
  previousEnv = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const { createApp } = require('../server');
  const app = createApp({
    dataDir: path.join(root, 'custom-data'),
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
  assert.ok(fs.existsSync(path.join(root, 'custom-data', 'tasks', task.id + '.json')));
  assert.ok(fs.existsSync(path.join(root, 'external-audio', task.id, 'meta.json')));
  await request(route + '/resume', 409, { apiKey });
  await request(route + '/cancel', 409, {});
});
