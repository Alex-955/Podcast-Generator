'use strict';
/**
 * B0-4：EdgeTtsAdapter 生命周期回归（全离线，本地假 WebSocket 服务器）。
 * 核心保证：四级超时（connect / first-data / idle / task）快速失败；
 * 失败必清理（不留下产物文件）；产物校验通过后才原子发布；
 * synthesizeSentence 限次重试（3 次），不能以无限重试代替生命周期修复。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EdgeTtsAdapter,
  TtsTimeoutError,
  TtsUpstreamError,
  generateSecMsGecToken,
  buildWsUrl,
  buildSsml,
} = require('../src/services/edgeTtsAdapter');
const { synthesizeSentence } = require('../src/services/ttsService');
const { startFakeEdgeTts } = require('./fakeEdgeTts');
const { makeMp3, FRAME_SECONDS_24K } = require('./helpers/mp3Fixtures');

const FAST_TIMEOUTS = {
  connectTimeoutMs: 500,
  firstDataTimeoutMs: 250,
  idleTimeoutMs: 250,
  taskTimeoutMs: 3000,
};

function tmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-adapter-'));
  return path.join(dir, 'sentence_000.mp3');
}

function makeAdapter(endpoint, overrides = {}) {
  return new EdgeTtsAdapter({
    voice: 'zh-CN-YunxiNeural',
    endpoint,
    ...FAST_TIMEOUTS,
    ...overrides,
  });
}

test('ok：完整音频原子发布且时长按帧计数精确', async () => {
  const payload = makeMp3(50); // 50 帧 × 0.024s = 1.2s
  const fake = await startFakeEdgeTts({ mode: 'ok', payload });
  const target = tmpTarget();
  try {
    const result = await makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target);
    assert.strictEqual(result.filePath, target);
    assert.strictEqual(result.bytes, payload.length);
    assert.ok(Math.abs(result.duration - 50 * FRAME_SECONDS_24K) < 1e-9);
    assert.ok(fs.existsSync(target));
    assert.ok(fs.readdirSync(path.dirname(target)).every((f) => !f.includes('.tmp-')), '不应留下临时文件');
  } finally {
    await fake.close();
  }
});

test('no-data：first-data 超时快速失败且不留下产物', async () => {
  const fake = await startFakeEdgeTts({ mode: 'no-data', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target),
      (e) => e instanceof TtsTimeoutError && e.phase === 'first-data'
    );
    assert.ok(!fs.existsSync(target), '失败不能留下产物文件');
  } finally {
    await fake.close();
  }
});

test('stall-mid：流中途停顿触发 idle 超时', async () => {
  const fake = await startFakeEdgeTts({ mode: 'stall-mid', payload: makeMp3(50) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target),
      (e) => e instanceof TtsTimeoutError && e.phase === 'idle'
    );
    assert.ok(!fs.existsSync(target));
  } finally {
    await fake.close();
  }
});

test('late：首包晚于 first-data 阈值即拒绝；阈值内可成功', async () => {
  const payload = makeMp3(10);
  const slow = await startFakeEdgeTts({ mode: 'late', payload, delayMs: 600 });
  try {
    await assert.rejects(
      () => makeAdapter(slow.endpoint).synthesizeToFile('测试句子', tmpTarget()),
      (e) => e instanceof TtsTimeoutError && e.phase === 'first-data'
    );
  } finally {
    await slow.close();
  }

  const ok = await startFakeEdgeTts({ mode: 'late', payload, delayMs: 30 });
  const target = tmpTarget();
  try {
    const result = await makeAdapter(ok.endpoint).synthesizeToFile('测试句子', target);
    assert.strictEqual(result.bytes, payload.length);
  } finally {
    await ok.close();
  }
});

test('task：整项总超时覆盖连接在内的全生命周期', async () => {
  const fake = await startFakeEdgeTts({ mode: 'no-data', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint, { taskTimeoutMs: 120, firstDataTimeoutMs: 5000 }).synthesizeToFile('测试', target),
      (e) => e instanceof TtsTimeoutError && e.phase === 'task'
    );
  } finally {
    await fake.close();
  }
});

test('garbage：产物不是有效 MP3 时拒绝发布', async () => {
  const fake = await startFakeEdgeTts({ mode: 'garbage', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target),
      (e) => e instanceof TtsUpstreamError
    );
    assert.ok(!fs.existsSync(target));
  } finally {
    await fake.close();
  }
});

test('no-separator：协议缺分隔符报协议错误', async () => {
  const fake = await startFakeEdgeTts({ mode: 'no-separator', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target),
      (e) => e instanceof TtsUpstreamError && /分隔符/.test(e.message)
    );
  } finally {
    await fake.close();
  }
});

test('close-early：连接提前关闭报音频不完整', async () => {
  const fake = await startFakeEdgeTts({ mode: 'close-early', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () => makeAdapter(fake.endpoint).synthesizeToFile('测试句子', target),
      (e) => e instanceof TtsUpstreamError && /提前关闭/.test(e.message)
    );
  } finally {
    await fake.close();
  }
});

test('synthesizeSentence：前两次失败第三次成功（限次重试）', async () => {
  const payload = makeMp3(10);
  const fake = await startFakeEdgeTts({
    mode: 'ok',
    payload,
    onConnection: (conn) => {
      conn.mode = conn.index < 2 ? 'close-early' : 'ok';
    },
  });
  const target = tmpTarget();
  try {
    const result = await synthesizeSentence({
      text: '重试测试',
      voice: 'zh-CN-YunxiNeural',
      outputPath: target,
      adapterOptions: { endpoint: fake.endpoint, ...FAST_TIMEOUTS },
    });
    assert.strictEqual(result.filePath, target);
    assert.strictEqual(fake.connections.length, 3);
  } finally {
    await fake.close();
  }
});

test('synthesizeSentence：连续失败最多尝试 3 次并报 502', async () => {
  const fake = await startFakeEdgeTts({ mode: 'close-early', payload: makeMp3(10) });
  const target = tmpTarget();
  try {
    await assert.rejects(
      () =>
        synthesizeSentence({
          text: '重试测试',
          voice: 'zh-CN-YunxiNeural',
          outputPath: target,
          adapterOptions: { endpoint: fake.endpoint, ...FAST_TIMEOUTS },
        }),
      (e) => e.statusCode === 502 && /已尝试 3 次/.test(e.message)
    );
    assert.strictEqual(fake.connections.length, 3, '不能无限重试');
    assert.ok(!fs.existsSync(target));
  } finally {
    await fake.close();
  }
});

test('token 与 URL 构造：Sec-MS-GEC 为 64 位大写十六进制且带齐协议参数', () => {
  const token = generateSecMsGecToken();
  assert.match(token, /^[0-9A-F]{64}$/);
  assert.strictEqual(token, generateSecMsGecToken(), '同一 300s 窗口内应稳定');

  const url = new URL(buildWsUrl('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'));
  assert.strictEqual(url.searchParams.get('TrustedClientToken'), '6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  assert.match(url.searchParams.get('Sec-MS-GEC'), /^[0-9A-F]{64}$/);
  assert.match(url.searchParams.get('Sec-MS-GEC-Version'), /^1-/);
});

test('SSML 构造：XML 特殊字符转义', () => {
  const ssml = buildSsml('a<b>&"c\'', { voice: 'zh-CN-YunxiNeural', lang: 'zh-CN', rate: '+0%', pitch: '+0Hz', volume: 'default' });
  assert.ok(ssml.includes('zh-CN-YunxiNeural'));
  assert.ok(ssml.includes('&lt;b&gt;&amp;&quot;c&apos;'));
  assert.ok(!ssml.includes('<b>'));
});
