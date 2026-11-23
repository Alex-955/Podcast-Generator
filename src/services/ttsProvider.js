const { EdgeTtsAdapter } = require('./edgeTtsAdapter');
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

const DEFAULT_PROVIDER_ID = 'edge';
const providers = new Map();

function registerTtsProvider(provider) {
  if (
    typeof provider?.id !== 'string' || !provider.id.trim() ||
    typeof provider.model !== 'string' || !provider.model.trim() ||
    !provider.defaultVoices || typeof provider.defaultVoices !== 'object' ||
    Array.isArray(provider.defaultVoices) || !Array.isArray(provider.availableVoices) ||
    typeof provider.synthesizeToFile !== 'function'
  ) {
    throw new TypeError('TTS Provider 必须提供 id、model、defaultVoices、availableVoices 和 synthesizeToFile');
  }
  providers.set(provider.id, provider);
}

function getTtsProvider(id = DEFAULT_PROVIDER_ID) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`未注册的 TTS Provider：${String(id)}`);
  return provider;
}

function listTtsProviders() {
  return [...providers.values()];
}

registerTtsProvider({
  id: DEFAULT_PROVIDER_ID,
  model: 'edge-readaloud-24k48k',
  defaultVoices: DEFAULT_VOICES,
  availableVoices: AVAILABLE_VOICES,
  synthesizeToFile({ text, voice, outputPath, rate, pitch, signal, adapterOptions }) {
    const adapter = new EdgeTtsAdapter({ voice, rate, pitch, ...adapterOptions });
    return adapter.synthesizeToFile(text, outputPath, { signal });
  },
});

module.exports = {
  DEFAULT_VOICES,
  AVAILABLE_VOICES,
  AVAILABLE_VOICE_IDS,
  DEFAULT_PROVIDER_ID,
  getTtsProvider,
  registerTtsProvider,
  listTtsProviders,
};
