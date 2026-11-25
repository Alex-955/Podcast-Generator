const { EdgeTtsAdapter } = require('./edgeTtsAdapter');
const { ttsSecrets, redactSecrets } = require('./validation');
const { minimaxProvider } = require('./minimaxTtsProvider');
const { volcengineProvider } = require('./volcengineTtsProvider');
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
    Array.isArray(provider.defaultVoices) || Object.keys(provider.defaultVoices).length === 0 ||
    Object.values(provider.defaultVoices).some(voice => typeof voice !== 'string' || !voice.trim()) || !Array.isArray(provider.availableVoices) ||
    typeof provider.synthesizeToFile !== 'function'
  ) {
    throw new TypeError('TTS Provider 必须提供 id、model、至少一个有效的 defaultVoices 音色、availableVoices 和 synthesizeToFile');
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
  id: DEFAULT_PROVIDER_ID, name: 'Microsoft Edge', requiresAuth: false, authModes: [],
  availableModels: ['edge-readaloud-24k48k'],
  model: 'edge-readaloud-24k48k',
  defaultVoices: DEFAULT_VOICES,
  availableVoices: AVAILABLE_VOICES,
  synthesizeToFile({ text, voice, outputPath, rate, pitch, signal, adapterOptions }) {
    const adapter = new EdgeTtsAdapter({ voice, rate, pitch, ...adapterOptions });
    return adapter.synthesizeToFile(text, outputPath, { signal });
  },
});

registerTtsProvider(minimaxProvider);
registerTtsProvider(volcengineProvider);

function resolveDefaultProviderId() {
  const id = process.env.TTS_PROVIDER?.trim();
  return providers.has(id) ? id : DEFAULT_PROVIDER_ID;
}

function resolveDefaultModel(provider = getTtsProvider(resolveDefaultProviderId())) {
  if (typeof provider === 'string') provider = getTtsProvider(provider);
  if (provider.id === 'minimax') return process.env.MINIMAX_TTS_MODEL?.trim() || provider.model;
  if (provider.id === 'volcengine') return process.env.VOLCENGINE_TTS_RESOURCE_ID?.trim() || provider.model;
  return provider.model;
}

function getPublicProviderInfo(provider = getTtsProvider(resolveDefaultProviderId())) {
  if (typeof provider === 'string') provider = getTtsProvider(provider);
  const { id, name, requiresAuth = false, authModes = [], availableModels = [], defaultVoices, availableVoices } = provider;
  const env = process.env;
  let serverConfigured = !requiresAuth;
  if (id === 'minimax') serverConfigured = Boolean(env.MINIMAX_API_KEY?.trim());
  if (id === 'volcengine') serverConfigured = Boolean(env.VOLCENGINE_TTS_API_KEY?.trim() ||
    (env.VOLCENGINE_TTS_APP_ID?.trim() && env.VOLCENGINE_TTS_ACCESS_KEY?.trim()));
  const configuredModel = resolveDefaultModel(provider);
  const safeModel = /^[a-zA-Z0-9_.:-]{1,120}$/.test(configuredModel) &&
    redactSecrets(configuredModel, [...ttsSecrets(), env.DEEPSEEK_API_KEY, env.LLM_BASE_URL]) === configuredModel;
  return { id, name, requiresAuth, authModes, availableModels, defaultModel: safeModel ? configuredModel : provider.model,
    defaultVoices: provider.defaultVoicesForModel?.(safeModel ? configuredModel : provider.model) || defaultVoices, availableVoices, serverConfigured };
}

function getPublicTtsProviders() {
  return listTtsProviders().map(getPublicProviderInfo);
}

module.exports = {
  resolveDefaultProviderId, resolveDefaultModel, getPublicProviderInfo, getPublicTtsProviders,
  DEFAULT_VOICES,
  AVAILABLE_VOICES,
  AVAILABLE_VOICE_IDS,
  DEFAULT_PROVIDER_ID,
  getTtsProvider,
  registerTtsProvider,
  listTtsProviders,
};
