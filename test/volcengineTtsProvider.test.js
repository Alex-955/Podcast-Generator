const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { volcengineProvider: provider } = require('../src/services/volcengineTtsProvider');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { httpTtsFixture } = require('./helpers/httpTtsFixture');

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
    [200, '{"data":"b29wcw=="}', /MP3/],
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
