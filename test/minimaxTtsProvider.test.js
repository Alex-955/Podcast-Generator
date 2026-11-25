const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createMinimaxProvider, DEFAULT_MINIMAX_ENDPOINT } = require('../src/services/minimaxTtsProvider');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { httpTtsFixture } = require('./helpers/httpTtsFixture');

const minimaxProvider = createMinimaxProvider({ allowPrivateEndpoint: true });
const apiKey = 'offline-minimax-secret';
const audio = makeMp3(10);
test('MiniMax 发送模型、音色、语速与认证头并原子写入 hex 音频', async t => {
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } })));
  for (const [rate, speed] of [['+10%', 1.1], ['+500%', 2], ['-300%', 0.5]]) {
    const result = await minimaxProvider.synthesizeToFile({ text: '测试', rate, outputPath, adapterOptions: { endpoint, apiKey, model: 'speech-02-turbo' } });
    assert.deepEqual(result, { bytes: audio.length, duration: 0.24 });
    assert.deepEqual(fs.readFileSync(outputPath), audio);
    const { headers, body } = requests.at(-1);
    assert.equal(headers.authorization, 'Bearer ' + apiKey);
    assert.deepEqual(body, { model: 'speech-02-turbo', text: '测试', stream: false,
      voice_setting: { voice_id: minimaxProvider.defaultVoices.阿泽, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }, output_format: 'hex' });
  }
});

test('MiniMax 使用新版默认模型与音色，情绪只发送受支持的值', async t => {
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } })));
  assert.equal(minimaxProvider.model, 'speech-2.8-turbo');
  assert.deepEqual(minimaxProvider.defaultVoices, { 阿泽: 'male-qn-jingying', 小晓: 'Chinese (Mandarin)_Warm_Bestie' });
  assert.equal(minimaxProvider.minRequestIntervalMs, 2600);
  assert.equal(minimaxProvider.getMinRequestIntervalMs({ endpoint: DEFAULT_MINIMAX_ENDPOINT }), 2600);
  assert.equal(minimaxProvider.getMinRequestIntervalMs(), 2600);
  assert.equal(minimaxProvider.getMinRequestIntervalMs({ endpoint }), 0);
  assert.equal(createMinimaxProvider({ minRequestIntervalMs: 0 }).getMinRequestIntervalMs(), 0);
  for (const [emotion, expected] of [
    [' 笑意 ', 'happy'], ['震惊', 'surprised'], ['低落', 'sad'], ['愤怒', 'angry'], ['紧张', 'fearful'],
    ['嫌弃', 'disgusted'], ['追问', 'neutral'], ['HAPPY', 'happy'], ['', undefined], ['未知', undefined], [undefined, undefined],
  ]) {
    await minimaxProvider.synthesizeToFile({ text: '测试', emotion, outputPath, adapterOptions: { endpoint, apiKey } });
    const { body } = requests.at(-1);
    assert.equal(body.model, 'speech-2.8-turbo');
    assert.equal(body.voice_setting.voice_id, 'male-qn-jingying');
    assert.equal(Object.hasOwn(body.voice_setting, 'emotion'), expected !== undefined);
    assert.equal(body.voice_setting.emotion, expected);
  }
});

test('MiniMax 拒绝错误状态、无效 JSON、损坏音频，保留已有文件', async t => {
  let response, status = 200;
  const { endpoint, outputPath } = await httpTtsFixture(t, res => { res.statusCode = status; res.end(response); });
  fs.writeFileSync(outputPath, audio);
  for (const [code, body, expected] of [
    [403, apiKey, /HTTP 403/], [200, '{', /JSON/],
    [200, { base_resp: { status_code: 1004, status_msg: `鉴权失败 ${apiKey} ${endpoint}` } }, /1004.*鉴权失败/],
    ...['', '123', 'xz', 'deadbeef'].map(hex => [200, { base_resp: { status_code: 0 }, data: { audio: hex } }, /音频/]),
  ]) {
    status = code;
    response = typeof body === 'string' ? body : JSON.stringify(body);
    await assert.rejects(minimaxProvider.synthesizeToFile({ outputPath, adapterOptions: { apiKey, endpoint } }), e =>
      expected.test(e.message) && !e.message.includes(apiKey) && !e.message.includes(endpoint));
    assert.deepEqual(fs.readFileSync(outputPath), audio);
  }
});

test('MiniMax 缺凭据、预取消、响应体超时', async t => {
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => res.write('{'));
  const args = { outputPath, adapterOptions: { endpoint } };
  await assert.rejects(minimaxProvider.synthesizeToFile(args), { statusCode: 400 });
  await assert.rejects(minimaxProvider.synthesizeToFile({ ...args, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  await assert.rejects(minimaxProvider.synthesizeToFile({ outputPath, adapterOptions: { endpoint, apiKey, timeoutMs: 50 } }), /超时/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('私网 TTS 开关独立，套接字校验全部 DNS 结果并使用受检地址', async t => {
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } })));
  const env = { ALLOW_PRIVATE_TTS_ENDPOINT: '0', ALLOW_PRIVATE_FETCH: '1' };
  for (const [name, value] of Object.entries(env)) {
    const old = process.env[name];
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    process.env[name] = value;
  }
  const named = endpoint.replace('127.0.0.1', 'speech.test');
  const synth = (host, lookup) => createMinimaxProvider({ apiKey, endpoint: host, lookup }).synthesizeToFile({ outputPath, text: '测试' });
  await assert.rejects(synth(endpoint), { statusCode: 400 });
  for (const address of ['127.0.0.1', '10.0.0.9', '169.254.5.6', '100.64.1.1', '203.0.113.1', 'fd00::10', '::ffff:7f00:1', '2001:db8::1']) {
    await assert.rejects(synth(named, async () => [{ address: '1.1.1.1', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 }]), { statusCode: 400 });
  }
  assert.equal(requests.length, 0);
  process.env.ALLOW_PRIVATE_TTS_ENDPOINT = '1';
  let resolutions = 0;
  await synth(named, async (host, options) => {
    assert.equal(host, 'speech.test');
    assert.equal(options.all, true);
    resolutions++;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  assert.equal(resolutions, 1);
  assert.equal(requests[0].headers.host, new URL(named).host);
});

test('真实 HTTP 适配器只重试可恢复错误，拒绝重定向与超限响应', async t => {
  const { synthesizeSentence } = require('../src/services/ttsService');
  let code = 401, body;
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => {
    res.statusCode = code;
    res.setHeader('Location', '/redirected');
    if (body === 'oversize') res.setHeader('content-length', 21 * 1024 * 1024);
    res.end(body || '/Users/private/unknown-file');
  });
  for (const [status, count] of [[400, 1], [401, 1], [403, 1], [404, 1], [422, 1], [307, 1], [500, 3], [503, 3]]) {
    code = status;
    const before = requests.length;
    await assert.rejects(synthesizeSentence({ text: '测试', outputPath, provider: minimaxProvider, adapterOptions: { apiKey, endpoint } }),
      error => error.message.includes('HTTP ' + code) && !error.message.includes('/Users'));
    assert.equal(requests.length - before, count);
  }
  code = 200;
  body = JSON.stringify({ base_resp: { status_code: 1004 } });
  const before = requests.length;
  await assert.rejects(synthesizeSentence({ text: '测试', outputPath, provider: minimaxProvider, adapterOptions: { apiKey, endpoint } }), { retryable: false });
  assert.equal(requests.length - before, 1);
  body = 'oversize';
  await assert.rejects(minimaxProvider.synthesizeToFile({ outputPath, adapterOptions: { apiKey, endpoint } }), /大小限制/);
});

test('MiniMax HTTP 200 中的确定性业务错误只请求一次，限流仍重试', async t => {
  const { synthesizeSentence } = require('../src/services/ttsService');
  let status;
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.end(JSON.stringify({ base_resp: { status_code: status } })));
  const rateLimits = { 1002: 'RPM', 1039: 'TPM' };
  for (const code of [1004, 1008, 1026, 1042, 2013, 20132, 2038, 2043, 2049, 1002, 1039]) {
    status = code;
    const limit = rateLimits[code];
    const before = requests.length;
    const retries = [];
    await assert.rejects(synthesizeSentence({
      text: '你好', provider: minimaxProvider, outputPath, adapterOptions: { endpoint, apiKey },
      rateLimitBackoffMs: [5, 5, 5, 5, 5], onRetry: info => retries.push(info),
    }), error => error.statusCode === 502 && error.message.includes(String(code)) &&
      (limit ? error.message.includes('已尝试 6 次') && error.message.includes(limit + ' 限流') : error.retryable === false));
    assert.equal(requests.length - before, limit ? 6 : 1);
    assert.deepEqual(retries.map(({ attempt, maxAttempts, delayMs, rateLimited }) => [attempt, maxAttempts, delayMs, rateLimited]),
      limit ? [1, 2, 3, 4, 5].map(attempt => [attempt, 6, 5, true]) : []);
  }
});
