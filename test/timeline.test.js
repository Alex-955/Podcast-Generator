'use strict';
/**
 * B0-5 时间轴回归：gap 帧量化（0.35s → 0.36s）与时间轴口径一致。
 * B0-5 验收：20 段时 totalDuration 与「逐段时长 + 逐段 gap」之和 0 漂移；
 * 3 / 20 / 100 段均单调且无漂移。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSentenceTimeline, SENTENCE_GAP_SECONDS } = require('../src/services/ttsService');
const { makeMp3, HEADER_24K, HEADER_48K, FRAME_SIZE_48K, FRAME_SIZE_24K } = require('./helpers/mp3Fixtures');
const { scanMp3Format, computeGap, buildSilenceFrames, analyzeMp3, isValidMp3 } = require('../src/services/mp3Utils');
const { concatenateAudioFiles } = require('../src/services/audioMerger');

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `期望 ${expected}，实际 ${actual}（差 ${actual - expected}）`
  );
}

function writeEntry(dir, index, frames, { header = HEADER_24K, frameSize = FRAME_SIZE_24K } = {}) {
  const fileName = `sentence_${String(index).padStart(3, '0')}.mp3`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, makeMp3(frames, { header, frameSize }));
  return { filePath, fileName, speaker: index % 2 === 0 ? '阿泽' : '小晓', text: `第${index}句台词` };
}

function setupEntries(frameCounts, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-test-'));
  return {
    dir,
    entries: frameCounts.map((frames, i) => writeEntry(dir, i, frames, options)),
  };
}

test('B0-5：0.35s gap 量化为 15 帧 / 0.36s，时间轴与合并器同口径', () => {
  const { dir, entries } = setupEntries([50, 25, 125]); // 1.2s / 0.6s / 3.0s
  const timeline = buildSentenceTimeline(entries);

  assert.strictEqual(timeline.measurement, 'mp3-frame-count');
  assert.strictEqual(timeline.sentenceGapFrames, 15); // ceil(0.35*24000/576)
  approx(timeline.sentenceGap, 0.36);
  // 修复目标：不再按 0.35s 累计造成漂移
  assert.ok(Math.abs(timeline.sentenceGap - 0.35) > 0.005);

  const [s0, s1, s2] = timeline.sentences;
  approx(s0.startTime, 0);
  approx(s0.endTime, 1.2);
  approx(s1.startTime, 1.56); // 1.2 + 0.36
  approx(s1.endTime, 2.16);
  approx(s2.startTime, 2.52); // 2.16 + 0.36
  approx(s2.endTime, 5.52);
  approx(timeline.totalDuration, 5.52);

  // 静音帧生成（audioMerger 使用）与时间轴 gap 用同一个 computeGap 结果
  const format = scanMp3Format(fs.readFileSync(entries[0].filePath));
  const gap = computeGap(format, SENTENCE_GAP_SECONDS);
  assert.strictEqual(gap.frameCount, 15);
  const silence = buildSilenceFrames(format, SENTENCE_GAP_SECONDS);
  assert.strictEqual(silence.length, 15 * FRAME_SIZE_24K);
});

test('B0-5：20 段时间轴单调无漂移', () => {
  const { entries } = setupEntries(Array.from({ length: 20 }, () => 10)); // 每段 0.24s
  const timeline = buildSentenceTimeline(entries);

  assert.strictEqual(timeline.sentences.length, 20);
  approx(timeline.sentenceGap, 0.36);

  let sumDurations = 0;
  timeline.sentences.forEach((sentence, i) => {
    approx(sentence.startTime, i * (0.24 + 0.36));
    approx(sentence.endTime, sentence.startTime + 0.24);
    approx(sentence.duration, 0.24);
    if (i > 0) {
      approx(sentence.startTime - timeline.sentences[i - 1].endTime, timeline.sentenceGap);
    }
    sumDurations += sentence.duration;
  });

  // 验收口径：总时长 = 逐段时长之和 + 逐段 gap 之和，0 漂移
  approx(timeline.totalDuration, sumDurations + 19 * timeline.sentenceGap);
  approx(timeline.totalDuration, 20 * 0.24 + 19 * 0.36);
});

test('B0-5：100 段时间轴单调无漂移', () => {
  const { entries } = setupEntries(Array.from({ length: 100 }, () => 10));
  const timeline = buildSentenceTimeline(entries);

  assert.strictEqual(timeline.sentences.length, 100);
  let sumDurations = 0;
  let prevEnd = 0;
  timeline.sentences.forEach((sentence) => {
    assert.ok(sentence.startTime >= prevEnd - 1e-9, '时间轴必须单调');
    prevEnd = sentence.endTime;
    sumDurations += sentence.duration;
  });
  approx(timeline.totalDuration, sumDurations + 99 * timeline.sentenceGap);
});

test('音频片段编码不一致时拒绝生成时间轴', () => {
  const { dir, entries } = setupEntries([10, 10]);
  fs.writeFileSync(entries[1].filePath, makeMp3(10, { header: HEADER_48K, frameSize: FRAME_SIZE_48K }));
  entries[1].fileName = 'sentence_001.mp3';
  assert.throws(() => buildSentenceTimeline(entries), /编码格式与其他片段不一致/);
});

test('非 MP3 片段拒绝生成时间轴', () => {
  const { dir, entries } = setupEntries([10]);
  fs.writeFileSync(entries[0].filePath, '这不是 MP3 数据');
  assert.throws(() => buildSentenceTimeline(entries), /不是有效 MP3/);
});

test('空列表拒绝生成时间轴', () => {
  assert.throws(() => buildSentenceTimeline([]), /没有可合成的台词/);
});

test('多段带 ID3v2 头、ID3v1 尾的音频拼接后可逐帧解析，字幕与成品时长一致', t => {
  const counts = [10, 15, 20];
  const { entries, dir } = setupEntries(counts);
  t.after(() => fs.rmSync(dir, { recursive: true }));
  // 4096 字节元数据体超过旧时间轴从原始文件扫描首帧的范围。
  const header = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 32, 0]), Buffer.alloc(4096)]);
  const tail = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]);
  for (const { filePath } of entries) {
    fs.writeFileSync(filePath, Buffer.concat([header, fs.readFileSync(filePath), tail]));
  }
  const timeline = buildSentenceTimeline(entries);
  const file = path.join(dir, 'full_podcast.mp3');
  concatenateAudioFiles(entries.map(entry => entry.filePath), file);
  const combined = fs.readFileSync(file);
  const expectedFrames = 10 + 15 + 20 + 2 * 15;
  assert.strictEqual(isValidMp3(combined), true);
  assert.strictEqual(analyzeMp3(combined).frameCount, expectedFrames);
  assert.strictEqual(combined.length, expectedFrames * FRAME_SIZE_24K);
  approx(timeline.totalDuration, analyzeMp3(combined).durationSeconds);
});
