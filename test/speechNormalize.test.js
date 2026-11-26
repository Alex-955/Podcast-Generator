const test = require('node:test');
const assert = require('node:assert/strict');
const { SPEECH_SPEEDS, normalizeSpeechSpeed, normalizeSpeechText, extractMinimaxPronunciationDict } =
  require('../src/services/speechNormalize');
const { normalizeSpeechText: legacyExport } = require('../src/services/ttsService');

test('语速只接受两档，默认舒缓，也可指定旧任务默认标准', () => {
  assert.ok(Object.isFrozen(SPEECH_SPEEDS));
  assert.deepEqual(SPEECH_SPEEDS, ['relaxed', 'standard']);
  assert.equal(normalizeSpeechSpeed(), 'relaxed');
  assert.equal(normalizeSpeechSpeed(undefined, 'standard'), 'standard');
  assert.equal(normalizeSpeechSpeed('relaxed', 'standard'), 'relaxed');
  assert.equal(normalizeSpeechSpeed('standard'), 'standard');
  for (const invalid of ['', null, 'RELAXED', 'fast', 1, ['standard']]) {
    assert.throws(() => normalizeSpeechSpeed(invalid), { name: 'InputError', statusCode: 400 });
  }
});

test('常见清晰度转成口播读法，保留网址、型号、状态码和原有年份规则', () => {
  assert.equal(legacyExport, normalizeSpeechText);
  const samples = [
    ['480P、720p、1080p、1440P、2160p、1080I', '四百八十P、七百二十P、一千零八十P、一千四百四十P、两千一百六十P、一千零八十i'],
    ['1080P高清、720p.', '一千零八十P高清、七百二十P.'],
    ['https://video.example/1080p?source=720P，www.video.example/1080P 1080p',
      'https://video.example/1080p?source=720P，www.video.example/1080P 一千零八十P'],
    ['GPT-4o、iPhone 16、HTTP 404、x1080p、2160px、1080p.mp4、a/720P、1.720p、1080',
      'GPT-4o、iPhone 16、HTTP 404、x1080p、2160px、1080p.mp4、a/720P、1.720p、1080'],
    ['2026年有1080P，90年代，历时1200年', '二零二六年有一千零八十P，九零年代，历时1200年'],
  ];
  for (const [raw, spoken] of samples) {
    assert.equal(normalizeSpeechText(raw), spoken);
    assert.equal(normalizeSpeechText(spoken), spoken);
  }
});

test('MiniMax 发音字典只提取当前台词命中的完整词组，重复词只发送一次', () => {
  assert.deepEqual(extractMinimaxPronunciationDict('重要的行为和长期计划'), []);
  assert.deepEqual(extractMinimaxPronunciationDict(null), []);
  assert.deepEqual(extractMinimaxPronunciationDict('重新重算，重新处理。下载、转载，再校对主角的台词，着重讲成长。'), [
    '重算/(chong2)(suan4)', '重新/(chong2)(xin1)', '处理/(chu3)(li3)', '下载/(xia4)(zai4)', '转载/(zhuan3)(zai3)',
    '校对/(jiao4)(dui4)', '主角/(zhu3)(jue2)', '着重/(zhuo2)(zhong4)', '成长/(cheng2)(zhang3)',
  ]);
});

test('MiniMax 发音字典保留“同行”的语境读音', () => {
  assert.deepEqual(extractMinimaxPronunciationDict('我和你同行'), []);
  assert.deepEqual(extractMinimaxPronunciationDict('银行行长谈行业发展'), [
    '行长/(hang2)(zhang3)', '行业/(hang2)(ye4)', '银行/(yin2)(hang2)',
  ]);
});
