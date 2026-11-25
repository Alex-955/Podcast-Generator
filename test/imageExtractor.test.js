const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const { Readable } = require('node:stream');
const { extractTextFromImages } = require('../src/services/imageExtractor');
const { httpStatusError, upstreamError } = require('../src/services/providerHttp');
const { DEFAULT_VOICES, synthesizeDialogueScript, synthesizeSentence } = require('../src/services/ttsService');
const { buildCacheKey, createTtsCache } = require('../src/services/ttsCache');
const { httpTtsFixture } = require('./helpers/httpTtsFixture');
const { makeMp3 } = require('./helpers/mp3Fixtures');

const images = ['data:image/png;base64,YQ==', 'data:image/JPG;base64,Yg=='];
const visionApiKey = 'offline-vision-token';
const visionBaseURL = 'https://vision-fixture.example/API/v1/';
const visionModel = 'test-provider/vision-model';
const payload = { images, visionApiKey, visionBaseURL, visionModel };

function configure(t, overrides = {}) {
  const env = { VISION_API_KEY: '', VISION_BASE_URL: '', VISION_MODEL: '', DEEPSEEK_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '', ...overrides };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
}

function response(body, statusCode = 200, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

function completion(content) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

test('识图请求按顺序传入多张图片，并接受带围栏的 JSON 及纯文本响应', async t => {
  configure(t);
  for (const [reply, title, content] of [
    ['```json\n{"title":"长截图","content":"第一段\\n\\n第二段"}\n```', '长截图', '第一段\n\n第二段'],
    ['```text\n 第一段\n\n第二段 \n```', '', '第一段\n\n第二段'],
    [' 纯文本 ', '', '纯文本'],
  ]) {
    let calls = 0;
    const result = await extractTextFromImages(payload, {
      llmRequest: async (url, args) => {
        calls++;
        assert.equal(url, 'https://vision-fixture.example/API/v1/chat/completions');
        assert.equal(args.method, 'POST');
        assert.equal(args.headers.Authorization, 'Bearer ' + visionApiKey);
        assert.equal(args.headers['Content-Type'], 'application/json');
        assert.equal(args.allowPrivateEndpoint, false);
        assert.ok(args.signal instanceof AbortSignal);
        const body = JSON.parse(args.body);
        assert.equal(body.model, visionModel);
        assert.equal(body.temperature, 0.1);
        assert.match(body.messages[0].content, /重叠的行/);
        assert.match(body.messages[0].content, /保留原标题、段落/);
        assert.deepEqual(body.messages[1].content.slice(0, -1), images.map(url => ({ type: 'image_url', image_url: { url } })));
        assert.equal(body.messages[1].content.at(-1).type, 'text');
        return response(completion(reply));
      },
    });
    assert.deepEqual(result, { title, content, length: content.length, truncated: false, imageCount: images.length });
    assert.equal(calls, 1);
  }
});

test('图片校验拒绝无效数量、类型、编码、单图和总大小', async t => {
  configure(t);
  const prefix = 'data:image/png;base64,';
  const atLimit = prefix + 'A'.repeat(6 * 1024 * 1024 - prefix.length);
  const llmRequest = t.mock.fn(async () => response(completion('转录成功')));
  for (const invalid of [
    undefined, [], '图片', Array(9).fill(images[0]), new Array(1), [1], ['data:image/gif;base64,YQ=='],
    ['data:image/png;base64,Y_Q='], ['data:image/png;base64,'], [images[0] + '\n'], [atLimit + 'A'], Array(4).fill(atLimit),
  ]) {
    await assert.rejects(extractTextFromImages({ ...payload, images: invalid }, { llmRequest }), { statusCode: 400 });
  }
  assert.equal(llmRequest.mock.callCount(), 0);
  assert.equal((await extractTextFromImages({ ...payload, images: [atLimit] }, { llmRequest })).imageCount, 1);
});

test('视觉响应按正文上限截断并拒绝空正文、超限和无效响应', async t => {
  configure(t);
  const long = '文'.repeat(12001);
  const result = await extractTextFromImages(payload, { llmRequest: async () => response(completion(long)) });
  assert.deepEqual(result, { title: '', length: 12000, truncated: true, content: long.slice(0, 12000), imageCount: 2 });
  for (const [body, status, headers, error] of [
    ['<html>重定向</html>', 302, { location: 'https://other.example' }, /HTTP 302/],
    ['{', 200, {}, /有效 JSON/],
    ['{}', 200, {}, /响应格式无效/],
    [completion('  '), 200, {}, /未能从图片/],
    [completion('{"title":"标题","content":""}'), 200, {}, /未能从图片/],
    [completion('正文'), 200, { 'content-length': 4 * 1024 * 1024 + 1 }, /大小限制/],
    ['A'.repeat(4 * 1024 * 1024 + 1), 200, {}, /大小限制/],
  ]) {
    const res = response(body, status, headers);
    await assert.rejects(extractTextFromImages(payload, { llmRequest: async () => res }),
      err => err.statusCode === 502 && error.test(err.message));
    assert.equal(res.destroyed, true);
  }
});

test('服务端视觉和通用密钥各自绑定到规范化后的配置地址', async t => {
  const settings = {
    VISION_API_KEY: 'server-vision-token', VISION_BASE_URL: 'http://127.0.0.1:1111/vision/v1/', VISION_MODEL: 'server-vision',
    DEEPSEEK_API_KEY: 'server-llm-token', LLM_BASE_URL: 'http://127.0.0.1:2222/service/', LLM_MODEL: 'server-llm',
  };
  configure(t, settings);
  const customBase = 'https://untrusted.example';
  const calls = [];
  const llmRequest = async (url, args) => {
    calls.push([url, args.headers.Authorization, JSON.parse(args.body).model, args.allowPrivateEndpoint]);
    return response(completion('正文'));
  };
  for (const fields of [
    { visionBaseURL: customBase }, { baseURL: customBase }, { visionBaseURL: customBase, visionApiKey: ' ' },
    { apiKey: visionApiKey, baseURL: settings.LLM_BASE_URL, visionBaseURL: customBase },
  ]) {
    await assert.rejects(extractTextFromImages({ images, ...fields }, { llmRequest }),
      err => err.statusCode === 400 && /对应的 API Key/.test(err.message));
  }
  assert.deepEqual(calls, []);
  const vision = ['http://127.0.0.1:1111/vision/v1/chat/completions', 'Bearer server-vision-token', 'server-vision', true];
  const llm = ['http://127.0.0.1:2222/service/v1/chat/completions', 'Bearer server-llm-token', 'server-llm', true];
  const custom = [customBase + '/v1/chat/completions', 'Bearer ' + visionApiKey, visionModel, false];
  for (const [fields, expected] of [
    [{}, vision],
    [{ visionApiKey }, [vision[0], 'Bearer ' + visionApiKey, vision[2], true]],
    [{ visionBaseURL: '  http://127.0.0.1:1111/vision/  ' }, vision],
    [{ apiKey: 'ordinary-request-token', visionBaseURL: settings.VISION_BASE_URL }, vision],
    [{ baseURL: 'http://127.0.0.1:1111/vision' }, vision],
    [{ visionBaseURL: 'http://127.0.0.1:2222/service/v1' }, llm],
    [{ baseURL: 'http://127.0.0.1:2222/service/v1' }, llm],
    [{ visionApiKey, visionBaseURL: customBase, visionModel }, custom],
    [{ apiKey: visionApiKey, baseURL: customBase, model: visionModel }, custom],
  ]) {
    await extractTextFromImages({ images, ...fields }, { llmRequest });
    assert.deepEqual(calls.pop(), expected);
  }
});

test('独立识图密钥缺少有效识图地址时报 400，通用地址不会收到请求', async t => {
  configure(t, { LLM_BASE_URL: 'https://llm-fixture.example' });
  const llmRequest = t.mock.fn(async () => response(completion('不应发出请求')));
  const fields = { images, visionApiKey: 'some-key', visionModel: 'kimi-k2.5' };
  for (const visionBase of ['', 'file:///tmp/vision']) {
    process.env.VISION_BASE_URL = visionBase;
    await assert.rejects(extractTextFromImages(fields, { llmRequest }), {
      statusCode: 400,
      message: '填写独立识图 API Key 时，请同时填写对应的识图 Base URL',
    });
  }
  assert.equal(llmRequest.mock.callCount(), 0);
});

test('识图拒绝缺密钥、纯文本模型、无效地址和敏感模型名称', async t => {
  configure(t);
  const llmRequest = t.mock.fn(async () => response(completion('不应发出请求')));
  await assert.rejects(extractTextFromImages({ images }, { llmRequest }), /请先配置支持识图的模型 API Key/);
  for (const override of [
    { visionBaseURL: 'https://api.deepseek.com./v1' }, { visionModel: 'DeepSeek-Chat' },
    { visionModel: 'deepseek-reasoner' }, { visionModel: 'deepseek-flash' },
  ]) {
    await assert.rejects(extractTextFromImages({ ...payload, ...override }, { llmRequest }), /暂不支持图片识别/);
  }
  for (const url of ['ftp://vision.example', 'https://user:password@vision.example', 'https://vision.example?secret=yes',
    'https://vision.example?', 'https://vision.example#', 'invalid']) {
    await assert.rejects(extractTextFromImages({ ...payload, visionBaseURL: url }, { llmRequest }), /接口地址无效/);
  }
  await assert.rejects(extractTextFromImages({ ...payload, visionModel: visionApiKey }, { llmRequest }), /模型名称无效/);
  assert.equal(llmRequest.mock.callCount(), 0);
});

test('默认识图传输拒绝非授权私网地址与解析结果', async t => {
  configure(t);
  for (const visionBaseURL of ['http://127.0.0.1', 'http://[::1]', 'http://ocr.local']) {
    await assert.rejects(extractTextFromImages({ ...payload, visionBaseURL }), { statusCode: 400, message: /受限网络/ });
  }
  let lookups = 0;
  await assert.rejects(extractTextFromImages(payload, {
    async lookup(host, { all }) {
      lookups++;
      assert.equal(host, 'vision-fixture.example');
      assert.equal(all, true);
      return [{ address: '127.0.0.1', family: 4 }];
    },
  }), { statusCode: 400, message: /受限网络/ });
  assert.equal(lookups, 1);
});

test('识图请求超时与取消均关闭响应并移除外部取消监听', { timeout: 5000 }, async t => {
  configure(t);
  let onRequest, onClose;
  const { endpoint, requests } = await httpTtsFixture(t, res => {
    res.once('close', onClose);
    res.write('{"choices":');
    onRequest();
  });
  process.env.VISION_BASE_URL = endpoint + '/v1/';
  const input = { ...payload, visionBaseURL: endpoint };
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const reading = new Promise(resolve => { onRequest = resolve; });
    const closed = new Promise(resolve => { onClose = resolve; });
    let upstreamSignal;
    const { requestProvider } = require('../src/services/providerHttp');
    const extraction = extractTextFromImages(input, {
      signal: controller.signal, timeoutMs: cancelled ? 5000 : 100,
      llmRequest(url, args) {
        upstreamSignal = args.signal;
        return requestProvider(url, args);
      },
    });
    const failure = assert.rejects(extraction, cancelled ? { name: 'AbortError' } : { statusCode: 502, message: /超时/ });
    await reading;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (cancelled) controller.abort();
    await failure;
    await closed;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(upstreamSignal.aborted, true);
  }
  await assert.rejects(extractTextFromImages(input, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(requests.length, 2);
});

test('视觉请求错误和转录响应不泄露密钥与实际接口路径', async t => {
  configure(t, { VISION_API_KEY: 'vision-server-secret', VISION_BASE_URL: 'https://vision-server.example/hidden' });
  const details = [visionApiKey, visionBaseURL, process.env.VISION_API_KEY, process.env.VISION_BASE_URL].join(' ');
  await assert.rejects(extractTextFromImages(payload, { llmRequest: async () => {
    throw upstreamError('失败 ' + details, false);
  } }), { statusCode: 502, retryable: false, message: '失败 *** *** *** ***' });
  await assert.rejects(extractTextFromImages(payload, { llmRequest: async () => {
    throw new Error(details + ' /Users/private/unknown-path');
  } }), { statusCode: 502, message: '识图模型接口连接失败' });
  const { title, content } = await extractTextFromImages(payload, {
    llmRequest: async () => response(completion(JSON.stringify({ title: details, content: '正文 ' + details }))),
  });
  assert.equal(title, '*** *** *** ***');
  assert.equal(content, '正文 *** *** *** ***');
});

test('远程合成按间隔执行，工作目录复用与缓存命中不触发请求', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-tts-pacing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const audio = makeMp3(2);
  const source = path.join(work, 'sentence_001.mp3');
  fs.writeFileSync(source, audio);
  const events = [];
  let firstEndedAt, secondStartedAt;
  const provider = {
    id: 'offline', model: 'fixture', minRequestIntervalMs: 25,
    synthesizeToFile({ outputPath, text }) {
      events.push(text);
      if (text === '第二次请求') secondStartedAt = Date.now();
      fs.writeFileSync(outputPath, audio);
      if (text === '首次请求') firstEndedAt = Date.now();
      return { bytes: audio.length, duration: 0.048 };
    },
  };
  cache.put(buildCacheKey({ provider: provider.id, model: provider.model, voice: DEFAULT_VOICES.阿泽, text: '缓存' }), source);
  const lines = ['首次请求', '已完成', '缓存', '第二次请求'].map(text => ({ speaker: '阿泽', text }));
  const result = await synthesizeDialogueScript(lines, work, null, { provider, cache, onProgress(progress) {
    if (progress.completedSegments > progress.index && ['已完成', '缓存'].includes(progress.text)) events.push(progress.text);
  } });
  assert.deepEqual(events, lines.map(line => line.text));
  assert.equal(result.reusedSegments, 1);
  assert.equal(result.cachedSegments, 2);
  assert.ok(secondStartedAt - firstEndedAt >= 24);
  const previouslyCompleted = await synthesizeDialogueScript(lines, work, null, {
    provider, cache, minRequestIntervalMs: 60000, signal: AbortSignal.timeout(1000),
  });
  assert.equal(previouslyCompleted.reusedSegments, 4);
  assert.deepEqual(events, lines.map(line => line.text));
});

test('限流可恢复到第六次合成，重试等待时间遵守服务商间隔', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-tts-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rateLimitBackoffMs = [2, 3, 4, 5, 25];
  const minInterval = 20;
  const adapterOptions = { endpoint: 'https://tts-fixture.example' };
  const retries = [];
  const attempts = [];
  const error = upstreamError('限流', true, { rateLimited: true });
  const result = await synthesizeSentence({
    text: '正文', emotion: '好奇', outputPath: path.join(root, 'sentence.mp3'), rateLimitBackoffMs, adapterOptions,
    provider: {
      minRequestIntervalMs: 10,
      getMinRequestIntervalMs(options) {
        assert.equal(options, adapterOptions);
        return minInterval;
      },
      synthesizeToFile({ emotion }) {
        assert.equal(emotion, '好奇');
        attempts.push(performance.now());
        if (attempts.length < 6) throw error;
        return { bytes: 128, duration: 0.048 };
      },
    },
    onRetry: retry => retries.push(retry),
  });
  assert.equal(attempts.length, 6);
  assert.equal(result.duration, 0.048);
  assert.deepEqual(retries, rateLimitBackoffMs.map((delayMs, index) =>
    ({ attempt: index + 1, maxAttempts: 6, delayMs: Math.max(delayMs, minInterval), rateLimited: true, error })));
  for (const [index, { delayMs }] of retries.entries()) {
    assert.ok(attempts[index + 1] - attempts[index] >= delayMs - 2);
  }
});

test('限流后连续三次普通 HTTP 500 错误在第四次尝试后停止', async () => {
  let calls = 0;
  const retries = [];
  await assert.rejects(synthesizeSentence({
    text: '正文', rateLimitBackoffMs: [5],
    provider: {
      synthesizeToFile() {
        throw httpStatusError(++calls === 1 ? 429 : 500);
      },
    },
    onRetry: ({ attempt, rateLimited }) => retries.push([attempt, rateLimited]),
  }), { statusCode: 502, message: '语音合成失败（已尝试 4 次）：HTTP 500' });
  assert.equal(calls, 4);
  assert.deepEqual(retries, [[1, true], [2, false], [3, false]]);
});
