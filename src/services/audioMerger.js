const fs = require('fs');
const path = require('path');
const {
  extractMp3Body, parseFrameHeader, xingOffset,
  analyzeMp3,
  compatibleFrameFormat,
  buildSilenceFrames,
  computeGap,
  SENTENCE_GAP_SECONDS,
} = require('./mp3Utils');

// Give VBR players one seek table for the whole programme, including sentence gaps.
function withSeekTable(audio, format, frames) {
  const header = Buffer.from(format.rawHeader);
  header[1] |= 1; // no CRC
  header[2] = (14 << 4) | (header[2] & 0x0c); // a legal frame large enough for the TOC
  const tag = Buffer.alloc(parseFrameHeader(header, 0).frameLength);
  header.copy(tag);
  const pos = xingOffset(header, format.versionBits);
  tag.write('Xing', pos);
  tag.writeUInt32BE(7, pos + 4); // frames, bytes, TOC
  tag.writeUInt32BE(frames, pos + 8);
  const bytes = audio.length + tag.length;
  tag.writeUInt32BE(bytes, pos + 12);
  let offset = 0, index = 0;
  for (let percent = 1; percent < 100; percent++) {
    const target = Math.floor(frames * percent / 100);
    while (index < target) {
      offset += parseFrameHeader(audio, offset).frameLength;
      index++;
    }
    tag[pos + 16 + percent] = Math.floor(256 * (tag.length + offset) / bytes);
  }
  return Buffer.concat([tag, audio]);
}

/**
 * 纯 Node.js 合并多个 MP3 音频切片为完整 MP3。
 * 过滤 ID3 头尾标签后将 MPEG Audio Frame 直接连接，句间插入与源音频格式
 * 一致的真实静音帧。
 *
 * B0-5 契约（不再静默跳过）：
 * - 缺失片段、无效 MP3、编码格式不一致（版本/帧采样数/采样率）一律抛错；
 * - 句间 gap 经 computeGap 按帧量化，与 ttsService.buildSentenceTimeline
 *   使用同一口径，保证字幕时间轴与合并产物精确一致。
 */
function concatenateAudioFiles(filePaths, outputFilePath, { gapSeconds = SENTENCE_GAP_SECONDS } = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('没有可拼接的音频片段');
  }

  const cleanedBuffers = [];
  let format = null, variableBitrate = false, frames = 0;
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`音频片段缺失，拒绝拼接：${path.basename(filePath)}`);
    }
    const raw = fs.readFileSync(filePath);
    const { ok, format: frame, variableBitrate: segmentVbr, frameCount } = analyzeMp3(raw);
    if (!ok) {
      throw new Error(`音频片段不是有效 MP3，拒绝拼接：${path.basename(filePath)}`);
    }
    if (!format) {
      format = frame;
    } else if (!compatibleFrameFormat(frame, format)) {
      throw new Error(`音频片段编码格式与其他片段不一致，拒绝拼接：${path.basename(filePath)}`);
    }
    frames += frameCount;
    if (segmentVbr || format.bitrateIdx !== frame.bitrateIdx) variableBitrate = true;
    cleanedBuffers.push(extractMp3Body(raw).subarray(frame.frameOffset));
  }

  const gap = computeGap(format, gapSeconds);
  const silence = gap.frameCount > 0 ? buildSilenceFrames(format, gapSeconds) : null;

  const chunks = [];
  cleanedBuffers.forEach((buf, i) => {
    if (i > 0 && silence) {
      chunks.push(silence);
    }
    chunks.push(buf);
  });

  let combined = Buffer.concat(chunks);
  if (variableBitrate) combined = withSeekTable(combined, format, frames + gap.frameCount * (filePaths.length - 1));
  fs.writeFileSync(outputFilePath, combined);

  return {
    success: true,
    filePath: outputFilePath,
    fileSize: combined.length,
    skippedCount: 0,
    totalFiles: filePaths.length,
    sentenceGap: gap.seconds,
    sentenceGapFrames: gap.frameCount,
  };
}

module.exports = {
  concatenateAudioFiles,
};
