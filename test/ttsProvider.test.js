'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_PROVIDER_ID, getTtsProvider, registerTtsProvider, listTtsProviders } = require('../src/services/ttsProvider');
const { DEFAULT_VOICES, AVAILABLE_VOICES } = require('../src/services/ttsService');
const { startFakeEdgeTts } = require('./fakeEdgeTts');
const { makeMp3 } = require('./helpers/mp3Fixtures');

test('默认注册 Edge Provider 并复用现有音色配置', () => {
  assert.equal(DEFAULT_PROVIDER_ID, 'edge');
  const provider = getTtsProvider();
  assert.equal(provider, getTtsProvider('edge'));
  assert.equal(provider.id, 'edge');
  assert.equal(provider.model, 'edge-readaloud-24k48k');
  assert.deepEqual(provider.defaultVoices, DEFAULT_VOICES);
  assert.deepEqual(provider.availableVoices, AVAILABLE_VOICES);
  assert.ok(listTtsProviders().includes(provider));
});

test('可以注册和列出自定义 Provider，未知 id 与不完整的契约给出明确错误', () => {
  assert.throws(() => getTtsProvider('missing'), /未注册.*missing/);
  assert.throws(() => registerTtsProvider({ id: 'incomplete' }), TypeError);
  const provider = {
    id: 'test',
    model: 'test-model',
    defaultVoices: { 阿泽: 'test-voice' },
    availableVoices: [{ id: 'test-voice' }],
    async synthesizeToFile() {},
  };
  registerTtsProvider(provider);
  assert.equal(getTtsProvider('test'), provider);
  assert.ok(listTtsProviders().includes(provider));
});

test('Edge Provider 委托本地假 WebSocket 合成并返回音频信息', async () => {
  const payload = makeMp3(10);
  const fake = await startFakeEdgeTts({ payload });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-provider-'));
  try {
    const outputPath = path.join(dir, 'sentence.mp3');
    const provider = getTtsProvider();
    const result = await provider.synthesizeToFile({
      text: '离线合成测试',
      voice: provider.defaultVoices.小晓,
      outputPath,
      rate: '+10%',
      pitch: '+2Hz',
      adapterOptions: { endpoint: fake.endpoint },
    });
    assert.equal(fake.connections.length, 1);
    assert.equal(result.filePath, outputPath);
    assert.equal(result.bytes, payload.length);
    assert.ok(result.duration > 0);
    assert.deepEqual(fs.readFileSync(outputPath), payload);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('Edge Provider 透传取消信号，合成结束时无残留文件', async () => {
  const controller = new AbortController();
  const fake = await startFakeEdgeTts({
    mode: 'no-data',
    payload: makeMp3(10),
    onConnection: () => controller.abort(),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-provider-'));
  try {
    await assert.rejects(getTtsProvider().synthesizeToFile({
      text: '离线取消测试',
      outputPath: path.join(dir, 'sentence.mp3'),
      signal: controller.signal,
      adapterOptions: { endpoint: fake.endpoint },
    }), { name: 'AbortError' });
    assert.equal(fake.connections.length, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true });
  }
});
