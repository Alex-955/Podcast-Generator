const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createTaskManager } = require('../src/services/taskManager');
const { getTtsProvider } = require('../src/services/ttsProvider');
const { createMinimaxProvider } = require('../src/services/minimaxTtsProvider');
const { synthesizeSentence, synthesizeDialogueScript, DEFAULT_VOICES, TTS_CHECKPOINT_FILENAME } = require('../src/services/ttsService');
const { getMp3DurationSeconds } = require('../src/services/mp3Utils');
const { startFakeEdgeTts } = require('./fakeEdgeTts');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { completion, configureLlm, response } = require('./helpers/llmFixture');

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

for (const style of ['dialogue', 'debate']) test(style + ' 创建与续跑同步校验节目风格，保留风格并传给剧本、任务 DTO 与成品元数据', async t => {
  const styles = [];
  const { manager, config } = setup(t, {
    ttsProvider: await localProvider(t),
    scriptGenerator({ podcastStyle }) {
      styles.push(podcastStyle);
      if (styles.length === 1) throw new Error('模拟剧本阶段中断');
      return script;
    },
  });
  const invalid = { statusCode: 400, message: '节目风格仅支持深度主讲（deep_dive）、轻松对谈（dialogue）或正反交锋（debate）' };
  for (const podcastStyle of [null, 123, 'unknown']) {
    assert.throws(() => manager.createTask({ ...payload, podcastStyle }), invalid);
  }
  assert.equal(fs.existsSync(config.tasksDir), false);

  const queued = manager.createTask({ ...payload, podcastStyle: ' ' + style.toUpperCase() + ' ' });
  const recordPath = path.join(config.tasksDir, queued.id + '.json');
  assert.equal(queued.podcastStyle, style);
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).podcastStyle, style);
  await waitFor(() => manager.getTask(queued.id), task => task.status === 'failed');
  const checkpoint = fs.readFileSync(recordPath, 'utf8');
  const restarted = createTaskManager(config);
  const credentials = { apiKey, baseURL: payload.baseURL };
  for (const podcastStyle of [null, 123, 'unknown']) {
    assert.throws(() => restarted.resumeTask(queued.id, { ...credentials, podcastStyle }), invalid);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), checkpoint);
  }
  assert.deepEqual(styles, [style]);

  assert.equal(restarted.resumeTask(queued.id, credentials).podcastStyle, style);
  const done = await waitFor(() => restarted.getTask(queued.id), task => task.status === 'completed');
  assert.deepEqual(styles, [style, style]);
  const meta = JSON.parse(fs.readFileSync(path.join(config.podcastsDir, queued.id, 'meta.json')));
  for (const artifact of [done, done.podcast, JSON.parse(fs.readFileSync(recordPath)), meta, restarted.listPodcasts().items[0]]) {
    assert.equal(artifact.podcastStyle, style);
  }
});

test('来源类型同步校验，留在任务和成品顶层，历史列表返回公开 TTS 摘要', async t => {
  const text = '这段发生在 1972 年。';
  const spoken = [];
  const provider = {
    id: 'offline', model: 'voice-test',
    synthesizeToFile({ outputPath, text }) {
      spoken.push(text);
      const audio = makeMp3(2);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.048 };
    },
  };
  const { manager, config, root } = setup(t, {
    ttsProvider: provider,
    extractor: () => ({ title: '离线文章', content: '离线正文' }),
    scriptGenerator: () => ({ ...script, dialogue: [{ speaker: '阿泽', text }] }),
  });
  const invalid = { statusCode: 400, message: '来源类型仅支持 url、text 或 image' };
  for (const sourceType of [null, 123, 'other', {}, ['image'], '', ' \n ']) {
    assert.throws(() => manager.createTask({ ...payload, sourceType }), invalid);
  }
  assert.equal(fs.existsSync(config.tasksDir), false);
  assert.equal(fs.existsSync(config.podcastsDir), false);

  for (const [input, expectedType] of [
    [{}, 'text'], [{ sourceType: undefined }, 'text'],
    [{ mode: 'url', url: 'https://article.example/story' }, 'url'],
    [{ mode: 'url', url: 'https://article.example/story', sourceType: undefined }, 'url'],
    [{ sourceType: 'url' }, 'url'], [{ sourceType: 'image' }, 'image'], [{ sourceType: 'text' }, 'text'],
  ]) {
    const task = manager.createTask({ ...payload, tts: { provider: provider.id }, ...input });
    assert.equal(task.sourceType, expectedType);
    assert.equal(Object.hasOwn(task.input, 'sourceType'), false);
    const done = await waitFor(() => manager.getTask(task.id), record => record.status === 'completed');
    const meta = JSON.parse(fs.readFileSync(path.join(config.podcastsDir, task.id, 'meta.json')));
    const record = JSON.parse(fs.readFileSync(path.join(config.tasksDir, task.id + '.json')));
    const detail = manager.getPodcast(task.id);
    const item = manager.listPodcasts().items.find(item => item.id === task.id);
    const reopened = createTaskManager(config).getTask(task.id);
    for (const entry of [done, done.podcast, detail, item, meta, record, reopened]) {
      assert.equal(entry.sourceType, expectedType);
      assert.equal(entry.ttsProvider, provider.id);
      assert.equal(entry.ttsModel, provider.model);
      assert.deepEqual(entry.voiceMapping, DEFAULT_VOICES);
      noLeaks(entry, root);
    }
    assert.equal(record.script.dialogue[0].text, text);
    assert.equal(meta.sentences[0].text, text);
    assert.equal(detail.sentences[0].text, text);
  }
  assert.deepEqual(spoken, ['这段发生在 一九七二年。']);
});

test('续跑显式切换节目风格时重生成剧本并清除旧剧本的断点音频', async t => {
  const styles = [];
  const { manager, config } = setup(t, {
    ttsProvider: await localProvider(t),
    scriptGenerator({ podcastStyle }) {
      styles.push(podcastStyle);
      return { ...script, podcastTitle: podcastStyle };
    },
    ttsSynthesizer(lines, dir, mapping, options) {
      const firstSegment = path.join(dir, 'sentence_000.mp3');
      if (styles.length === 1) {
        fs.writeFileSync(firstSegment, makeMp3(1));
        throw new Error('模拟语音阶段中断');
      }
      assert.equal(fs.existsSync(firstSegment), false);
      return synthesizeDialogueScript(lines, dir, mapping, options);
    },
  });
  const queued = manager.createTask(payload);
  assert.equal(queued.podcastStyle, 'deep_dive');
  const failed = await waitFor(() => manager.getTask(queued.id), task => task.status === 'failed');
  assert.equal(failed.hasScript, true);
  const reopened = createTaskManager(config);
  const resumed = reopened.resumeTask(queued.id, { apiKey, baseURL: payload.baseURL, podcastStyle: 'dialogue' });
  assert.equal(resumed.podcastStyle, 'dialogue');
  assert.equal(resumed.hasScript, false);
  const done = await waitFor(() => reopened.getTask(queued.id), task => task.status === 'completed');
  assert.deepEqual(styles, ['deep_dive', 'dialogue']);
  assert.equal(done.podcast.podcastTitle, 'dialogue');
  assert.equal(done.podcast.podcastStyle, 'dialogue');
});

test('带剧本的旧任务切换到深度主讲需要 Key，校验通过后重生成并清除旧断点音频', async t => {
  configureLlm(t);
  const provider = await localProvider(t);
  const scriptGenerator = t.mock.fn(({ podcastStyle }) => ({ ...script, podcastTitle: podcastStyle }));
  const { manager, config } = setup(t, { ttsProvider: provider, scriptGenerator });
  const id = 'legacy-with-script';
  const record = {
    id, status: 'failed', stage: 'tts', progress: {}, input: { mode: 'text', title: '原文标题' },
    sourceContent: '旧任务原文', script, ttsProvider: provider.id, ttsModel: provider.model, voiceMapping: DEFAULT_VOICES,
  };
  const recordPath = path.join(config.tasksDir, id + '.json');
  const audioDir = path.join(config.podcastsDir, id);
  const checkpoint = path.join(audioDir, 'sentence_000.mp3');
  fs.mkdirSync(config.tasksDir);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record));
  fs.writeFileSync(checkpoint, makeMp3(1));

  assert.equal(manager.getTask(id).podcastStyle, 'dialogue');
  assert.throws(() => manager.resumeTask(id, { podcastStyle: 'deep_dive' }), { statusCode: 400, message: /API Key/ });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath)), record);
  assert.deepEqual(fs.readFileSync(checkpoint), makeMp3(1));

  const resumed = manager.resumeTask(id, { apiKey, baseURL: payload.baseURL, podcastStyle: 'deep_dive' });
  assert.equal(resumed.podcastStyle, 'deep_dive');
  assert.equal(resumed.hasScript, false);
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).script, null);
  assert.equal(fs.existsSync(checkpoint), false);
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  assert.equal(done.podcast.podcastTitle, 'deep_dive');
  assert.equal(done.podcast.podcastStyle, 'deep_dive');
  assert.equal(scriptGenerator.mock.callCount(), 1);
  assert.equal(scriptGenerator.mock.calls[0].arguments[0].podcastStyle, 'deep_dive');
});

test('尚未生成剧本的旧任务续跑时默认深度主讲', async t => {
  configureLlm(t);
  const scriptGenerator = t.mock.fn(() => script);
  const { manager, config } = setup(t, { ttsProvider: await localProvider(t), scriptGenerator });
  const id = 'legacy-without-script';
  const record = { id, status: 'failed', stage: 'script', progress: {}, input: { mode: 'text' }, sourceContent: '原文' };
  fs.mkdirSync(config.tasksDir);
  fs.writeFileSync(path.join(config.tasksDir, id + '.json'), JSON.stringify(record));
  assert.equal(manager.getTask(id).podcastStyle, 'deep_dive');
  manager.resumeTask(id, { apiKey, baseURL: payload.baseURL });
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  assert.equal(done.podcast.podcastStyle, 'deep_dive');
  assert.equal(scriptGenerator.mock.callCount(), 1);
  assert.equal(scriptGenerator.mock.calls[0].arguments[0].podcastStyle, 'deep_dive');
});

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
  assert.throws(() => manager.createTask({ ...article, apiKey }), { statusCode: 400, message: /同时填写对应的接口地址/ });
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

test('任务创建及续跑在首次写盘或改写检查点前拒绝无效模型配置', async t => {
  const configuredBase = 'http://127.0.0.1:7945/team';
  configureLlm(t, { LLM_BASE_URL: configuredBase + '/v1/', DEEPSEEK_API_KEY: 'configured-task-key' });
  let reply = response({ error: 'mock failure' }, 500);
  const llmRequest = t.mock.fn(async (url, options) => {
    assert.equal(url, configuredBase + '/v1/chat/completions');
    assert.equal(options.allowPrivateEndpoint, true);
    return reply;
  });
  const ttsSynthesizer = t.mock.fn(async () => { throw new Error('保留已完成的剧本'); });
  const { manager, config } = setup(t, { scriptGenerator: undefined, llmRequest, ttsSynthesizer });
  const rejected = [
    { baseURL: undefined }, { baseURL: configuredBase + '#' }, { baseURL: configuredBase + '/untrusted' },
    { baseURL: 'http://[::1]' }, { model: 123 }, { model: {} }, { model: 'a/../model' }, { model: 'C:/private/model' },
  ];
  for (const fields of rejected) {
    assert.throws(() => manager.createTask({ ...payload, ...fields }), { statusCode: 400 });
  }
  assert.equal(fs.existsSync(config.tasksDir), false);
  assert.equal(llmRequest.mock.callCount(), 0);
  const { id } = manager.createTask({ ...payload, baseURL: configuredBase });
  const file = path.join(config.tasksDir, id + '.json');
  for (const hasScript of [false, true]) {
    const checkpoint = await waitFor(() => manager.getTask(id), task => task.status === 'failed' && task.hasScript === hasScript);
    const before = fs.readFileSync(file, 'utf8');
    const callsBefore = llmRequest.mock.callCount();
    for (const fields of rejected) {
      assert.throws(() => manager.resumeTask(id, { apiKey, baseURL: configuredBase, ...fields }), { statusCode: 400 });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(manager.getTask(id), checkpoint);
    assert.equal(llmRequest.mock.callCount(), callsBefore);
    if (!hasScript) {
      reply = response(completion(JSON.stringify(script)));
      manager.resumeTask(id, { apiKey, baseURL: configuredBase });
    }
  }
  assert.equal(llmRequest.mock.callCount(), 2);
  assert.equal(ttsSynthesizer.mock.callCount(), 1);
  process.env.LLM_BASE_URL = 'file:///tmp/mock';
  assert.equal(manager.resumeTask(id).status, 'running');
  await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  assert.equal(llmRequest.mock.callCount(), 2);
  assert.equal(ttsSynthesizer.mock.callCount(), 2);
});

test('默认任务生成器拦截解析到私网的模型域名，且不进入合成', async t => {
  configureLlm(t);
  const lookup = t.mock.fn(async (host, options) => {
    assert.equal(host, 'private.example');
    assert.equal(options.all, true);
    return [{ address: '127.0.0.1', family: 4 }];
  });
  const ttsSynthesizer = t.mock.fn();
  const { manager, root } = setup(t, { scriptGenerator: undefined, lookup, ttsSynthesizer });
  const { id } = manager.createTask(payload);
  const failed = await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  assert.equal(failed.error.stage, 'script');
  assert.match(failed.error.message, /受限网络/);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(ttsSynthesizer.mock.callCount(), 0);
  noLeaks(failed, root);
});

test('剧本回显规范化后的自定义地址时在保存剧本前拒绝', async t => {
  configureLlm(t);
  const baseURL = 'https://mock-script.example/team/v1/';
  const echoed = baseURL.slice(0, -1);
  const llmRequest = async () => response(completion(JSON.stringify({ ...script, summary: '回显 ' + echoed })));
  const ttsSynthesizer = t.mock.fn();
  const { manager, config } = setup(t, { scriptGenerator: undefined, llmRequest, ttsSynthesizer });
  const { id } = manager.createTask({ ...payload, baseURL });
  const failed = await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  assert.equal(failed.hasScript, false);
  assert.match(failed.error.message, /模型返回内容包含敏感凭据/);
  assert.equal(ttsSynthesizer.mock.callCount(), 0);
  assert.ok(!fs.readFileSync(path.join(config.tasksDir, id + '.json'), 'utf8').includes(echoed));
});

test('创建时拦截含本次 Key 的标题、正文或文章链接，首次落盘前返回 400', t => {
  const unexpectedCall = () => assert.fail('输入应在任务启动前被拒绝');
  const { manager, root } = setup(t, { extractor: unexpectedCall, scriptGenerator: unexpectedCall });
  for (const input of [
    { ...payload, title: '标题' + apiKey },
    { ...payload, content: '正文' + apiKey },
    { ...payload, mode: 'url', url: 'https://article.example/' + apiKey },
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
    const task = manager.createTask({ ...payload, mode: 'url', url: 'https://article.example/story' });
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
    restarted.resumeTask(id, { apiKey, baseURL: payload.baseURL });
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
  assert.equal(recovered.podcastStyle, 'dialogue');
  assert.equal(recovered.error.stage, 'tts');
  assert.equal(recovered.error.retryable, true);
  for (const [id, bytes] of Object.entries(damaged)) {
    assert.throws(() => restarted.getTask(id));
    assert.equal(fs.readFileSync(file(id), 'utf8'), bytes);
  }
  restarted.resumeTask(valid.id);
  const done = await waitFor(() => restarted.getTask(valid.id), task => task.status === 'completed');
  assert.equal(done.podcast.podcastStyle, 'dialogue');
  assert.equal(done.podcast.sentences.length, script.dialogue.length);
});

test('历史断点省略风格时无须 Key 即可用旧对谈剧本和默认音色续跑', async t => {
  configureLlm(t);
  const voices = [];
  const scriptGenerator = t.mock.fn(() => assert.fail('应复用旧剧本'));
  const { config, manager } = setup(t, {
    scriptGenerator,
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
  const resumed = manager.resumeTask(record.id);
  assert.equal(resumed.podcastStyle, 'dialogue');
  assert.equal(resumed.hasScript, true);
  const done = await waitFor(() => manager.getTask(record.id), task => task.status === 'completed');
  assert.equal(done.podcast.podcastStyle, 'dialogue');
  assert.equal(scriptGenerator.mock.callCount(), 0);
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

test('成功的模型回复若回显本次 Key 会被拦截，服务地址脱敏后继续生成', async t => {
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
  assert.equal(done.podcast.summary, '本集介绍 ***');
});

test('剧本存盘与合成前脱敏本地路径和凭据格式，任务及成品各出口使用脱敏内容', async t => {
  configureLlm(t);
  const details = [
    String.raw`/Users/private/secret C:\private\file.txt path:C:/private/file.txt Bearer private-fixture-value`,
    String.raw`文稿保存在/Users/private/secret 文稿保存在C:/private/a 文稿保存在C:\private\a`,
    '（/Users/private/secret） 【C:/private/a】 访问https://example.com/a/b vendor/model:fast',
  ].join(' ');
  const safeDetails = [
    '*** *** path:*** Bearer ***', '文稿保存在*** 文稿保存在*** 文稿保存在***',
    '（***） 【***】 访问https://example.com/a/b vendor/model:fast',
  ].join(' ');
  const reply = {
    podcastTitle: `标题 ${details}`, summary: `概要 ${details}`,
    dialogue: [{ speaker: '阿泽', text: `开场 ${details} 收尾`, emotion: `认真 ${details}` }],
  };
  const ttsInputs = [];
  const { manager, config } = setup(t, {
    ttsProvider: await localProvider(t), scriptGenerator: () => reply,
    ttsSynthesizer(lines, ...args) {
      ttsInputs.push(...lines);
      return synthesizeDialogueScript(lines, ...args);
    },
  });
  const { id } = manager.createTask({ ...payload, tts: { provider: 'edge' } });
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  const stored = JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(config.podcastsDir, id, 'meta.json')));
  const detail = manager.getPodcast(id);
  const listed = manager.listPodcasts().items[0];
  for (const item of [done, stored, stored.script, meta, done.podcast, detail, listed]) {
    assert.equal(item.podcastTitle, `标题 ${safeDetails}`);
    assert.equal(item.summary, `概要 ${safeDetails}`);
    assert.doesNotMatch(JSON.stringify(item), /private/);
  }
  assert.equal(ttsInputs.length, 1);
  for (const [line] of [ttsInputs, stored.script.dialogue, meta.sentences, done.podcast.sentences, detail.sentences]) {
    assert.equal(line.text, `开场 ${safeDetails} 收尾`);
    assert.equal(line.emotion, `认真 ${safeDetails}`);
  }
});

test('剧本含空白台词时整份拦截，保存的任务和 TTS 均无无效剧本', async t => {
  configureLlm(t);
  const ttsSynthesizer = t.mock.fn();
  const { manager, config } = setup(t, {
    ttsSynthesizer,
    scriptGenerator: () => ({ ...script, dialogue: [...dialogue, { speaker: '阿泽', text: ' \n ' }] }),
  });
  const { id } = manager.createTask({ ...payload, tts: { provider: 'edge' } });
  const failed = await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  assert.equal(failed.error.stage, 'script');
  assert.equal(failed.error.message, '模型返回内容包含敏感路径或凭据，已拦截并中止保存');
  assert.equal(failed.hasScript, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json'))).script, null);
  assert.equal(ttsSynthesizer.mock.callCount(), 0);
});

test('历史任务与成品在读取时脱敏，归档文件保持原样', t => {
  const { manager, config } = setup(t);
  const id = 'legacy-sensitive';
  const legacyScript = {
    podcastTitle: '标题 /Users/private/secret', summary: '概要 C:\\private\\file.txt',
    dialogue: [{ speaker: '阿泽', text: '台词 path:C:/private/file.txt', emotion: 'Bearer private-fixture-value' }],
  };
  const taskFile = path.join(config.tasksDir, id + '.json');
  const podcastDir = path.join(config.podcastsDir, id);
  const metaFile = path.join(podcastDir, 'meta.json');
  const taskBytes = JSON.stringify({ id, status: 'completed', stage: 'done', podcastId: id,
    input: { mode: 'text' }, progress: {}, script: legacyScript });
  const metaBytes = JSON.stringify({ podcastTitle: legacyScript.podcastTitle, summary: legacyScript.summary, sentences: legacyScript.dialogue });
  fs.mkdirSync(config.tasksDir);
  fs.mkdirSync(podcastDir, { recursive: true });
  fs.writeFileSync(taskFile, taskBytes);
  fs.writeFileSync(metaFile, metaBytes);
  fs.writeFileSync(path.join(podcastDir, 'full_podcast.mp3'), makeMp3(1));

  const dto = manager.getTask(id);
  const detail = manager.getPodcast(id);
  const listed = manager.listPodcasts().items[0];
  for (const item of [dto, dto.podcast, detail, listed]) {
    assert.equal(item.podcastStyle, 'dialogue');
    assert.equal(item.podcastTitle, '标题 ***');
    assert.equal(item.summary, '概要 ***');
    assert.doesNotMatch(JSON.stringify(item), /private/);
  }
  assert.equal(detail.sentences[0].text, '台词 path:***');
  assert.equal(detail.sentences[0].emotion, 'Bearer ***');
  assert.equal(fs.readFileSync(taskFile, 'utf8'), taskBytes);
  assert.equal(fs.readFileSync(metaFile, 'utf8'), metaBytes);
});

test('历史剧本的台词或情绪脱敏后续跑会重做旧断点音频', async t => {
  configureLlm(t);
  for (const { status, text, emotion, safeText, safeEmotion } of [
    { status: 'cancelled', text: '文稿保存在/Users/private/secret', safeText: '文稿保存在***' },
    { status: 'running', text: '正文', emotion: '【C:/private/a】', safeText: '正文', safeEmotion: '【***】' },
  ]) {
    await t.test(status === 'running' ? '启动恢复后情绪已脱敏的任务' : '已暂停且台词待脱敏的任务', async child => {
      const provider = await localProvider(child);
      const ttsSynthesizer = child.mock.fn(synthesizeDialogueScript);
      const scriptGenerator = child.mock.fn(() => assert.fail('应复用已有剧本'));
      const { config } = setup(child, { ttsProvider: provider, ttsSynthesizer, scriptGenerator });
      const id = 'legacy-stale-audio';
      const record = {
        id, status, stage: 'tts', progress: {}, input: { mode: 'text' },
        script: { ...script, dialogue: [{ speaker: '阿泽', text, emotion }] },
        ttsProvider: provider.id, ttsModel: provider.model, voiceMapping: DEFAULT_VOICES,
      };
      const taskFile = path.join(config.tasksDir, id + '.json');
      const workDir = path.join(config.podcastsDir, id);
      const segment = path.join(workDir, 'sentence_000.mp3');
      const staleAudio = makeMp3(1);
      fs.mkdirSync(config.tasksDir);
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(taskFile, JSON.stringify(record));
      fs.writeFileSync(segment, staleAudio);

      const manager = createTaskManager(config);
      const beforeRead = fs.readFileSync(taskFile, 'utf8');
      assert.equal(manager.getTask(id).podcastStyle, 'dialogue');
      assert.equal(fs.readFileSync(taskFile, 'utf8'), beforeRead);
      assert.deepEqual(fs.readFileSync(segment), staleAudio);
      if (status === 'running') assert.equal(JSON.parse(beforeRead).clearPending, true);

      manager.resumeTask(id);
      assert.equal(fs.existsSync(segment), false);
      const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
      assert.equal(ttsSynthesizer.mock.callCount(), 1);
      const [lines] = ttsSynthesizer.mock.calls[0].arguments;
      assert.equal(lines[0].text, safeText);
      assert.equal(lines[0].emotion, safeEmotion);
      assert.equal(scriptGenerator.mock.callCount(), 0);
      assert.equal(done.podcast.sentences[0].text, safeText);
      assert.deepEqual(fs.readFileSync(segment), makeMp3(10));
      assert.deepEqual(fs.readFileSync(path.join(workDir, 'full_podcast.mp3')), makeMp3(10));
    });
  }
});

test('历史倒序、残缺目录原样保留、旧元数据投影与安全 ID', t => {
  const { manager, config, root } = setup(t);
  const dates = { old: '2024-01-01', latest: '2025-01-01' };
  for (const id of ['old', 'latest', 'no-meta', 'no-audio', 'empty', 'corrupt']) {
    const dir = path.join(config.podcastsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    if (id !== 'no-audio') fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), id === 'empty' ? '' : 'audio');
    const meta = { createAt: dates[id], filePath: root, sentences: [{ fileName: 'line.mp3', filePath: root }],
      ...(id === 'latest' && { podcastStyle: 'obsolete', sourceType: 'obsolete' }) };
    if (id !== 'no-meta') fs.writeFileSync(path.join(dir, 'meta.json'), id === 'corrupt' ? '{' : JSON.stringify(meta));
  }
  assert.deepEqual(manager.listPodcasts().items.map(({ id, sourceType }) => [id, sourceType]), [['latest', null], ['old', null]]);
  for (const id of ['latest', 'old']) {
    const detail = manager.getPodcast(id);
    assert.equal(detail.podcastStyle, 'dialogue');
    assert.equal(detail.sourceType, null);
  }
  noLeaks(manager.getPodcast('latest'), root);
  assert.equal(fs.readdirSync(config.podcastsDir).length, 6);
  assert.throws(() => manager.getPodcast('../old'), { statusCode: 400 });
  assert.throws(() => manager.getPodcast('empty'), { statusCode: 404 });
});

test('历史 TTS 摘要过滤畸形字段、非公开角色、凭据和自定义路径', t => {
  const { manager, config, root } = setup(t);
  const credential = 'offline-server-tts-app';
  const originalAppId = process.env.VOLCENGINE_TTS_APP_ID;
  process.env.VOLCENGINE_TTS_APP_ID = credential;
  t.after(() => {
    if (originalAppId === undefined) delete process.env.VOLCENGINE_TTS_APP_ID;
    else process.env.VOLCENGINE_TTS_APP_ID = originalAppId;
  });
  const output = path.join(config.podcastsDir, 'legacy');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'full_podcast.mp3'), makeMp3(2));
  fs.writeFileSync(path.join(output, 'meta.json'), JSON.stringify({
    ttsProvider: { id: 'minimax', apiKey }, ttsModel: 'https://private-tts.example/path',
    voiceMapping: { 阿泽: 'S_custom', 小晓: credential, endpoint: 'https://private-tts.example/path', accessKey: 'hidden' },
  }));
  for (const entry of [manager.getPodcast('legacy'), manager.listPodcasts().items[0]]) {
    assert.equal(Object.hasOwn(entry, 'ttsProvider'), false);
    assert.equal(Object.hasOwn(entry, 'ttsModel'), false);
    assert.deepEqual(entry.voiceMapping, { 阿泽: 'S_custom' });
    noLeaks(entry, root);
  }
});

test('历史列表、详情、字幕及任务 DTO 统一遮盖旧记录的顶层与嵌套凭据', t => {
  const { manager, config } = setup(t);
  const id = 'legacy-credentials';
  const dir = path.join(config.podcastsDir, id);
  const secretDate = '2024-06-10T09:00:00.000Z';
  const safeDate = '2026-11-25T03:00:00.000Z';
  const credentials = {
    apiKey: 'legacy-top-api-key-value', appId: 'legacy-top-app-id-value', accessKey: secretDate,
    llm: { apiKey: 'legacy-nested-llm-key-value', baseURL: 'https://historic-llm.example/private' },
    tts: { apiKey: 'legacy-nested-tts-key-value', accessKey: 'legacy-nested-access-value',
      appId: 'legacy-nested-app-id-value', endpoint: 'https://historic-tts.example/private' },
  };
  const secrets = [credentials.apiKey, credentials.appId, secretDate, ...Object.values(credentials.llm), ...Object.values(credentials.tts)];
  const echoed = secrets.join(' ');
  const masked = secrets.map(() => '***').join(' ');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(config.tasksDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), makeMp3(2));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...credentials,
    podcastTitle: echoed, summary: echoed, ttsProvider: 'minimax', ttsModel: credentials.apiKey,
    createAt: secretDate, totalDuration: credentials.tts.apiKey, sentenceGap: { hidden: secretDate },
    measurement: credentials.appId, sourceTruncated: credentials.apiKey,
    voiceMapping: { 阿泽: credentials.tts.appId, 小晓: 'safe_voice' },
    sentences: [
      { index: credentials.apiKey, speaker: credentials.appId, text: echoed, emotion: credentials.tts.accessKey,
        startTime: secretDate, endTime: { hidden: credentials.tts.apiKey }, duration: credentials.tts.appId,
        fileName: credentials.tts.apiKey + '.mp3' },
      { index: 1, speaker: '小晓', text: '下一句', startTime: 0, endTime: 1.5, duration: 1.5 },
    ],
  }));
  fs.writeFileSync(path.join(config.tasksDir, id + '.json'), JSON.stringify({ ...credentials,
    id, status: 'failed', stage: 'tts', ttsProvider: 'minimax', ttsModel: credentials.tts.apiKey,
    voiceMapping: { 阿泽: credentials.appId, 小晓: 'safe_voice', private: credentials.apiKey },
    input: { mode: 'url', url: `https://article.example/story?ref=${credentials.tts.apiKey}`, title: echoed,
      contentLength: credentials.appId, sourceTruncated: true, extra: credentials.apiKey },
    progress: { stageIndex: 3, totalStages: credentials.appId, completedSegments: 1,
      totalSegments: { hidden: credentials.apiKey }, cachedSegments: credentials.tts.apiKey,
      stageLabel: echoed, message: echoed, currentSpeaker: credentials.tts.accessKey,
      stageStartedAt: secretDate, extra: credentials.apiKey },
    error: { stage: credentials.appId, message: echoed, retryable: true,
      failedSegmentIndex: credentials.tts.apiKey, extra: credentials.apiKey },
    createdAt: secretDate, updatedAt: safeDate,
    script: { ...script, podcastTitle: echoed, summary: echoed },
  }));

  const detail = manager.getPodcast(id);
  const item = manager.listPodcasts().items[0];
  const task = manager.getTask(id);
  for (const value of [detail, item, task]) {
    assert.equal(value.podcastTitle, masked);
    assert.equal(value.summary, masked);
    for (const secret of secrets) assert.ok(!JSON.stringify(value).includes(secret));
  }
  for (const value of [detail, item, task]) {
    assert.equal(value.ttsProvider, 'minimax');
    assert.equal(Object.hasOwn(value, 'ttsModel'), false);
    assert.deepEqual(value.voiceMapping, { 小晓: 'safe_voice' });
  }
  for (const value of [detail, item]) {
    assert.equal(value.createAt, null);
    assert.equal(value.totalDuration, undefined);
  }
  assert.equal(detail.sourceTruncated, true);
  assert.equal(detail.sentenceGap, undefined);
  assert.equal(detail.measurement, undefined);
  const [sentence, normal] = detail.sentences;
  assert.equal(sentence.text, masked);
  assert.equal(sentence.speaker, '***');
  assert.equal(sentence.emotion, '***');
  assert.equal(Object.hasOwn(sentence, 'audioUrl'), false);
  for (const key of ['index', 'startTime', 'endTime', 'duration']) assert.equal(sentence[key], undefined);
  assert.deepEqual(normal, { index: 1, speaker: '小晓', text: '下一句', emotion: undefined, startTime: 0, endTime: 1.5, duration: 1.5 });
  assert.deepEqual(task.input, { mode: 'url', url: 'https://article.example/story?ref=***',
    title: masked, contentLength: undefined, sourceTruncated: true });
  assert.deepEqual(task.progress, { stageIndex: 3, totalStages: undefined, completedSegments: 1,
    totalSegments: undefined, cachedSegments: undefined, stageLabel: masked, message: masked, currentSpeaker: '***', stageStartedAt: null });
  assert.deepEqual(task.error, { stage: undefined, message: masked, retryable: true, failedSegmentIndex: null });
  assert.equal(task.createdAt, null);
  assert.equal(task.updatedAt, safeDate);
});

test('任务 DTO 遮盖文章签名参数，重启后抓取仍使用原文章链接', async t => {
  const url = 'https://article.example/story?token=offline-article-signature';
  const urls = [];
  const { manager, config } = setup(t, { extractor(input) {
    urls.push(input.url);
    throw new Error('模拟抓取中断');
  } });
  const task = manager.createTask({ ...payload, mode: 'url', url });
  assert.equal(task.input.url, 'https://article.example/story?token=***');
  await waitFor(() => manager.getTask(task.id), current => current.status === 'failed');
  const reopened = createTaskManager(config);
  assert.equal(reopened.resumeTask(task.id, { apiKey, baseURL: payload.baseURL }).input.url, task.input.url);
  await waitFor(() => reopened.getTask(task.id), current => current.status === 'failed');
  assert.deepEqual(urls, [url, url]);
});

test('删除跳过播客目录和任务文件位置的符号链接，只清除真实目标', t => {
  const { manager, config } = setup(t);
  const { podcastsDir, tasksDir, cacheDir } = config;
  const sharedRoot = createTaskManager({ ...config, podcastsDir: path.dirname(cacheDir) });
  const sibling = path.join(podcastsDir, 'keep');
  const siblingTask = path.join(tasksDir, 'keep.json');
  const directoryLink = path.join(podcastsDir, 'alias');
  const taskLink = path.join(tasksDir, 'alias.json');
  const cacheAudio = path.join(cacheDir, 'retained.mp3');
  const audio = makeMp3(2);
  for (const dir of [sibling, tasksDir, cacheDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'full_podcast.mp3'), audio);
  fs.writeFileSync(siblingTask, '{}');
  fs.writeFileSync(cacheAudio, audio);
  fs.symlinkSync(sibling, directoryLink, 'dir');
  fs.symlinkSync(siblingTask, taskLink, 'file');
  assert.throws(() => manager.deletePodcast('alias'), { statusCode: 404 });
  assert.ok(fs.lstatSync(directoryLink).isSymbolicLink());
  assert.ok(fs.lstatSync(taskLink).isSymbolicLink());

  const directoryOnly = path.join(podcastsDir, 'directory-only');
  const taskOnly = path.join(tasksDir, 'task-only.json');
  fs.mkdirSync(directoryOnly);
  fs.writeFileSync(path.join(directoryOnly, 'full_podcast.mp3'), audio);
  fs.writeFileSync(path.join(directoryOnly, 'meta.json'), '{}');
  fs.symlinkSync(siblingTask, path.join(tasksDir, 'directory-only.json'), 'file');
  fs.writeFileSync(taskOnly, JSON.stringify({ id: 'task-only', status: 'failed', stage: 'script',
    input: { mode: 'text' }, progress: {}, sourceContent: '离线正文' }));
  fs.symlinkSync(sibling, path.join(podcastsDir, 'task-only'), 'dir');
  assert.deepEqual(manager.deletePodcast('directory-only'), { id: 'directory-only', deleted: true });
  assert.deepEqual(manager.deletePodcast('task-only'), { id: 'task-only', deleted: true });
  assert.equal(fs.existsSync(directoryOnly), false);
  assert.equal(fs.existsSync(taskOnly), false);
  assert.ok(fs.lstatSync(path.join(tasksDir, 'directory-only.json')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(podcastsDir, 'task-only')).isSymbolicLink());
  assert.deepEqual(fs.readFileSync(path.join(sibling, 'full_podcast.mp3')), audio);
  assert.equal(fs.readFileSync(siblingTask, 'utf8'), '{}');

  assert.throws(() => sharedRoot.deletePodcast(path.basename(cacheDir)), { statusCode: 404 });
  assert.throws(() => sharedRoot.deletePodcast(path.basename(cacheDir).toUpperCase()), { statusCode: 404 });
  assert.deepEqual(fs.readFileSync(cacheAudio), audio);
});

test('删除拒绝普通目录、不完整成品和不匹配的任务记录', t => {
  const { manager, config } = setup(t);
  const backup = path.join(config.podcastsDir, 'import-backup');
  const invalidTask = path.join(config.tasksDir, 'import-backup.json');
  const marker = path.join(backup, 'original.txt');
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(config.tasksDir, { recursive: true });
  fs.writeFileSync(marker, '原备份');
  for (const record of [{}, { id: 'different-id', status: 'failed', stage: 'script', input: { mode: 'text' },
    progress: {}, sourceContent: '离线正文' }]) {
    const contents = JSON.stringify(record);
    fs.writeFileSync(invalidTask, contents);
    assert.throws(() => manager.deletePodcast('import-backup'), { statusCode: 404 });
    assert.equal(fs.readFileSync(invalidTask, 'utf8'), contents);
  }
  fs.writeFileSync(path.join(backup, 'full_podcast.mp3'), makeMp3(2));
  const metaFile = path.join(backup, 'meta.json');
  for (const invalidMeta of ['null', '[]', '{', '{"sentences":{}}', '{"sentences":[null]}', '{"sentences":[[]]}']) {
    fs.writeFileSync(metaFile, invalidMeta);
    assert.throws(() => manager.getPodcast('import-backup'), { statusCode: 404 });
    assert.deepEqual(manager.listPodcasts().items, []);
    assert.throws(() => manager.deletePodcast('import-backup'), { statusCode: 404 });
    assert.equal(fs.readFileSync(metaFile, 'utf8'), invalidMeta);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), '原备份');
});

test('即使成品根目录配置在缓存或任务树下，删除也保留对应子树', t => {
  const { config } = setup(t);
  for (const parent of [config.cacheDir, config.tasksDir]) {
    const podcastsDir = path.join(parent, 'podcasts');
    const dir = path.join(podcastsDir, 'overlap');
    const audio = path.join(dir, 'full_podcast.mp3');
    const meta = path.join(dir, 'meta.json');
    const retained = path.join(dir, 'retain.mp3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audio, makeMp3(2));
    fs.writeFileSync(meta, '{}');
    fs.writeFileSync(retained, makeMp3(3));
    const manager = createTaskManager({ ...config, podcastsDir });
    assert.equal(manager.getPodcast('overlap').id, 'overlap');
    assert.throws(() => manager.deletePodcast('overlap'), { statusCode: 404 });
    assert.deepEqual(fs.readFileSync(audio), makeMp3(2));
    assert.deepEqual(fs.readFileSync(retained), makeMp3(3));
    assert.equal(fs.readFileSync(meta, 'utf8'), '{}');
  }
});

test('活动任务按历史 podcastId 及同一目录的别名锁定成品', async t => {
  const { manager, config } = setup(t, { scriptGenerator({ signal }) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const id = 'active-task';
  const podcastId = 'legacy-output';
  const dir = path.join(config.podcastsDir, podcastId);
  const record = { id, podcastId, status: 'failed', stage: 'script', input: { mode: 'text' }, progress: {}, sourceContent: '离线正文' };
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(config.tasksDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), makeMp3(2));
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
  fs.writeFileSync(path.join(config.tasksDir, id + '.json'), JSON.stringify(record));
  assert.equal(manager.resumeTask(id, payload).status, 'running');
  try {
    assert.throws(() => manager.deletePodcast(podcastId), { statusCode: 409 });
    const upper = podcastId.toUpperCase();
    const aliases = fs.existsSync(path.join(config.podcastsDir, upper));
    assert.throws(() => manager.deletePodcast(upper), { statusCode: aliases ? 409 : 404 });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'full_podcast.mp3')), makeMp3(2));
  } finally {
    manager.cancelTask(id);
    await new Promise(resolve => setImmediate(resolve));
  }
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
  assert.equal(manager.resumeTask(id, { apiKey, baseURL: payload.baseURL }).status, 'running');
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
  const tts = { provider: 'volcengine', appId, accessKey, endpoint, resourceId: 'seed-tts-1.0-concurr', voiceMapping: { 阿泽: 'S_cloned' } };
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
    assert.equal(record.ttsModel, tts.resourceId);
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
    assert.throws(() => manager.resumeTask(id, {
      apiKey, baseURL: payload.baseURL, tts: { provider: 'volcengine', endpoint: 'https://other.example' },
    }), { statusCode: 400 });
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
    ...createMinimaxProvider({ minRequestIntervalMs: 0 }),
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
  const checkpoint = path.join(dir, TTS_CHECKPOINT_FILENAME);
  const status = target => waitFor(() => manager.getTask(id), task => task.status === target);
  await status('failed');
  assert.equal(JSON.parse(fs.readFileSync(checkpoint)).toneVersion, 'tone-v3');
  for (const [change, shouldClear] of [
    [{}, false],
    [{ model: 'speech-02-turbo' }, true],
    [{ voiceMapping: { 小晓: 'S_new_voice' } }, true],
  ]) {
    manager.resumeTask(id, { tts: { ...credentials, ...change } });
    assert.equal(fs.readdirSync(dir).length === 0, shouldClear);
    assert.equal(fs.existsSync(checkpoint), !shouldClear);
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
  assert.equal(fs.existsSync(checkpoint), false);
});

test('新任务默认舒缓，旧任务未记录语速按标准续跑，切换语速才清理片段', async t => {
  const calls = [];
  const provider = { ...getTtsProvider('edge'), synthesizeToFile({ rate, outputPath }) {
    calls.push(rate);
    const audio = makeMp3(2);
    fs.writeFileSync(outputPath, audio);
    return { bytes: audio.length, duration: 0.048 };
  } };
  let canMerge = false;
  const { manager, config } = setup(t, { ttsProvider: provider, audioMerger(...args) {
    if (!canMerge) throw new Error('模拟合并中断');
    return require('../src/services/audioMerger').concatenateAudioFiles(...args);
  } });
  const invalid = { statusCode: 400, message: /语速仅支持/ };
  assert.throws(() => manager.createTask({ ...payload, tts: { speechSpeed: 'fast' } }), invalid);
  const { id, speechSpeed } = manager.createTask(payload);
  assert.equal(speechSpeed, 'relaxed');
  const work = path.join(config.podcastsDir, id);
  const recordPath = path.join(config.tasksDir, id + '.json');
  const readRecord = () => JSON.parse(fs.readFileSync(recordPath));
  const status = target => waitFor(() => manager.getTask(id), task => task.status === target);
  await status('failed');
  assert.equal(readRecord().speechSpeed, 'relaxed');
  assert.deepEqual(calls, Array(3).fill('-8%'));
  assert.throws(() => manager.resumeTask(id, { tts: { speechSpeed: null } }), invalid);
  assert.equal(fs.readdirSync(work).length, 3);

  assert.equal(manager.resumeTask(id, { tts: { speechSpeed: 'standard' } }).speechSpeed, 'standard');
  assert.deepEqual(fs.readdirSync(work), []);
  await status('failed');
  assert.deepEqual(calls, [...Array(3).fill('-8%'), ...Array(3).fill('+0%')]);
  const legacyRecord = readRecord();
  delete legacyRecord.speechSpeed;
  fs.writeFileSync(recordPath, JSON.stringify(legacyRecord));
  assert.equal(manager.getTask(id).speechSpeed, 'standard');
  canMerge = true;
  assert.equal(manager.resumeTask(id).speechSpeed, 'standard');
  assert.equal(fs.readdirSync(work).length, 3);
  const done = await status('completed');
  assert.equal(calls.length, 6);
  assert.equal(done.progress.cachedSegments, 3);
  for (const result of [done, readRecord(), manager.getPodcast(id), manager.listPodcasts().items[0],
    JSON.parse(fs.readFileSync(path.join(work, 'meta.json')))]) {
    assert.equal(result.speechSpeed, 'standard');
  }
});

test('触发限流时实时保存重试进度，恢复合成后完成任务', async t => {
  const { upstreamError } = require('../src/services/providerHttp');
  const messages = [];
  let calls = 0;
  const { manager, config } = setup(t, {
    ttsProvider: {
      id: 'offline', model: 'test',
      synthesizeToFile({ outputPath }) {
        if (++calls === 1) throw upstreamError('限流', true, { rateLimited: true });
        const audio = makeMp3(2);
        fs.writeFileSync(outputPath, audio);
        return { bytes: audio.length, duration: 0.048 };
      },
    },
    ttsSynthesizer(lines, workDir, voices, options) {
      return synthesizeDialogueScript(lines, workDir, voices, {
        ...options, rateLimitBackoffMs: [5],
        onProgress(progress) {
          options.onProgress(progress);
          if (progress.retrying) {
            const file = path.join(config.tasksDir, path.basename(workDir) + '.json');
            messages.push(JSON.parse(fs.readFileSync(file, 'utf8')).progress);
          }
        },
      });
    },
  });
  const { id } = manager.createTask(payload);
  const done = await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  assert.equal(calls, dialogue.length + 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].completedSegments, 0);
  assert.equal(messages[0].message, '第 1/3 句触发频率限制，约 1 秒后自动重试（第 1/6 次）…');
  assert.doesNotMatch(done.progress.message, /频率限制/);
});

async function checkAccountIsolation(t, voice) {
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
  const tts = { provider: 'minimax', endpoint: first.endpoint, apiKey: accountA, voiceMapping: { 阿泽: voice } };
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
}

test('切换端点及私有音色账号均清除断点，缓存按真实音源隔离', t => checkAccountIsolation(t, 'S_custom'));
test('自定义端点的内置同名音色按账号隔离断点与缓存', t => checkAccountIsolation(t, 'male-qn-jingying'));
test('豆包已知音色版本错配在创建与续跑时同步拒绝', async t => {
  const { manager } = setup(t, { scriptGenerator() { throw new Error('待续跑'); } });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), task => task.status === 'failed');
  for (const [model, voice] of [['seed-tts-1.0', 'zh_female_vv_uranus_bigtts'],
    ['seed-tts-2.0', 'zh_male_yangguangqingnian_moon_bigtts'], ['seed-tts-2.0', 'zh_female_cancan_mars_bigtts'],
    ['seed-tts-2.0', 'zh_male_xudong_conversation_wvae_bigtts'], ['seed-tts-2.0-concurr', 'zh_male_xudong_conversation_wvae_bigtts'],
    ['seed-tts-1.0-concurr', 'zh_female_vv_uranus_bigtts']]) {
    const tts = { provider: 'volcengine', apiKey: 'voice-secret', model, voiceMapping: { 小晓: voice } };
    assert.throws(() => manager.createTask({ ...payload, tts }), { statusCode: 400 });
    assert.throws(() => manager.resumeTask(id, { ...payload, tts }), { statusCode: 400 });
  }
});

test('关闭中止当前合成，落盘续跑状态，并在重启时沿用已完成分段', { timeout: 10000 }, async t => {
  const secondStarted = Promise.withResolvers();
  const calls = [];
  let hold = true, interruptedSignal;
  const ttsProvider = {
    id: 'offline', model: 'test', defaultVoices: DEFAULT_VOICES,
    synthesizeToFile({ text, signal, outputPath }) {
      calls.push(text);
      if (hold && text === dialogue[1].text) {
        interruptedSignal = signal;
        secondStarted.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const audio = makeMp3(5);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.12 };
    },
  };
  const { root, config, manager } = setup(t, { ttsProvider });
  const { id } = manager.createTask(payload);
  await secondStarted.promise;
  const work = path.join(config.podcastsDir, id);
  const firstSegment = path.join(work, 'sentence_000.mp3');
  const audio = fs.readFileSync(firstSegment);
  const closing = manager.shutdown();
  assert.equal(manager.shutdown(), closing);
  const unavailable = { statusCode: 503, code: 'SERVER_SHUTTING_DOWN' };
  assert.throws(() => manager.createTask(), unavailable);
  assert.throws(() => manager.resumeTask(id), unavailable);
  assert.equal(interruptedSignal.aborted, true);
  await closing;

  const record = JSON.parse(fs.readFileSync(path.join(config.tasksDir, id + '.json')));
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.error, {
    stage: 'tts', retryable: true, failedSegmentIndex: null,
    message: '服务已关闭，上次生成被中断，可点击「从断点继续生成」恢复',
  });
  assert.equal(record.script.dialogue.length, 3);
  noLeaks(record, root);
  assert.deepEqual(fs.readFileSync(firstSegment), audio);

  hold = false;
  const restarted = createTaskManager(config);
  restarted.resumeTask(id);
  await waitFor(() => restarted.getTask(id), task => task.status === 'completed');
  assert.deepEqual(calls, [dialogue[0].text, dialogue[1].text, dialogue[1].text, dialogue[2].text]);
});

test('关闭等待可超时，明确取消的状态仍保留', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { manager } = setup(t, {
    scriptGenerator() {
      entered.resolve();
      return finish.promise;
    },
  });
  const { id } = manager.createTask(payload);
  await entered.promise;
  assert.equal(manager.cancelTask(id).status, 'cancelled');
  const watchdog = new AbortController();
  try {
    await Promise.race([
      manager.shutdown({ timeoutMs: 30 }),
      delay(1000, undefined, { signal: watchdog.signal }).then(() => assert.fail('关闭未按限时返回')),
    ]);
    assert.equal(manager.getTask(id).status, 'cancelled');
    assert.equal(manager.getTask(id).error, null);
  } finally {
    watchdog.abort();
    finish.resolve(script);
  }
});

for (const fault of ['tts', 'cancel', 'merge', 'publish']) {
  test('微调失败保留原音频、字幕和逐句文件，重启后无需 LLM 续跑：' + fault, async t => {
    configureLlm(t);
    const started = Promise.withResolvers();
    let inject = false;
    let llmCalls = 0;
    const secret = 'opaque-edit-credential';
    const endpoint = 'https://tts-fixture.example/v1';
    const synth = ({ outputPath, text, signal }) => {
      if (inject && text === '改写二') {
        if (fault === 'tts') throw Object.assign(new Error('模拟 502 ' + secret + ' ' + endpoint), { statusCode: 502, retryable: false });
        if (fault === 'cancel') {
          started.resolve();
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
      }
      const audio = makeMp3(text === '改写一' ? 5 : 2);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.1 };
    };
    const { manager, config } = setup(t, {
      scriptGenerator: () => { llmCalls++; return script; },
      ttsProvider: { ...getTtsProvider('edge'), synthesizeToFile: synth },
      audioMerger(...args) {
        if (inject && fault === 'merge') throw new Error('模拟拼接失败');
        return require('../src/services/audioMerger').concatenateAudioFiles(...args);
      },
    });
    const { id } = manager.createTask({ ...payload, podcastStyle: 'debate' });
    await waitFor(() => manager.getTask(id), v => v.status === 'completed');
    const dir = path.join(config.podcastsDir, id);
    const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name))]));
    const before = snapshot();
    if (fault === 'publish') {
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (src, dest) => {
        if (inject && dest === path.join(dir, 'meta.json')) throw new Error('模拟元数据写盘失败');
        return rename(src, dest);
      });
    }
    inject = true;
    const edit = manager.resynthesizePodcast(id, { dialogue: dialogue.slice(0, 2).map((line, i) => ({
      ...line, text: ['改写一', '改写二'][i],
    })), tts: { apiKey: secret, endpoint } });
    assert.throws(() => manager.deletePodcast(id), { statusCode: 409 });
    assert.throws(() => manager.getPodcast('.resynth-' + edit.id), { statusCode: 400 });
    assert.deepEqual(manager.listPodcasts().items.map(item => item.id), [id]);
    if (fault === 'cancel') {
      await started.promise;
      manager.cancelTask(edit.id);
    }
    const status = fault === 'cancel' ? 'cancelled' : 'failed';
    await waitFor(() => manager.getTask(edit.id), v => v.status === status);
    await manager.shutdown();
    assert.deepEqual(snapshot(), before);
    const record = fs.readFileSync(path.join(config.tasksDir, edit.id + '.json'), 'utf8');
    for (const value of [secret, endpoint, config.tasksDir, config.podcastsDir]) {
      assert.ok(!record.includes(value));
      assert.ok(!before['meta.json'].toString().includes(value));
    }
    assert.equal(JSON.parse(record).targetPodcastId, id);
    inject = false;
    const restarted = createTaskManager(config);
    assert.equal(restarted.resumeTask(edit.id).targetPodcastId, id);
    const done = await waitFor(() => restarted.getTask(edit.id), v => v.status === 'completed');
    assert.equal(llmCalls, 1);
    assert.equal(done.podcastId, id);
    assert.deepEqual(done.podcast.sentences.map(s => s.text), ['改写一', '改写二']);
    assert.equal(fs.existsSync(path.join(dir, 'sentence_002.mp3')), false);
    assert.notDeepEqual(fs.readFileSync(path.join(dir, 'full_podcast.mp3')), before['full_podcast.mp3']);
  });
}

test('缓存淘汰后，换音色、语速、服务商或声源作用域均不补种旧音频', async t => {
  const calls = [];
  let scope = 'first';
  const edge = { ...getTtsProvider('edge'), getScopeHash: () => scope, synthesizeToFile(args) {
    calls.push(args);
    const audio = makeMp3(3);
    fs.writeFileSync(args.outputPath, audio);
    return { bytes: audio.length, duration: 0.1 };
  } };
  const { manager, config } = setup(t, { ttsProvider: edge, getTtsProviderById: () => ({ ...edge, id: 'offline' }) });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), v => v.status === 'completed');
  for (const tts of [{}, { voiceMapping: { 阿泽: 'zh-CN-YunjianNeural' } }, { speechSpeed: 'standard' }, { provider: 'offline' }]) {
    scope = 'second';
    fs.rmSync(config.cacheDir, { recursive: true });
    calls.length = 0;
    const edit = manager.resynthesizePodcast(id, { dialogue, tts });
    const done = await waitFor(() => manager.getTask(edit.id), v => v.status === 'completed');
    assert.equal(calls.length, dialogue.length);
    assert.equal(done.progress.cachedSegments, 0);
  }
});

test('失败微调的目标已删除时拒绝续跑', async t => {
  let fail = false;
  const provider = await localProvider(t, null, () => {
    if (fail) throw Object.assign(new Error('模拟失败'), { retryable: false });
  });
  const { manager } = setup(t, { ttsProvider: provider });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), v => v.status === 'completed');
  fail = true;
  const edit = manager.resynthesizePodcast(id, { dialogue: [{ speaker: '阿泽', text: '改写' }] });
  await waitFor(() => manager.getTask(edit.id), v => v.status === 'failed');
  manager.deletePodcast(id);
  assert.throws(() => manager.resumeTask(edit.id), { statusCode: 404 });
});

test('发布中进程退出，启动恢复后整套旧成品可读并可继续微调', async t => {
  const { manager, config } = setup(t, { ttsProvider: await localProvider(t) });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), v => v.status === 'completed');
  const target = path.join(config.podcastsDir, id);
  const snapshot = () => Object.fromEntries(fs.readdirSync(target).map(n => [n, fs.readFileSync(path.join(target, n))]));
  const before = snapshot();
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createTaskManager } = require(process.argv[1]);
    const { config, id, target } = JSON.parse(process.argv[2]);
    const audio = fs.readFileSync(path.join(target, 'sentence_001.mp3'));
    const manager = createTaskManager({ ...config, ttsProvider: { id: 'edge', model: 'test-model',
      synthesizeToFile({ outputPath }) {
        fs.writeFileSync(outputPath, Buffer.concat([audio, audio]));
        return { bytes: 2 * audio.length, duration: 1 };
      },
    } });
    const rename = fs.renameSync;
    fs.renameSync = (src, dest) => {
      rename(src, dest);
      if (dest === path.join(target, 'full_podcast.mp3')) process.exit(37);
    };
    const edit = manager.resynthesizePodcast(id, { dialogue: [{ speaker: '小晓', text: '改后' }] });
    fs.writeFileSync(1, edit.id);
  `, require.resolve('../src/services/taskManager'), JSON.stringify({ config, id, target })],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 37, child.stderr);
  assert.notDeepEqual(fs.readFileSync(path.join(target, 'full_podcast.mp3')), before['full_podcast.mp3']);
  const restarted = createTaskManager(config);
  assert.deepEqual(snapshot(), before);
  const editId = child.stdout.trim();
  assert.equal(restarted.getTask(editId).status, 'failed');
  restarted.resumeTask(editId);
  const done = await waitFor(() => restarted.getTask(editId), v => v.status === 'completed');
  assert.equal(done.podcast.sentences[0].text, '改后');
});

test('不安全的音频版本不进入详情或历史 URL，日期按公开字段校验', t => {
  const { manager, config } = setup(t);
  const dir = path.join(config.podcastsDir, 'historical');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'full_podcast.mp3'), makeMp3(1));
  for (const version of ['../../x', 'x'.repeat(33), 'sk-fake-version', 'safe-version_1']) {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ audioVersion: version, updatedAt: 'invalid',
      sentences: [{ fileName: 'sentence_000.mp3' }] }));
    const detail = manager.getPodcast('historical');
    const valid = version === 'safe-version_1';
    assert.equal(Object.hasOwn(detail, 'audioVersion'), valid);
    assert.equal(detail.updatedAt, valid ? null : undefined);
    const suffix = valid ? '?v=' + version : '';
    assert.equal(detail.fullAudioUrl, '/podcasts/historical/full_podcast.mp3' + suffix);
    assert.equal(detail.sentences[0].audioUrl, '/podcasts/historical/sentence_000.mp3' + suffix);
    assert.equal(manager.listPodcasts().items[0].fullAudioUrl, detail.fullAudioUrl);
  }
});

test('元数据写入和回滚均失败时阻断访问，恢复后不会撤销后续成品', async t => {
  const { manager, config, root } = setup(t, { ttsProvider: await localProvider(t) });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  const target = path.join(config.podcastsDir, id);
  const extra = path.join(target, 'sentence_099.mp3');
  fs.writeFileSync(extra, makeMp3(7));
  const snapshot = () => Object.fromEntries(fs.readdirSync(target, { withFileTypes: true })
    .filter(entry => entry.isFile()).map(({ name }) => [name, fs.readFileSync(path.join(target, name))]));
  const original = snapshot();
  let fault = true;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (fault && (to === path.join(target, 'meta.json') || path.basename(from) === '.restore')) {
      throw new Error('模拟发布和回滚写盘故障');
    }
    return rename(from, to);
  });
  const edit = { baseVersion: null, dialogue: [{ speaker: '小晓', text: '新的台词' }] };
  const a = manager.resynthesizePodcast(id, edit);
  await waitFor(() => manager.getTask(a.id), task => task.status === 'failed');
  const transaction = path.join(target, '.tmp-publish-' + a.id);
  const info = JSON.parse(fs.readFileSync(path.join(transaction, 'prepared')));
  assert.deepEqual(info, { taskId: a.id, previousVersion: null, targetVersion: info.targetVersion, dialogueCount: 1 });
  assert.match(info.targetVersion, /^[a-f0-9]{32}$/);
  assert.equal(fs.existsSync(extra), false);
  for (const operation of [() => manager.resynthesizePodcast(id, edit), () => manager.getPodcast(id),
    () => manager.deletePodcast(id), () => manager.resumeTask(a.id)]) {
    assert.throws(operation, { statusCode: 503, code: 'PODCAST_RECOVERY_FAILED' });
    assert.equal(fs.existsSync(path.join(transaction, 'prepared')), true);
  }
  const staleBackup = path.join(root, 'stale-backup');
  fs.cpSync(transaction, staleBackup, { recursive: true });
  fault = false;
  assert.deepEqual(manager.getPodcast(id).sentences.map(line => line.text), dialogue.map(line => line.text));
  assert.deepEqual(snapshot(), original);
  assert.equal(fs.existsSync(transaction), false);
  const b = manager.resynthesizePodcast(id, edit);
  const done = await waitFor(() => manager.getTask(b.id), task => task.status === 'completed');
  assert.equal(fs.existsSync(extra), false);
  const committed = snapshot();
  assert.throws(() => manager.resumeTask(a.id), { statusCode: 409, code: 'PODCAST_VERSION_CONFLICT' });
  // Even an old prepared backup discovered after B committed cannot undo B.
  fs.cpSync(staleBackup, transaction, { recursive: true });
  const restarted = createTaskManager(config);
  assert.deepEqual(restarted.getPodcast(id), done.podcast);
  assert.deepEqual(snapshot(), committed);
  assert.equal(fs.existsSync(transaction), false);
});

test('合成期间目标版本发生变化，发布前再次校验并保留磁盘成品', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let hold = false;
  const { manager, config } = setup(t, { ttsProvider: await localProvider(t),
    async audioMerger(...args) {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      return require('../src/services/audioMerger').concatenateAudioFiles(...args);
    },
  });
  const { id } = manager.createTask(payload);
  await waitFor(() => manager.getTask(id), task => task.status === 'completed');
  const target = path.join(config.podcastsDir, id);
  const file = path.join(target, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(file));
  hold = true;
  const edit = manager.resynthesizePodcast(id, { baseVersion: null, dialogue: dialogue.slice(0, 1) });
  await entered.promise;
  meta.audioVersion = 'newer-version';
  fs.writeFileSync(file, JSON.stringify(meta));
  const snapshot = () => fs.readdirSync(target).map(name => [name, fs.readFileSync(path.join(target, name))]);
  const before = snapshot();
  release.resolve();
  const failed = await waitFor(() => manager.getTask(edit.id), task => task.status === 'failed');
  assert.match(failed.error.message, /播客已更新/);
  assert.throws(() => manager.resumeTask(edit.id), { statusCode: 409, code: 'PODCAST_VERSION_CONFLICT' });
  assert.deepEqual(snapshot(), before);
});

for (const scenario of ['换账号', '同账号', '缺少旧账号证明']) {
  test('MiniMax 官方音色清空缓存后按成品账号复用，归档不回写缓存：' + scenario, async t => {
    const same = scenario === '同账号';
    const lines = Array.from({ length: same ? 10 : 2 }, (_, index) => ({ speaker: '阿泽', text: '原句' + index }));
    const a = 'offline-account-alpha';
    const b = 'offline-account-bravo';
    const calls = [];
    const ttsProvider = { ...createMinimaxProvider({ minRequestIntervalMs: 0 }),
      synthesizeToFile({ outputPath, text, adapterOptions }) {
        calls.push([adapterOptions.apiKey, text]);
        const audio = makeMp3(adapterOptions.apiKey === a ? 3 : 5);
        fs.writeFileSync(outputPath, audio);
        return { bytes: audio.length, duration: 1 };
      },
    };
    const { manager, config } = setup(t, { ttsProvider, scriptGenerator: () => ({ ...script, dialogue: lines }) });
    const completed = id => waitFor(() => manager.getTask(id), task => task.status === 'completed');
    const tts = apiKey => ({ provider: 'minimax', apiKey });
    const { id } = manager.createTask({ ...payload, tts: tts(a) });
    await completed(id);
    const recordFile = taskId => path.join(config.tasksDir, taskId + '.json');
    const record = JSON.parse(fs.readFileSync(recordFile(id)));
    assert.match(record.ttsAccountHash, /^[a-f0-9]{64}$/);
    if (scenario === '缺少旧账号证明') {
      delete record.ttsAccountHash;
      fs.writeFileSync(recordFile(id), JSON.stringify(record));
    }
    const verifyEdit = async (key, expectedCalls) => {
      fs.rmSync(config.cacheDir, { recursive: true });
      calls.length = 0;
      lines[0] = { ...lines[0], text: lines[0].text + '改' };
      const edit = manager.resynthesizePodcast(id, { dialogue: lines, tts: tts(key) });
      const done = await completed(edit.id);
      assert.deepEqual(calls, lines.slice(0, expectedCalls).map(line => [key, line.text]));
      assert.equal(fs.readdirSync(config.cacheDir).length, expectedCalls);
      const privateRecord = fs.readFileSync(recordFile(edit.id), 'utf8');
      for (const credential of [a, b]) assert.ok(!privateRecord.includes(credential));
      const hash = JSON.parse(privateRecord).ttsAccountHash;
      const dir = path.join(config.podcastsDir, id);
      for (const value of [JSON.stringify(done), JSON.stringify(manager.getPodcast(id)), fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')]) {
        for (const hidden of [hash, 'ttsAccountHash', a, b]) assert.ok(!value.includes(hidden));
      }
      assert.deepEqual(fs.readFileSync(path.join(dir, 'sentence_001.mp3')), makeMp3(key === a ? 3 : 5));
    };
    const key = scenario === '换账号' ? b : a;
    await verifyEdit(key, same ? 1 : lines.length);
    // The current edited version has its own proof, including when B replaced A.
    await verifyEdit(key, 1);
  });
}
