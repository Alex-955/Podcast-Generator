'use strict';
/**
 * B-F2：MP3 产物完整性校验（严格帧边界 / 截断尾帧 / 帧序列一致性）。
 * 复现修复前缺陷：首帧前 5 字节残片被旧实现误判为 0.024s 的有效 MP3。
 */
const test = require('node:test');
const assert = require('node:assert');
const { analyzeMp3, getMp3DurationSeconds, isValidMp3 } = require('../src/services/mp3Utils');

// MPEG-2 L3 24kHz/48kbps → 帧长 144 字节 / 每帧 576 采样 / 0.024s
const HEADER_24K = Buffer.from([0xff, 0xf3, 0x64, 0xc0]);
// MPEG-1 L3 48kHz/128kbps → 帧长 384 字节 / 每帧 1152 采样 / 0.024s
const HEADER_48K = Buffer.from([0xff, 0xfb, 0x94, 0xc0]);

function makeFrame(header, frameLength) {
  const frame = Buffer.alloc(frameLength);
  header.copy(frame, 0);
  return frame;
}
const f24 = () => makeFrame(HEADER_24K, 144);
const f48 = () => makeFrame(HEADER_48K, 384);
const frames24 = (n) => Buffer.concat(Array.from({ length: n }, f24));

test('完整帧序列：有效、帧数与时长精确', () => {
  const buf = frames24(10);
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.frameCount, 10);
  assert.ok(Math.abs(r.durationSeconds - 0.24) < 1e-9);
  assert.strictEqual(isValidMp3(buf), true);
  assert.ok(Math.abs(getMp3DurationSeconds(buf) - 0.24) < 1e-9);
});

test('B-F2 复现：首帧前 5 字节残片不得判为有效', () => {
  const frag = f24().subarray(0, 5);
  const r = analyzeMp3(frag);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'truncated-tail');
  assert.strictEqual(isValidMp3(frag), false);
  assert.strictEqual(getMp3DurationSeconds(frag), 0);
});

test('截断尾帧拒绝：完整帧 + 半帧尾巴按残缺处理', () => {
  const buf = Buffer.concat([frames24(3), f24().subarray(0, 50)]);
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'truncated-tail');
  assert.strictEqual(getMp3DurationSeconds(buf), 0);
});

test('尾部垃圾字节按帧序列不一致拒绝', () => {
  const buf = Buffer.concat([frames24(3), Buffer.from('XY')]);
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'frame-sequence');
  assert.strictEqual(isValidMp3(buf), false);
});

test('同一 buffer 内混入不同编码流拒绝（帧序列一致性）', () => {
  const buf = Buffer.concat([frames24(2), f48()]);
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'mixed-format');
  assert.strictEqual(isValidMp3(buf), false);
});

test('容忍 ID3v2 头与 ID3v1 尾标签', () => {
  const id3v2 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const id3v1 = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]);
  const buf = Buffer.concat([id3v2, frames24(3), id3v1]);
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.frameCount, 3);
  assert.ok(Math.abs(r.durationSeconds - 0.072) < 1e-9);
});

test('纯垃圾数据拒绝（no-frame）', () => {
  const buf = Buffer.from('这不是 MP3 数据，仅用于触发校验失败');
  const r = analyzeMp3(buf);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-frame');
  assert.strictEqual(getMp3DurationSeconds(buf), 0);
});
