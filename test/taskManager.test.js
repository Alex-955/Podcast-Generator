const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createTaskManager } = require('../src/services/taskManager');
const { getTtsProvider } = require('../src/services/ttsProvider');
const { synthesizeSentence } = require('../src/services/ttsService');
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

test('启动扫描保留截断和 ID 不匹配的记录，并恢复同目录的 running 任务', t => {
  const { config } = setup(t);
  fs.mkdirSync(config.tasksDir);
  const truncated = path.join(config.tasksDir, 'broken.json');
  const mismatch = path.join(config.tasksDir, 'mismatch.json');
  const running = path.join(config.tasksDir, 'running.json');
  const wrongRecord = JSON.stringify({ id: 'running', status: 'running', stage: 'extract' });
  fs.writeFileSync(truncated, '{"id":');
  fs.writeFileSync(mismatch, wrongRecord);
  fs.writeFileSync(running, JSON.stringify({ id: 'running', status: 'running', stage: 'tts' }));

  const restarted = createTaskManager(config);
  const recovered = restarted.getTask('running');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.stage, 'tts');
  assert.equal(recovered.error.retryable, true);
  assert.equal(fs.readFileSync(truncated, 'utf8'), '{"id":');
  assert.equal(fs.readFileSync(mismatch, 'utf8'), wrongRecord);
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
