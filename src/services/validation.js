/**
 * B0-3：请求校验、边界约束与日志脱敏。
 *
 * 错误分类（HTTP 状态码随 error.statusCode 传递）：
 * - InputError（400）：用户输入问题
 * - 上游错误（502）：抓取/LLM/TTS 失败（由各服务抛出并带 statusCode）
 * - 其他（500）：内部错误
 */

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 12000; // 与 extractor.MAX_CONTENT_LENGTH 一致的确定性截断语义
const MAX_DIALOGUE_LINES = 300;
const MAX_LINE_TEXT_LENGTH = 2000;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.statusCode = 400;
  }
}

/** 校验必填文本字段 */
function requireText(value, name, { max, allowEmpty = false }) {
  if (typeof value !== 'string') {
    throw new InputError(`${name} 必须是文本`);
  }
  const text = value.trim();
  if (!allowEmpty && !text) {
    throw new InputError(`请填写${name}`);
  }
  if (text.length > max) {
    throw new InputError(`${name} 超过 ${max} 字上限（当前 ${text.length} 字）`);
  }
  return text;
}

/**
 * 校验剧本生成请求。content 超长时按与抓取一致的语义确定性截断并置 truncated。
 * @returns {{title: string, content: string, truncated: boolean, url: string}}
 */
function validateScriptRequest({ title, content, url } = {}) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (cleanTitle.length > MAX_TITLE_LENGTH) {
    throw new InputError(`标题超过 ${MAX_TITLE_LENGTH} 字上限（当前 ${cleanTitle.length} 字）`);
  }
  const fullContent = requireText(content, '文章正文', { max: Number.MAX_SAFE_INTEGER });
  const truncated = fullContent.length > MAX_CONTENT_LENGTH;
  const cleanContent = fullContent.slice(0, MAX_CONTENT_LENGTH);

  let cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
    throw new InputError('链接格式不正确，请粘贴以 http:// 或 https:// 开头的完整文章链接');
  }

  return { title: cleanTitle, content: cleanContent, truncated, url: cleanUrl };
}

/**
 * 校验外部提交的对话列表（synthesize-podcast 入口）。
 * LLM 产出走 normalizeDialogue 的丢弃语义；用户输入在此直接报明确错误。
 */
function validateDialogueList(dialogue) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) {
    throw new InputError('对话内容为空');
  }
  if (dialogue.length > MAX_DIALOGUE_LINES) {
    throw new InputError(`台词超过 ${MAX_DIALOGUE_LINES} 行上限（当前 ${dialogue.length} 行）`);
  }
  dialogue.forEach((line, i) => {
    if (!line || typeof line !== 'object') {
      throw new InputError(`第 ${i + 1} 行台词格式无效`);
    }
    if (typeof line.text !== 'string') {
      throw new InputError(`第 ${i + 1} 行台词不是文本`);
    }
    if (!line.text.trim()) {
      throw new InputError(`第 ${i + 1} 行台词为空`);
    }
    if (line.text.length > MAX_LINE_TEXT_LENGTH) {
      throw new InputError(`第 ${i + 1} 行台词超过 ${MAX_LINE_TEXT_LENGTH} 字上限`);
    }
  });
  return dialogue;
}

function validateEditedDialogue(dialogue) {
  if (!Array.isArray(dialogue) || !dialogue.length) throw new InputError('对话内容为空');
  if (dialogue.length > MAX_DIALOGUE_LINES) throw new InputError(`台词超过 ${MAX_DIALOGUE_LINES} 行上限`);
  return Array.from(dialogue, (line, index) => {
    const label = `第 ${index + 1} 行台词`;
    if (!line || ![Object.prototype, null].includes(Object.getPrototypeOf(line))) {
      throw new InputError(label + '格式无效');
    }
    const speaker = line.speaker;
    if (!['阿泽', '小晓'].includes(speaker)) throw new InputError(label + '的说话人仅支持阿泽或小晓');
    const text = requireText(line.text, label, { max: MAX_LINE_TEXT_LENGTH });
    let emotion;
    if (line.emotion != null) {
      if (typeof line.emotion !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(line.emotion) || line.emotion.trim().length > 20) {
        throw new InputError(label + '的情绪须为不超过 20 字的单行文本');
      }
      emotion = line.emotion.trim();
    }
    return { speaker, text, ...(emotion && { emotion }) };
  });
}

/**
 * 校验音色映射：值必须在 AVAILABLE_VOICES 白名单内。
 */
function validateVoiceMapping(mapping, providerOrAllowedIds) {
  if (mapping === undefined || mapping === null) {
    return undefined;
  }
  if (typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new InputError('voiceMapping 格式无效');
  }
  const id = providerOrAllowedIds?.id || providerOrAllowedIds;
  const commercial = id === 'minimax' || id === 'volcengine';
  const allowedIds = Array.isArray(providerOrAllowedIds) ? providerOrAllowedIds : require('./ttsProvider').AVAILABLE_VOICE_IDS;
  const normalized = {};
  for (const [speaker, voice] of Object.entries(mapping)) {
    if (commercial && !['阿泽', '小晓'].includes(speaker)) throw new InputError('不支持的播客角色');
    const valid = typeof voice === 'string' && (commercial ? /^[a-zA-Z0-9_() .:-]{1,120}$/.test(voice) && voice.trim() : allowedIds.includes(voice));
    if (!valid) {
      throw new InputError('不支持的音色');
    }
    normalized[speaker] = commercial ? voice.trim() : voice;
  }
  return normalized;
}

function ttsSecrets(tts = {}) {
  const env = process.env;
  return [tts.apiKey, tts.appId, tts.accessKey, tts.endpoint, tts.baseURL, env.MINIMAX_API_KEY, env.MINIMAX_TTS_ENDPOINT,
    env.VOLCENGINE_TTS_API_KEY, env.VOLCENGINE_TTS_APP_ID, env.VOLCENGINE_TTS_ACCESS_KEY, env.VOLCENGINE_TTS_ENDPOINT];
}

/** 日志/错误消息脱敏：去掉 API Key 形态的凭据 */
function redactSecrets(text, sensitiveValues = []) {
  let message = String(text);
  const values = sensitiveValues.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of values) message = message.replaceAll(value, '***');
  return message
    .replace(/(?:Authorization|X-Api-(?:Access-Key|App-Id|Key)|accessKey|appId|apiKey|baseURL|endpoint|filePath)["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?[^\s,"'}]+/gi, '***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/((?:api[-_]?key|token|secret)[\"'\s:=]+)[A-Za-z0-9._~+/-]{6,}/gi, '$1***');
}

module.exports = {
  InputError,
  MAX_TITLE_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_DIALOGUE_LINES,
  MAX_LINE_TEXT_LENGTH,
  requireText,
  validateScriptRequest,
  validateDialogueList,
  validateEditedDialogue,
  validateVoiceMapping,
  redactSecrets,
  ttsSecrets,
};
