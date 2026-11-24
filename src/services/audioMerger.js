const fs = require('fs');
const path = require('path');
const {
  extractMp3Body,
  scanMp3Format,
  buildSilenceFrames,
  computeGap,
  SENTENCE_GAP_SECONDS,
} = require('./mp3Utils');

/**
 * 纯 Node.js 合并多个 MP3 音频切片为完整 MP3。
 * 过滤 ID3 头尾标签后将 MPEG Audio Frame 直接连接，句间插入与源音频格式
 * 一致的真实静音帧。
 *
 * B0-5 契约（不再静默跳过）：
 * - 缺失片段、无效 MP3、编码格式不一致（版本/码率/采样率）一律抛错；
 * - 句间 gap 经 computeGap 按帧量化，与 ttsService.buildSentenceTimeline
 *   使用同一口径，保证字幕时间轴与合并产物精确一致。
 */
function concatenateAudioFiles(filePaths, outputFilePath, { gapSeconds = SENTENCE_GAP_SECONDS } = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('没有可拼接的音频片段');
  }

  const cleanedBuffers = [];
  let format = null;
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`音频片段缺失，拒绝拼接：${path.basename(filePath)}`);
    }
    const buf = extractMp3Body(fs.readFileSync(filePath));
    const frame = scanMp3Format(buf);
    if (!frame) {
      throw new Error(`音频片段不是有效 MP3，拒绝拼接：${path.basename(filePath)}`);
    }
    if (!format) {
      format = frame;
    } else if (
      frame.versionBits !== format.versionBits ||
      frame.bitrateIdx !== format.bitrateIdx ||
      frame.samplerateIdx !== format.samplerateIdx
    ) {
      throw new Error(`音频片段编码格式与其他片段不一致，拒绝拼接：${path.basename(filePath)}`);
    }
    cleanedBuffers.push(buf.subarray(frame.frameOffset));
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

  const combined = Buffer.concat(chunks);
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
