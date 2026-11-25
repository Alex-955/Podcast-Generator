const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createTaskManager } = require('../src/services/taskManager');
const { getTtsProvider } = require('../src/services/ttsProvider');
const { synthesizeSentence, synthesizeDialogueScript, DEFAULT_VOICES } = require('../src/services/ttsService');
const { getMp3DurationSeconds } = require('../src/services/mp3Utils');
const { startFakeEdgeTts } = require('./fakeEdgeTts');
const { makeMp3 } = require('./helpers/mp3Fixtures');

const apiKey = 'sk-secret-test-key';
const dialogue = ['第一句', '第二句', '第三句'].map((text, i) => ({ speaker: i % 2 ? '小晓' : '阿泽', text }));
const script = { podcastTitle: '离线节目', summary: '摘要', dialogue };
const payload = { mode: 'text', content: '文'.repeat(12200), apiKey, baseURL: 'https://private.example' };

async function waitFor(read, predicate) {
  const deadline = Date.now() + 5000;
  do {
    const value = read();
    if (predicate(value)) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail('等待任务状态超时');
}

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-tasks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    tasksDir: path.join(root, 'tasks'), podcastsDir: path.join(root, 'podcasts'), cacheDir: path.join(root, 'cache'),
    scriptGenerator: async () => script, ...overrides,
  };
  return { root, config, manager: createTaskManager(config) };
}

function noLeaks(value, root) {
  const json = JSON.stringify(value);
  for (const sensitive of [apiKey, payload.baseURL, '"apiKey"', '"baseURL"', '"Authorization"', '"filePath"', root]) {
    assert.ok(!json.includes(sensitive), '不应泄露 ' + sensitive);
  }
}

async function localProvider(t, onConnection, beforeSynthesis) {
  const fake = await startFakeEdgeTts({ payload: makeMp3(10), onConnection });
  t.after(() => fake.close());
  const edge = getTtsProvider();
  return {
    ...edge,
    synthesizeToFile(args) {
      beforeSynthesis?.(args);
      return edge.synthesizeToFile({ ...args, adapterOptions: { endpoint: fake.endpoint } });
    },
  };
}

test('服务端 Key 仅用于服务端配置的模型地址，自带 Key 可使用自定义地址', async t => {
  const serverKey = 'offline-server-credential';
  const defaultURL = 'https://api.deepseek.com';
  const customURL = 'https://model.example/Team';
  const { DEEPSEEK_API_KEY, LLM_BASE_URL } = process.env;
  t.after(() => {
    for (const [key, value] of Object.entries({ DEEPSEEK_API_KEY, LLM_BASE_URL })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DEEPSEEK_API_KEY = serverKey;
  delete process.env.LLM_BASE_URL;
  const calls = [];
  const { manager, config } = setup(t, {
    ttsProvider: await localProvider(t),
    scriptGenerator({ apiKey, baseURL }) {
      calls.push({ apiKey, baseURL });
      return script;
    },
  });
  const article = { mode: 'text', content: '普通正文' };
  const denied = { statusCode: 400, message: '使用自定义接口地址时请提供对应的 API Key' };
  assert.throws(() => manager.createTask({ ...article, baseURL: customURL }), denied);
  assert.throws(() => manager.createTask({ ...article, baseURL: customURL, apiKey: '  ' }), denied);
  assert.throws(() => manager.createTask({ ...article, title: serverKey }), { statusCode: 400, message: '输入内容包含敏感凭据，已拦截并中止保存' });
  assert.equal(fs.existsSync(config.tasksDir), false);
  assert.equal(calls.length, 0);

  async function checkDestination(credentials, expectedKey, expectedURL) {
    const { id } = manager.createTask({ ...article, ...credentials });
    const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
    assert.deepEqual(calls.splice(0), [{ apiKey: expectedKey, baseURL: expectedURL }]);
    assert.ok(!JSON.stringify(done).includes(expectedKey));
  }
  await checkDestination({}, serverKey, defaultURL);
  await checkDestination({ baseURL: defaultURL }, serverKey, defaultURL);
  await checkDestination({ baseURL: customURL, apiKey }, apiKey, customURL);
  process.env.LLM_BASE_URL = customURL;
  await checkDestination({ baseURL: '  https://MODEL.example/Team/v1/  ' }, serverKey, customURL);
  assert.throws(() => manager.createTask({ ...article, baseURL: 'https://model.example/team' }), denied);
});

test('创建时拦截含本次 Key 的标题、正文或文章链接，首次落盘前返回 400', t => {
  const unexpectedCall = () => assert.fail('输入应在任务启动前被拒绝');
  const { manager, root } = setup(t, { extractor: unexpectedCall, scriptGenerator: unexpectedCall });
  for (const input of [
    { ...payload, title: '标题' + apiKey },
    { ...payload, content: '正文' + apiKey },
    { mode: 'url', url: 'https://article.example/' + apiKey, apiKey },
  ]) {
    assert.throws(() => manager.createTask(input), {
      statusCode: 400, message: '输入内容包含敏感凭据，已拦截并中止保存',
    });
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('抓取返回的标题或正文含本次 Key 时任务在 extract 失败，文件与 DTO 不含凭据', async t => {
  let article;
  let scriptCalls = 0;
  const { manager, config, root } = setup(t, {
    extractor: () => article,
    scriptGenerator() { scriptCalls++; throw new Error('不应进入剧本阶段'); },
  });
  for (const field of ['title', 'content']) {
    article = { title: '标题', content: '正文', [field]: '文章中包含 ' + apiKey };
    const task = manager.createTask({ mode: 'url', url: 'https://article.example/story', apiKey });
    const failed = await waitFor(() => manager.getTask(task.id), record => record.status === 'failed');
    assert.equal(failed.error.stage, 'extract');
    assert.equal(failed.error.message, '抓取内容包含敏感凭据，已拦截并中止保存');
    const stored = JSON.parse(fs.readFileSync(path.join(config.tasksDir, task.id + '.json')));
    assert.equal(stored.sourceContent, '');
    assert.equal(stored.input.title, '');
    noLeaks(failed, root);
    noLeaks(stored, root);
  }
  assert.equal(scriptCalls, 0);
});

test('url / text 四阶段、真实逐句进度、跨任务缓存与成品帧时间轴', async t => {
  const stages = [];
  let extractCount = 0;
  const progress = [];
  let task;
  const provider = await localProvider(t, null, () => progress.push(manager.getTask(task.id).progress));
  const { manager, config, root } = setup(t, {
    ttsProvider: provider,
    extractor: async () => {
      extractCount++;
      stages.push(manager.getTask(task.id).stage);
      return { title: '原文章', content: '正文', truncated: true };
    },
    scriptGenerator: async ({ content }) => {
      stages.push(manager.getTask(task.id).stage);
      assert.equal(content.length, task.input.mode === 'url' ? 2 : 12000);
      return script;
    },
    audioMerger(...args) {
      stages.push(manager.getTask(task.id).stage);
      return require('../src/services/audioMerger').concatenateAudioFiles(...args);
    },
  });
  for (const mode of ['url', 'text']) {
    task = manager.createTask({ ...payload, mode, url: 'https://example.org/article' });
    assert.equal(task.status, 'queued');
    const done = await waitFor(() => manager.getTask(task.id), x => x.status === 'completed');
    assert.equal(done.progress.stageIndex, 4);
    assert.equal(done.progress.completedSegments, 3);
    assert.equal(done.progress.cachedSegments, mode === 'url' ? 0 : 3);
    assert.equal(done.input.sourceTruncated, true);
    assert.equal(done.podcastId, task.id);
    assert.deepEqual(done.podcast, manager.getPodcast(task.id));
    const dir = path.join(config.podcastsDir, task.id);
    const mp3 = fs.readFileSync(path.join(dir, 'full_podcast.mp3'));
    assert.ok(Math.abs(getMp3DurationSeconds(mp3) - done.podcast.totalDuration) < 1e-9);
    assert.equal(done.podcast.totalDuration, done.podcast.sentences.at(-1).endTime);
    for (const object of [done, manager.listPodcasts(), JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))),
      JSON.parse(fs.readFileSync(path.join(config.tasksDir, task.id + '.json')))]) noLeaks(object, root);
  }
  assert.equal(extractCount, 1);
  assert.deepEqual(stages, ['extract', 'script', 'merge', 'script', 'merge']);
  assert.deepEqual(progress.map(p => [p.stageIndex, p.completedSegments, p.currentSpeaker]),
    [[3, 0, '阿泽'], [3, 1, '小晓'], [3, 2, '阿泽']]);
});

test('第三句失败后跨重启续跑，仅合成第三句，无需凭据', async t => {
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { if (key !== undefined) process.env.DEEPSEEK_API_KEY = key; });
  let fail = true;
  let llmCalls = 0;
  const calls = [];
  const provider = await localProvider(t, conn => {
    if (fail && conn.index >= 2) conn.mode = 'close-early';
  }, ({ text }) => calls.push(text));
  const { manager, config } = setup(t, {
    ttsProvider: provider, scriptGenerator: async () => { llmCalls++; return script; },
  });
  const { id } = manager.createTask(payload);
  const failed = await waitFor(() => manager.getTask(id), x => x.status === 'failed');
  assert.equal(failed.error.failedSegmentIndex, 2);
  assert.equal(failed.progress.completedSegments, 2);
  assert.deepEqual(calls, ['第一句', '第二句', '第三句', '第三句', '第三句']);
  fs.rmSync(config.cacheDir, { recursive: true }); // 本次只能从工作目录复用。
  fail = false;
  const restarted = createTaskManager(config);
  restarted.resumeTask(id);
  const done = await waitFor(() => restarted.getTask(id), x => x.status === 'completed');
  assert.equal(llmCalls, 1);
  assert.deepEqual(calls.slice(5), ['第三句']);
  assert.equal(done.progress.cachedSegments, 2);
  assert.equal(done.podcast.sentences.length, 3);
});

test('取消合成会关闭连接并释放单活锁，保留 cancelled 状态', async t => {
  let connected;
  const started = new Promise(resolve => { connected = resolve; });
  let count = 0;
  const provider = await localProvider(t, conn => { count++; conn.mode = 'no-data'; connected(); });
  const { manager, config } = setup(t, { ttsProvider: provider });
  const { id } = manager.createTask(payload);
  await started;
  assert.throws(() => manager.createTask(payload), { statusCode: 409, code: 'TASK_ALREADY_RUNNING' });
  assert.equal(manager.cancelTask(id).status, 'cancelled');
  await waitFor(() => fs.readdirSync(path.join(config.podcastsDir, id)), files => !files.length);
  assert.equal(manager.getTask(id).status, 'cancelled');
  assert.equal(manager.getTask(id).error, null);
  assert.equal(count, 1);
  assert.deepEqual(fs.readdirSync(path.join(config.podcastsDir, id)), []);
  assert.throws(() => manager.cancelTask(id), { statusCode: 409 });
});

test('重启将 queued / running 转为可恢复失败，保存的正文供重试', async t => {
  const { manager, config } = setup(t, { scriptGenerator: async () => { throw new Error('模拟错误'); } });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), x => x.status === 'failed');
  const file = path.join(config.tasksDir, id + '.json');
  const task = JSON.parse(fs.readFileSync(file));
  for (const status of ['running', 'queued']) {
    fs.writeFileSync(file, JSON.stringify({ ...task, status }));
    const restarted = createTaskManager(config);
    const recovered = restarted.getTask(id);
    assert.equal(recovered.status, 'failed');
    assert.deepEqual(recovered.error, {
      stage: 'script', message: '服务已重启，上次生成被中断，可点击「从断点继续生成」恢复', retryable: true, failedSegmentIndex: null,
    });
    restarted.resumeTask(id, { apiKey });
    await waitFor(() => restarted.getTask(id), x => x.error?.message === '模拟错误');
  }
});

test('启动扫描原样保留损坏记录，有可用剧本的 running 任务能续跑完成', async t => {
  const unexpectedCall = () => assert.fail('已有剧本，应跳过抓取和剧本生成');
  const { config } = setup(t, {
    ttsProvider: await localProvider(t), extractor: unexpectedCall, scriptGenerator: unexpectedCall,
  });
  fs.mkdirSync(config.tasksDir);
  const file = id => path.join(config.tasksDir, id + '.json');
  const valid = {
    id: 'running', status: 'running', stage: 'tts', input: { mode: 'text', title: '标题' }, script,
    progress: { stageIndex: 3, totalStages: 4, totalSegments: 3, completedSegments: 0, cachedSegments: 0 },
  };
  fs.writeFileSync(file(valid.id), JSON.stringify(valid));
  const damaged = {
    broken: '{"id":',
    mismatch: JSON.stringify(valid),
    incomplete: JSON.stringify({ id: 'incomplete', status: 'running', stage: 'tts' }),
    noSource: JSON.stringify({ ...valid, id: 'noSource', script: null }),
    noUrl: JSON.stringify({ ...valid, id: 'noUrl', script: null, input: { mode: 'url' } }),
    badStage: JSON.stringify({ ...valid, id: 'badStage', stage: 'unknown' }),
    badStatus: JSON.stringify({ ...valid, id: 'badStatus', status: 'unknown' }),
    badMode: JSON.stringify({ ...valid, id: 'badMode', input: { mode: 'other' } }),
    badProgress: JSON.stringify({ ...valid, id: 'badProgress', progress: [] }),
    badVoices: JSON.stringify({ ...valid, id: 'badVoices', voiceMapping: [] }),
  };
  for (const [id, bytes] of Object.entries(damaged)) fs.writeFileSync(file(id), bytes);

  const restarted = createTaskManager(config);
  const recovered = restarted.getTask('running');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.stage, 'tts');
  assert.equal(recovered.error.retryable, true);
  for (const [id, bytes] of Object.entries(damaged)) {
    assert.throws(() => restarted.getTask(id));
    assert.equal(fs.readFileSync(file(id), 'utf8'), bytes);
  }
  restarted.resumeTask(valid.id);
  const done = await waitFor(() => restarted.getTask(valid.id), task => task.status === 'completed');
  assert.equal(done.podcast.sentences.length, script.dialogue.length);
});

test('voiceMapping 为 null 的历史断点用两位主播的默认音色续跑', async t => {
  const voices = [];
  const { config, manager } = setup(t, {
    ttsProvider: await localProvider(t, null, ({ voice }) => voices.push(voice)),
    ttsSynthesizer(lines, dir, mapping, options) {
      assert.deepEqual(mapping, DEFAULT_VOICES);
      return synthesizeDialogueScript(lines, dir, mapping, options);
    },
  });
  const record = {
    id: 'null-voices', status: 'failed', stage: 'tts', input: { mode: 'text' },
    progress: {}, script, voiceMapping: null,
  };
  fs.mkdirSync(config.tasksDir);
  fs.writeFileSync(path.join(config.tasksDir, record.id + '.json'), JSON.stringify(record));
  manager.resumeTask(record.id);
  const done = await waitFor(() => manager.getTask(record.id), task => task.status === 'completed');
  assert.equal(done.podcast.sentences.length, dialogue.length);
  assert.deepEqual(voices, dialogue.map(line => DEFAULT_VOICES[line.speaker]));
});

test('状态和失败记录均写盘失败时，仍可查询恢复态并在同一实例续跑', async t => {
  let blockWrites = false;
  let failedWrites = 0;
  let generations = 0;
  const scriptGenerator = () => { generations++; return script; };
  const { manager, config } = setup(t, {
    ttsProvider: await localProvider(t), scriptGenerator,
    async ttsSynthesizer(...args) {
      const result = await synthesizeDialogueScript(...args);
      if (failedWrites === 0) blockWrites = true;
      return result;
    },
  });
  const { id } = manager.createTask(payload);
  const file = path.join(config.tasksDir, id + '.json');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (blockWrites && to === file) {
      failedWrites++;
      throw Object.assign(new Error('模拟任务目录暂不可写'), { code: 'EROFS' });
    }
    return rename(from, to);
  });
  await waitFor(() => failedWrites, count => count >= 2);
  const recovered = manager.getTask(id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.stage, 'tts'); // 最后成功落盘的阶段
  assert.equal(recovered.error.retryable, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'running');
  blockWrites = false;
  manager.resumeTask(id);
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  assert.equal(done.progress.cachedSegments, dialogue.length);
  assert.equal(generations, 1);
});

test('成功的模型回复若回显本次 Key 会在保存及合成前被拦截，讨论服务地址仍可生成', async t => {
  let reply;
  let syntheses = 0;
  const provider = await localProvider(t, null, () => { syntheses++; });
  const { manager, config, root } = setup(t, { ttsProvider: provider, scriptGenerator: () => reply });
  for (const field of ['podcastTitle', 'summary', 'text', 'emotion']) {
    reply = structuredClone(script);
    const target = ['text', 'emotion'].includes(field) ? reply.dialogue.at(-1) : reply;
    target[field] = `回显 ${apiKey} 测试`;
    const { id } = manager.createTask(payload);
    const task = await waitFor(() => manager.getTask(id), task => task.status === 'failed');
    assert.equal(task.error.message, '模型返回内容包含敏感凭据，已拦截并中止保存');
    assert.equal(task.error.stage, 'script');
    assert.equal(task.hasScript, false);
    noLeaks(task, root);
    const stored = JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json')));
    assert.equal(stored.script, null);
    noLeaks(stored, root);
    assert.equal(fs.existsSync(path.join(config.podcastsDir, id)), false);
  }
  assert.equal(syntheses, 0);
  assert.deepEqual(manager.listPodcasts().items, []);

  reply = { ...script, summary: '本集介绍 https://api.deepseek.com' };
  const { id } = manager.createTask({ ...payload, baseURL: 'https://api.deepseek.com' });
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  assert.equal(done.podcast.summary, reply.summary);
});

test('历史倒序、残缺目录原样保留、旧元数据投影与安全 ID', t => {
  const { manager, config, root } = setup(t);
  const dates = { old: '2024-01-01', latest: '2025-01-01' };
  for (const id of ['old', 'latest', 'no-meta', 'no-audio', 'empty', 'corrupt']) {
    const dir = path.join(config.podcastsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    if (id !== 'no-audio') fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), id === 'empty' ? '' : 'audio');
    const meta = { createAt: dates[id], filePath: root, sentences: [{ fileName: 'line.mp3', filePath: root }] };
    if (id !== 'no-meta') fs.writeFileSync(path.join(dir, 'meta.json'), id === 'corrupt' ? '{' : JSON.stringify(meta));
  }
  assert.deepEqual(manager.listPodcasts().items.map(x => x.id), ['latest', 'old']);
  noLeaks(manager.getPodcast('latest'), root);
  assert.equal(fs.readdirSync(config.podcastsDir).length, 6);
  assert.throws(() => manager.getPodcast('../old'), { statusCode: 400 });
  assert.throws(() => manager.getPodcast('empty'), { statusCode: 404 });
});

test('退避期间取消不会打开下一次连接', async () => {
  const controller = new AbortController();
  const attempts = [];
  const promise = synthesizeSentence({
    text: '台词', signal: controller.signal, onAttempt: n => attempts.push(n),
    provider: { synthesizeToFile() { throw new Error('断线'); } },
  });
  setImmediate(() => controller.abort());
  await assert.rejects(promise, { name: 'AbortError' });
  assert.deepEqual(attempts, [1]);
});

test('取消后立即续跑会等待旧调用退出，迟到的失败不能覆盖新进度', async t => {
  let rejectOld;
  let calls = 0;
  const { manager } = setup(t, {
    scriptGenerator: async () => {
      calls++;
      if (calls === 1) return new Promise((_, reject) => { rejectOld = reject; });
      return script;
    },
    ttsProvider: await localProvider(t),
  });
  const { id } = manager.createTask(payload);
  await waitFor(() => calls, n => n === 1);
  manager.cancelTask(id);
  assert.equal(manager.resumeTask(id, { apiKey }).status, 'running');
  assert.throws(() => manager.createTask(payload), { code: 'TASK_ALREADY_RUNNING' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  rejectOld(new Error('上一次运行的延迟错误'));
  await waitFor(() => manager.getTask(id), x => x.status === 'completed');
  assert.equal(calls, 2);
});

test('上游错误即使回显整段凭据或存储路径，也不会进入任务文件或 DTO', async t => {
  const { manager, config, root } = setup(t, {
    scriptGenerator({ apiKey, baseURL }) {
      throw new Error(`Authorization: Bearer ${apiKey} baseURL=${baseURL} filePath=${root}/test`);
    },
  });
  const { id } = manager.createTask(payload);
  const failed = await waitFor(() => manager.getTask(id), x => x.status === 'failed');
  assert.equal(failed.error.stage, 'script');
  assert.equal(failed.error.failedSegmentIndex, null);
  assert.equal(failed.error.retryable, true);
  assert.ok(failed.error.message.includes('***'));
  assert.doesNotMatch(failed.error.message, /Authorization|baseURL|filePath/);
  noLeaks(failed, root);
  noLeaks(JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json'))), root);
});

test('换语音服务后从首句重配，旧句与成品同步清理，沿用原文与剧本', async t => {
  const { httpTtsFixture } = require('./helpers/httpTtsFixture');
  const { HEADER_48K, FRAME_SIZE_48K } = require('./helpers/mp3Fixtures');
  const audio = makeMp3(4, { header: HEADER_48K, frameSize: FRAME_SIZE_48K });
  const { endpoint, requests } = await httpTtsFixture(t, res => res.end(JSON.stringify({ code: 20000000, data: audio.toString('base64') })));
  const previousPrivate = process.env.ALLOW_PRIVATE_TTS_ENDPOINT;
  process.env.ALLOW_PRIVATE_TTS_ENDPOINT = '1';
  t.after(() => { if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_TTS_ENDPOINT; else process.env.ALLOW_PRIVATE_TTS_ENDPOINT = previousPrivate; });
  const oldEndpoint = process.env.VOLCENGINE_TTS_ENDPOINT;
  process.env.VOLCENGINE_TTS_ENDPOINT = endpoint;
  t.after(() => { if (oldEndpoint === undefined) delete process.env.VOLCENGINE_TTS_ENDPOINT; else process.env.VOLCENGINE_TTS_ENDPOINT = oldEndpoint; });
  let llmCalls = 0;
  const edge = {
    ...getTtsProvider(), synthesizeToFile({ outputPath, text }) {
      if (text !== dialogue[0].text) throw Object.assign(new Error('模拟中断'), { statusCode: 400 });
      fs.writeFileSync(outputPath, makeMp3(1));
      return { bytes: 144, duration: 0.024 };
    },
  };
  const { config, manager } = setup(t, { ttsProvider: edge, scriptGenerator: () => { llmCalls++; return script; } });
  const { id } = manager.createTask(payload);
  const failed = await waitFor(() => manager.getTask(id), x => x.status === 'failed');
  assert.equal(failed.error.failedSegmentIndex, 1);
  const dir = path.join(config.podcastsDir, id);
  assert.deepEqual(fs.readdirSync(dir), ['sentence_000.mp3']);
  fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), makeMp3(1));
  const appId = 'offline-app-value', accessKey = 'offline-access-value';
  const tts = { provider: 'volcengine', appId, accessKey, endpoint, resourceId: 'seed-tts-1.0', voiceMapping: { 阿泽: 'S_cloned' } };
  const resumed = manager.resumeTask(id, { tts });
  assert.deepEqual(fs.readdirSync(dir), []);
  const done = await waitFor(() => manager.getTask(id), x => x.status === 'completed');
  assert.equal(llmCalls, 1);
  assert.equal(done.progress.cachedSegments, 0);
  assert.deepEqual(requests.map(r => r.body.req_params.text), dialogue.map(l => l.text));
  assert.deepEqual(requests.map(r => r.body.req_params.speaker), ['S_cloned', 'zh_female_cancan_mars_bigtts', 'S_cloned']);
  assert.ok(requests.every(r => r.headers['x-api-resource-id'] === tts.resourceId && r.headers['x-api-app-id'] === appId));
  const stored = JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json')));
  assert.deepEqual(stored.script, script);
  assert.equal(stored.sourceContent.length, 12000);
  for (const record of [resumed, done, stored, JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')))]) {
    assert.equal(record.ttsProvider, 'volcengine');
    assert.equal(record.ttsModel, 'seed-tts-1.0');
    assert.equal(record.voiceMapping.阿泽, 'S_cloned');
    for (const secret of [appId, accessKey, endpoint]) assert.ok(!JSON.stringify(record).includes(secret));
  }
});

test('TTS 凭据回显在首次落盘、抓取、模型输出和失败记录边界均被拦截或脱敏', async t => {
  const tts = { provider: 'minimax', apiKey: 'private-mini-key', endpoint: 'https://mini-private.example/v1' };
  let modelOutput = script;
  const { config, manager } = setup(t, {
    extractor: () => ({ title: '正文', content: '回显 ' + tts.apiKey }),
    scriptGenerator: () => modelOutput,
    ttsSynthesizer: () => { throw new Error(`连接 ${tts.endpoint} 时凭据 ${tts.apiKey} 失效`); },
  });
  for (const fields of [{ content: tts.apiKey }, { title: tts.endpoint }, { tts: { ...tts, model: tts.apiKey } },
    { tts: { ...tts, voiceMapping: { 阿泽: tts.apiKey } } }]) {
    assert.throws(() => manager.createTask({ ...payload, tts, ...fields }), { statusCode: 400 });
  }
  for (const stage of ['extract', 'script', 'tts']) {
    modelOutput = stage === 'script' ? { ...script, summary: '回显 ' + tts.endpoint } : script;
    const input = stage === 'extract' ? { mode: 'url', url: 'https://article.example/item' } : {};
    const { id } = manager.createTask({ ...payload, tts, ...input });
    const failed = await waitFor(() => manager.getTask(id), x => x.status === 'failed');
    assert.equal(failed.error.stage, stage);
    const json = fs.readFileSync(path.join(config.tasksDir, id + '.json'), 'utf8') + JSON.stringify(failed);
    for (const secret of [tts.apiKey, tts.endpoint]) assert.ok(!json.includes(secret));
    assert.throws(() => manager.resumeTask(id, { apiKey, tts: { provider: 'volcengine', endpoint: 'https://other.example' } }), { statusCode: 400 });
  }
});

test('合成输入错误仅尝试一次', async () => {
  const { InputError } = require('../src/services/validation');
  const error = new InputError('无效音色');
  const attempts = [];
  await assert.rejects(synthesizeSentence({ text: '台词', provider: { synthesizeToFile() { throw error; } },
    onAttempt: n => attempts.push(n) }), e => e === error);
  assert.deepEqual(attempts, [1]);
});

test('同一家服务换模型或换音色时清理工作目录，补凭据续跑时复用原片段', async t => {
  const calls = [];
  const provider = {
    ...getTtsProvider('minimax'),
    synthesizeToFile({ outputPath, adapterOptions, voice }) {
      calls.push({ model: adapterOptions.model, voice });
      const audio = makeMp3(2);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.048 };
    },
  };
  let llmCalls = 0, finish = false;
  const { manager, config } = setup(t, {
    getTtsProviderById: id => id === provider.id ? provider : getTtsProvider(id),
    scriptGenerator() { llmCalls++; return script; },
    audioMerger(...args) {
      if (!finish) throw new Error('模拟合并中断');
      return require('../src/services/audioMerger').concatenateAudioFiles(...args);
    },
  });
  const credentials = { apiKey: 'offline-mini-credential' };
  const { id } = manager.createTask({ ...payload, tts: { provider: 'minimax', ...credentials, model: 'speech-02-hd' } });
  const dir = path.join(config.podcastsDir, id);
  const status = target => waitFor(() => manager.getTask(id), task => task.status === target);
  await status('failed');
  for (const [change, shouldClear] of [
    [{}, false],
    [{ model: 'speech-02-turbo' }, true],
    [{ voiceMapping: { 小晓: 'S_new_voice' } }, true],
  ]) {
    manager.resumeTask(id, { tts: { ...credentials, ...change } });
    assert.equal(fs.readdirSync(dir).length === 0, shouldClear);
    await status('failed');
  }
  assert.equal(llmCalls, 1);
  assert.deepEqual(calls.map(item => item.model), [...Array(3).fill('speech-02-hd'), ...Array(4).fill('speech-02-turbo')]);
  assert.equal(calls.at(-1).voice, 'S_new_voice');
  finish = true;
  manager.resumeTask(id, { tts: credentials });
  const done = await status('completed');
  assert.equal(done.progress.cachedSegments, 3);
  assert.equal(calls.length, 7);
});

test('切换端点及私有音色账号均清除断点，缓存按真实音源隔离', async t => {
  const { httpTtsFixture } = require('./helpers/httpTtsFixture');
  const old = process.env.ALLOW_PRIVATE_TTS_ENDPOINT;
  process.env.ALLOW_PRIVATE_TTS_ENDPOINT = '1';
  t.after(() => { if (old === undefined) delete process.env.ALLOW_PRIVATE_TTS_ENDPOINT; else process.env.ALLOW_PRIVATE_TTS_ENDPOINT = old; });
  const accountA = 'credential-alpha', accountB = 'credential-beta';
  const fixture = n => httpTtsFixture(t, (res, req) => {
    const frames = req.headers.authorization === 'Bearer ' + accountB ? n + 1 : n;
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: makeMp3(frames).toString('hex') } }));
  });
  const first = await fixture(2), second = await fixture(4);
  let finish = false, llmCalls = 0;
  const { manager, config } = setup(t, {
    scriptGenerator() { llmCalls++; return { ...script, dialogue: dialogue.slice(0, 1) }; },
    audioMerger(...args) {
      if (!finish) throw new Error('暂停合并');
      return require('../src/services/audioMerger').concatenateAudioFiles(...args);
    },
  });
  const tts = { provider: 'minimax', endpoint: first.endpoint, apiKey: accountA, voiceMapping: { 阿泽: 'S_custom' } };
  const { id } = manager.createTask({ ...payload, tts });
  const work = path.join(config.podcastsDir, id), record = path.join(config.tasksDir, id + '.json');
  const done = status => waitFor(() => manager.getTask(id), x => x.status === status);
  await done('failed');
  const hash = () => JSON.parse(fs.readFileSync(record)).ttsScopeHash;
  const hashes = [hash()];
  for (const [endpoint, key, frames] of [[second.endpoint, accountA, 4], [second.endpoint, accountB, 5]]) {
    fs.writeFileSync(path.join(work, 'full_podcast.mp3'), makeMp3(1));
    manager.resumeTask(id, { tts: { ...tts, endpoint, apiKey: key } });
    assert.deepEqual(fs.readdirSync(work), []);
    await done('failed');
    assert.deepEqual(fs.readFileSync(path.join(work, 'sentence_000.mp3')), makeMp3(frames));
    hashes.push(hash());
  }
  finish = true;
  manager.resumeTask(id, { tts });
  const completed = await done('completed');
  assert.equal(completed.progress.cachedSegments, 1);
  assert.equal(llmCalls, 1);
  assert.deepEqual(fs.readFileSync(path.join(work, 'full_podcast.mp3')), makeMp3(2));
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 2);
  assert.equal(new Set(hashes).size, 3);
  for (const value of hashes) assert.match(value, /^[a-f0-9]{64}$/);
  const meta = fs.readFileSync(path.join(work, 'meta.json'), 'utf8');
  assert.ok(!(JSON.stringify(completed) + meta).includes('ttsScopeHash'));
  for (const secret of [first.endpoint, second.endpoint, accountA, accountB]) {
    assert.ok(!(fs.readFileSync(record, 'utf8') + meta + JSON.stringify(completed)).includes(secret));
  }
});

test('豆包已知音色版本错配在创建与续跑时同步拒绝', async t => {
  const { manager } = setup(t, { scriptGenerator() { throw new Error('待续跑'); } });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  for (const [model, voice] of [['seed-tts-1.0', 'zh_female_vv_uranus_bigtts'],
    ['seed-tts-2.0', 'zh_male_yangguangqingnian_moon_bigtts'], ['seed-tts-2.0', 'zh_female_cancan_mars_bigtts']]) {
    const tts = { provider: 'volcengine', apiKey: 'voice-secret', model, voiceMapping: { 小晓: voice } };
    assert.throws(() => manager.createTask({ ...payload, tts }), { statusCode: 400 });
    assert.throws(() => manager.resumeTask(id, { ...payload, tts }), { statusCode: 400 });
  }
});
