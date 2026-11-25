const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createVolcengineProvider } = require('../src/services/volcengineTtsProvider');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { httpTtsFixture } = require('./helpers/httpTtsFixture');

const provider = createVolcengineProvider({ allowPrivateEndpoint: true });
const apiKey = 'offline-single', appId = 'offline-app', accessKey = 'offline-access';
const audio = makeMp3(4);
test('豆包按认证模式发送请求，解码跨包、多行与结尾残行', async t => {
  const record = part => JSON.stringify({ code: 0, data: part.toString('base64') });
  const first = record(audio.subarray(0, 29));
  const tail = JSON.stringify({ code: 20000000, data: audio.subarray(29).toString('base64') });
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => {
    res.write(first.slice(0, 13));
    setImmediate(() => res.end(first.slice(13) + '\r\n\n' + tail));
  });
  for (const auth of [{ apiKey, appId, accessKey }, { appId, accessKey }]) {
    assert.deepEqual(await provider.synthesizeToFile({ text: '首句', outputPath, adapterOptions: { endpoint, ...auth } }),
      { duration: 0.096, bytes: audio.length });
    assert.deepEqual(fs.readFileSync(outputPath), audio);
    const { headers, body } = requests.at(-1);
    assert.equal(headers['x-api-key'], auth.apiKey);
    assert.equal(headers['x-api-app-id'], auth.apiKey ? undefined : appId);
    assert.equal(headers['x-api-access-key'], auth.apiKey ? undefined : accessKey);
    assert.equal(headers['x-api-resource-id'], 'seed-tts-2.0');
    assert.match(headers['x-api-request-id'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(body, { user: { uid: 'ai-podcast-generator' }, req_params: { text: '首句', speaker: provider.defaultVoices.阿泽,
      audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000 } } });
  }
  assert.notEqual(requests[0].headers['x-api-request-id'], requests[1].headers['x-api-request-id']);
});

test('豆包 NDJSON 即使已有音频也拒绝错误行、损坏数据及 HTTP 错误', async t => {
  let line, status;
  const { endpoint, outputPath } = await httpTtsFixture(t, res => { res.statusCode = status; res.end(line); });
  for (const [code, body, expected] of [
    [200, JSON.stringify({ data: audio.toString('base64') }) + '\n' +
      JSON.stringify({ code: 91, message: [apiKey, appId, accessKey, endpoint].join(' ') }), /状态码 91/],
    [401, '鉴权失败 ' + accessKey, /HTTP 401/], [200, 'xxx', /JSON/],
    [200, '{"code":20000000,"data":"b29wcw=="}', /MP3/],
  ]) {
    status = code;
    line = body;
    await assert.rejects(provider.synthesizeToFile({ outputPath, adapterOptions: { endpoint, apiKey, appId, accessKey } }),
      e => expected.test(e.message) && [apiKey, appId, accessKey, endpoint].every(value => !e.message.includes(value)));
    assert.equal(fs.existsSync(outputPath), false);
  }
});

test('豆包缺凭据与取消，进行中的请求停止读取响应', async t => {
  const controller = new AbortController();
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => {
    res.write('{"data":"');
    setImmediate(() => controller.abort());
  });
  await assert.rejects(provider.synthesizeToFile({ outputPath, adapterOptions: { endpoint, appId } }), { statusCode: 400 });
  await assert.rejects(provider.synthesizeToFile({ outputPath, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  await assert.rejects(provider.synthesizeToFile({ signal: controller.signal, outputPath, adapterOptions: { endpoint, apiKey } }), { name: 'AbortError' });
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(outputPath), false);
});

test('豆包提前 EOF 不替换文件，收到成功码即返回并关闭长连接', async t => {
  let complete = false;
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const line = JSON.stringify({ code: 0, data: audio.toString('base64') }) + '\n';
  const { endpoint, outputPath } = await httpTtsFixture(t, res => {
    if (!complete) return res.end(line);
    res.on('close', closed);
    res.write(line + '{"code":20000000}');
  });
  const args = { outputPath, adapterOptions: { apiKey, endpoint, timeoutMs: 1000 } };
  fs.writeFileSync(outputPath, '原文件');
  await assert.rejects(provider.synthesizeToFile(args), /缺少成功结束码/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), '原文件');
  complete = true;
  await provider.synthesizeToFile(args);
  assert.deepEqual(fs.readFileSync(outputPath), audio);
  await disconnected;
});

test('跨包 NDJSON 单行缓存有上限', async t => {
  const { endpoint, outputPath } = await httpTtsFixture(t, res => res.end('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(provider.synthesizeToFile({ outputPath, adapterOptions: { apiKey, endpoint } }), /响应行超过/);
  assert.ok(!fs.existsSync(outputPath));
});

test('豆包资源系列后缀和大小写均使用对应版本的默认音色', async t => {
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.end(JSON.stringify({ code: 20000000, data: audio.toString('base64') })));
  for (const [resourceId, voice] of [['seed-tts-1.0-concurr', 'zh_male_yangguangqingnian_moon_bigtts'],
    ['SEED-TTS-1.0-concurr', 'zh_male_yangguangqingnian_moon_bigtts'], ['seed-tts-2.0-concurr', 'zh_male_m191_uranus_bigtts']]) {
    await provider.synthesizeToFile({ outputPath, text: '你好', adapterOptions: { endpoint, apiKey, resourceId } });
    assert.equal(requests.at(-1).headers['x-api-resource-id'], resourceId);
    assert.equal(requests.at(-1).body.req_params.speaker, voice);
  }
});

test('豆包 HTTP 客户端错误只请求一次，408 和 429 重试', async t => {
  const { synthesizeSentence } = require('../src/services/ttsService');
  let status;
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => res.writeHead(status).end());
  for (const [code, count] of [[413, 1], [414, 1], [415, 1], [408, 3], [429, 3]]) {
    status = code;
    const before = requests.length;
    await assert.rejects(synthesizeSentence({ text: '你好', provider, outputPath, adapterOptions: { endpoint, apiKey } }),
      error => error.message.includes('HTTP ' + code) && (count === 3 || error.retryable === false));
    assert.equal(requests.length - before, count, 'HTTP ' + code);
  }
});

test('豆包 HTTP 200 中的参数、音色或授权错误只请求一次，并发限流仍重试', async t => {
  const { synthesizeSentence } = require('../src/services/ttsService');
  let record;
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res => res.end(JSON.stringify(record) + '\n'));
  for (const [code, message, count] of [
    [40402003, 'text too long', 1], [45000001, '', 1], [45000002, '', 1], [45000010, '', 1],
    [45000000, 'speaker not granted for this resource', 1], [45000000, 'permission denied', 1],
    [45002001, 'no readable text', 1], [413, '', 1],
    [45000000, 'no permission to use concurrent resource seed-tts-1.0-concurr', 1],
    [45000000, 'concurrent resource not activated, QPS limit applies', 1],
    [45000000, '资源未开通，无法提高并发限制', 1],
    [45000000, 'concurrent resource seed-tts-1.0-concurr', 1],
    [45000000, '并发数超过限制', 3],
    [45000000, 'permission denied for seed-tts-1.0-concurr', 1],
    [45000000, 'unauthorized for concurrent requests', 1],
    [45000000, 'request body too large', 1],
    [45000000, 'payload size exceeds the rate limit', 1],
    [45000000, 'generic provider error', 1],
    [45000000, 'quota not enough for voice', 1], [45000000, 'resource concurrency limit exceeded', 3],
  ]) {
    record = { code, message };
    const before = requests.length;
    await assert.rejects(synthesizeSentence({ text: '你好', provider, outputPath, adapterOptions: { endpoint, apiKey } }),
      error => error.message.includes(String(code)) && (count === 3 || error.retryable === false));
    assert.equal(requests.length - before, count, message);
  }
});

test('完整的无权限错误即使缺少末尾换行且连接保活也只请求一次', async t => {
  const { synthesizeSentence } = require('../src/services/ttsService');
  const { endpoint, outputPath, requests } = await httpTtsFixture(t, res =>
    res.write('{"code":45000000,"message":"speaker not granted"}'));
  await assert.rejects(synthesizeSentence({ text: '你好', provider, outputPath, adapterOptions: { endpoint, apiKey, timeoutMs: 1000 } }),
    { statusCode: 502, retryable: false });
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(outputPath), false);
});
