const { InputError, validateVoiceMapping } = require('./validation');
const { checkEndpoint } = require('./providerHttp');
const { DEFAULT_MINIMAX_ENDPOINT } = require('./minimaxTtsProvider');
const { DEFAULT_VOLCENGINE_ENDPOINT, validateVolcengineVoice } = require('./volcengineTtsProvider');
const { resolveDefaultModel, DEFAULT_VOICES } = require('./ttsProvider');

function stringSetting(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new InputError('语音配置项必须是文本');
  return value.trim();
}

function normalizedEndpoint(value) {
  const url = URL.parse(value);
  if (!url || !/^https?:\/\//i.test(value) || url.username || url.password || url.hash) {
    throw new InputError('语音接口地址必须是有效的 HTTP 或 HTTPS 地址，且不能包含登录信息或片段');
  }
  return url.href;
}

function getTtsCredentials(provider, tts, previousModel) {
  const env = process.env;
  const mini = provider.id === 'minimax';
  if (!mini && provider.id !== 'volcengine') return { model: provider.model };
  const model = (!mini && stringSetting(tts.resourceId)) || stringSetting(tts.model) || previousModel || resolveDefaultModel(provider);
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(model)) throw new InputError('语音模型或资源 ID 格式无效');
  const ownKey = stringSetting(tts.apiKey);
  const ownApp = stringSetting(tts.appId);
  const ownAccess = stringSetting(tts.accessKey);
  const serverEndpoint = normalizedEndpoint(mini ? env.MINIMAX_TTS_ENDPOINT || DEFAULT_MINIMAX_ENDPOINT :
    env.VOLCENGINE_TTS_ENDPOINT || DEFAULT_VOLCENGINE_ENDPOINT);
  const endpoint = normalizedEndpoint(stringSetting(tts.endpoint) || serverEndpoint);
  if (endpoint !== serverEndpoint && !ownKey && (mini || !ownApp || !ownAccess)) {
    throw new InputError('使用自定义语音接口地址时请提供完整的对应凭据');
  }
  checkEndpoint(endpoint, env.ALLOW_PRIVATE_TTS_ENDPOINT === '1');
  if (mini) {
    const apiKey = ownKey || env.MINIMAX_API_KEY?.trim();
    if (!apiKey) throw new InputError('请先配置 MiniMax 语音合成 API Key 后再生成');
    return { apiKey, endpoint, model };
  }
  const apiKey = ownKey || (!(ownApp && ownAccess) && env.VOLCENGINE_TTS_API_KEY?.trim());
  if (apiKey) return { apiKey, endpoint, model, resourceId: model };
  const appId = ownApp || env.VOLCENGINE_TTS_APP_ID?.trim();
  const accessKey = ownAccess || env.VOLCENGINE_TTS_ACCESS_KEY?.trim();
  if (!appId || !accessKey) throw new InputError('请先配置火山引擎语音 API Key（或 AppID + Access Key）后再生成');
  return { appId, accessKey, endpoint, model, resourceId: model };
}

function resolveVoiceMapping(provider, model, input) {
  const defaults = provider.defaultVoicesForModel?.(model) || provider.defaultVoices || DEFAULT_VOICES;
  const mapping = validateVoiceMapping(input, provider);
  const fallback = Object.values(defaults)[0];
  const voices = Object.fromEntries(['阿泽', '小晓'].map(name => [name, mapping?.[name] || defaults[name] || fallback]));
  if (provider.id === 'volcengine') {
    for (const voice of Object.values(voices)) validateVolcengineVoice(model, voice);
  }
  return voices;
}

module.exports = { getTtsCredentials, resolveVoiceMapping };
