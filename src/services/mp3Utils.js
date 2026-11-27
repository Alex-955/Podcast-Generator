/**
 * 轻量 MP3 工具：帧解析、精确时长计算、静音帧生成
 * 仅依赖二进制解析，不依赖 ffmpeg，支持 MPEG-1 / MPEG-2 / MPEG-2.5 Layer III
 * （Edge-TTS 输出为 MPEG-2 Layer III, 24kHz / 48kbps 单声道）
 *
 * 背景说明：
 * - 句间停顿必须以真实静音帧插入音频流，否则字幕时间轴（按句间 gap 累加）
 *   与实际音频会持续漂移。
 * - 静音帧 = 复用源音频的帧头（清除 padding 位）+ 全零 payload。
 *   全零 Huffman payload 在主流解码器中等价于静音，这是常见的免编码器做法。
 */

// MPEG-1 Layer III 码率表 (kbps)
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
// MPEG-2 / 2.5 Layer III 码率表 (kbps)
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// 各版本的采样率表 (Hz)
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000],  // MPEG-2.5
};

/** 句间自然停顿（秒）。ttsService 的时间轴与此常量保持一致 */
const SENTENCE_GAP_SECONDS = 0.42;

/** 移除 ID3v2 头部（若存在） */
function stripID3(buffer) {
  if (buffer.length > 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    const headerTotal = 10 + size;
    if (buffer.length > headerTotal) {
      return buffer.subarray(headerTotal);
    }
  }
  return buffer;
}

/** 提取供帧解析与拼接共用的音频数据，移除 ID3v2 头和可选的 128 字节 ID3v1 尾标签。 */
function extractMp3Body(buffer) {
  const body = stripID3(buffer);
  const tail = body.length - 128;
  if (tail >= 0 && body[tail] === 0x54 && body[tail + 1] === 0x41 && body[tail + 2] === 0x47) {
    return body.subarray(0, tail);
  }
  return body;
}

/**
 * 解析 offset 处的 MP3 帧头（仅 Layer III）
 * @returns {object|null} 帧信息，非合法帧头时返回 null
 */
function parseFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buf[offset + 1] >> 3) & 0x03; // 0=MPEG2.5, 2=MPEG2, 3=MPEG1
  const layerBits = (buf[offset + 1] >> 1) & 0x03;   // 01 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const bitrateIdx = (buf[offset + 2] >> 4) & 0x0f;
  const samplerateIdx = (buf[offset + 2] >> 2) & 0x03;
  const padding = (buf[offset + 2] >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 0x0f || samplerateIdx === 3) return null;

  const versionLabel = { 0: '2.5', 2: '2', 3: '1' }[versionBits];
  const bitrate = (versionBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][samplerateIdx];
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding;

  return { versionBits, versionLabel, bitrateIdx, samplerateIdx, bitrate, sampleRate, padding, samplesPerFrame, frameLength };
}

/**
 * 从音频数据中定位第一个合法帧，返回流格式信息（含原始帧头 4 字节）
 */
function scanMp3Format(buffer) {
  const maxScan = Math.min(buffer.length - 4, 4096);
  for (let offset = 0; offset < maxScan; offset++) {
    const frame = parseFrameHeader(buffer, offset);
    if (frame) {
      return {
        ...frame,
        rawHeader: Buffer.from(buffer.slice(offset, offset + 4)),
        frameOffset: offset,
      };
    }
  }
  return null;
}

function xingOffset(header, versionBits) {
  const mono = (header[3] >> 6) === 3;
  const sideInfo = versionBits === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return 4 + sideInfo;
}

function hasVbrHeader(body, frame) {
  const bytes = body.subarray(frame.frameOffset, frame.frameOffset + frame.frameLength);
  const offset = xingOffset(frame.rawHeader, frame.versionBits);
  const isXing = pos => ['Xing', 'Info'].includes(bytes.toString('latin1', pos, pos + 4));
  return isXing(offset) || (!(bytes[1] & 1) && isXing(offset + 2)) || bytes.toString('latin1', 36, 40) === 'VBRI';
}

function compatibleFrameFormat(frame, format) {
  return frame.versionBits === format.versionBits &&
    frame.sampleRate === format.sampleRate &&
    frame.samplesPerFrame === format.samplesPerFrame;
}

/**
 * B-F2 严格完整性分析：校验完整帧边界、截断尾帧与帧序列一致性。
 * - 首帧前允许少量前导字节（scanMp3Format 容错），容忍 ID3v2 头与 ID3v1 'TAG' 尾标签
 * - 从首帧起必须帧帧完整落在 buffer 内（offset + frameLength <= length），
 *   否则按 truncated-tail 拒绝——残片/截断产物不得视为有效
 * - 帧边界上解析不出合法帧头按 frame-sequence 拒绝（数据损坏/尾部残片/垃圾字节）
 * - 帧间 version / sampleRate / samplesPerFrame 必须一致，
 *   否则按 mixed-format 拒绝（拼接了不同编码流）
 *
 * @returns {{ok: boolean, reason: string|null, durationSeconds: number, frameCount: number, format: object|null}}
 */
function analyzeMp3(buffer, { onFrame } = {}) {
  const fail = (reason) => ({ ok: false, reason, durationSeconds: 0, frameCount: 0, format: null });
  if (!buffer || buffer.length < 4) return fail('too-short');

  const body = extractMp3Body(buffer);
  let format = scanMp3Format(body);
  if (!format) return fail('no-frame');

  let offset = format.frameOffset;
  if (hasVbrHeader(body, format)) {
    offset += format.frameLength;
    const first = parseFrameHeader(body, offset);
    if (!first || !compatibleFrameFormat(first, format)) return fail('no-audio-frames');
    format = { ...first, frameOffset: offset, rawHeader: Buffer.from(body.subarray(offset, offset + 4)) };
  }
  let variableBitrate = false;
  let totalSamples = 0;
  let frameCount = 0;
  while (offset < body.length) {
    const frame = parseFrameHeader(body, offset);
    if (!frame) return fail('frame-sequence');
    // 完整帧边界：整帧必须落在 buffer 内，截断尾帧直接拒绝
    if (offset + frame.frameLength > body.length) return fail('truncated-tail');
    // 帧序列一致性：版本 / 采样率 / 每帧采样数必须一致
    if (!compatibleFrameFormat(frame, format)) {
      return fail('mixed-format');
    }
    if (frame.bitrateIdx !== format.bitrateIdx) variableBitrate = true;
    onFrame?.(frame.frameLength);
    totalSamples += frame.samplesPerFrame;
    frameCount += 1;
    offset += frame.frameLength;
  }
  if (frameCount === 0) return fail('no-frame');

  return { ok: true, reason: null, variableBitrate, durationSeconds: totalSamples / format.sampleRate, frameCount, format };
}

/**
 * 精确计算 MP3 时长（严格逐帧累加）
 * @returns {number} 秒；任何不完整/不一致情形返回 0（不发布残缺产物）
 */
function getMp3DurationSeconds(buffer) {
  const result = analyzeMp3(buffer);
  return result.ok ? result.durationSeconds : 0;
}

/**
 * B0-5 核心：把目标静音时长量化为整帧。
 * 时间轴累计与合并器插入必须使用本函数的同一个结果，
 * 否则会出现"元数据按 0.35s 累计、实际插入 0.36s"的漂移。
 *
 * @returns {{frameCount: number, seconds: number}} 帧数与精确时长（帧数 × 每帧采样 / 采样率）
 */
function computeGap(format, seconds) {
  if (!format || seconds <= 0) return { frameCount: 0, seconds: 0 };
  const frameCount = Math.ceil((seconds * format.sampleRate) / format.samplesPerFrame);
  return {
    frameCount,
    seconds: (frameCount * format.samplesPerFrame) / format.sampleRate,
  };
}

/**
 * 生成指定时长的静音帧序列（复用源音频帧头，清除 padding 位）
 * 帧数由 computeGap 量化，与时间轴口径一致。
 */
function buildSilenceFrames(format, seconds) {
  if (!format || seconds <= 0) return null;

  // 清除 padding 位，保证每个静音帧长度一致
  const header = Buffer.from(format.rawHeader);
  header[2] = header[2] & 0xfd;
  const frameLength = Math.floor((format.samplesPerFrame / 8) * format.bitrate / format.sampleRate);

  const { frameCount } = computeGap(format, seconds);
  const frame = Buffer.alloc(frameLength);
  header.copy(frame, 0);

  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

/** 是否为帧完整、序列一致的有效 MP3 数据（B-F2 严格口径） */
function isValidMp3(buffer) {
  return analyzeMp3(buffer).ok;
}

module.exports = {
  SENTENCE_GAP_SECONDS,
  stripID3,
  extractMp3Body,
  xingOffset, compatibleFrameFormat,
  parseFrameHeader,
  scanMp3Format,
  analyzeMp3,
  getMp3DurationSeconds,
  computeGap,
  buildSilenceFrames,
  isValidMp3,
};
