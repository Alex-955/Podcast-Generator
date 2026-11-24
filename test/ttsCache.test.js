const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCacheKey, createTtsCache } = require('../src/services/ttsCache');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { getMp3DurationSeconds } = require('../src/services/mp3Utils');

const input = { provider: 'edge', model: 'v1', voice: 'voice', rate: '+0%', pitch: '+0Hz', text: '早上好' };
const key = buildCacheKey(input);

test('缓存键稳定且区分所有影响声音的字段', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(buildCacheKey({ ...input, text: ' 早上好 ' }), key);
  for (const field of Object.keys(input)) {
    assert.notEqual(buildCacheKey({ ...input, [field]: input[field] + '2' }), key);
  }
});

test('缓存校验原始音频，原子复制，损坏时清除并允许重建', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const cache = createTtsCache(path.join(dir, 'cache'));
  const source = path.join(dir, 'source.mp3');
  const target = path.join(dir, 'work', 'line.mp3');
  const mp3 = makeMp3(12);
  assert.deepEqual(cache.get(key, target), { hit: false });
  assert.throws(() => cache.getPath('../bad'));
  fs.writeFileSync(source, mp3);
  cache.put(key, source);
  assert.deepEqual(cache.get(key, target), {
    hit: true, bytes: mp3.length, filePath: target, duration: getMp3DurationSeconds(mp3),
  });
  assert.deepEqual(fs.readFileSync(target), mp3);
  fs.writeFileSync(source, 'bad');
  assert.throws(() => cache.put(key, source), /MP3/);
  assert.deepEqual(fs.readFileSync(cache.getPath(key)), mp3);
  fs.writeFileSync(cache.getPath(key), 'corrupt');
  assert.deepEqual(cache.get(key, target), { hit: false });
  assert.equal(fs.existsSync(cache.getPath(key)), false);
  fs.writeFileSync(source, mp3);
  cache.put(key, source);
  assert.throws(() => cache.get(key, path.dirname(target))); // rename onto existing directory
  assert.ok(fs.readdirSync(dir, { recursive: true }).every(f => !f.includes('.tmp-')));
});

test('逐句合成优先复用工作目录，然后查缓存，且报告两种命中数', async t => {
  const { synthesizeDialogueScript, DEFAULT_VOICES } = require('../src/services/ttsService');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const source = path.join(work, 'sentence_000.mp3');
  fs.writeFileSync(source, makeMp3(10));
  fs.writeFileSync(path.join(work, 'sentence_001.mp3'), '残缺');
  const dialogue = ['已完成', '缓存', '新台词'].map(text => ({ speaker: '阿泽', text }));
  const provider = {
    id: 'test', model: 'v1',
    synthesizeToFile({ text, outputPath }) {
      assert.equal(text, '新台词');
      const mp3 = makeMp3(15);
      fs.writeFileSync(outputPath, mp3);
      return { bytes: mp3.length, duration: getMp3DurationSeconds(mp3) };
    },
  };
  cache.put(buildCacheKey({ provider: provider.id, model: provider.model, voice: DEFAULT_VOICES.阿泽, text: '缓存' }), source);
  const progress = [];
  const result = await synthesizeDialogueScript(dialogue, work, null, {
    cache, provider, onProgress: p => progress.push([p.completedSegments, p.cachedSegments, p.reusedSegments]),
  });
  assert.deepEqual(progress, [[0, 0, 0], [1, 1, 1], [1, 1, 1], [2, 2, 1], [2, 2, 1], [3, 2, 1]]);
  assert.equal(result.cachedSegments, 2);
  assert.equal(result.reusedSegments, 1);
});
