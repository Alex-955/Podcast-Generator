const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { minimaxProvider } = require('../src/services/minimaxTtsProvider');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { httpTtsFixture } = require('./helpers/httpTtsFixture');

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
