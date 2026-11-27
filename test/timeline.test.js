'use strict';
/**
 * B0-5 时间轴回归：gap 帧量化（0.42s → 0.432s）与时间轴口径一致。
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

function setupEntries(t, frameCounts, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    entries: frameCounts.map((frames, i) => writeEntry(dir, i, frames, options)),
  };
}

test('B0-5：0.42s gap 量化为 18 帧 / 0.432s，时间轴与合并器同口径', t => {
  const { entries } = setupEntries(t, [50, 25, 125]); // 1.2s / 0.6s / 3.0s
  const timeline = buildSentenceTimeline(entries);

  assert.strictEqual(timeline.measurement, 'mp3-frame-count');
  assert.strictEqual(timeline.sentenceGapFrames, 18); // ceil(0.42*24000/576)
  approx(timeline.sentenceGap, 0.432);
  // 修复目标：不再按 0.42s 累计造成漂移
  assert.ok(Math.abs(timeline.sentenceGap - 0.42) > 0.005);

  const [s0, s1, s2] = timeline.sentences;
  approx(s0.startTime, 0);
  approx(s0.endTime, 1.2);
  approx(s1.startTime, 1.632); // 1.2 + 0.432
  approx(s1.endTime, 2.232);
  approx(s2.startTime, 2.664); // 2.232 + 0.432
  approx(s2.endTime, 5.664);
  approx(timeline.totalDuration, 5.664);

  // 静音帧生成（audioMerger 使用）与时间轴 gap 用同一个 computeGap 结果
  const format = scanMp3Format(fs.readFileSync(entries[0].filePath));
  const gap = computeGap(format, SENTENCE_GAP_SECONDS);
  assert.strictEqual(gap.frameCount, 18);
  const silence = buildSilenceFrames(format, SENTENCE_GAP_SECONDS);
  assert.strictEqual(silence.length, 18 * FRAME_SIZE_24K);
});

test('B0-5：20 段时间轴单调无漂移', t => {
  const { entries } = setupEntries(t, Array.from({ length: 20 }, () => 10)); // 每段 0.24s
  const timeline = buildSentenceTimeline(entries);

  assert.strictEqual(timeline.sentences.length, 20);
  approx(timeline.sentenceGap, 0.432);

  let sumDurations = 0;
  timeline.sentences.forEach((sentence, i) => {
    approx(sentence.startTime, i * (0.24 + 0.432));
    approx(sentence.endTime, sentence.startTime + 0.24);
    approx(sentence.duration, 0.24);
    if (i > 0) {
      approx(sentence.startTime - timeline.sentences[i - 1].endTime, timeline.sentenceGap);
    }
    sumDurations += sentence.duration;
  });

  // 验收口径：总时长 = 逐段时长之和 + 逐段 gap 之和，0 漂移
  approx(timeline.totalDuration, sumDurations + 19 * timeline.sentenceGap);
  approx(timeline.totalDuration, 20 * 0.24 + 19 * 0.432);
});

test('B0-5：100 段时间轴单调无漂移', t => {
  const { entries } = setupEntries(t, Array.from({ length: 100 }, () => 10));
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

test('音频片段编码不一致时拒绝生成时间轴', t => {
  const { entries } = setupEntries(t, [10, 10]);
  fs.writeFileSync(entries[1].filePath, makeMp3(10, { header: HEADER_48K, frameSize: FRAME_SIZE_48K }));
  entries[1].fileName = 'sentence_001.mp3';
  assert.throws(() => buildSentenceTimeline(entries), /编码格式与其他片段不一致/);
});

test('非 MP3 片段拒绝生成时间轴', t => {
  const { entries } = setupEntries(t, [10]);
  fs.writeFileSync(entries[0].filePath, '这不是 MP3 数据');
  assert.throws(() => buildSentenceTimeline(entries), /不是有效 MP3/);
});

test('空列表拒绝生成时间轴', () => {
  assert.throws(() => buildSentenceTimeline([]), /没有可合成的台词/);
});

test('单独调用拼接器时拒绝尾帧被截断的片段，已有成品保持原样', t => {
  const { dir, entries } = setupEntries(t, [4, 3]);
  const files = entries.map(entry => entry.filePath);
  const output = path.join(dir, 'full_podcast.mp3');
  concatenateAudioFiles(files, output);
  const original = fs.readFileSync(output);
  fs.truncateSync(files[1], fs.statSync(files[1]).size - 1);
  assert.throws(() => concatenateAudioFiles(files, output), /不是有效 MP3/);
  assert.deepStrictEqual(fs.readFileSync(output), original);
});

test('多段带 ID3v2 头、ID3v1 尾的 CBR 音频可跨缓冲区拼接，字幕与成品时长一致', t => {
  const counts = [510, 15, 20];
  const { entries, dir } = setupEntries(t, counts);
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
  const expectedFrames = 510 + 15 + 20 + 2 * 18;
  assert.strictEqual(isValidMp3(combined), true);
  assert.strictEqual(analyzeMp3(combined).frameCount, expectedFrames);
  assert.deepEqual(combined, makeMp3(expectedFrames));
  approx(timeline.totalDuration, analyzeMp3(combined).durationSeconds);
});

test('同采样率的不同码率片段保留逐字节的 Xing Seek Table，与时间轴一致', t => {
  const { dir, entries } = setupEntries(t, [5]);
  entries.push(writeEntry(dir, 1, 7, { header: Buffer.from([0xff, 0xf3, 0x84, 0xc0]), frameSize: 192 }));
  const timeline = buildSentenceTimeline(entries);
  const file = path.join(dir, 'full_podcast.mp3');
  const merged = concatenateAudioFiles(entries.map(e => e.filePath), file);
  const bytes = fs.readFileSync(file);
  const analysis = analyzeMp3(bytes);
  assert.equal(analysis.ok, true);
  assert.equal(bytes.toString('ascii', 13, 17), 'Xing');
  assert.equal(bytes.readUInt32BE(21), analysis.frameCount);
  assert.equal(bytes.readUInt32BE(25), bytes.length);
  const tagBytes = 480;
  const frameSizes = [...Array(5 + 18).fill(144), ...Array(7).fill(192)];
  const expectedTag = Buffer.alloc(tagBytes);
  Buffer.from([0xff, 0xf3, 0xe4, 0xc0]).copy(expectedTag);
  expectedTag.write('Xing', 13);
  expectedTag.writeUInt32BE(7, 17);
  expectedTag.writeUInt32BE(frameSizes.length, 21);
  expectedTag.writeUInt32BE(bytes.length, 25);
  for (let i = 1; i < 100; i++) {
    const offset = frameSizes.slice(0, Math.floor(frameSizes.length * i / 100)).reduce((sum, length) => sum + length, tagBytes);
    expectedTag[29 + i] = Math.floor(256 * offset / bytes.length);
  }
  assert.equal(merged.fileSize, bytes.length);
  assert.deepEqual(bytes.subarray(0, tagBytes), expectedTag);
  assert.deepEqual(bytes.subarray(tagBytes), Buffer.concat([makeMp3(23), fs.readFileSync(entries[1].filePath)]));
  assert.equal(analysis.frameCount, 12 + timeline.sentenceGapFrames);
  approx(analysis.durationSeconds, timeline.totalDuration);
});

test('Xing、Info 和 VBRI 单段统计不计入字幕与完整节目时长', t => {
  const { dir, entries } = setupEntries(t, [7, 9, 10]);
  const tags = ['Xing', 'Info', 'VBRI'];
  for (const [index, entry] of entries.entries()) {
    const tag = makeMp3(1);
    const pos = index === 2 ? 36 : 13;
    tag.write(tags[index], pos);
    tag.writeUInt32BE(7, pos + 4);
    tag.writeUInt32BE(999999, pos + 8);
    fs.writeFileSync(entry.filePath, Buffer.concat([tag, fs.readFileSync(entry.filePath)]));
  }
  const timeline = buildSentenceTimeline(entries);
  const out = path.join(dir, 'full.mp3');
  concatenateAudioFiles(entries.map(e => e.filePath), out);
  const bytes = fs.readFileSync(out);
  for (const tag of tags) assert.equal(bytes.indexOf(tag), -1);
  const analysis = analyzeMp3(bytes);
  assert.equal(analysis.frameCount, 26 + 2 * timeline.sentenceGapFrames);
  approx(timeline.totalDuration, analysis.durationSeconds);
});

test('拼接器对缺失、无效或编码不兼容的片段抛出原有错误并且不创建产物', t => {
  const { dir, entries } = setupEntries(t, [2]);
  const missing = path.join(dir, 'missing.mp3');
  const bad = path.join(dir, 'invalid.mp3');
  const incompatible = writeEntry(dir, 1, 2, { header: HEADER_48K, frameSize: FRAME_SIZE_48K });
  fs.writeFileSync(bad, '无效片段');
  const out = path.join(dir, 'full.mp3');
  const before = fs.readdirSync(dir);
  for (const [file, message] of [
    [missing, '音频片段缺失，拒绝拼接：missing.mp3'],
    [bad, '音频片段不是有效 MP3，拒绝拼接：invalid.mp3'],
    [incompatible.filePath, '音频片段编码格式与其他片段不一致，拒绝拼接：sentence_001.mp3'],
  ]) {
    assert.throws(() => concatenateAudioFiles([entries[0].filePath, file], out), { message });
    assert.deepEqual(fs.readdirSync(dir), before);
  }
});

test('拼接器循环处理短写，写失败后清理临时文件并保留已有成品', t => {
  const { dir, entries } = setupEntries(t, [5, 7]);
  const out = path.join(dir, 'full.mp3');
  const files = entries.map(entry => entry.filePath);
  const write = fs.writeSync;
  const shortWrite = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length) =>
    write(fd, buffer, offset, Math.min(length, 200)));
  concatenateAudioFiles(files, out);
  shortWrite.mock.restore();
  const complete = fs.readFileSync(out);
  assert.deepEqual(complete, makeMp3(30));

  const before = fs.readdirSync(dir);
  let calls = 0;
  const error = new Error('模拟音频写失败');
  const failedWrite = t.mock.method(fs, 'writeSync', (...args) => {
    if (++calls === 2) throw error;
    return write(...args);
  });
  try {
    assert.throws(() => concatenateAudioFiles(files, out), error);
  } finally {
    failedWrite.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(dir), before);
  assert.deepEqual(fs.readFileSync(out), complete);
});

for (const change of ['替换', '修改']) {
  test('两遍拼接之间' + change + '同长度片段时保留原成品', t => {
    const { dir, entries } = setupEntries(t, [10]);
    const input = entries[0].filePath;
    const output = path.join(dir, 'output.mp3');
    fs.writeFileSync(output, 'previous');
    const data = fs.readFileSync(input);
    const previous = fs.statSync(input);
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
      if (flags === 'wx' && path.basename(file).startsWith('.tmp-')) {
        if (change === '替换') {
          fs.writeFileSync(input + '.next', data);
          fs.utimesSync(input + '.next', previous.atime, previous.mtime);
          fs.renameSync(input + '.next', input);
        } else {
          fs.writeFileSync(input, data);
          fs.utimesSync(input, 1, 1);
        }
      }
      return open(file, flags, ...rest);
    });
    assert.throws(() => concatenateAudioFiles([input], output), /片段在拼接时已改变/);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'previous');
    assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('.tmp-')));
  });
}
