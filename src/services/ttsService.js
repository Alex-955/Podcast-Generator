const fs = require('fs');
const path = require('path');
const { EdgeTtsAdapter } = require('./edgeTtsAdapter');
const {
  getMp3DurationSeconds,
  scanMp3Format,
  computeGap,
  isValidMp3,
  SENTENCE_GAP_SECONDS,
} = require('./mp3Utils');

// 默认角色语音配置（微软神经网络语音）
const DEFAULT_VOICES = {
  阿泽: 'zh-CN-YunxiNeural', // 沉稳、年轻而温暖的男声（云希）
  小晓: 'zh-CN-XiaoxiaoNeural', // 自然、有亲和力与表现力的女声（晓晓）
};

// 备选音色库（voiceMapping 白名单，见 src/services/validation.js）
const AVAILABLE_VOICES = [
  { id: 'zh-CN-YunxiNeural', name: '云希 (男声·温和沉稳·主持人推荐)', gender: 'male' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女声·灵动自然·嘉宾推荐)', gender: 'female' },
  { id: 'zh-CN-YunjianNeural', name: '云健 (男声·磁性解说)', gender: 'male' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 (男声·专业新闻播报)', gender: 'male' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵 (女声·知性细腻)', gender: 'female' },
  { id: 'zh-CN-XiaomengNeural', name: '晓梦 (女声·活泼开朗)', gender: 'female' },
];

const AVAILABLE_VOICE_IDS = AVAILABLE_VOICES.map((v) => v.id);
const MAX_SYNTHESIS_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('合成文本必须是非空字符串');
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
    const adapter = new EdgeTtsAdapter({ voice, rate, pitch, ...adapterOptions });
    try {
      const { bytes, duration } = await adapter.synthesizeToFile(text, outputPath);
      return {
        filePath: outputPath,
        fileName: path.basename(outputPath),
        fileSize: bytes,
        duration: Math.round(duration * 1000) / 1000,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
        await sleep(300 * attempt); // 线性退避
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
 * 返回 dialogue 元素保留 filePath（server.js 负责拼接；meta 中会剔除该字段）。
 */
async function synthesizeDialogueScript(dialogueList, workDir, voiceMapping = DEFAULT_VOICES) {
  fs.mkdirSync(workDir, { recursive: true });

  const synthEntries = [];
  const synthMeta = [];
  for (let index = 0; index < dialogueList.length; index += 1) {
    const line = dialogueList[index];
    const fileName = sentenceFileName(index);
    const outputPath = path.join(workDir, fileName);
    // 说话人只允许归一后的阿泽/小晓（scriptEngine.normalizeDialogue 保证）
    const voice = voiceMapping[line.speaker] || DEFAULT_VOICES[line.speaker] || DEFAULT_VOICES.阿泽;
    const synthResult = await synthesizeSentence({
      text: line.text,
      voice,
      outputPath,
      rate: line.rate || '+0%',
      pitch: line.pitch || '+0Hz',
    });
    synthEntries.push({
      filePath: synthResult.filePath,
      fileName,
      speaker: line.speaker,
      text: line.text,
      emotion: typeof line.emotion === 'string' ? line.emotion : undefined,
    });
    synthMeta.push({ ...synthResult, line });
  }

  const timeline = buildSentenceTimeline(synthEntries);

  const dialogue = timeline.sentences.map((sentence, i) => ({
    index: sentence.index,
    speaker: sentence.speaker,
    text: sentence.text,
    ...(synthEntries[i].emotion ? { emotion: synthEntries[i].emotion } : {}),
    startTime: sentence.startTime,
    endTime: sentence.endTime,
    duration: sentence.duration,
    fileName: sentence.fileName,
    audioUrl: sentence.audioUrl,
    filePath: synthMeta[i].filePath,
    fileSize: synthMeta[i].fileSize,
  }));

  return {
    dialogue,
    totalDuration: timeline.totalDuration,
    sentenceGap: timeline.sentenceGap,
    sentenceGapFrames: timeline.sentenceGapFrames,
    measurement: timeline.measurement,
  };
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
