const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { DEFAULT_VOICES, AVAILABLE_VOICES, AVAILABLE_VOICE_IDS, getTtsProvider } = require('./ttsProvider');
const { buildCacheKey } = require('./ttsCache');
const { atomicWrite } = require('./atomicWrite');
const {
  analyzeMp3,
  compatibleFrameFormat,
  computeGap,
  isValidMp3,
  SENTENCE_GAP_SECONDS,
} = require('./mp3Utils');

const { InputError } = require('./validation');

const MAX_SYNTHESIS_ATTEMPTS = 3;
const TTS_CHECKPOINT_FILENAME = '.tts-checkpoint.json';
const CALENDAR_YEAR = /^(?:1[1-9]\d{2}|20\d{2})$/;
const CHINESE_DIGITS = '零一二三四五六七八九';
const URL_OR_YEAR = /(https?:\/\/[^\s"'<>()（）《》【】，。！？；：、]+)|(?<![A-Za-z0-9._/])(?:(\d+(?:\.\d+)?)\s*([-~～—–至到])\s*)?(\d+)\s*(年代?)/gi;
const STRICT_DURATION_PREFIX = /(?:历时|长达|持续|跨越|经过|相隔|距今|已有|超过|不到|不足|将近|满|整整|一共|共计|总共|累计|短短|为期)\s*$/;
const APPROXIMATE_PREFIX = /(?:大约|约|近|前后)\s*$/;
const DURATION_SUFFIX = /^(?:的?(?:历史|时间|之久|岁月|沧桑|光阴|历程)|多|余|间)/;

function normalizeSpeechText(text) {
  if (typeof text !== 'string') throw new Error('合成文本必须是非空字符串');
  const readDigits = number => number.replace(/\d/g, digit => CHINESE_DIGITS[Number(digit)]);
  return text.replace(URL_OR_YEAR, (match, url, start, separator, end, unit, offset) => {
    if (url) return match;
    if (unit === '年') {
      const prefix = text.slice(0, offset);
      if (STRICT_DURATION_PREFIX.test(prefix) ||
          (APPROXIMATE_PREFIX.test(prefix) && DURATION_SUFFIX.test(text.slice(offset + match.length)))) return match;
    }
    if (start) {
      if (!CALENDAR_YEAR.test(start) || !CALENDAR_YEAR.test(end)) return match;
      return `${readDigits(start)}${separator === '至' ? '至' : '到'}${readDigits(end)}${unit}`;
    }
    if (CALENDAR_YEAR.test(end) || (unit === '年代' && /^[1-9]0$/.test(end))) return `${readDigits(end)}${unit}`;
    return match;
  });
}

function readSpeechCheckpoint(file, toneVersion) {
  try {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.toneVersion === toneVersion && saved.segments && typeof saved.segments === 'object' &&
          !Array.isArray(saved.segments)) {
        const segments = Object.fromEntries(Object.entries(saved.segments).filter(([index, key]) =>
          /^\d+$/.test(index) && typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)));
        return { toneVersion, segments };
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { toneVersion, segments: {} };
}

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
  emotion,
  adapterOptions = {},
  provider = getTtsProvider(),
  signal,
  onAttempt,
  onRetry,
  rateLimitMaxAttempts = 6,
  rateLimitBackoffMs = [2500, 5000, 9000, 14000, 20000],
}) {
  checkCancellation(signal);
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('合成文本必须是非空字符串');
  }
  const spokenText = normalizeSpeechText(text);
  if (!spokenText.trim()) throw new Error('合成文本必须是非空字符串');

  let lastError = null;
  let maxAttempts = MAX_SYNTHESIS_ATTEMPTS;
  let rateLimitHits = 0;
  let normalHits = 0;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    onAttempt?.(attempt);
    checkCancellation(signal);
    try {
      const { bytes, duration } = await provider.synthesizeToFile({
        text: spokenText, voice, outputPath, rate, pitch, emotion, signal, adapterOptions,
      });
      checkCancellation(signal);
      return {
        filePath: outputPath,
        fileName: path.basename(outputPath),
        fileSize: bytes,
        duration: Math.round(duration * 1000) / 1000,
      };
    } catch (error) {
      checkCancellation(signal);
      if (error instanceof InputError || error?.statusCode === 400 || error?.retryable === false) throw error;
      if (error instanceof TtsCancelledError || error?.name === 'AbortError') throw error;
      lastError = error;
      const rateLimited = Boolean(error?.rateLimited);
      let delayMs = 300 * attempt;
      if (rateLimited) {
        rateLimitHits++;
        normalHits = 0;
        maxAttempts = Math.max(maxAttempts, rateLimitMaxAttempts);
        delayMs = rateLimitBackoffMs[Math.min(rateLimitHits - 1, rateLimitBackoffMs.length - 1)] ?? delayMs;
      } else {
        normalHits++;
        if (normalHits >= MAX_SYNTHESIS_ATTEMPTS) break;
      }
      if (attempt < maxAttempts) {
        const intervalMs = provider.getMinRequestIntervalMs?.(adapterOptions) ?? provider.minRequestIntervalMs ?? 0;
        delayMs = Math.max(delayMs, intervalMs);
        onRetry?.({ attempt, maxAttempts, delayMs, rateLimited, error });
        await delay(delayMs, undefined, { signal });
      }
    }
  }

  const detail = lastError && lastError.message ? lastError.message : String(lastError);
  const wrapped = new Error(`语音合成失败（已尝试 ${attempt} 次）：${detail}`);
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
    const { format: frame, durationSeconds } = analyzeMp3(buffer);
    if (!frame) {
      throw new Error(`音频片段 ${entry.fileName} 不是有效 MP3，拒绝生成时间轴`);
    }
    if (!format) {
      format = frame;
    } else if (!compatibleFrameFormat(frame, format)) {
      throw new Error(`音频片段 ${entry.fileName} 编码格式与其他片段不一致，拒绝生成时间轴`);
    }
    return durationSeconds;
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
async function synthesizeDialogueScript(dialogueList, workDir, voiceMapping, options = {}) {
  const { provider = getTtsProvider(), cache, signal, onProgress, ttsModel, rateLimitMaxAttempts, rateLimitBackoffMs } = options;
  let adapterOptions = options.adapterOptions;
  if (ttsModel) {
    adapterOptions = { ...adapterOptions, model: ttsModel };
    if (provider.id === 'volcengine') adapterOptions.resourceId = ttsModel;
  }
  const cacheModel = adapterOptions?.resourceId || adapterOptions?.model || provider.model;
  const defaultVoices = provider.defaultVoicesForModel?.(cacheModel) || provider.defaultVoices || DEFAULT_VOICES;
  const voices = voiceMapping || defaultVoices;
  const intervalMs = options.minRequestIntervalMs ?? provider.getMinRequestIntervalMs?.(adapterOptions) ?? provider.minRequestIntervalMs ?? 0;
  fs.mkdirSync(workDir, { recursive: true });
  const toneVersion = typeof provider.toneVersion === 'string' ? provider.toneVersion.trim() : '';
  const spokenLines = dialogueList.map(line => typeof line?.text === 'string' ? normalizeSpeechText(line.text) : line?.text);
  const checkpointFile = path.join(workDir, TTS_CHECKPOINT_FILENAME);
  const needsCheckpoint = toneVersion || spokenLines.some((spoken, index) => spoken !== dialogueList[index]?.text);
  const checkpoint = needsCheckpoint ? readSpeechCheckpoint(checkpointFile, toneVersion || 'speech-v1') : null;
  const entries = [];
  const totalSegments = dialogueList.length;
  let cachedSegments = 0;
  let reusedSegments = 0;
  let lastRequestEndAt = null;
  for (const [index, line] of dialogueList.entries()) {
    const { speaker, text, rate = '+0%', pitch = '+0Hz', emotion } = line;
    const voice = voices[speaker] || defaultVoices[speaker] || Object.values(defaultVoices)[0];
    const fileName = sentenceFileName(index);
    const outputPath = path.join(workDir, fileName);
    const report = (completedSegments, retry) => onProgress?.({
      index, completedSegments, totalSegments, cachedSegments, reusedSegments, speaker, text, ...retry,
    });
    try {
      checkCancellation(signal);
      report(index);
      checkCancellation(signal);
      const spokenText = spokenLines[index];
      const getKey = () => {
        if (typeof spokenText !== 'string') throw new Error('合成文本必须是非空字符串');
        const scopeHash = provider.getScopeHash?.([voice], adapterOptions);
        return buildCacheKey({ scopeHash, provider: provider.id, model: cacheModel, voice, rate, pitch, emotion, text: spokenText, toneVersion });
      };
      const checkpointKey = (toneVersion || spokenText !== text) && getKey();
      const reuseAllowed = !checkpointKey || checkpoint.segments[index] === checkpointKey;
      const existing = reuseAllowed && fs.existsSync(outputPath) && fs.readFileSync(outputPath);
      let fileSize;
      if (existing && isValidMp3(existing)) {
        reusedSegments++;
        cachedSegments++;
        fileSize = existing.length;
      } else {
        const key = checkpointKey || ((cache || checkpoint) && getKey());
        const cached = cache?.get(key, outputPath);
        if (cached?.hit) {
          cachedSegments++;
          fileSize = cached.bytes;
        } else {
          if (lastRequestEndAt !== null && Number.isFinite(intervalMs) && intervalMs > 0) {
            let elapsedMs = performance.now() - lastRequestEndAt;
            // A timer can wake early, so recheck elapsed time before sending.
            while (elapsedMs < intervalMs) {
              const waitMs = Math.min(0x7fffffff, Math.ceil(intervalMs - elapsedMs));
              await delay(waitMs, undefined, { signal });
              elapsedMs = performance.now() - lastRequestEndAt;
            }
          }
          const result = await synthesizeSentence({
            text, voice, outputPath, rate, pitch, emotion, provider, signal, adapterOptions, rateLimitMaxAttempts, rateLimitBackoffMs,
            onRetry({ attempt, maxAttempts, delayMs, rateLimited }) {
              report(index, { retrying: true, attempt, maxAttempts, delayMs, rateLimited });
            },
          });
          lastRequestEndAt = performance.now();
          checkCancellation(signal);
          cache?.put(key, outputPath);
          fileSize = result.fileSize;
        }
        if (checkpoint && checkpoint.segments[index] !== key) {
          checkpoint.segments[index] = key;
          atomicWrite(checkpointFile, JSON.stringify(checkpoint));
        }
      }
      entries.push({ filePath: outputPath, fileSize, fileName, speaker, text, emotion });
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
  TTS_CHECKPOINT_FILENAME,
  sentenceFileName,
  normalizeSpeechText,
  synthesizeSentence,
  synthesizeDialogueScript,
  buildSentenceTimeline,
};
