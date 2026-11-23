const { EdgeTtsAdapter } = require('./edgeTtsAdapter');
const { DEFAULT_VOICES, AVAILABLE_VOICES } = require('./ttsService');

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
  DEFAULT_PROVIDER_ID,
  getTtsProvider,
  registerTtsProvider,
  listTtsProviders,
};
