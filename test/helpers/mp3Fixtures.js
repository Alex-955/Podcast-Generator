'use strict';
/**
 * 合成合法 MP3 帧序列（仅帧头合法 + 全零 payload），供离线测试时长/时间轴/合并使用。
 * 与 Edge-TTS 真实输出同规格：MPEG-2 Layer III, 24kHz, 48kbps, 单声道。
 */

// MPEG-2 L3, 24kHz, 48kbps, mono（frameLength = 72 * 48000 / 24000 = 144）
const HEADER_24K = Buffer.from([0xff, 0xf3, 0x64, 0xc0]);
const FRAME_SIZE_24K = 144;
const SAMPLES_PER_FRAME_24K = 576;
const FRAME_SECONDS_24K = SAMPLES_PER_FRAME_24K / 24000; // 0.024s

// MPEG-1 L3, 48kHz, 128kbps, mono（frameLength = 144 * 128000 / 48000 = 384），用于格式不一致用例
const HEADER_48K = Buffer.from([0xff, 0xfb, 0x94, 0xc0]);
const FRAME_SIZE_48K = 384;

function makeFrame(header, frameSize) {
  const frame = Buffer.alloc(frameSize);
  header.copy(frame, 0);
  return frame;
}

function makeMp3(frameCount, { header = HEADER_24K, frameSize = FRAME_SIZE_24K } = {}) {
  return Buffer.concat(Array.from({ length: frameCount }, () => makeFrame(header, frameSize)));
}

function framesForSeconds(seconds) {
  return Math.round(seconds / FRAME_SECONDS_24K);
}

module.exports = {
  HEADER_24K,
  FRAME_SIZE_24K,
  SAMPLES_PER_FRAME_24K,
  FRAME_SECONDS_24K,
  HEADER_48K,
  FRAME_SIZE_48K,
  makeFrame,
  makeMp3,
  framesForSeconds,
};
