const { speechScopeHash } = require('./ttsCache');
const { randomUUID } = require('node:crypto');
const { InputError } = require('./validation');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { boundedChunks, upstreamError } = require('./providerHttp');
const { synthesizeHttp } = require('./httpTts');

const DEFAULT_VOLCENGINE_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_VOLCENGINE_RESOURCE_ID = 'seed-tts-2.0';
const TONE_RULE_VERSION = 'tone-v2';
const DEFAULT_VOLCENGINE_VOICES = { 阿泽: 'zh_male_taocheng_uranus_bigtts', 小晓: 'zh_female_vv_uranus_bigtts' };
const V1_VOICES = { 阿泽: 'zh_male_yangguangqingnian_moon_bigtts', 小晓: 'zh_female_cancan_mars_bigtts' };
const V1_RESOURCE = /^seed-tts-1\.0/i;
const V2_RESOURCE = /^seed-tts-2\.0/i;
const V1_SPEAKER = /_(?:moon|mars|wvae)_bigtts$/;

function defaultVolcengineVoices(resourceId) {
  return V1_RESOURCE.test(resourceId) ? V1_VOICES : DEFAULT_VOLCENGINE_VOICES;
}

function validateVolcengineVoice(resourceId, voice) {
  if (voice.startsWith('S_')) return;
  if ((V1_RESOURCE.test(resourceId) && voice.endsWith('_uranus_bigtts')) ||
      (V2_RESOURCE.test(resourceId) && V1_SPEAKER.test(voice))) {
    throw new InputError('所选音色与豆包语音资源版本不匹配');
  }
}

const AVAILABLE_VOLCENGINE_VOICES = [
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0（明快青年男声·阿泽推荐）', gender: 'male' },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0（沉稳播客男声）', gender: 'male' },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0（对话磁性男声）', gender: 'male' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0（灵动自然女声·小晓推荐）', gender: 'female' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0（亲和对话女声）', gender: 'female' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0（清亮拆解女声）', gender: 'female' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0（干脆活波女声）', gender: 'female' },
  { id: V1_VOICES.阿泽, name: '阳光青年 1.0', gender: 'male' },
  { id: V1_VOICES.小晓, name: '灿灿 1.0', gender: 'female' },
];

const DIRECTOR_CUES = new Map([
  ['平静 温和', '用平和柔和、自然松弛的播客聊天语气，音量适中清晰不要偏高'],
  ['笑意 开心', '用轻松自然、带点笑意的播客聊天语气，音量稳定清晰'],
  ['感慨 温暖 总结', '用真诚温暖、娓娓道来的朋友聊天语气，音量清晰平稳不要压低变小'],
  ['好奇 疑惑 追问', '用自然好奇、像朋友插话提问的轻松语气，音量清晰平稳'],
  ['兴奋 惊讶 震惊', '用自然生动、略有兴致的播客聊天语气，克制平稳，切勿夸张惊呼或突然拔高音量'],
  ['认真 分析', '用专注清楚、不端架子的日常聊天语气，音量平稳'],
].flatMap(([tags, cue]) => tags.split(' ').map(tag => [tag, cue])));

function permanentBusinessError(code, message) {
  if ([400, 401, 403, 404, 413, 422, 40402003, 45000001, 45000002, 45000010, 45001001, 45002001].includes(code)) return true;
  if (code === 45000000) {
    const denied = /\b(?:permission\s+denied|(?:no|without|lack(?:s|ing)?|requires?)\s+permission|access\s+denied|auth(?:entication|orization)?\s+fail\w*|unauthori[sz]ed|forbidden|not\s+(?:granted|allowed|authorized|found|supported|enabled|activated)|unsupported|not\s+exist|invalid\s+(?:token|key|app|credential|parameter|param|resource|speaker|voice|argument|request))\b|权限不足|无权限|没有权限|未开通|未授权|鉴权失败|认证失败|不支持|不存在/i.test(message);
    const oversized = /\b(?:too\s+(?:large|long)|too\s+many\s+(?:characters|tokens)|(?:body|payload|text|request)\s+(?:is\s+)?(?:too\s+)?(?:large|long|oversized)|(?:body|payload|text)\s+(?:size|length)\s+(?:limit\s+)?exceed\w*|(?:size|length)\s+exceed\w*)\b|请求体过大|文本过大|文本过长|超长/i.test(message);
    if (denied || oversized) return true;

    const throttled =
      /\brate[\s_-]*limit\w*|\bthrottl\w*|\btoo\s+many\s+requests\b|限流|请求过于频繁/i.test(message) ||
      (/\b(?:concurren(?:t|cy)|qps|rate)\b/i.test(message) && /\b(?:limit\w*|quota\w*|exceed\w*|reach(?:ed|ing)?|max(?:imum)?|full|exhaust\w*|too\s+high)\b/i.test(message)) ||
      (/(?:并发|频[率次]|qps)/i.test(message) && /(?:超限|超过|超额|上限|限制|已满|过高)/.test(message));
    return !throttled;
  }
  return /\bunauthori[sz]ed\b|\bforbidden\b|\bauth(?:entication|orization)?\s+fail\w*|\binvalid\s+(?:token|key|parameter|speaker)\b|鉴权失败|认证失败|参数错误/i.test(message);
}

async function readAudio(response, limit) {
  const chunks = [];
  function readLine(line) {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); }
    catch { throw upstreamError('响应行不是有效 JSON'); }
    return consumeRecord(obj);
  }
  function consumeRecord(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw upstreamError('响应行格式无效');
    if (obj.code !== undefined && obj.code !== 0 && obj.code !== 20000000) {
      const code = obj.code;
      const permanent = permanentBusinessError(code, typeof obj.message === 'string' ? obj.message : '');
      throw upstreamError(`状态码 ${Number.isSafeInteger(code) ? code : '未知'}：语音请求失败`, !permanent,
        { rateLimited: code === 45000000 && !permanent });
    }
    if (typeof obj.data === 'string' && obj.data.length) {
      const encoded = obj.data;
      const bytes = Buffer.from(encoded, 'base64');
      const canonical = bytes.toString('base64');
      if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) {
        throw upstreamError('响应中的音频不是有效 base64 数据');
      }
      chunks.push(bytes);
    }
    return obj.code === 20000000;
  }
  let pending = [], size = 0;
  // Follow object boundaries across chunks so that an unterminated final line can
  // finish a keep-alive response. Parse at most once speculatively per line.
  let depth = 0, quoted = false, escaped = false, inspected = false;
  function closesObject(bytes) {
    if (inspected) return false;
    for (const byte of bytes) {
      if (escaped) escaped = false;
      else if (quoted && byte === 92) escaped = true;
      else if (byte === 34) quoted = !quoted;
      else if (!quoted && byte === 123) depth++;
      else if (!quoted && byte === 125 && --depth === 0) {
        inspected = true;
        return true;
      }
    }
    return false;
  }
  function append(bytes) {
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw upstreamError('语音响应行超过大小限制', false);
    if (bytes.length) pending.push(bytes);
  }
  for await (const chunk of boundedChunks(response, limit)) {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      append(chunk.subarray(start, end));
      if (readLine(Buffer.concat(pending, size).toString())) return Buffer.concat(chunks);
      pending = [];
      size = depth = 0;
      inspected = quoted = escaped = false;
      start = end + 1;
    }
    const tail = chunk.subarray(start);
    append(tail);
    // Some servers send the complete last object without a delimiter and keep HTTP open.
    // Both a completion code and an error code end the stream without a newline.
    if (closesObject(tail)) {
      let record;
      try { record = JSON.parse(Buffer.concat(pending, size).toString()); }
      catch { /* The regular line parser reports malformed records at the delimiter or EOF. */ }
      if (record?.code !== undefined && record.code !== 0 && consumeRecord(record)) return Buffer.concat(chunks);
    }
  }
  if (size && readLine(Buffer.concat(pending, size).toString())) return Buffer.concat(chunks);
  throw upstreamError('语音响应提前结束，缺少成功结束码');
}

function createVolcengineProvider(options = {}) {
  return {
    id: 'volcengine', name: '火山引擎（豆包语音 V3）', requiresAuth: true, authModes: ['apiKey', 'appIdAccessKey'],
    toneVersion: TONE_RULE_VERSION,
    model: options.resourceId || DEFAULT_VOLCENGINE_RESOURCE_ID, availableModels: ['seed-tts-2.0', 'seed-tts-1.0'],
    defaultVoices: defaultVolcengineVoices(options.resourceId), defaultVoicesForModel: defaultVolcengineVoices, availableVoices: AVAILABLE_VOLCENGINE_VOICES,
    getScopeHash(voices, overrides) {
      const credentials = { ...options, ...overrides };
      const endpoint = credentials.endpoint || DEFAULT_VOLCENGINE_ENDPOINT;
      return speechScopeHash(endpoint, credentials, voices, AVAILABLE_VOLCENGINE_VOICES, DEFAULT_VOLCENGINE_ENDPOINT, TONE_RULE_VERSION);
    },
    async synthesizeToFile({ text, voice, emotion, outputPath, signal, adapterOptions }) {
      if (signal?.aborted) throw new TtsCancelledError();
      const { apiKey, appId, accessKey, resourceId, endpoint, timeoutMs, allowPrivateEndpoint, lookup } = { ...options, ...adapterOptions };
      if (!apiKey?.trim() && !(appId?.trim() && accessKey?.trim())) {
        throw new InputError('请先配置火山引擎语音 API Key（或 AppID + Access Key）后再生成');
      }
      const speaker = voice || defaultVolcengineVoices(resourceId).阿泽;
      const resource = resourceId || DEFAULT_VOLCENGINE_RESOURCE_ID;
      validateVolcengineVoice(resource, speaker);
      const reqParams = { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000 } };
      const cleanEmotion = typeof emotion === 'string' && emotion.trim();
      if (cleanEmotion && V2_RESOURCE.test(resource) && !V1_SPEAKER.test(speaker.toLowerCase())) {
        const cue = DIRECTOR_CUES.get(cleanEmotion) || `用自然生动的${cleanEmotion}播客聊天语气，音量保持清晰平稳`;
        reqParams.additions = JSON.stringify({ disable_markdown_filter: true, context_texts: [cue] });
      }
      const auth = apiKey?.trim() ? { 'X-Api-Key': apiKey } : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessKey };
      return synthesizeHttp({
        name: '火山引擎', endpoint: endpoint || DEFAULT_VOLCENGINE_ENDPOINT,
        headers: { ...auth, 'X-Api-Resource-Id': resource, 'X-Api-Request-Id': randomUUID() },
        body: {
          user: { uid: 'ai-podcast-generator' },
          req_params: reqParams,
        },
        signal, timeoutMs, outputPath, allowPrivateEndpoint, lookup, readAudio,
      });
    },
  };
}

const volcengineProvider = createVolcengineProvider();
module.exports = { validateVolcengineVoice, DEFAULT_VOLCENGINE_ENDPOINT, DEFAULT_VOLCENGINE_RESOURCE_ID, DEFAULT_VOLCENGINE_VOICES,
  AVAILABLE_VOLCENGINE_VOICES, createVolcengineProvider, volcengineProvider };
