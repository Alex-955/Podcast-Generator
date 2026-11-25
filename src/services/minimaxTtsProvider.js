const { speechScopeHash } = require('./ttsCache');
const { InputError } = require('./validation');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { readJson, upstreamError } = require('./providerHttp');
const { synthesizeHttp } = require('./httpTts');

const DEFAULT_MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';
const DEFAULT_MINIMAX_MODEL = 'speech-2.8-turbo';
const TONE_RULE_VERSION = 'tone-v2';
const DEFAULT_MINIMAX_VOICES = { 阿泽: 'male-qn-jingying', 小晓: 'Chinese (Mandarin)_Warm_Bestie' };
const AVAILABLE_MINIMAX_VOICES = [
  { id: 'male-qn-jingying', name: '精英青年（沉稳自然·阿泽推荐）', gender: 'male' },
  { id: 'Chinese (Mandarin)_Radio_Host', name: '电台主播（从容播报）', gender: 'male' },
  { id: 'Chinese (Mandarin)_Sincere_Adult', name: '真诚成年（温和朋友感）', gender: 'male' },
  { id: 'male-qn-qingse', name: '青涩青年（年轻明快）', gender: 'male' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', name: '温暖闺蜜（亲切自然·小晓推荐）', gender: 'female' },
  { id: 'presenter_female', name: '女性主持人（清亮大方）', gender: 'female' },
  { id: 'danya_xuejie', name: '淡雅学姐（柔和知性）', gender: 'female' },
  { id: 'female-tianmei', name: '甜美女性（轻快明朗）', gender: 'female' },
  { id: 'female-shaonv', name: '清脆少女（活泼灵动）', gender: 'female' },
  { id: 'Chinese (Mandarin)_Wise_Women', name: '知性女性（深度解析）', gender: 'female' },
  { id: 'female-yujie', name: '知性御姐（干练沉稳）', gender: 'female' },
];

const EMOTIONS = new Map(Object.entries({
  happy: 'happy 笑意 开心 喜悦 欢乐',
  sad: 'sad 悲伤 伤感 难过 低落',
  angry: 'angry 生气 愤怒 气愤',
  fearful: 'fearful 害怕 恐惧 紧张',
  disgusted: 'disgusted 厌恶 嫌弃',
  neutral: 'neutral 平静 温和 认真 好奇 疑惑 追问 感慨 温暖 肯定 笃定 分析 客观 总结 兴奋 惊讶 震惊 surprised',
}).flatMap(([value, aliases]) => aliases.split(' ').map(tag => [tag, value])));

async function readAudio(response, limit) {
  const body = await readJson(response, limit);
  const code = body?.base_resp?.status_code;
  if (code !== 0) {
    if (code === 1002 || code === 1039) {
      const limit = code === 1002 ? 'RPM' : 'TPM';
      throw upstreamError(`状态码 ${code}：触发频率限制（${limit} 限流）`, true, { rateLimited: true });
    }
    const permanent = [1004, 1008, 1026, 1042, 2013, 20132, 2038, 2043, 2049].includes(code);
    const reason = code === 1004 ? '鉴权失败' : permanent ? '请检查账户与请求参数' : '服务商返回错误';
    throw upstreamError(`状态码 ${Number.isSafeInteger(code) ? code : '未知'}：${reason}`, !permanent);
  }
  const hex = body?.data?.audio;
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw upstreamError('响应中的音频不是有效十六进制数据');
  }
  return Buffer.from(hex, 'hex');
}

function createMinimaxProvider(options = {}) {
  return {
    id: 'minimax', name: 'MiniMax Speech', requiresAuth: true, authModes: ['apiKey'],
    toneVersion: TONE_RULE_VERSION,
    model: options.model || DEFAULT_MINIMAX_MODEL,
    availableModels: ['speech-02-hd', 'speech-02-turbo', 'speech-2.8-hd', 'speech-2.8-turbo'],
    defaultVoices: DEFAULT_MINIMAX_VOICES, availableVoices: AVAILABLE_MINIMAX_VOICES,
    minRequestIntervalMs: options.minRequestIntervalMs ?? 2600,
    getMinRequestIntervalMs(adapterOptions = {}) {
      return options.minRequestIntervalMs !== undefined ? options.minRequestIntervalMs :
        ((adapterOptions?.endpoint || DEFAULT_MINIMAX_ENDPOINT) === DEFAULT_MINIMAX_ENDPOINT ? 2600 : 0);
    },
    getScopeHash(voices, overrides) {
      const credentials = { ...options, ...overrides };
      const endpoint = credentials.endpoint || DEFAULT_MINIMAX_ENDPOINT;
      return speechScopeHash(endpoint, credentials, voices, AVAILABLE_MINIMAX_VOICES, DEFAULT_MINIMAX_ENDPOINT, TONE_RULE_VERSION);
    },
    async synthesizeToFile({ text, voice, rate, emotion, outputPath, signal, adapterOptions }) {
      if (signal?.aborted) throw new TtsCancelledError();
      const { apiKey, endpoint, model, timeoutMs, allowPrivateEndpoint, lookup } = { ...options, ...adapterOptions };
      if (!apiKey?.trim()) throw new InputError('请先配置 MiniMax 语音合成 API Key 后再生成');
      const percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(rate);
      const speed = percent ? Math.max(0.5, Math.min(2, 1 + Number(percent[1]) / 100)) : 1;
      const voiceSetting = { voice_id: voice || DEFAULT_MINIMAX_VOICES.阿泽, speed, vol: 1, pitch: 0 };
      const mappedEmotion = typeof emotion === 'string' && EMOTIONS.get(emotion.trim().toLowerCase());
      if (mappedEmotion) voiceSetting.emotion = mappedEmotion;
      return synthesizeHttp({
        name: 'MiniMax', endpoint: endpoint || DEFAULT_MINIMAX_ENDPOINT,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model: model || DEFAULT_MINIMAX_MODEL, text, stream: false,
          voice_setting: voiceSetting,
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
          output_format: 'hex',
        },
        signal, timeoutMs, outputPath, readAudio, allowPrivateEndpoint, lookup,
      });
    },
  };
}

const minimaxProvider = createMinimaxProvider();
module.exports = { DEFAULT_MINIMAX_ENDPOINT, DEFAULT_MINIMAX_MODEL, DEFAULT_MINIMAX_VOICES,
  AVAILABLE_MINIMAX_VOICES, createMinimaxProvider, minimaxProvider };
