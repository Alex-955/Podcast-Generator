const { InputError } = require('./validation');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { synthesizeHttp } = require('./httpTts');

const DEFAULT_MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';
const DEFAULT_MINIMAX_MODEL = 'speech-02-hd';
const DEFAULT_MINIMAX_VOICES = { 阿泽: 'male-qn-jingying', 小晓: 'female-yujie' };
const AVAILABLE_MINIMAX_VOICES = [
  { id: 'male-qn-jingying', name: '精英青年（沉稳自然·阿泽推荐）', gender: 'male' },
  { id: 'Chinese (Mandarin)_Radio_Host', name: '电台主播（从容播报）', gender: 'male' },
  { id: 'Chinese (Mandarin)_Sincere_Adult', name: '真诚成年（温和朋友感）', gender: 'male' },
  { id: 'male-qn-qingse', name: '青涩青年（年轻明快）', gender: 'male' },
  { id: 'female-yujie', name: '知性御姐（干练细腻·小晓推荐）', gender: 'female' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', name: '温暖闺蜜（亲切放松）', gender: 'female' },
  { id: 'Chinese (Mandarin)_Wise_Women', name: '知性女性（深度解析）', gender: 'female' },
  { id: 'female-shaonv', name: '清脆少女（轻快活泼）', gender: 'female' },
];

async function readAudio(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error('响应不是有效 JSON'); }
  if (body?.base_resp?.status_code !== 0) {
    throw new Error(`状态码 ${body?.base_resp?.status_code ?? '缺失'}：${body?.base_resp?.status_msg ?? '未知错误'}`);
  }
  const hex = body?.data?.audio;
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('响应中的音频不是有效十六进制数据');
  }
  return Buffer.from(hex, 'hex');
}

function createMinimaxProvider(options = {}) {
  return {
    id: 'minimax', name: 'MiniMax Speech', requiresAuth: true, authModes: ['apiKey'],
    model: options.model || DEFAULT_MINIMAX_MODEL,
    availableModels: ['speech-02-hd', 'speech-02-turbo', 'speech-2.8-hd', 'speech-2.8-turbo'],
    defaultVoices: DEFAULT_MINIMAX_VOICES, availableVoices: AVAILABLE_MINIMAX_VOICES,
    async synthesizeToFile({ text, voice, rate, outputPath, signal, adapterOptions }) {
      if (signal?.aborted) throw new TtsCancelledError();
      const { apiKey, endpoint, model, timeoutMs } = { ...options, ...adapterOptions };
      if (!apiKey?.trim()) throw new InputError('请先配置 MiniMax 语音合成 API Key 后再生成');
      const percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(rate);
      const speed = percent ? Math.max(0.5, Math.min(2, 1 + Number(percent[1]) / 100)) : 1;
      return synthesizeHttp({
        name: 'MiniMax', endpoint: endpoint || DEFAULT_MINIMAX_ENDPOINT,
        headers: { Authorization: `Bearer ${apiKey}` }, secrets: [apiKey],
        body: {
          model: model || DEFAULT_MINIMAX_MODEL, text, stream: false,
          voice_setting: { voice_id: voice || DEFAULT_MINIMAX_VOICES.阿泽, speed, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
          output_format: 'hex',
        },
        signal, timeoutMs, outputPath, readAudio,
      });
    },
  };
}

const minimaxProvider = createMinimaxProvider();
module.exports = { DEFAULT_MINIMAX_ENDPOINT, DEFAULT_MINIMAX_MODEL, DEFAULT_MINIMAX_VOICES,
  AVAILABLE_MINIMAX_VOICES, createMinimaxProvider, minimaxProvider };
