const fs = require('fs');
const path = require('path');
const { setTimeout: delay } = require('node:timers/promises');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { DEFAULT_VOICES, AVAILABLE_VOICES, AVAILABLE_VOICE_IDS, getTtsProvider } = require('./ttsProvider');
const { buildCacheKey } = require('./ttsCache');
const {
  getMp3DurationSeconds,
  scanMp3Format,
  computeGap,
  isValidMp3,
  SENTENCE_GAP_SECONDS,
} = require('./mp3Utils');

const MAX_SYNTHESIS_ATTEMPTS = 3;

function checkCancellation(signal) {
  if (signal?.aborted) throw new TtsCancelledError();
}

/**
 * 合成文件名：内部安全 ID，不携带任何用户输入
 * （B0-3：说话人文本可能是恶意字符串，绝不进入文件路径）
 */
function sentenceFileName(index) {
  return `sentence_${String(index).padStart(3, '0')}.mp3`;
}

/**
 * 合成单句音频（限次重试 + 退避）
 *
 * 生命周期由 EdgeTtsAdapter 保证（connect/first-data/idle/task 四级超时，
 * 超时即断开连接并销毁写入流）。每次尝试使用独立临时文件，成功校验
 * 音频有效后由适配层原子发布到 outputPath；失败产物不进入最终结果。
 */
async function synthesizeSentence({
  text,
  voice,
  outputPath,
  rate = '+0%',
  pitch = '+0Hz',
  adapterOptions = {},
  provider = getTtsProvider(),
  signal,
  onAttempt,
}) {
  checkCancellation(signal);
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('合成文本必须是非空字符串');
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
    onAttempt?.(attempt);
    checkCancellation(signal);
    try {
      const { bytes, duration } = await provider.synthesizeToFile({ text, voice, outputPath, rate, pitch, signal, adapterOptions });
      checkCancellation(signal);
      return {
        filePath: outputPath,
        fileName: path.basename(outputPath),
        fileSize: bytes,
        duration: Math.round(duration * 1000) / 1000,
      };
    } catch (error) {
      checkCancellation(signal);
      if (error instanceof TtsCancelledError || error.name === 'AbortError') throw error;
      lastError = error;
      if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
        await delay(300 * attempt, undefined, { signal }); // 线性退避
      }
    }
  }

  const detail = lastError && lastError.message ? lastError.message : String(lastError);
  const wrapped = new Error(`语音合成失败（已尝试 ${MAX_SYNTHESIS_ATTEMPTS} 次）：${detail}`);
  wrapped.statusCode = 502;
  throw wrapped;
}

/**
 * B0-5：完全由实际片段文件的帧解析结果构建时间轴。
 *
 * 句间 gap 先按 MP3 帧量化（computeGap），时间轴累计与 audioMerger 的
 * 静音帧插入使用同一个量化结果，因此：
 *   - 每句 startTime/endTime 与合并产物中的真实位置精确一致；
 *   - totalDuration === 末句 endTime === 合并产物时长（同一帧计数口径）。
 * 显示层取整只发生在前端 formatTime。
 *
 * @param {Array<{filePath: string, fileName: string, speaker: string, text: string, emotion?: string}>} entries
 */
function buildSentenceTimeline(entries, { gapSeconds = SENTENCE_GAP_SECONDS } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('没有可合成的台词');
  }

  let format = null;
  const durations = entries.map((entry) => {
    const buffer = fs.readFileSync(entry.filePath);
    const frame = scanMp3Format(buffer);
    if (!frame) {
      throw new Error(`音频片段 ${entry.fileName} 不是有效 MP3，拒绝生成时间轴`);
    }
    if (!format) {
      format = frame;
    } else if (
      frame.versionBits !== format.versionBits ||
      frame.bitrateIdx !== format.bitrateIdx ||
      frame.samplerateIdx !== format.samplerateIdx
    ) {
      throw new Error(`音频片段 ${entry.fileName} 编码格式与其他片段不一致，拒绝生成时间轴`);
    }
    const duration = getMp3DurationSeconds(buffer);
    if (duration <= 0) {
      throw new Error(`音频片段 ${entry.fileName} 时长无法解析`);
    }
    return duration;
  });

  const gap = computeGap(format, gapSeconds);
  let cursor = 0;
  const sentences = entries.map((entry, index) => {
    const startTime = cursor;
    const endTime = cursor + durations[index];
    cursor = endTime + gap.seconds;
    const sentence = {
      index,
      speaker: entry.speaker,
      text: entry.text,
      startTime,
      endTime,
      duration: durations[index],
      fileName: entry.fileName,
      audioUrl: `/audio/${entry.fileName}`,
    };
    if (entry.emotion) sentence.emotion = entry.emotion;
    return sentence;
  });

  return {
    sentences,
    totalDuration: sentences[sentences.length - 1].endTime,
    sentenceGap: gap.seconds,
    sentenceGapFrames: gap.frameCount,
    measurement: 'mp3-frame-count',
  };
}

/**
 * 逐句合成 + 构建精确时间轴。
 * 返回 dialogue 元素保留 filePath（供任务引擎拼接，成品元数据只保留公开字段）。
 */
async function synthesizeDialogueScript(dialogueList, workDir, voiceMapping = DEFAULT_VOICES, options = {}) {
  const { provider = getTtsProvider(), cache, signal, onProgress, adapterOptions } = options;
  fs.mkdirSync(workDir, { recursive: true });
  const entries = [];
  const totalSegments = dialogueList.length;
  let cachedSegments = 0;
  let reusedSegments = 0;
  for (const [index, line] of dialogueList.entries()) {
    const { speaker, text, rate = '+0%', pitch = '+0Hz' } = line;
    const voice = voiceMapping[speaker] || DEFAULT_VOICES[speaker] || DEFAULT_VOICES.阿泽;
    const fileName = sentenceFileName(index);
    const outputPath = path.join(workDir, fileName);
    const report = completedSegments => onProgress?.({
      index, completedSegments, totalSegments, cachedSegments, reusedSegments, speaker, text,
    });
    try {
      checkCancellation(signal);
      report(index);
      checkCancellation(signal);
      const existing = fs.existsSync(outputPath) && fs.readFileSync(outputPath);
      let fileSize;
      if (existing && isValidMp3(existing)) {
        reusedSegments++;
        cachedSegments++;
        fileSize = existing.length;
      } else {
        const key = cache && buildCacheKey({ provider: provider.id, model: provider.model, voice, rate, pitch, text });
        const cached = cache?.get(key, outputPath);
        if (cached?.hit) {
          cachedSegments++;
          fileSize = cached.bytes;
        } else {
          const result = await synthesizeSentence({ text, voice, outputPath, rate, pitch, provider, signal, adapterOptions });
          checkCancellation(signal);
          cache?.put(key, outputPath);
          fileSize = result.fileSize;
        }
      }
      entries.push({ filePath: outputPath, fileSize, fileName, speaker, text, emotion: line.emotion });
      report(index + 1);
      checkCancellation(signal);
    } catch (error) {
      error.segmentIndex = index;
      throw error;
    }
  }

  const { sentences, ...timeline } = buildSentenceTimeline(entries);
  const dialogue = sentences.map((sentence, index) => ({
    ...sentence, filePath: entries[index].filePath, fileSize: entries[index].fileSize,
  }));
  return { dialogue, ...timeline, cachedSegments, reusedSegments };
}

module.exports = {
  DEFAULT_VOICES,
  AVAILABLE_VOICES,
  AVAILABLE_VOICE_IDS,
  SENTENCE_GAP_SECONDS,
  sentenceFileName,
  synthesizeSentence,
  synthesizeDialogueScript,
  buildSentenceTimeline,
};
