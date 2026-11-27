const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildCacheKey, createTtsCache, speechScopeHash } = require('../src/services/ttsCache');
const { normalizeSpeechText, synthesizeSentence, synthesizeDialogueScript, DEFAULT_VOICES, TTS_CHECKPOINT_FILENAME } = require('../src/services/ttsService');
const { makeMp3 } = require('./helpers/mp3Fixtures');
const { getMp3DurationSeconds } = require('../src/services/mp3Utils');
const { resolveSpeechRate } = require('../src/services/ttsProvider');

const input = { provider: 'edge', model: 'v1', voice: 'voice', rate: '+0%', pitch: '+0Hz', text: '早上好' };
const key = buildCacheKey(input);

test('缓存键稳定且区分所有影响声音的字段', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(buildCacheKey({ ...input, text: ' 早上好 ' }), key);
  for (const field of Object.keys(input)) {
    assert.notEqual(buildCacheKey({ ...input, [field]: input[field] + '2' }), key);
  }
});

test('各厂商的任务语速进入原生请求和缓存键，显式台词速率优先', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-rate-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const audio = makeMp3(2);
  const dialogue = [{ speaker: '阿泽', text: '常见的 1080p 视频' }, { speaker: '阿泽', text: '特别的台词', rate: '+8%' }];
  for (const [id, expectedRelaxedRate] of [['edge', '-8%'], ['minimax', '-10%'], ['volcengine', '-10%']]) {
    const calls = [];
    const provider = { id, model: 'test', defaultVoices: DEFAULT_VOICES, synthesizeToFile({ text, rate, outputPath }) {
      calls.push([text, rate]);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.048 };
    } };
    for (const [index, [speed, hits]] of [['relaxed', 0], ['standard', 1], ['relaxed', 2], ['standard', 2]].entries()) {
      const rate = resolveSpeechRate(id, speed);
      const workDir = path.join(root, id, String(index));
      const result = await synthesizeDialogueScript(dialogue, workDir, null, { provider, rate, cache });
      assert.equal(result.cachedSegments, hits);
      assert.deepEqual(result.dialogue.map(line => line.text), dialogue.map(line => line.text));
      const key = buildCacheKey({ provider: id, model: 'test', voice: DEFAULT_VOICES.阿泽, rate, text: '常见的 一千零八十P 视频' });
      assert.equal(fs.existsSync(cache.getPath(key)), true);
    }
    assert.deepEqual(calls, [
      ['常见的 一千零八十P 视频', expectedRelaxedRate], ['特别的台词', '+8%'], ['常见的 一千零八十P 视频', '+0%'],
    ]);
  }
});

test('情绪区分缓存，省略或填写空情绪均保留旧缓存键', () => {
  const previousFields = [input.provider, input.model, input.voice, input.rate, input.pitch, input.text, 'scope'];
  const oldKey = createHash('sha256').update(JSON.stringify(previousFields)).digest('hex');
  const scoped = { ...input, scopeHash: 'scope' };
  for (const emotion of [undefined, '', '  ', 1]) assert.equal(buildCacheKey({ ...scoped, emotion }), oldKey);
  const curiousKey = buildCacheKey({ ...scoped, emotion: '好奇' });
  assert.equal(buildCacheKey({ ...scoped, emotion: ' 好奇 ' }), curiousKey);
  assert.notEqual(curiousKey, oldKey);
  assert.notEqual(curiousKey, buildCacheKey({ ...scoped, emotion: '笑意' }));
  assert.equal(buildCacheKey({ ...scoped, toneVersion: ' ' }), oldKey);
  assert.notEqual(buildCacheKey({ ...scoped, toneVersion: 'tone-v2' }), oldKey);
  assert.notEqual(buildCacheKey({ ...scoped, toneVersion: 'tone-v2' }), buildCacheKey({ ...scoped, emotion: 'tone-v2' }));
});

test('语音年份、年代和区间按位读，普通数字保持原样', () => {
  const cases = [
    ['1972 年和1972年', '一九七二年和一九七二年'],
    ['2026 年和2026年', '二零二六年和二零二六年'],
    ['1100年和2099年', '一一零零年和二零九九年'],
    ['1970 年代和1970年代', '一九七零年代和一九七零年代'],
    ['80 年代、90年代、10 年代', '八零年代、九零年代、一零年代'],
    ['3000 年前，5000 年历史，1000 年，1099年，2100年', '3000 年前，5000 年历史，1000 年，1099年，2100年'],
    ['1972 元，1.2024年，12024年，1.90年代，12080 年代，80年', '1972 元，1.2024年，12024年，1.90年代，12080 年代，80年'],
    ['1000—1978 年，1972—2100年，1.1972-1978年', '1000—1978 年，1972—2100年，1.1972-1978年'],
    ['历时1200年，长达 1500 年', '历时1200年，长达 1500 年'],
    ['持续1200至1500年', '持续1200至1500年'],
    ['约1972年出生', '约一九七二年出生'],
    ['约1200年历史，大约1500年时间', '约1200年历史，大约1500年时间'],
    ['近1200到1500年的岁月，约1972至1978年间', '近1200到1500年的岁月，约1972至1978年间'],
    ['大约1972至1978年完成', '大约一九七二至一九七八年完成'],
    ['v2024年版与foo/2024年', 'v2024年版与foo/2024年'],
    ['（https://example.com/2024年），2026年', '（https://example.com/2024年），二零二六年'],
    ['1972 至 1978 年、1972 到 1978 年', '一九七二至一九七八年、一九七二到一九七八年'],
    ...['-', '~', '～', '—', '–'].map(separator => [`1972 ${separator} 1978 年`, '一九七二到一九七八年']),
  ];
  for (const [text, expected] of cases) {
    assert.equal(normalizeSpeechText(text), expected, text);
    assert.equal(normalizeSpeechText(expected), expected, text);
  }
});

test('合成和缓存键使用语音读法，台词与进度保留原文', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-spoken-text-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const legacyAudio = path.join(root, 'legacy.mp3');
  fs.writeFileSync(legacyAudio, makeMp3(2));
  const calls = [];
  const provider = {
    id: 'offline', model: 'v1',
    synthesizeToFile({ outputPath, text }) {
      calls.push(text);
      const audio = makeMp3(5);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.12 };
    },
  };
  const spoken = '始于一九七二年';
  const source = '始于1972 年';
  const cacheKey = text => buildCacheKey({ provider: provider.id, model: provider.model, voice: DEFAULT_VOICES.阿泽, text });
  cache.put(cacheKey(source), legacyAudio);
  for (const text of [null, '', ' \n ']) {
    await assert.rejects(synthesizeSentence({ text, provider }), /合成文本必须是非空字符串/);
  }
  await synthesizeSentence({ text: '2026年', provider, outputPath: path.join(root, 'direct.mp3') });
  const progress = [];
  for (const [index, text] of [source, '始于1972年', spoken].entries()) {
    const dialogue = [{ speaker: '阿泽', text }];
    const result = await synthesizeDialogueScript(dialogue, path.join(root, String(index)), undefined,
      { cache, provider, onProgress: update => progress.push(update.text) });
    assert.equal(result.cachedSegments, index === 0 ? 0 : 1);
    assert.equal(result.dialogue[0].text, text);
    assert.equal(dialogue[0].text, text);
    assert.deepEqual(fs.readFileSync(result.dialogue[0].filePath), makeMp3(5));
  }
  assert.deepEqual(calls, ['二零二六年', spoken]);
  assert.deepEqual(progress, [source, source, '始于1972年', '始于1972年', spoken, spoken]);
  assert.deepEqual(fs.readFileSync(cache.getPath(cacheKey(source))), makeMp3(2));
  assert.deepEqual(fs.readFileSync(cache.getPath(cacheKey(spoken))), makeMp3(5));
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

test('每次合成选择的模型同时用于上游请求与缓存键，缺省音色来自当前服务商', async t => {
  const { createMinimaxProvider } = require('../src/services/minimaxTtsProvider');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-model-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const calls = [];
  const provider = {
    ...createMinimaxProvider({ minRequestIntervalMs: 0 }), synthesizeToFile({ outputPath, voice, emotion, adapterOptions }) {
      calls.push([voice, adapterOptions.model, emotion]);
      const audio = makeMp3(5);
      fs.writeFileSync(outputPath, audio);
      return { bytes: audio.length, duration: 0.12 };
    },
  };
  const cases = [
    ['speech-02-hd', undefined, 0], ['speech-02-turbo', undefined, 0], ['speech-02-hd', undefined, 1],
    ['speech-02-hd', '好奇', 0], ['speech-02-hd', '好奇', 1],
  ];
  for (const [index, [ttsModel, emotion, hits]] of cases.entries()) {
    const result = await synthesizeDialogueScript([{ speaker: '小晓', text: '相同台词', emotion }], path.join(root, String(index)),
      undefined, { cache, provider, ttsModel });
    assert.equal(result.cachedSegments, hits);
  }
  assert.deepEqual(calls, cases.filter(([, , hits]) => hits === 0).map(([model, emotion]) => [provider.defaultVoices.小晓, model, emotion]));
});

test('新版语气绕过旧缓存和断点，匹配分段键后才复用新版断点', async t => {
  const { createMinimaxProvider, DEFAULT_MINIMAX_ENDPOINT } = require('../src/services/minimaxTtsProvider');
  const { volcengineProvider, DEFAULT_VOLCENGINE_ENDPOINT } = require('../src/services/volcengineTtsProvider');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-tone-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const cache = createTtsCache(path.join(root, 'cache'));
  const oldAudio = makeMp3(2);
  const newAudio = makeMp3(5);
  for (const [original, endpoint] of [[createMinimaxProvider({ minRequestIntervalMs: 0 }), DEFAULT_MINIMAX_ENDPOINT],
    [volcengineProvider, DEFAULT_VOLCENGINE_ENDPOINT]]) {
    const calls = [];
    const provider = { ...original, synthesizeToFile({ text, outputPath, emotion }) {
      calls.push([text, emotion]);
      fs.writeFileSync(outputPath, newAudio);
      return { bytes: newAudio.length, duration: 0.12 };
    } };
    const voice = provider.defaultVoices.阿泽;
    const settings = { provider: provider.id, model: provider.model, voice, text: '说到这里', emotion: '兴奋' };
    const credentials = { apiKey: 'offline-voice-key' };
    const legacyScope = speechScopeHash(endpoint, credentials, [voice], provider.availableVoices, endpoint);
    const currentScope = provider.getScopeHash([voice], credentials);
    assert.equal(provider.toneVersion, provider.id === 'minimax' ? 'tone-v3' : 'tone-v2');
    assert.notEqual(currentScope, legacyScope);
    const oldKey = buildCacheKey({ ...settings, scopeHash: legacyScope });
    const newKey = buildCacheKey({ ...settings, scopeHash: currentScope, toneVersion: provider.toneVersion });
    const workDir = path.join(root, provider.id);
    fs.mkdirSync(workDir);
    const segment = path.join(workDir, 'sentence_000.mp3');
    const checkpointFile = path.join(workDir, TTS_CHECKPOINT_FILENAME);
    fs.writeFileSync(segment, oldAudio);
    cache.put(oldKey, segment);
    if (provider.id === 'volcengine') {
      fs.writeFileSync(checkpointFile, JSON.stringify({ toneVersion: 'tone-v1', segments: { 0: oldKey } }));
    }

    const dialogue = [{ speaker: '阿泽', text: settings.text, emotion: settings.emotion }];
    const fresh = await synthesizeDialogueScript(dialogue, workDir, null, { cache, provider, adapterOptions: credentials });
    assert.equal(fresh.cachedSegments, 0);
    assert.equal(fresh.reusedSegments, 0);
    assert.deepEqual(fs.readFileSync(segment), newAudio);
    assert.deepEqual(fs.readFileSync(cache.getPath(oldKey)), oldAudio);
    assert.deepEqual(fs.readFileSync(cache.getPath(newKey)), newAudio);
    assert.deepEqual(JSON.parse(fs.readFileSync(checkpointFile)), { toneVersion: provider.toneVersion, segments: { 0: newKey } });

    const resumeWithoutCache = () => synthesizeDialogueScript(dialogue, workDir, null, { provider, adapterOptions: credentials });
    assert.equal((await resumeWithoutCache()).reusedSegments, 1);
    fs.writeFileSync(segment, oldAudio);
    fs.writeFileSync(checkpointFile, JSON.stringify({ toneVersion: provider.toneVersion, segments: { 0: oldKey } }));
    assert.equal((await resumeWithoutCache()).reusedSegments, 0);
    assert.deepEqual(fs.readFileSync(segment), newAudio);
    assert.deepEqual(calls, [[settings.text, settings.emotion], [settings.text, settings.emotion]]);
  }
});

test('Edge 首次续跑重合成年份台词，第二次只复用匹配口播键的断点', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-speech-checkpoint-'));
  t.after(() => fs.rmSync(workDir, { recursive: true }));
  const legacyAudio = makeMp3(2);
  const newAudio = makeMp3(5);
  const calls = [];
  const provider = { id: 'edge', model: 'offline', synthesizeToFile({ text, outputPath }) {
    calls.push(text);
    fs.writeFileSync(outputPath, newAudio);
    return { bytes: newAudio.length, duration: 0.12 };
  } };
  const rawYear = '始于1972 年';
  const spokenYear = '始于一九七二年';
  const dialogue = [rawYear, '原样复用', '补合成普通台词'].map(text => ({ speaker: '阿泽', text }));
  const legacyYearPath = path.join(workDir, 'sentence_000.mp3');
  const ordinaryPath = path.join(workDir, 'sentence_001.mp3');
  fs.writeFileSync(legacyYearPath, legacyAudio);
  fs.writeFileSync(ordinaryPath, legacyAudio);

  const run = () => synthesizeDialogueScript(dialogue, workDir, null, { provider });
  const fresh = await run();
  assert.equal(fresh.reusedSegments, 1);
  assert.deepEqual(calls, [spokenYear, '补合成普通台词']);
  assert.deepEqual(fs.readFileSync(legacyYearPath), newAudio);
  assert.deepEqual(fs.readFileSync(ordinaryPath), legacyAudio);
  assert.equal(fresh.dialogue[0].text, rawYear);
  const keyFor = text => buildCacheKey({ provider: provider.id, model: provider.model, voice: DEFAULT_VOICES.阿泽, text });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, TTS_CHECKPOINT_FILENAME)));
  assert.deepEqual(checkpoint, { toneVersion: 'speech-v1', segments: { 0: keyFor(spokenYear), 2: keyFor(dialogue[2].text) } });

  assert.equal((await run()).reusedSegments, 3);
  assert.deepEqual(calls, [spokenYear, '补合成普通台词']);
});

test('官方预置音色共享缓存，自定义服务只使用实际选中的认证方式生成摘要', () => {
  const { volcengineProvider: provider, DEFAULT_VOLCENGINE_ENDPOINT } = require('../src/services/volcengineTtsProvider');
  const voice = provider.defaultVoices.阿泽;
  const hash = (options, id = voice) => provider.getScopeHash([id], options);
  assert.equal(hash({ apiKey: 'key-A' }), hash({ endpoint: DEFAULT_VOLCENGINE_ENDPOINT, apiKey: 'key-B' }));
  assert.notEqual(hash({ apiKey: 'key-A' }, 'S_private'), hash({ apiKey: 'key-B' }, 'S_private'));
  const endpoint = 'https://custom.example/speech';
  assert.equal(hash({ endpoint, apiKey: 'key-A' }), hash({ endpoint, apiKey: ' key-A ', appId: 'unused', accessKey: 'unused' }));
  const pair = { endpoint, appId: 'app-A', accessKey: 'access-A' };
  assert.equal(hash(pair), hash({ ...pair, appId: ' app-A ', accessKey: ' access-A ' }));
  assert.notEqual(hash(pair), hash({ ...pair, appId: 'app-B' }));
  assert.notEqual(hash(pair), hash({ ...pair, accessKey: 'access-B' }));
});

function cacheFixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-cache-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  const audio = makeMp3(2);
  const source = path.join(root, 'source.mp3');
  fs.writeFileSync(source, audio);
  let time = Date.UTC(2026, 0, 1);
  const cache = createTtsCache(cacheDir, { ...options(audio), now: () => time });
  return {
    cacheDir, cache, source, audio, root,
    keys: ['a', 'b', 'c'].map(value => value.repeat(64)),
    files: () => fs.readdirSync(cacheDir).sort(),
    advance: ms => { time += ms; },
  };
}

test('缓存按字节与文件数淘汰最旧条目，命中保活，重写原键不增加数量', t => {
  for (const limit of ['maxBytes', 'maxFiles']) {
    const { cache, source, root, keys: [a, b, c], files, advance } = cacheFixture(t,
      audio => limit === 'maxBytes' ? { maxBytes: audio.length * 2 } : { maxFiles: 2 });
    cache.put(a, source);
    advance(1000);
    cache.put(b, source);
    advance(1000);
    assert.equal(cache.get(a, path.join(root, 'hit.mp3')).hit, true);
    advance(1000);
    cache.put(c, source);
    assert.deepEqual(files(), [a + '.mp3', c + '.mp3']);
    cache.put(c, source);
    assert.deepEqual(files(), [a + '.mp3', c + '.mp3']);
  }
});

test('缓存过期、同时间按文件名淘汰，并保护当前写入或显式保护的键', t => {
  const { cache, source, keys: [a, b, c], root, files, advance } = cacheFixture(t,
    () => ({ maxFiles: 2, maxAgeMs: 1000 }));
  cache.put(b, source);
  cache.put(a, source);
  cache.put(c, source);
  assert.deepEqual(files(), [b + '.mp3', c + '.mp3']);
  advance(1001);
  assert.equal(cache.get(b, path.join(root, 'expired.mp3')).hit, false);
  cache.prune({ protectKey: c });
  assert.deepEqual(files(), [c + '.mp3']);
  cache.put(a, source);
  assert.deepEqual(files(), [a + '.mp3']);
  advance(1001);
  cache.put(b, source);
  assert.deepEqual(files(), [b + '.mp3']);

  const tiny = cacheFixture(t, () => ({ maxBytes: 1 }));
  tiny.cache.put(a, tiny.source);
  assert.deepEqual(tiny.files(), [a + '.mp3']);
  tiny.cache.prune();
  assert.deepEqual(tiny.files(), []);
});

test('缓存清理只处理顶层普通缓存文件，跳过目录、链接和非缓存文件', t => {
  const { cache, cacheDir, source, audio, keys: [a, b, c], root, files } = cacheFixture(t, () => ({ maxFiles: 0 }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, c + '.mp3'), audio);
  const link = cache.getPath(a);
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    const fileLink = cache.getPath(c);
    fs.symlinkSync(source, fileLink);
    assert.equal(cache.get(c, path.join(root, 'link-hit.mp3')).hit, false);
  }
  fs.mkdirSync(cache.getPath(b));
  fs.writeFileSync(path.join(cache.getPath(b), 'child.mp3'), audio);
  fs.writeFileSync(path.join(cacheDir, 'notes.mp3'), '保留');
  const before = files();
  cache.prune();
  assert.deepEqual(files(), before);
  assert.deepEqual(fs.readFileSync(path.join(outside, c + '.mp3')), audio);

  const linkedCache = createTtsCache(link, { maxFiles: 0 });
  linkedCache.prune();
  assert.equal(linkedCache.get(c, path.join(root, 'root-link-hit.mp3')).hit, false);
  assert.throws(() => linkedCache.put(c, source), /缓存目录无效/);
  assert.deepEqual(fs.readFileSync(path.join(outside, c + '.mp3')), audio);
});

test('prune 只清理超过一小时且身份未变的顶层原子写临时文件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-temp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const temp = i => path.join(dir, '.tmp-ABCDEF01-2345-6789-abcd-' + String(i).padStart(12, '0'));
  const time = 8_000_000;
  for (const [file, age] of [[temp(1), 3600001], [temp(2), 3600000], [temp(3), 4000000], [temp(4) + '.other', 4000000]]) {
    fs.writeFileSync(file, 'original');
    fs.utimesSync(file, (time - age) / 1000, (time - age) / 1000);
  }
  const malformed = path.join(dir, '.tmp-' + 'a'.repeat(36));
  for (const file of [temp(7), temp(8), malformed]) {
    fs.writeFileSync(file, 'old');
    fs.utimesSync(file, 1, 1);
  }
  fs.mkdirSync(temp(5));
  fs.symlinkSync(temp(5), temp(6), process.platform === 'win32' ? 'junction' : 'dir');
  const lstat = fs.lstatSync;
  let observed = false;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    const stat = lstat(file, ...rest);
    if (file === temp(3) && !observed) {
      observed = true;
      fs.renameSync(file, file + '.old');
      fs.writeFileSync(file, 'replacement');
    }
    return stat;
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === temp(7) || from === temp(8)) {
      rename(from, from + '.old');
      fs.writeFileSync(from, 'new arrival');
    }
    if (to === temp(8)) fs.writeFileSync(to, 'concurrent arrival', { flag: 'wx' });
    return rename(from, to);
  });
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === temp(8)) fs.writeFileSync(to, 'concurrent arrival', { flag: 'wx' });
    return link(from, to);
  });
  createTtsCache(dir, { now: () => time }).prune();
  assert.equal(fs.existsSync(temp(1)), false);
  assert.ok(fs.existsSync(temp(2)) && fs.existsSync(temp(4) + '.other'));
  assert.equal(fs.readFileSync(temp(3), 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(temp(7), 'utf8'), 'new arrival');
  assert.equal(fs.readFileSync(temp(8), 'utf8'), 'concurrent arrival');
  assert.equal(fs.readFileSync(malformed, 'utf8'), 'old');
  assert.ok(lstat(temp(6)).isSymbolicLink());
  assert.ok(lstat(temp(5)).isDirectory());
});

test('归档账号摘要始终区分端点和实际认证凭据', () => {
  const { speechAccountHash } = require('../src/services/ttsCache');
  const endpoint = 'https://tts.example/';
  const hash = options => speechAccountHash({ endpoint, ...options });
  assert.equal(hash({ apiKey: 'A' }), hash({ endpoint: 'https://tts.example', apiKey: ' A ', appId: 'unused', accessKey: 'unused' }));
  assert.notEqual(hash({ apiKey: 'A' }), hash({ apiKey: 'B' }));
  assert.notEqual(hash({ apiKey: 'A' }), hash({ apiKey: 'A', endpoint: endpoint + 'other' }));
  const pair = { appId: 'app', accessKey: 'key' };
  assert.notEqual(hash(pair), hash({ ...pair, appId: 'second' }));
  assert.notEqual(hash(pair), hash({ ...pair, accessKey: 'other' }));
  assert.equal(hash({ appId: 'app' }), undefined);
});
