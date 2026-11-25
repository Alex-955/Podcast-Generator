const { randomUUID } = require('node:crypto');
const { InputError } = require('./validation');
const { TtsCancelledError } = require('./edgeTtsAdapter');
const { synthesizeHttp } = require('./httpTts');

const DEFAULT_VOLCENGINE_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_VOLCENGINE_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_VOLCENGINE_VOICES = { 阿泽: 'zh_male_m191_uranus_bigtts', 小晓: 'zh_female_vv_uranus_bigtts' };
const AVAILABLE_VOLCENGINE_VOICES = [
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0（自然播客男声·阿泽推荐）', gender: 'male' },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0（对话磁性男声）', gender: 'male' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0（明快青年男声）', gender: 'male' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0（灵动自然女声·小晓推荐）', gender: 'female' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0（亲和对话女声）', gender: 'female' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0（清亮拆解女声）', gender: 'female' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0（干脆活波女声）', gender: 'female' },
];

async function readAudio(response) {
  const chunks = [];
  function readLine(line) {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); }
    catch { throw new Error('响应行不是有效 JSON'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('响应行格式无效');
    if (obj.code !== undefined && obj.code !== 0 && obj.code !== 20000000) {
      throw new Error(`状态码 ${obj.code}：${obj.message || '未知错误'}`);
    }
    if (typeof obj.data === 'string' && obj.data.length) {
      const encoded = obj.data;
      const bytes = Buffer.from(encoded, 'base64');
      const canonical = bytes.toString('base64');
      if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) {
        throw new Error('响应中的音频不是有效 base64 数据');
      }
      chunks.push(bytes);
    }
  }
  let tail = '';
  for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (tail + text).split('\n');
    tail = lines.pop();
    for (const line of lines) readLine(line);
  }
  readLine(tail);
  return Buffer.concat(chunks);
}

function createVolcengineProvider(options = {}) {
  return {
    id: 'volcengine', name: '火山引擎（豆包语音 V3）', requiresAuth: true, authModes: ['apiKey', 'appIdAccessKey'],
    model: options.resourceId || DEFAULT_VOLCENGINE_RESOURCE_ID, availableModels: ['seed-tts-2.0', 'seed-tts-1.0'],
    defaultVoices: DEFAULT_VOLCENGINE_VOICES, availableVoices: AVAILABLE_VOLCENGINE_VOICES,
    async synthesizeToFile({ text, voice, outputPath, signal, adapterOptions }) {
      if (signal?.aborted) throw new TtsCancelledError();
      const { apiKey, appId, accessKey, resourceId, endpoint, timeoutMs } = { ...options, ...adapterOptions };
      if (!apiKey?.trim() && !(appId?.trim() && accessKey?.trim())) {
        throw new InputError('请先配置火山引擎语音 API Key（或 AppID + Access Key）后再生成');
      }
      const auth = apiKey?.trim() ? { 'X-Api-Key': apiKey } : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessKey };
      return synthesizeHttp({
        name: '火山引擎', endpoint: endpoint || DEFAULT_VOLCENGINE_ENDPOINT,
        headers: { ...auth, 'X-Api-Resource-Id': resourceId || DEFAULT_VOLCENGINE_RESOURCE_ID, 'X-Api-Request-Id': randomUUID() },
        body: {
          user: { uid: 'ai-podcast-generator' },
          req_params: { text, speaker: voice || DEFAULT_VOLCENGINE_VOICES.阿泽,
            audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000 } },
        },
        signal, timeoutMs, outputPath, secrets: [apiKey, appId, accessKey], readAudio,
      });
    },
  };
}

const volcengineProvider = createVolcengineProvider();
module.exports = { DEFAULT_VOLCENGINE_ENDPOINT, DEFAULT_VOLCENGINE_RESOURCE_ID, DEFAULT_VOLCENGINE_VOICES,
  AVAILABLE_VOLCENGINE_VOICES, createVolcengineProvider, volcengineProvider };
