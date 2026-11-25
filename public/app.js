(function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-flash';
  const MAX_CONTENT_LENGTH = 12000;
  const FULL_PREVIEW_THRESHOLD = 150;
  const POLL_INTERVAL_MS = 1000;
  const SPEEDS = [0.8, 1.0, 1.25, 1.5, 1.75, 2.0];
  const STAGE_ORDER = ['extract', 'script', 'tts', 'merge'];

  const STORAGE_KEYS = {
    apiKey: 'ai_podcast_apikey',
    baseURL: 'ai_podcast_baseurl',
    model: 'ai_podcast_model',
    visionConfig: 'ai_podcast_vision_config',
    ttsConfig: 'ai_podcast_tts_config',
    activeTaskId: 'ai_podcast_active_task_id',
  };

  const LLM_PRESETS = [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      hint: '支持剧本生成与长图识字（如 DeepSeek Flash）。前往 platform.deepseek.com 创建 API Key 后，点下方「获取模型列表」勾选最新模型。',
    },
    {
      id: 'kimi',
      label: 'Kimi API',
      baseURL: 'https://api.moonshot.cn/v1',
      hint: 'Kimi 开放平台按量计费标准地址（platform.moonshot.cn），支持全部最新 Kimi 通用与多模态模型。填 Key 后点「获取模型列表」选择。',
    },
    {
      id: 'kimi_coding',
      label: 'Kimi Code Plan',
      baseURL: 'https://api.kimi.com/coding/v1',
      hint: 'Kimi 编程会员（Code Plan）专属地址；部分会员 Key 仅授权编程代理调用，若拉取或测试遇 403 限制请切回「Kimi API」。',
    },
    {
      id: 'doubao',
      label: '豆包',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      hint: '火山方舟大模型平台（console.volcengine.com/ark）。若账号已开通模型可直接拉取勾选；若使用推理接入点 ID（ep-xxx）可手动填入模型名。',
    },
    {
      id: 'qwen',
      label: '通义千问',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      hint: '阿里云百炼兼容模式（bailian.console.aliyun.com）。填入 API Key 后点「获取模型列表」挑选所需模型。',
    },
    {
      id: 'mimo',
      label: '小米 MiMo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      hint: '小米 MiMo 开放平台（platform.xiaomimimo.com）。填入 API Key 后点「获取模型列表」即可查看最新模型。',
    },
    {
      id: 'siliconflow',
      label: '硅基流动',
      baseURL: 'https://api.siliconflow.cn/v1',
      hint: '聚合主流开源大模型（cloud.siliconflow.cn）。模型数量较多，拉取后可用搜索框快速筛选勾选。',
    },
    {
      id: 'custom',
      label: '自定义',
      baseURL: '',
      hint: '支持任意 OpenAI 兼容接口（OpenRouter、One-API、本地 Ollama 等）；填写 Base URL 与 Key 后点「获取模型列表」或手填模型名。',
    },
  ];

  const VISION_PRESETS = [
    { id: 'reuse', baseURL: '' },
    { id: 'kimi', baseURL: 'https://api.moonshot.cn/v1' },
    { id: 'kimi_coding', baseURL: 'https://api.kimi.com/coding/v1' },
    { id: 'doubao', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
    { id: 'qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  ];

  const FALLBACK_TTS_CATALOG = {
    defaultProvider: 'edge',
    items: [
      {
        id: 'minimax',
        name: 'MiniMax Speech',
        requiresAuth: true,
        authModes: ['apiKey'],
        availableModels: ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-02-turbo', 'speech-02-hd'],
        defaultModel: 'speech-2.8-turbo',
        defaultVoices: { 阿泽: 'male-qn-jingying', 小晓: 'Chinese (Mandarin)_Warm_Bestie' },
        availableVoices: [
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
        ],
        serverConfigured: false,
      },
      {
        id: 'volcengine',
        name: '火山引擎（豆包语音 V3）',
        requiresAuth: true,
        authModes: ['apiKey', 'appIdAccessKey'],
        availableModels: ['seed-tts-2.0', 'seed-tts-1.0'],
        defaultModel: 'seed-tts-2.0',
        defaultVoices: { 阿泽: 'zh_male_taocheng_uranus_bigtts', 小晓: 'zh_female_vv_uranus_bigtts' },
        availableVoices: [
          { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0（明快青年男声·阿泽推荐）', gender: 'male' },
          { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0（沉稳播客男声）', gender: 'male' },
          { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0（对话磁性男声）', gender: 'male' },
          { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0（灵动自然女声·小晓推荐）', gender: 'female' },
          { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0（亲和对话女声）', gender: 'female' },
          { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0（清亮拆解女声）', gender: 'female' },
          { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0（干脆爽朗女声）', gender: 'female' },
          { id: 'zh_male_yangguangqingnian_moon_bigtts', name: '阳光青年 1.0', gender: 'male' },
          { id: 'zh_female_cancan_mars_bigtts', name: '灿灿 1.0', gender: 'female' },
        ],
        serverConfigured: false,
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        requiresAuth: false,
        authModes: [],
        availableModels: ['edge-readaloud-24k48k'],
        defaultModel: 'edge-readaloud-24k48k',
        defaultVoices: { 阿泽: 'zh-CN-YunxiNeural', 小晓: 'zh-CN-XiaoxiaoNeural' },
        availableVoices: [
          { id: 'zh-CN-YunxiNeural', name: '云希 (男声·温和沉稳·主持人推荐)', gender: 'male' },
          { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女声·灵动自然·嘉宾推荐)', gender: 'female' },
          { id: 'zh-CN-YunjianNeural', name: '云健 (男声·磁性解说)', gender: 'male' },
          { id: 'zh-CN-YunyangNeural', name: '云扬 (男声·专业新闻播报)', gender: 'male' },
          { id: 'zh-CN-XiaohanNeural', name: '晓涵 (女声·知性细腻)', gender: 'female' },
          { id: 'zh-CN-XiaomengNeural', name: '晓梦 (女声·活泼开朗)', gender: 'female' },
        ],
        serverConfigured: true,
      },
    ],
  };

  const TTS_SHORT_LABELS = {
    minimax: 'MiniMax Speech',
    volcengine: '火山 · 豆包',
    edge: 'Edge 免费',
  };

  const TTS_MODEL_LABELS = {
    'speech-2.8-turbo': 'speech-2.8-turbo（新一代高性价比·推荐）',
    'speech-2.8-hd': 'speech-2.8-hd（新一代高清）',
    'speech-02-turbo': 'speech-02-turbo（高速经典）',
    'speech-02-hd': 'speech-02-hd（经典高清·费率较高）',
    'seed-tts-2.0': 'seed-tts-2.0（豆包语音大模型 2.0 · 推荐）',
    'seed-tts-1.0': 'seed-tts-1.0（豆包经典版 1.0）',
  };

  const TTS_GUIDES = {
    minimax: '默认采用新一代 speech-2.8-turbo（比 02-hd 省约 43% 费用），内置句间节流防 1002 限流。前往 platform.minimaxi.com 创建 API Key 即可使用。',
    volcengine: '字节跳动豆包大模型语音（OPPO AI 妙听同款语音体系，小天 2.0 + Vivi 2.0 搭配自然）。在 console.volcengine.com/speech/app 开通「大模型语音合成」后获取 API Key。',
    edge: '免配置密钥的微软神经网络语音试用通道；因非官方公开接口，近期偶发 403 限流且拟真度一般，长期稳定制作建议使用 MiniMax 或火山豆包。',
  };

  const DEFAULT_TTS_CONFIG = {
    provider: '',
    minimax: {
      apiKey: '',
      model: 'speech-2.8-turbo',
      endpoint: '',
      voiceHost: 'male-qn-jingying',
      voiceGuest: 'Chinese (Mandarin)_Warm_Bestie',
    },
    volcengine: {
      authMode: 'apiKey',
      apiKey: '',
      appId: '',
      accessKey: '',
      resourceId: 'seed-tts-2.0',
      endpoint: '',
      voiceHost: 'zh_male_taocheng_uranus_bigtts',
      voiceGuest: 'zh_female_vv_uranus_bigtts',
    },
    edge: {
      voiceHost: 'zh-CN-YunxiNeural',
      voiceGuest: 'zh-CN-XiaoxiaoNeural',
    },
  };

  const SAMPLES = {
    ai: {
      title: 'AI 智能体 Agent 正在重构现代个人工作流',
      content: [
        '随着大语言模型推理能力的跃升，AI 不再只是问答机器，而是演化为具备自主规划、工具调用与协作能力的智能体。在传统认知中，人类需要学习各种复杂的工具软件；而在智能体时代，工具主动适应人类的意图。',
        '智能体的核心价值在于“解耦认知与执行”。比如在过去的写作流程中，收集资料、校对格式、排版发布都需要消耗大量精力。现在，一个经过精心编排的智能体可以同时调用网络搜索、阅读长文档、提炼核心论点，并直接生成结构化内容。',
        '然而，智能体并不是万能的。它的真正护城河依然在人类的输入——即深刻的领域经验、品味与判断力。正如很多行业专家所指出的那样：“AI 不会取代人，但善用 AI 智能体的人会迅速拉开与普通人的差距。”',
      ].join('\n'),
    },
    deepseek: {
      title: 'DeepSeek 的技术突围：算力性价比与架构创新',
      content: [
        '近年来，全球大模型领域一直被庞大的算力军备竞赛所主导。然而，DeepSeek 的横空出世打破了这一固有格局。通过在模型架构（如 MoE 混合专家模型、MLA 多头潜在注意力）以及训练策略上的深度极致优化，它实现了以远低于硅谷同行的算力成本，逼近甚至超越顶尖闭源模型的性能。',
        '更关键的是，DeepSeek 采取了极度开放和普惠的 API 定价策略。它让原本高昂的百万 token 推理成本降低到了人民币几毛钱甚至几分钱的级别。这极大降低了全球中小团队、独立开发者将 AI 融入日常产品的门槛。',
        '对于广大普通用户和开发者来说，底层模型的性价比变革，意味着我们可以更肆无忌惮地让 AI 帮我们进行长文转播客、多轮对抗推演、代码全自动重构等高耗能任务，而完全不必担心钱包承受不起。',
      ].join('\n'),
    },
    work: {
      title: '数字游民时代的“自由”真相：自律才是终极生产力',
      content: [
        '随着远程办公常态化与在线协作工具的成熟，“背着电脑环游世界”的数字游民生活方式吸引了无数年轻人。海滩边的咖啡馆、雪山脚下的民宿，似乎成了打破写字楼工位禁锢的乌托邦。',
        '但真正经历过半年以上游民生活的人会告诉你，这种看似浪漫的背后隐藏着剧烈的熵增：时区混乱、网络波动、社交孤独感，以及因为缺乏固定作息带来的拖延与焦虑。',
        '真正的自由绝不是随心所欲，而是建立在极高自我管理意识上的自律。那些能够长期维持游民状态并持续创造高价值收入的人，无一例外都拥有一套近乎严苛的个人操作系统：固定的深度工作时段、模块化的任务管理，以及清晰的工作生活边界。',
      ].join('\n'),
    },
  };

  const state = {
    apiKey: readStorage(STORAGE_KEYS.apiKey),
    baseURL: readStorage(STORAGE_KEYS.baseURL),
    model: readStorage(STORAGE_KEYS.model),
    visionConfig: loadVisionConfig(),
    ttsConfig: loadTtsConfig(),
    ttsCatalog: FALLBACK_TTS_CATALOG,
    settingsTab: 'llm',
    modalLlmKeyEndpoint: '',
    modalVisionKeyEndpoint: '',
    modalTtsProvider: 'edge',
    modalVolcAuthMode: 'apiKey',
    uiInputTab: 'url',
    input: window.InputSource.createState(),
    imageSlices: [],
    extractingImages: false,
    confirmedDraft: null,
    polishingDraft: false,
    fullPreviewExpanded: false,
    llmModelsCache: new Map(),
    activeTask: null,
    pollTimer: null,
    pollInFlight: false,
    elapsedTimer: null,
    historyItems: [],
    currentPodcast: null,
    currentMetaBaseText: '尚无已选播客',
    audioEngine: null,
    playbackRate: 1.0,
    isSeeking: false,
    subtitleElements: [],
  };

  const dom = {
    btnSettings: document.getElementById('btnSettings'),
    apiKeyStatusDot: document.getElementById('apiKeyStatusDot'),
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnCancelSettings: document.getElementById('btnCancelSettings'),
    settingsForm: document.getElementById('settingsForm'),
    settingsTabIndicator: document.getElementById('settingsTabIndicator'),
    settingsTabLlm: document.getElementById('settingsTabLlm'),
    settingsTabTts: document.getElementById('settingsTabTts'),
    settingsPanelLlm: document.getElementById('settingsPanelLlm'),
    settingsPanelTts: document.getElementById('settingsPanelTts'),
    llmPresetPills: document.querySelectorAll('[data-llm-preset]'),
    llmPresetHint: document.getElementById('llmPresetHint'),
    settingApiKey: document.getElementById('settingApiKey'),
    settingBaseUrl: document.getElementById('settingBaseUrl'),
    btnFetchLlmModels: document.getElementById('btnFetchLlmModels'),
    llmModelsStatus: document.getElementById('llmModelsStatus'),
    llmModelPickerWrap: document.getElementById('llmModelPickerWrap'),
    settingModelFilter: document.getElementById('settingModelFilter'),
    settingModelSelect: document.getElementById('settingModelSelect'),
    settingModel: document.getElementById('settingModel'),
    btnToggleKeyVisible: document.getElementById('btnToggleKeyVisible'),
    btnTestLlm: document.getElementById('btnTestLlm'),
    llmTestStatus: document.getElementById('llmTestStatus'),
    visionSettingsDisclosure: document.getElementById('visionSettingsDisclosure'),
    visionPresetPills: document.querySelectorAll('[data-vision-preset]'),
    settingVisionApiKey: document.getElementById('settingVisionApiKey'),
    btnToggleVisionKey: document.getElementById('btnToggleVisionKey'),
    settingVisionBaseUrl: document.getElementById('settingVisionBaseUrl'),
    btnFetchVisionModels: document.getElementById('btnFetchVisionModels'),
    visionModelsStatus: document.getElementById('visionModelsStatus'),
    settingVisionModelSelect: document.getElementById('settingVisionModelSelect'),
    settingVisionModel: document.getElementById('settingVisionModel'),

    ttsProviderButtons: document.querySelectorAll('[data-tts-provider]'),
    ttsFieldsMinimax: document.getElementById('ttsFieldsMinimax'),
    ttsFieldsVolcengine: document.getElementById('ttsFieldsVolcengine'),
    ttsFieldsEdge: document.getElementById('ttsFieldsEdge'),
    settingMinimaxKey: document.getElementById('settingMinimaxKey'),
    btnToggleMinimaxKey: document.getElementById('btnToggleMinimaxKey'),
    minimaxServerHint: document.getElementById('minimaxServerHint'),
    settingMinimaxModel: document.getElementById('settingMinimaxModel'),
    settingMinimaxVoiceHost: document.getElementById('settingMinimaxVoiceHost'),
    settingMinimaxVoiceGuest: document.getElementById('settingMinimaxVoiceGuest'),
    settingMinimaxEndpoint: document.getElementById('settingMinimaxEndpoint'),

    volcAuthButtons: document.querySelectorAll('[data-volc-auth]'),
    volcAuthApiKeyGroup: document.getElementById('volcAuthApiKeyGroup'),
    volcAuthAppGroup: document.getElementById('volcAuthAppGroup'),
    settingVolcApiKey: document.getElementById('settingVolcApiKey'),
    btnToggleVolcApiKey: document.getElementById('btnToggleVolcApiKey'),
    settingVolcAppId: document.getElementById('settingVolcAppId'),
    settingVolcAccessKey: document.getElementById('settingVolcAccessKey'),
    btnToggleVolcAccessKey: document.getElementById('btnToggleVolcAccessKey'),
    volcServerHint: document.getElementById('volcServerHint'),
    settingVolcResource: document.getElementById('settingVolcResource'),
    settingVolcVoiceHost: document.getElementById('settingVolcVoiceHost'),
    settingVolcVoiceGuest: document.getElementById('settingVolcVoiceGuest'),
    settingVolcEndpoint: document.getElementById('settingVolcEndpoint'),

    settingEdgeVoiceHost: document.getElementById('settingEdgeVoiceHost'),
    settingEdgeVoiceGuest: document.getElementById('settingEdgeVoiceGuest'),
    ttsProviderGuide: document.getElementById('ttsProviderGuide'),
    btnTestTts: document.getElementById('btnTestTts'),
    ttsTestStatus: document.getElementById('ttsTestStatus'),

    tabIndicator: document.getElementById('tabIndicator'),
    tabBtnUrl: document.getElementById('tabBtnUrl'),
    tabBtnText: document.getElementById('tabBtnText'),
    tabBtnImage: document.getElementById('tabBtnImage'),
    panelUrl: document.getElementById('panelUrl'),
    panelText: document.getElementById('panelText'),
    panelImage: document.getElementById('panelImage'),
    inputUrl: document.getElementById('inputUrl'),
    btnFetchUrl: document.getElementById('btnFetchUrl'),
    inputTitle: document.getElementById('inputTitle'),
    inputText: document.getElementById('inputText'),
    textCharCount: document.getElementById('textCharCount'),
    btnPreviewText: document.getElementById('btnPreviewText'),
    imageDropZone: document.getElementById('imageDropZone'),
    inputImageFiles: document.getElementById('inputImageFiles'),
    imagePreviewStrip: document.getElementById('imagePreviewStrip'),
    imageSelectionMeta: document.getElementById('imageSelectionMeta'),
    btnClearImages: document.getElementById('btnClearImages'),
    btnExtractImages: document.getElementById('btnExtractImages'),
    samplePills: document.querySelectorAll('.sample-pill'),
    parseErrorBanner: document.getElementById('parseErrorBanner'),
    parseErrorText: document.getElementById('parseErrorText'),
    btnOpenVisionFromParse: document.getElementById('btnOpenVisionFromParse'),
    btnSwitchToTextFromParse: document.getElementById('btnSwitchToTextFromParse'),
    btnRetryParseUrl: document.getElementById('btnRetryParseUrl'),

    studioRail: document.querySelector('.studio-rail'),
    confirmCard: document.getElementById('confirmCard'),
    confirmSourceBadge: document.getElementById('confirmSourceBadge'),
    confirmCharBadge: document.getElementById('confirmCharBadge'),
    confirmTtsBadge: document.getElementById('confirmTtsBadge'),
    confirmTruncatedBadge: document.getElementById('confirmTruncatedBadge'),
    confirmTitle: document.getElementById('confirmTitle'),
    confirmExcerpt: document.getElementById('confirmExcerpt'),
    btnToggleFullPreview: document.getElementById('btnToggleFullPreview'),
    btnPolishDraft: document.getElementById('btnPolishDraft'),
    polishBanner: document.getElementById('polishBanner'),
    polishBannerText: document.getElementById('polishBannerText'),
    polishBannerActions: document.getElementById('polishBannerActions'),
    btnEditInput: document.getElementById('btnEditInput'),
    btnStartGenerate: document.getElementById('btnStartGenerate'),

    progressSection: document.getElementById('progressSection'),
    progressStatusBadge: document.getElementById('progressStatusBadge'),
    stageElapsed: document.getElementById('stageElapsed'),
    btnCancelTask: document.getElementById('btnCancelTask'),
    progressTaskTitle: document.getElementById('progressTaskTitle'),
    stageStepper: document.getElementById('stageStepper'),
    taskMeterTrack: document.getElementById('taskMeterTrack'),
    taskMeterFill: document.getElementById('taskMeterFill'),
    progressMessage: document.getElementById('progressMessage'),
    cacheHitBadge: document.getElementById('cacheHitBadge'),
    activeSpeakerChip: document.getElementById('activeSpeakerChip'),
    taskErrorBanner: document.getElementById('taskErrorBanner'),
    taskErrorText: document.getElementById('taskErrorText'),
    taskResumeHint: document.getElementById('taskResumeHint'),
    taskErrorActions: document.getElementById('taskErrorActions'),

    historyCount: document.getElementById('historyCount'),
    btnRefreshHistory: document.getElementById('btnRefreshHistory'),
    historyList: document.getElementById('historyList'),

    playerDeck: document.getElementById('playerDeck'),
    waveVisualizer: document.getElementById('waveVisualizer'),
    currentPodcastMeta: document.getElementById('currentPodcastMeta'),
    currentPodcastTitle: document.getElementById('currentPodcastTitle'),
    currentPodcastSummary: document.getElementById('currentPodcastSummary'),
    currentTime: document.getElementById('currentTime'),
    totalDuration: document.getElementById('totalDuration'),
    seekSlider: document.getElementById('seekSlider'),
    btnDownloadAudio: document.getElementById('btnDownloadAudio'),
    btnCopyMarkdown: document.getElementById('btnCopyMarkdown'),
    btnRewind10: document.getElementById('btnRewind10'),
    btnPlayPause: document.getElementById('btnPlayPause'),
    playRipple: document.getElementById('playRipple'),
    btnForward10: document.getElementById('btnForward10'),
    btnBgmMode: document.getElementById('btnBgmMode'),
    bgmModeLabel: document.getElementById('bgmModeLabel'),
    btnSpeed: document.getElementById('btnSpeed'),
    subtitlesList: document.getElementById('subtitlesList'),

    mobileMiniPlayer: document.getElementById('mobileMiniPlayer'),
    miniTitle: document.getElementById('miniTitle'),
    miniTime: document.getElementById('miniTime'),
    btnMiniSpeed: document.getElementById('btnMiniSpeed'),
    btnMiniPlayPause: document.getElementById('btnMiniPlayPause'),
    miniProgressFill: document.getElementById('miniProgressFill'),

    mainAudio: document.getElementById('mainAudioPlayer'),
    toastStack: document.getElementById('toastStack'),
  };

  function readStorage(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function writeStorage(key, value) {
    try {
      if (value) {
        localStorage.setItem(key, value);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // 隐私模式下忽略本地存储写入失败
    }
  }

  function loadVisionConfig() {
    const raw = readStorage(STORAGE_KEYS.visionConfig);
    if (!raw) return { apiKey: '', baseURL: '', model: '' };
    try {
      const parsed = JSON.parse(raw);
      return {
        apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : '',
        baseURL: typeof parsed?.baseURL === 'string' ? parsed.baseURL : '',
        model: typeof parsed?.model === 'string' ? parsed.model : '',
      };
    } catch {
      return { apiKey: '', baseURL: '', model: '' };
    }
  }

  function saveVisionConfigToStorage() {
    const cfg = state.visionConfig;
    if (!cfg.apiKey && !cfg.baseURL && !cfg.model) {
      writeStorage(STORAGE_KEYS.visionConfig, '');
      return;
    }
    writeStorage(STORAGE_KEYS.visionConfig, JSON.stringify(cfg));
  }

  function loadTtsConfig() {
    const raw = readStorage(STORAGE_KEYS.ttsConfig);
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const base = {
      provider: typeof parsed?.provider === 'string' ? parsed.provider : DEFAULT_TTS_CONFIG.provider,
      minimax: { ...DEFAULT_TTS_CONFIG.minimax, ...(parsed?.minimax && typeof parsed.minimax === 'object' ? parsed.minimax : {}) },
      volcengine: { ...DEFAULT_TTS_CONFIG.volcengine, ...(parsed?.volcengine && typeof parsed.volcengine === 'object' ? parsed.volcengine : {}) },
      edge: { ...DEFAULT_TTS_CONFIG.edge, ...(parsed?.edge && typeof parsed.edge === 'object' ? parsed.edge : {}) },
    };
    if (!['minimax', 'volcengine', 'edge', ''].includes(base.provider)) {
      base.provider = '';
    }
    if (!['apiKey', 'appIdAccessKey'].includes(base.volcengine.authMode)) {
      base.volcengine.authMode = 'apiKey';
    }
    return base;
  }

  function saveTtsConfigToStorage() {
    writeStorage(STORAGE_KEYS.ttsConfig, JSON.stringify(state.ttsConfig));
  }

  function resolveEffectiveTtsProviderId() {
    if (['minimax', 'volcengine', 'edge'].includes(state.ttsConfig.provider)) {
      return state.ttsConfig.provider;
    }
    return state.ttsCatalog?.defaultProvider || 'edge';
  }

  function getCatalogProvider(id) {
    const items = Array.isArray(state.ttsCatalog?.items) ? state.ttsCatalog.items : FALLBACK_TTS_CATALOG.items;
    return items.find((item) => item.id === id) || FALLBACK_TTS_CATALOG.items.find((item) => item.id === id);
  }

  function showToast(message) {
    const pill = document.createElement('div');
    pill.className = 'toast-pill';
    pill.textContent = message;
    dom.toastStack.appendChild(pill);
    window.setTimeout(() => {
      pill.remove();
    }, 3200);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatDateLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${month} 月 ${day} 日 ${hh}:${mm}`;
  }

  function isHostSpeaker(speaker) {
    return speaker === '阿泽' || speaker === '主持人' || speaker === 'Host' || String(speaker).includes('泽');
  }

  function displaySpeakerName(speaker) {
    return isHostSpeaker(speaker) ? '阿泽' : '小晓';
  }

  function initWaveformBars() {
    const heights = [
      0.32, 0.56, 0.44, 0.78, 0.94, 0.62, 0.40, 0.85,
      0.98, 0.68, 0.46, 0.88, 0.74, 0.52, 0.92, 0.64,
      0.38, 0.82, 0.95, 0.58, 0.42, 0.76, 0.48, 0.30,
    ];
    dom.waveVisualizer.textContent = '';
    heights.forEach((peak, idx) => {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      const centerDist = Math.abs(idx - (heights.length - 1) / 2) / (heights.length / 2);
      const envelope = 0.56 - centerDist * 0.34;
      const idle = Math.max(0.20, envelope * (0.72 + (idx % 3) * 0.14)).toFixed(2);
      const dur = 680 + ((idx * 97) % 420);
      const delay = ((idx * 65) % 480);
      bar.style.setProperty('--idle-scale', idle);
      bar.style.setProperty('--bar-peak', String(peak));
      bar.style.setProperty('--bar-dur', `${dur}ms`);
      bar.style.setProperty('--bar-delay', `${delay}ms`);
      dom.waveVisualizer.appendChild(bar);
    });
  }

  function positionTabIndicator(immediate) {
    const map = { url: dom.tabBtnUrl, text: dom.tabBtnText, image: dom.tabBtnImage };
    const activeBtn = map[state.uiInputTab] || dom.tabBtnUrl;
    if (!activeBtn) return;
    if (immediate) {
      dom.tabIndicator.style.transition = 'none';
    }
    dom.tabIndicator.style.width = `${activeBtn.offsetWidth}px`;
    dom.tabIndicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    if (immediate) {
      void dom.tabIndicator.offsetWidth;
      dom.tabIndicator.style.transition = '';
    }
  }

  function invalidateConfirmedDraft() {
    state.confirmedDraft = null;
    state.fullPreviewExpanded = false;
    dom.confirmCard.classList.add('hidden');
    if (dom.studioRail) dom.studioRail.classList.remove('has-confirm');
    const previewSpan = dom.btnPreviewText.querySelector('span');
    if (previewSpan) previewSpan.textContent = '预览并确认';
  }

  function hideParseError() {
    dom.parseErrorBanner.classList.add('hidden');
    dom.parseErrorText.textContent = '';
    dom.inputUrl.classList.remove('is-invalid');
    dom.inputText.classList.remove('is-invalid');
    if (dom.btnOpenVisionFromParse) dom.btnOpenVisionFromParse.classList.add('hidden');
  }

  function showParseError(message, fieldEl, { source = state.uiInputTab, showVisionConfig = false } = {}) {
    dom.parseErrorText.textContent = message;
    dom.parseErrorBanner.classList.remove('hidden');
    if (fieldEl) fieldEl.classList.add('is-invalid');

    if (dom.btnOpenVisionFromParse) {
      dom.btnOpenVisionFromParse.classList.toggle('hidden', !showVisionConfig);
    }
    if (dom.btnSwitchToTextFromParse) {
      dom.btnSwitchToTextFromParse.classList.toggle('hidden', source === 'text');
    }
    if (dom.btnRetryParseUrl) {
      dom.btnRetryParseUrl.classList.toggle('hidden', source !== 'url');
    }
  }

  function switchTab(mode, { immediateIndicator = false } = {}) {
    const uiMode = ['url', 'text', 'image'].includes(mode) ? mode : 'url';
    state.uiInputTab = uiMode;
    window.InputSource.setMode(state.input, uiMode === 'url' ? 'url' : 'text');

    const tabs = [
      [dom.tabBtnUrl, dom.panelUrl, uiMode === 'url'],
      [dom.tabBtnText, dom.panelText, uiMode === 'text'],
      [dom.tabBtnImage, dom.panelImage, uiMode === 'image'],
    ];
    tabs.forEach(([btn, panel, active]) => {
      if (btn) {
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      }
      if (panel) {
        panel.classList.toggle('hidden', !active);
        panel.classList.toggle('is-active', active);
      }
    });

    invalidateConfirmedDraft();
    hideParseError();
    positionTabIndicator(immediateIndicator);
  }

  function updateTextCounter() {
    const len = dom.inputText.value.trim().length;
    dom.textCharCount.textContent = `${len.toLocaleString('zh-CN')} / ${MAX_CONTENT_LENGTH.toLocaleString('zh-CN')} 字`;
    dom.textCharCount.classList.toggle('is-over', len > MAX_CONTENT_LENGTH);
  }

  function renderPolishBanner() {
    const draft = state.confirmedDraft;
    if (!dom.polishBanner || !draft) return;

    dom.polishBannerActions.textContent = '';
    dom.polishBanner.classList.remove('is-done');

    if (draft.polishedFrom) {
      dom.polishBanner.classList.remove('hidden');
      dom.polishBanner.classList.add('is-done');
      dom.polishBannerText.textContent = draft.changeSummary || '已完成上下文纠错与语句顺滑处理';
      const undoBtn = createActionBtn('恢复润色前原文', 'btn btn-subtle btn-sm', restoreDraftBeforePolish);
      dom.polishBannerActions.appendChild(undoBtn);
      return;
    }

    if (draft.hasIssues) {
      dom.polishBanner.classList.remove('hidden');
      dom.polishBannerText.textContent = draft.issueHint
        ? `智能体检：${draft.issueHint}，是否根据上下文纠错润色？`
        : '智能体检：识别出部分内容可能存在错别字或断句问题，建议点击「AI 纠错润色」优化后再生成播客。';
      const polishBtn = createActionBtn('立即纠错润色', 'btn btn-primary btn-sm', handlePolishDraft);
      dom.polishBannerActions.appendChild(polishBtn);
      return;
    }

    dom.polishBanner.classList.add('hidden');
    dom.polishBannerText.textContent = '';
  }

  function restoreDraftBeforePolish() {
    const draft = state.confirmedDraft;
    if (!draft?.polishedFrom) return;
    const prev = draft.polishedFrom;
    renderConfirmationCard({
      ...draft,
      title: prev.title,
      content: prev.content,
      length: prev.content.length,
      truncated: prev.truncated,
      hasIssues: prev.hasIssues,
      issueHint: prev.issueHint,
      polishedFrom: null,
      changeSummary: '',
    });
    if (state.uiInputTab === 'text') {
      dom.inputTitle.value = prev.title || '';
      dom.inputText.value = prev.content || '';
      updateTextCounter();
    }
    showToast('已恢复润色前原文');
  }

  async function handlePolishDraft() {
    const draft = state.confirmedDraft;
    if (!draft || state.polishingDraft) return;
    state.polishingDraft = true;
    const polishBtnSpan = dom.btnPolishDraft?.querySelector('span');
    if (dom.btnPolishDraft) dom.btnPolishDraft.disabled = true;
    if (polishBtnSpan) polishBtnSpan.textContent = '正在纠错润色…';
    const bannerBtn = dom.polishBannerActions?.querySelector('button');
    if (bannerBtn) bannerBtn.disabled = true;

    try {
      const data = await apiJson('/api/polish-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          content: draft.content,
          ...buildCredsPayload(),
        }),
      });

      const originalSnapshot = draft.polishedFrom || {
        title: draft.title,
        content: draft.content,
        truncated: Boolean(draft.truncated),
        hasIssues: Boolean(draft.hasIssues),
        issueHint: draft.issueHint || '',
      };

      renderConfirmationCard({
        ...draft,
        title: data.title || draft.title,
        content: data.content,
        length: data.length,
        truncated: Boolean(data.truncated),
        hasIssues: false,
        issueHint: '',
        polishedFrom: originalSnapshot,
        changeSummary: data.changeSummary || '已完成上下文纠错与语句顺滑处理',
      });

      if (state.uiInputTab === 'text') {
        dom.inputTitle.value = data.title || '';
        dom.inputText.value = data.content || '';
        updateTextCounter();
      }
      showToast('已完成 AI 纠错润色，可核对或一键还原');
    } catch (err) {
      handleCredentialOrTaskError(err);
    } finally {
      state.polishingDraft = false;
      if (dom.btnPolishDraft) dom.btnPolishDraft.disabled = false;
      if (polishBtnSpan) polishBtnSpan.textContent = 'AI 纠错润色';
    }
  }

  function renderConfirmationCard(draft) {
    state.confirmedDraft = draft;
    state.fullPreviewExpanded = false;

    const badgeText = draft.mode === 'url' ? '链接解析' : draft.mode === 'image' ? '长图识字' : '直接贴正文';
    dom.confirmSourceBadge.textContent = badgeText;
    dom.confirmCharBadge.textContent = `${draft.length.toLocaleString('zh-CN')} 字`;
    updateConfirmTtsBadge();
    dom.confirmTruncatedBadge.classList.toggle('hidden', !draft.truncated);
    dom.confirmTitle.textContent = draft.title || '未命名文章（生成时将自动提炼标题）';

    updateExcerptView();
    renderPolishBanner();
    dom.confirmCard.classList.remove('hidden');
    if (dom.studioRail) dom.studioRail.classList.add('has-confirm');
    if (draft.mode === 'text') {
      const previewSpan = dom.btnPreviewText.querySelector('span');
      if (previewSpan) previewSpan.textContent = '已在下方预览';
    }
    const busy = hasActiveRunningTask();
    dom.btnStartGenerate.disabled = busy;
    dom.btnStartGenerate.querySelector('span').textContent = busy ? '当前已有任务生成中' : '开始生成双人播客';
  }

  function updateExcerptView() {
    const draft = state.confirmedDraft;
    if (!draft) return;
    const text = draft.content || '';
    const longText = text.length > FULL_PREVIEW_THRESHOLD;

    if (!longText) {
      dom.confirmExcerpt.textContent = text;
      dom.confirmExcerpt.classList.remove('is-expanded');
      dom.btnToggleFullPreview.classList.add('hidden');
      return;
    }

    dom.btnToggleFullPreview.classList.remove('hidden');
    dom.btnToggleFullPreview.setAttribute('aria-expanded', String(state.fullPreviewExpanded));
    dom.btnToggleFullPreview.querySelector('span').textContent = state.fullPreviewExpanded ? '收起全文' : '展开全文预览';

    if (state.fullPreviewExpanded) {
      dom.confirmExcerpt.textContent = text;
      dom.confirmExcerpt.classList.add('is-expanded');
    } else {
      dom.confirmExcerpt.textContent = `${text.slice(0, FULL_PREVIEW_THRESHOLD)}…`;
      dom.confirmExcerpt.classList.remove('is-expanded');
    }
  }

  async function apiJson(url, options = {}) {
    const res = await fetch(url, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`服务返回异常响应（HTTP ${res.status}）`);
    }
    if (!res.ok || data?.success === false) {
      const err = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data.data;
  }

  async function handleFetchUrl() {
    const url = dom.inputUrl.value.trim();
    if (!url) {
      showParseError('请先粘贴文章或微信公众号链接。', dom.inputUrl);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showParseError('请粘贴以 http:// 或 https:// 开头的完整链接；如果手头是文章正文，请切换到「直接贴正文」。', dom.inputUrl);
      return;
    }

    const opSeq = window.InputSource.beginOperation(state.input, url);
    if (opSeq === null) {
      showToast('操作正在进行中，请稍候');
      return;
    }

    hideParseError();
    invalidateConfirmedDraft();
    setParseLoading(true);

    try {
      const data = await apiJson('/api/extract-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const applied = window.InputSource.applyParseResult(state.input, {
        seq: opSeq,
        url,
        currentUrl: dom.inputUrl.value,
        title: data.title,
        content: data.content,
      });

      if (applied !== 'applied') {
        showToast('链接输入已变化，已丢弃过期解析结果');
        return;
      }

      renderConfirmationCard({
        mode: 'url',
        url,
        title: data.title || '',
        content: data.content,
        length: data.length,
        truncated: Boolean(data.truncated),
      });
    } catch (err) {
      showParseError(err.message || '抓取文章失败，建议切换到「直接贴正文」粘贴文章内容', dom.inputUrl);
    } finally {
      window.InputSource.finishOperation(state.input, opSeq);
      setParseLoading(false);
    }
  }

  function setParseLoading(loading) {
    dom.btnFetchUrl.disabled = loading;
    dom.btnFetchUrl.querySelector('span').textContent = loading ? '正在抓取正文…' : '解析文章';
  }

  function confirmTextDraft() {
    const rawContent = dom.inputText.value.trim();
    const rawTitle = dom.inputTitle.value.trim();
    if (!rawContent) {
      showParseError('请先粘贴或输入文章正文。', dom.inputText);
      dom.inputText.focus();
      return;
    }
    if (/^https?:\/\/\S+$/i.test(rawContent)) {
      showParseError('检测到你粘贴的是单个链接，请切换到「文章链接」标签进行抓取解析。', dom.inputText);
      return;
    }

    hideParseError();
    const truncated = rawContent.length > MAX_CONTENT_LENGTH;
    const content = rawContent.slice(0, MAX_CONTENT_LENGTH);

    renderConfirmationCard({
      mode: 'text',
      title: rawTitle,
      content,
      length: content.length,
      truncated,
    });
  }

  function buildVisionPayload(source = state.visionConfig) {
    const out = {};
    if (source?.apiKey?.trim()) out.visionApiKey = source.apiKey.trim();
    if (source?.baseURL?.trim()) out.visionBaseURL = source.baseURL.trim();
    if (source?.model?.trim()) out.visionModel = source.model.trim();
    return out;
  }

  const MAX_IMAGE_SLICES = 8;

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`无法读取图片 ${file.name || ''}`));
      };
      img.src = objectUrl;
    });
  }

  function encodeCanvasSlice(img, sx, sy, sw, sh, outW, outH) {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  async function sliceImageFile(file, remainingQuota) {
    const img = await loadImageFromFile(file);
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) throw new Error('图片尺寸无效');

    const targetW = Math.min(natW, 1360);
    const scale = targetW / natW;
    const scaledH = Math.max(1, Math.round(natH * scale));
    const slices = [];

    if (natH / natW > 2.2 && remainingQuota > 1) {
      const targetSliceOutH = Math.round(targetW * 1.45);
      const overlapOutH = Math.round(targetW * 0.14);
      let stepOut = Math.max(200, targetSliceOutH - overlapOutH);
      const estimatedCount = Math.ceil((scaledH - overlapOutH) / stepOut);

      if (estimatedCount > remainingQuota) {
        stepOut = Math.ceil((scaledH - overlapOutH) / remainingQuota);
      }

      const sliceSrcH = Math.min(natH, Math.round(Math.max(targetSliceOutH, stepOut + overlapOutH) / scale));
      const stepSrc = Math.max(100, Math.round(stepOut / scale));

      for (let sy = 0; sy < natH && slices.length < remainingQuota; sy += stepSrc) {
        const sh = Math.min(sliceSrcH, natH - sy);
        const outH = Math.max(1, Math.round(sh * scale));
        slices.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          dataUrl: encodeCanvasSlice(img, 0, sy, natW, sh, targetW, outH),
          sourceName: file.name || '截图',
          autoSliced: true,
        });
        if (sy + sh >= natH) break;
      }
      return slices;
    }

    const cappedOutH = Math.min(scaledH, 3200);
    const cappedW = cappedOutH < scaledH ? Math.max(1, Math.round(targetW * (cappedOutH / scaledH))) : targetW;
    slices.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: encodeCanvasSlice(img, 0, 0, natW, natH, cappedW, cappedOutH),
      sourceName: file.name || '截图',
      autoSliced: false,
    });
    return slices;
  }

  function renderImageSelection() {
    const list = state.imageSlices;
    dom.imagePreviewStrip.textContent = '';

    if (!list.length) {
      dom.imagePreviewStrip.classList.add('hidden');
      dom.imageSelectionMeta.textContent = '尚未选择图片';
      dom.btnClearImages.classList.add('hidden');
      dom.btnExtractImages.disabled = true;
      return;
    }

    dom.imagePreviewStrip.classList.remove('hidden');
    dom.btnClearImages.classList.remove('hidden');
    dom.btnExtractImages.disabled = state.extractingImages;

    const slicedCount = list.filter((item) => item.autoSliced).length;
    dom.imageSelectionMeta.textContent = slicedCount > 0
      ? `已准备 ${list.length}/${MAX_IMAGE_SLICES} 片段（含长图自动切片）`
      : `已选 ${list.length}/${MAX_IMAGE_SLICES} 张图片`;

    list.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'image-thumb-card';

      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = `待识别图片 ${idx + 1}`;

      const badge = document.createElement('span');
      badge.className = 'image-thumb-idx';
      badge.textContent = `#${idx + 1}`;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'image-thumb-del';
      delBtn.setAttribute('aria-label', `移除第 ${idx + 1} 张图片`);
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.imageSlices = state.imageSlices.filter((slice) => slice.id !== item.id);
        renderImageSelection();
      });

      card.append(img, badge, delBtn);
      dom.imagePreviewStrip.appendChild(card);
    });
  }

  async function appendImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type));
    if (!files.length) {
      showToast('请选择 PNG、JPG 或 WebP 格式的截图文件');
      return;
    }
    hideParseError();

    let added = 0;
    for (const file of files) {
      const remaining = MAX_IMAGE_SLICES - state.imageSlices.length;
      if (remaining <= 0) {
        showToast(`单次最多支持 ${MAX_IMAGE_SLICES} 张（或切片），多余部分已跳过`);
        break;
      }
      try {
        const sliced = await sliceImageFile(file, remaining);
        state.imageSlices.push(...sliced);
        added += sliced.length;
      } catch (err) {
        showToast(err.message || '图片处理失败');
      }
    }
    renderImageSelection();
    if (added > 0) {
      showToast(`已载入 ${added} 个图片片段`);
    }
  }

  function clearSelectedImages() {
    state.imageSlices = [];
    if (dom.inputImageFiles) dom.inputImageFiles.value = '';
    hideParseError();
    renderImageSelection();
  }

  async function handleExtractImages() {
    if (!state.imageSlices.length || state.extractingImages) return;
    hideParseError();
    invalidateConfirmedDraft();
    state.extractingImages = true;
    dom.btnExtractImages.disabled = true;
    const btnSpan = dom.btnExtractImages.querySelector('span');
    if (btnSpan) btnSpan.textContent = '正在识别文字…';

    try {
      const data = await apiJson('/api/extract-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: state.imageSlices.map((s) => s.dataUrl),
          ...buildCredsPayload(),
          ...buildVisionPayload(),
        }),
      });

      switchTab('text');
      dom.inputTitle.value = data.title || '';
      dom.inputText.value = data.content || '';
      updateTextCounter();

      renderConfirmationCard({
        mode: 'image',
        title: data.title || '',
        content: data.content,
        length: data.length,
        truncated: Boolean(data.truncated),
        hasIssues: Boolean(data.hasIssues),
        issueHint: data.issueHint || '',
      });
      showToast(data.hasIssues
        ? `已识别 ${data.length.toLocaleString('zh-CN')} 字（检测到疑似错字，可点「AI 纠错润色」）`
        : `已从截图识别 ${data.length.toLocaleString('zh-CN')} 字，请核对后生成播客`);
    } catch (err) {
      const msg = err.message || '图片文字识别失败，建议换清晰截图或直接贴正文';
      const needsVisionConfig = err.status === 400 && /识图|图片|视觉|多模态|API Key/i.test(msg);
      showParseError(msg, null, { source: 'image', showVisionConfig: needsVisionConfig });
    } finally {
      state.extractingImages = false;
      if (btnSpan) btnSpan.textContent = '识别图片文字';
      dom.btnExtractImages.disabled = state.imageSlices.length === 0;
    }
  }

  function buildCredsPayload(source = state) {
    const payload = {};
    const key = String(source.apiKey || '').trim();
    const baseURL = String(source.baseURL || '').trim();
    const model = String(source.model || '').trim();
    if (key) {
      payload.apiKey = key;
      if (baseURL) payload.baseURL = baseURL;
    } else if (baseURL && baseURL !== DEFAULT_BASE_URL) {
      payload.baseURL = baseURL;
    }
    if (model && (key || model !== DEFAULT_MODEL)) {
      payload.model = model;
    }
    return payload;
  }

  function buildTtsPayload(source = state.ttsConfig, providerOverride) {
    const cfg = source || state.ttsConfig;
    const provider = providerOverride || resolveEffectiveTtsProviderId();
    if (provider === 'minimax') {
      const out = {
        provider: 'minimax',
        model: cfg.minimax.model || DEFAULT_TTS_CONFIG.minimax.model,
        voiceMapping: {
          阿泽: cfg.minimax.voiceHost || DEFAULT_TTS_CONFIG.minimax.voiceHost,
          小晓: cfg.minimax.voiceGuest || DEFAULT_TTS_CONFIG.minimax.voiceGuest,
        },
      };
      if (cfg.minimax.apiKey?.trim()) out.apiKey = cfg.minimax.apiKey.trim();
      if (cfg.minimax.endpoint?.trim()) out.endpoint = cfg.minimax.endpoint.trim();
      return out;
    }
    if (provider === 'volcengine') {
      const resourceId = cfg.volcengine.resourceId || DEFAULT_TTS_CONFIG.volcengine.resourceId;
      const defaults = getVolcDefaultVoices(resourceId);
      const out = {
        provider: 'volcengine',
        resourceId,
        model: resourceId,
        voiceMapping: {
          阿泽: cfg.volcengine.voiceHost || defaults.阿泽,
          小晓: cfg.volcengine.voiceGuest || defaults.小晓,
        },
      };
      if (cfg.volcengine.authMode === 'appIdAccessKey') {
        if (cfg.volcengine.appId?.trim()) out.appId = cfg.volcengine.appId.trim();
        if (cfg.volcengine.accessKey?.trim()) out.accessKey = cfg.volcengine.accessKey.trim();
      } else if (cfg.volcengine.apiKey?.trim()) {
        out.apiKey = cfg.volcengine.apiKey.trim();
      }
      if (cfg.volcengine.endpoint?.trim()) out.endpoint = cfg.volcengine.endpoint.trim();
      return out;
    }
    return {
      provider: 'edge',
      voiceMapping: {
        阿泽: cfg.edge.voiceHost || DEFAULT_TTS_CONFIG.edge.voiceHost,
        小晓: cfg.edge.voiceGuest || DEFAULT_TTS_CONFIG.edge.voiceGuest,
      },
    };
  }

  function hasActiveRunningTask() {
    return state.activeTask && ['queued', 'running'].includes(state.activeTask.status);
  }

  async function handleStartGenerate() {
    if (!state.confirmedDraft) {
      showToast('请先解析文章或预览确认正文');
      return;
    }
    if (hasActiveRunningTask()) {
      showToast('当前已有任务正在生成，请等待完成或先取消');
      return;
    }

    const draftSnapshot = { ...state.confirmedDraft };
    dom.btnStartGenerate.disabled = true;

    try {
      const task = await apiJson('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'text',
          title: draftSnapshot.title,
          content: draftSnapshot.content,
          ...buildCredsPayload(),
          tts: buildTtsPayload(),
        }),
      });

      invalidateConfirmedDraft();
      setActiveTask(task);
      if (window.innerWidth <= 900) {
        dom.progressSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      startPolling();
      showToast('已加入后台生成队列，开始制作双人播客');
    } catch (err) {
      handleCredentialOrTaskError(err);
    } finally {
      dom.btnStartGenerate.disabled = hasActiveRunningTask();
    }
  }

  function handleCredentialOrTaskError(err) {
    const msg = err.message || '请求未能完成';
    showToast(msg);
    if (err.status === 400) {
      if (/语音|MiniMax|火山|豆包|音色|TTS|AppID|Access Key|资源版本/i.test(msg)) {
        openSettingsModal('tts');
      } else if (/API Key|接口地址|模型/i.test(msg)) {
        openSettingsModal('llm');
      }
    }
  }

  function setActiveTask(task) {
    state.activeTask = task;
    if (task && task.id) {
      writeStorage(STORAGE_KEYS.activeTaskId, task.id);
      if (dom.studioRail) dom.studioRail.classList.add('has-task');
      renderTaskProgress(task);
    } else {
      writeStorage(STORAGE_KEYS.activeTaskId, '');
      stopPolling();
      stopElapsedTimer();
      dom.progressSection.classList.add('hidden');
      if (dom.studioRail) dom.studioRail.classList.remove('has-task');
    }
    if (state.confirmedDraft) {
      const busy = hasActiveRunningTask();
      dom.btnStartGenerate.disabled = busy;
      dom.btnStartGenerate.querySelector('span').textContent = busy ? '当前已有任务生成中' : '开始生成双人播客';
    }
  }

  function startPolling() {
    stopPolling();
    startElapsedTimer();
    state.pollTimer = window.setInterval(pollCurrentTask, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    updateElapsedLabel();
    state.elapsedTimer = window.setInterval(updateElapsedLabel, 500);
  }

  function stopElapsedTimer() {
    if (state.elapsedTimer) {
      window.clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  function updateElapsedLabel() {
    const task = state.activeTask;
    if (!task) return;
    if (!['queued', 'running'].includes(task.status)) {
      dom.stageElapsed.textContent = '';
      return;
    }
    const started = Date.parse(task.progress?.stageStartedAt || task.createdAt);
    if (Number.isNaN(started)) {
      dom.stageElapsed.textContent = '';
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - started) / 1000));
    dom.stageElapsed.textContent = `本阶段已耗时 ${sec}s`;
  }

  async function pollCurrentTask() {
    if (!state.activeTask?.id || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const task = await apiJson(`/api/tasks/${encodeURIComponent(state.activeTask.id)}`);
      state.activeTask = task;
      renderTaskProgress(task);

      if (task.status === 'completed') {
        stopPolling();
        stopElapsedTimer();
        writeStorage(STORAGE_KEYS.activeTaskId, '');
        await loadHistoryList();
        if (task.podcast) {
          loadPodcast(task.podcast, { autoplay: false });
        }
        showToast(`播客《${task.podcastTitle || '新剧集'}》已生成完毕`);
        window.setTimeout(() => {
          if (state.activeTask?.id === task.id && state.activeTask?.status === 'completed') {
            setActiveTask(null);
          }
        }, 1600);
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        stopPolling();
        stopElapsedTimer();
      }
    } catch (err) {
      if (err.status === 404) {
        setActiveTask(null);
      }
    } finally {
      state.pollInFlight = false;
    }
  }

  function renderTaskProgress(task) {
    dom.progressSection.classList.remove('hidden');

    const title = task.podcastTitle || task.input?.title || '正在处理文章并准备播客';
    dom.progressTaskTitle.textContent = title;

    const status = task.status;
    dom.progressStatusBadge.className = 'state-chip';
    if (status === 'queued' || status === 'running') {
      dom.progressStatusBadge.classList.add('is-running');
      dom.progressStatusBadge.textContent = status === 'queued' ? '排队中' : '生成中';
      dom.btnCancelTask.classList.remove('hidden');
      dom.btnCancelTask.disabled = false;
    } else if (status === 'completed') {
      dom.progressStatusBadge.classList.add('is-done');
      dom.progressStatusBadge.textContent = '已完成';
      dom.btnCancelTask.classList.add('hidden');
    } else if (status === 'cancelled') {
      dom.progressStatusBadge.classList.add('is-cancelled');
      dom.progressStatusBadge.textContent = '已取消';
      dom.btnCancelTask.classList.add('hidden');
    } else {
      dom.progressStatusBadge.classList.add('is-failed');
      dom.progressStatusBadge.textContent = '已中断';
      dom.btnCancelTask.classList.add('hidden');
    }

    updateStepper(task);
    updateMeterAndChips(task);
    updateTaskErrorBanner(task);
    updateElapsedLabel();
  }

  function updateStepper(task) {
    const activeStage = task.stage;
    const isCompleted = task.status === 'completed' || activeStage === 'done';
    const activeIdx = isCompleted ? STAGE_ORDER.length : Math.max(0, STAGE_ORDER.indexOf(activeStage));

    const nodes = dom.stageStepper.querySelectorAll('.step-node');
    nodes.forEach((node) => {
      const idx = STAGE_ORDER.indexOf(node.dataset.stage);
      node.classList.remove('is-done', 'is-active', 'is-error');
      if (idx < activeIdx) {
        node.classList.add('is-done');
      } else if (idx === activeIdx) {
        if (task.status === 'failed') {
          node.classList.add('is-error');
        } else if (task.status === 'running' || task.status === 'queued') {
          node.classList.add('is-active');
        }
      }
    });
  }

  function updateMeterAndChips(task) {
    const prog = task.progress || {};
    const stage = task.stage;
    const running = ['queued', 'running'].includes(task.status);

    dom.taskMeterFill.classList.remove('is-indeterminate');

    if (task.status === 'completed') {
      dom.taskMeterFill.style.width = '100%';
      dom.taskMeterTrack.setAttribute('aria-valuenow', '100');
      dom.progressMessage.textContent = '全部片段拼接完成，已载入右侧播放器。';
    } else if (stage === 'tts' && prog.totalSegments > 0) {
      const pct = Math.min(100, Math.round((prog.completedSegments / prog.totalSegments) * 100));
      dom.taskMeterFill.style.width = `${pct}%`;
      dom.taskMeterTrack.setAttribute('aria-valuenow', String(pct));
      dom.progressMessage.textContent = `已完成 ${prog.completedSegments}/${prog.totalSegments} 句${prog.message ? ` · ${prog.message}` : ''}`;
    } else if (running) {
      dom.taskMeterFill.classList.add('is-indeterminate');
      dom.taskMeterTrack.removeAttribute('aria-valuenow');
      dom.progressMessage.textContent = prog.message || `${prog.stageLabel || '处理中'}…`;
    } else {
      const donePct = prog.totalSegments > 0
        ? Math.round((prog.completedSegments / prog.totalSegments) * 100)
        : 0;
      dom.taskMeterFill.style.width = `${donePct}%`;
      dom.taskMeterTrack.setAttribute('aria-valuenow', String(donePct));
      dom.progressMessage.textContent = prog.message || '任务已停留在当前阶段';
    }

    if (prog.cachedSegments > 0) {
      dom.cacheHitBadge.textContent = `缓存命中 ${prog.cachedSegments} 句`;
      dom.cacheHitBadge.classList.remove('hidden');
    } else {
      dom.cacheHitBadge.classList.add('hidden');
    }

    if (running && prog.currentSpeaker) {
      const host = isHostSpeaker(prog.currentSpeaker);
      dom.activeSpeakerChip.textContent = `当前合成：${displaySpeakerName(prog.currentSpeaker)}`;
      dom.activeSpeakerChip.className = `meta-pill ${host ? 'is-host' : 'is-guest'}`;
    } else {
      dom.activeSpeakerChip.classList.add('hidden');
    }
  }

  function updateTaskErrorBanner(task) {
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      dom.taskErrorBanner.classList.add('hidden');
      dom.taskErrorActions.textContent = '';
      return;
    }

    dom.taskErrorBanner.classList.remove('hidden');
    dom.taskErrorBanner.classList.toggle('is-cancelled', task.status === 'cancelled');

    if (task.status === 'cancelled') {
      dom.taskErrorText.textContent = '已取消当前生成。你可以随时从断点继续，或放弃并重新导入文稿。';
    } else {
      dom.taskErrorText.textContent = task.error?.message || '生成过程中遇到意外错误。';
    }

    if (task.hasScript) {
      dom.taskResumeHint.textContent = '剧本与已完成的单句音频已缓存，续跑将直接跳过模型生成阶段。';
      dom.taskResumeHint.classList.remove('hidden');
    } else {
      dom.taskResumeHint.classList.add('hidden');
    }

    dom.taskErrorActions.textContent = '';
    const isExtractFailure = task.status === 'failed' && task.error?.stage === 'extract';

    if (isExtractFailure) {
      const switchBtn = createActionBtn('切换到直接贴正文', 'btn btn-primary btn-sm', () => {
        setActiveTask(null);
        switchTab('text');
        dom.inputText.focus();
      });
      const retryBtn = createActionBtn('原链接重试', 'btn btn-subtle btn-sm', () => handleResumeTask(task.id));
      const discardBtn = createActionBtn('放弃', 'btn btn-ghost btn-sm', () => setActiveTask(null));
      dom.taskErrorActions.append(switchBtn, retryBtn, discardBtn);
    } else if (task.status === 'failed' && task.error?.stage === 'tts') {
      const resumeBtn = createActionBtn('从断点继续生成', 'btn btn-primary btn-sm', () => handleResumeTask(task.id));
      const switchTtsBtn = createActionBtn('切换语音服务商', 'btn btn-subtle btn-sm', () => openSettingsModal('tts'));
      const discardBtn = createActionBtn('放弃', 'btn btn-ghost btn-sm', () => setActiveTask(null));
      dom.taskErrorActions.append(resumeBtn, switchTtsBtn, discardBtn);
    } else {
      const resumeBtn = createActionBtn('从断点继续生成', 'btn btn-primary btn-sm', () => handleResumeTask(task.id));
      const discardBtn = createActionBtn('放弃', 'btn btn-ghost btn-sm', () => setActiveTask(null));
      dom.taskErrorActions.append(resumeBtn, discardBtn);
    }
  }

  function createActionBtn(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async function handleCancelTask() {
    if (!state.activeTask?.id) return;
    dom.btnCancelTask.disabled = true;
    try {
      const task = await apiJson(`/api/tasks/${encodeURIComponent(state.activeTask.id)}/cancel`, {
        method: 'POST',
      });
      setActiveTask(task);
      stopPolling();
      stopElapsedTimer();
      showToast('已取消当前生成任务');
    } catch (err) {
      dom.btnCancelTask.disabled = false;
      showToast(err.message || '取消任务失败');
    }
  }

  async function handleResumeTask(taskId) {
    try {
      const task = await apiJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...buildCredsPayload(),
          tts: buildTtsPayload(),
        }),
      });
      setActiveTask(task);
      startPolling();
      showToast('已从断点恢复生成');
    } catch (err) {
      handleCredentialOrTaskError(err);
    }
  }

  async function loadHistoryList() {
    try {
      const data = await apiJson('/api/podcasts');
      state.historyItems = Array.isArray(data?.items) ? data.items : [];
      renderHistoryList();
    } catch {
      dom.historyList.textContent = '';
      const p = document.createElement('p');
      p.className = 'history-empty';
      p.textContent = '未能获取本地历史列表，请稍后刷新重试。';
      dom.historyList.appendChild(p);
    }
  }

  function renderHistoryList() {
    const items = state.historyItems;
    dom.historyCount.textContent = `${items.length} 集`;
    dom.historyList.textContent = '';

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '还没有已完成的本地播客，导入第一篇文章试试看。';
      dom.historyList.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item';
      const isCurrent = state.currentPodcast?.id === item.id;
      if (isCurrent) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-current', 'true');
      }

      const title = document.createElement('span');
      title.className = 'history-item-title';
      title.textContent = item.podcastTitle || '未命名播客';

      const meta = document.createElement('span');
      meta.className = 'history-item-meta';
      const parts = [
        `${item.sentenceCount || 0} 句`,
        formatTime(item.totalDuration || 0),
        formatDateLabel(item.createAt),
      ].filter(Boolean);
      meta.textContent = parts.join(' · ');

      btn.append(title, meta);
      btn.addEventListener('click', () => handleSelectHistory(item.id));
      dom.historyList.appendChild(btn);
    });
  }

  async function handleSelectHistory(podcastId) {
    try {
      const podcast = await apiJson(`/api/podcasts/${encodeURIComponent(podcastId)}`);
      loadPodcast(podcast, { autoplay: false });
    } catch (err) {
      showToast(err.message || '读取播客详情失败');
    }
  }

  function updateBgmButton(mode = state.audioEngine?.getBgmMode?.() || 'warm') {
    if (!dom.btnBgmMode) return;
    dom.btnBgmMode.dataset.bgmMode = mode;
    if (dom.bgmModeLabel) {
      dom.bgmModeLabel.textContent = state.audioEngine?.getBgmLabel?.(mode) || '暖调配乐';
    }
  }

  function handleAudioPhaseChange({ phase, isActive, bgmMode }) {
    const playingNow = isActive || !dom.mainAudio.paused;
    setDeckPlaying(playingNow);
    updateBgmButton(bgmMode);
    if (!dom.currentPodcastMeta) return;
    if (phase === 'intro') {
      dom.currentPodcastMeta.textContent = `${state.currentMetaBaseText} · 片头纯音乐…`;
    } else if (phase === 'outro') {
      dom.currentPodcastMeta.textContent = `${state.currentMetaBaseText} · 片尾淡出…`;
    } else {
      dom.currentPodcastMeta.textContent = state.currentMetaBaseText;
    }
  }

  function loadPodcast(podcast, { autoplay = false } = {}) {
    state.currentPodcast = podcast;
    window.InputSource.resetPlaybackHighlight(state.input);

    const sentences = Array.isArray(podcast.sentences) ? podcast.sentences : [];
    dom.currentPodcastTitle.textContent = podcast.podcastTitle || 'AI 妙听双人播客';
    state.currentMetaBaseText = `共 ${sentences.length} 句对话 · 全长 ${formatTime(podcast.totalDuration || 0)}`;
    dom.currentPodcastMeta.textContent = state.currentMetaBaseText;

    if (podcast.summary) {
      dom.currentPodcastSummary.textContent = podcast.summary;
      dom.currentPodcastSummary.classList.remove('hidden');
    } else {
      dom.currentPodcastSummary.textContent = '';
      dom.currentPodcastSummary.classList.add('hidden');
    }

    dom.mainAudio.src = podcast.fullAudioUrl;
    dom.mainAudio.playbackRate = state.playbackRate;
    dom.mainAudio.load();

    dom.currentTime.textContent = '00:00';
    dom.totalDuration.textContent = formatTime(podcast.totalDuration || 0);
    setSeekProgress(0);

    dom.seekSlider.disabled = false;
    dom.btnPlayPause.disabled = false;
    dom.btnRewind10.disabled = false;
    dom.btnForward10.disabled = false;
    if (dom.btnBgmMode) dom.btnBgmMode.disabled = false;
    dom.btnSpeed.disabled = false;
    dom.btnCopyMarkdown.disabled = sentences.length === 0;

    dom.btnDownloadAudio.href = podcast.fullAudioUrl;
    dom.btnDownloadAudio.download = `${podcast.podcastTitle || 'ai-podcast'}.mp3`;
    dom.btnDownloadAudio.classList.remove('is-disabled');
    dom.btnDownloadAudio.removeAttribute('aria-disabled');

    setDeckPlaying(false);
    dom.playerDeck.dataset.speaker = 'none';
    dom.miniTitle.textContent = podcast.podcastTitle || 'AI 妙听双人播客';
    dom.miniTime.textContent = `00:00 / ${formatTime(podcast.totalDuration || 0)}`;
    if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = 'none';

    state.audioEngine?.loadPodcast(podcast);
    updateBgmButton();

    renderSubtitles(sentences);
    renderHistoryList();
    updateMobileMiniVisibility();

    if (autoplay) {
      if (state.audioEngine) {
        state.audioEngine.requestPlay().catch(() => {});
      } else {
        dom.mainAudio.play().catch(() => {});
      }
    }
  }

  function renderSubtitles(sentences) {
    dom.subtitlesList.textContent = '';
    state.subtitleElements = [];

    if (!sentences.length) {
      const empty = document.createElement('div');
      empty.className = 'subtitles-empty';
      const p = document.createElement('p');
      p.textContent = '该集暂无可展示的字幕时间轴。';
      empty.appendChild(p);
      dom.subtitlesList.appendChild(empty);
      return;
    }

    sentences.forEach((s, idx) => {
      const isHost = isHostSpeaker(s.speaker);
      const row = document.createElement('div');
      row.className = `subtitle-item ${isHost ? 'is-host' : 'is-guest'}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `${displaySpeakerName(s.speaker)} ${formatTime(s.startTime)}：${s.text}`);

      const meta = document.createElement('div');
      meta.className = 'subtitle-meta';

      const speaker = document.createElement('span');
      speaker.className = 'subtitle-speaker';
      speaker.textContent = displaySpeakerName(s.speaker);
      meta.appendChild(speaker);

      if (s.emotion) {
        const emotion = document.createElement('span');
        emotion.className = 'subtitle-emotion';
        emotion.textContent = `· ${s.emotion}`;
        meta.appendChild(emotion);
      }

      const time = document.createElement('span');
      time.className = 'subtitle-time';
      time.textContent = formatTime(s.startTime);
      meta.appendChild(time);

      const text = document.createElement('p');
      text.className = 'subtitle-text';
      text.textContent = s.text;

      row.append(meta, text);

      const jumpAndPlay = () => {
        if (!dom.mainAudio.src) return;
        const target = Math.max(0, Number(s.startTime) || 0);
        syncHighlightToTime(target);
        if (state.audioEngine) {
          state.audioEngine.seekAndPlay(target).catch(() => {});
        } else {
          dom.mainAudio.currentTime = target;
          if (dom.mainAudio.paused) {
            dom.mainAudio.play().catch(() => {});
          }
        }
      };

      row.addEventListener('click', jumpAndPlay);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          jumpAndPlay();
        }
      });

      dom.subtitlesList.appendChild(row);
      state.subtitleElements.push(row);
    });
  }

  /** 兼容 0.36s 句间静音间隙：落入间隔时保持上一句高亮不闪烁 */
  function findActiveSentenceIndex(sentences, currentTime) {
    if (!sentences.length) return -1;
    let candidate = -1;
    for (let i = 0; i < sentences.length; i += 1) {
      const s = sentences[i];
      if (currentTime >= s.startTime && currentTime < s.endTime) {
        return i;
      }
      if (currentTime >= s.startTime) {
        candidate = i;
      } else {
        break;
      }
    }
    return candidate;
  }

  function syncHighlightToTime(curTime) {
    const sentences = state.currentPodcast?.sentences;
    if (!sentences?.length) return;
    const idx = findActiveSentenceIndex(sentences, curTime);
    if (idx === -1) return;

    const activeSentence = sentences[idx];
    const speakerRole = isHostSpeaker(activeSentence.speaker) ? 'host' : 'guest';
    dom.playerDeck.dataset.speaker = speakerRole;
    if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = speakerRole;

    if (idx !== state.input.activeSentenceIndex) {
      const prevIdx = state.input.activeSentenceIndex;
      if (prevIdx >= 0 && state.subtitleElements[prevIdx]) {
        state.subtitleElements[prevIdx].classList.remove('is-active');
      }
      state.input.activeSentenceIndex = idx;
      const activeEl = state.subtitleElements[idx];
      if (activeEl) {
        activeEl.classList.add('is-active');
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  function setSeekProgress(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    dom.seekSlider.value = String(clamped);
    dom.seekSlider.style.setProperty('--seek-pct', `${clamped}%`);
    if (dom.miniProgressFill) dom.miniProgressFill.style.width = `${clamped}%`;
  }

  function setDeckPlaying(playing) {
    dom.playerDeck.dataset.playing = playing ? 'true' : 'false';
    if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.playing = playing ? 'true' : 'false';
  }

  function togglePlayPause() {
    if (!dom.mainAudio.src) return;
    triggerPlayRipple();
    if (state.audioEngine) {
      const phase = state.audioEngine.getPhase();
      const activeNow = phase === 'intro' || phase === 'playing' || phase === 'outro' || !dom.mainAudio.paused;
      if (activeNow) {
        state.audioEngine.requestPause();
      } else {
        state.audioEngine.requestPlay().catch((err) => {
          showToast('未能播放音频：' + (err.message || '请检查音频文件'));
        });
      }
      return;
    }
    if (dom.mainAudio.paused) {
      dom.mainAudio.play().catch((err) => {
        showToast('未能播放音频：' + (err.message || '请检查音频文件'));
      });
    } else {
      dom.mainAudio.pause();
    }
  }

  function triggerPlayRipple() {
    dom.playRipple.classList.remove('is-burst');
    void dom.playRipple.offsetWidth;
    dom.playRipple.classList.add('is-burst');
  }

  function seekRelative(delta) {
    if (!dom.mainAudio.src) return;
    const duration = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
    const target = Math.max(0, Math.min(duration, dom.mainAudio.currentTime + delta));
    syncHighlightToTime(target);
    if (state.audioEngine?.getPhase?.() === 'intro') {
      state.audioEngine.seekAndPlay(target).catch(() => {});
      return;
    }
    dom.mainAudio.currentTime = target;
    state.audioEngine?.syncTime(target);
  }

  function cyclePlaybackSpeed() {
    const currentIdx = SPEEDS.indexOf(state.playbackRate);
    const nextIdx = (currentIdx + 1) % SPEEDS.length;
    state.playbackRate = SPEEDS[nextIdx];
    dom.mainAudio.playbackRate = state.playbackRate;
    const label = `${state.playbackRate}x`;
    dom.btnSpeed.textContent = label;
    if (dom.btnMiniSpeed) dom.btnMiniSpeed.textContent = label;
    dom.btnSpeed.classList.remove('is-pop');
    void dom.btnSpeed.offsetWidth;
    dom.btnSpeed.classList.add('is-pop');
  }

  function updateMobileMiniVisibility() {
    if (!dom.mobileMiniPlayer) return;
    if (window.innerWidth > 900 || !state.currentPodcast) {
      dom.mobileMiniPlayer.classList.add('hidden');
      return;
    }
    const deckRect = dom.playerDeck.getBoundingClientRect();
    const shouldShow = deckRect.bottom < 72;
    dom.mobileMiniPlayer.classList.toggle('hidden', !shouldShow);
  }

  async function handleCopyMarkdown() {
    const podcast = state.currentPodcast;
    if (!podcast || !Array.isArray(podcast.sentences) || !podcast.sentences.length) return;

    const lines = [];
    lines.push(`# ${podcast.podcastTitle || 'AI 妙听双人播客'}`);
    if (podcast.summary) {
      lines.push('', `> ${podcast.summary}`);
    }
    lines.push('');
    podcast.sentences.forEach((s) => {
      lines.push(`**${displaySpeakerName(s.speaker)}**（${formatTime(s.startTime)}）：${s.text}`);
    });
    const markdown = lines.join('\n');

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const helper = document.createElement('textarea');
        helper.value = markdown;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      showToast(`已复制 ${podcast.sentences.length} 句 Markdown 剧本`);
    } catch {
      showToast('浏览器未授予剪贴板权限，请手动选择字幕复制');
    }
  }

  function isVolcVoiceCompatible(resourceId, voiceId) {
    if (!voiceId) return true;
    if (/^seed-tts-1\.0/i.test(resourceId || '')) {
      return !voiceId.endsWith('_uranus_bigtts');
    }
    return !/_(?:moon|mars|wvae)_bigtts$/i.test(voiceId);
  }

  function getVolcDefaultVoices(resourceId) {
    if (/^seed-tts-1\.0/i.test(resourceId || '')) {
      return {
        阿泽: 'zh_male_yangguangqingnian_moon_bigtts',
        小晓: 'zh_female_cancan_mars_bigtts',
      };
    }
    return {
      阿泽: 'zh_male_taocheng_uranus_bigtts',
      小晓: 'zh_female_vv_uranus_bigtts',
    };
  }

  function normalizeBaseUrlForMatch(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  function normalizeEndpointForBinding(url) {
    return normalizeBaseUrlForMatch(url).replace(/\/v1$/i, '');
  }

  function detectLlmPresetId(baseURL) {
    const normalized = normalizeBaseUrlForMatch(baseURL);
    if (!normalized) return 'custom';
    for (const preset of LLM_PRESETS) {
      if (!preset.baseURL) continue;
      const target = normalizeBaseUrlForMatch(preset.baseURL);
      if (normalized === target || (preset.id === 'deepseek' && normalized === `${target}/v1`)) {
        return preset.id;
      }
    }
    return 'custom';
  }

  function updateLlmPresetSelection(presetId) {
    const preset = LLM_PRESETS.find((item) => item.id === presetId) || LLM_PRESETS[LLM_PRESETS.length - 1];
    dom.llmPresetPills.forEach((pill) => {
      pill.classList.toggle('is-active', pill.dataset.llmPreset === preset.id);
    });
    if (dom.llmPresetHint) {
      dom.llmPresetHint.textContent = preset.hint;
    }
  }

  function applyLlmPreset(presetId) {
    const preset = LLM_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const prevBase = normalizeEndpointForBinding(dom.settingBaseUrl.value);
    const nextBase = preset.id === 'custom' ? '' : normalizeEndpointForBinding(preset.baseURL);
    const hadKey = Boolean(dom.settingApiKey.value.trim());
    const endpointChanged = Boolean(
      (prevBase && prevBase !== nextBase) ||
      (state.modalLlmKeyEndpoint && state.modalLlmKeyEndpoint !== nextBase)
    );
    if (preset.id !== 'custom') {
      dom.settingBaseUrl.value = preset.baseURL;
    } else if (endpointChanged) {
      dom.settingBaseUrl.value = '';
    }
    if (hadKey && endpointChanged) {
      dom.settingApiKey.value = '';
      dom.settingModel.value = '';
      state.modalLlmKeyEndpoint = '';
    } else if (hadKey && !state.modalLlmKeyEndpoint && nextBase) {
      state.modalLlmKeyEndpoint = nextBase;
    }
    updateLlmPresetSelection(preset.id);
    setTestStatus(dom.llmTestStatus, '', '');
    syncModelPickerForBase('llm');
    if (hadKey && endpointChanged) {
      setTestStatus(dom.llmModelsStatus, '', `已切换为「${preset.label}」，为防密钥串发已清空旧 Key，请填写对应 API Key`);
      (preset.id === 'custom' ? dom.settingBaseUrl : dom.settingApiKey).focus();
    } else if (preset.id === 'custom') {
      dom.settingBaseUrl.focus();
    }
  }

  function modelCacheKey(scope, baseURL) {
    return `${scope}:${normalizeBaseUrlForMatch(baseURL)}`;
  }

  function renderLlmModelOptions() {
    const cacheKey = modelCacheKey('llm', dom.settingBaseUrl.value.trim());
    const models = state.llmModelsCache.get(cacheKey);
    if (!Array.isArray(models) || !models.length) {
      dom.llmModelPickerWrap?.classList.add('hidden');
      return;
    }

    dom.llmModelPickerWrap?.classList.remove('hidden');
    if (dom.settingModelFilter) {
      dom.settingModelFilter.classList.toggle('hidden', models.length <= 8);
    }

    const query = (dom.settingModelFilter?.value || '').trim().toLowerCase();
    const filtered = query ? models.filter((m) => m.id.toLowerCase().includes(query)) : models;
    const currentVal = dom.settingModel.value.trim();

    dom.settingModelSelect.textContent = '';
    if (!filtered.length) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '未匹配到模型，请清空搜索词或下方手填';
      dom.settingModelSelect.appendChild(emptyOpt);
      return;
    }

    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = `请选择模型（共 ${filtered.length} 个可用）`;
    dom.settingModelSelect.appendChild(placeholderOpt);

    filtered.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.ownedBy ? `${m.id}（${m.ownedBy}）` : m.id;
      dom.settingModelSelect.appendChild(opt);
    });

    if (filtered.some((m) => m.id === currentVal)) {
      dom.settingModelSelect.value = currentVal;
    } else {
      dom.settingModelSelect.value = '';
    }
  }

  function renderVisionModelOptions() {
    const base = dom.settingVisionBaseUrl?.value.trim() || dom.settingBaseUrl.value.trim();
    const models = state.llmModelsCache.get(modelCacheKey('vision', base)) || state.llmModelsCache.get(modelCacheKey('llm', base));
    if (!dom.settingVisionModelSelect) return;
    if (!Array.isArray(models) || !models.length) {
      dom.settingVisionModelSelect.classList.add('hidden');
      return;
    }
    dom.settingVisionModelSelect.classList.remove('hidden');
    dom.settingVisionModelSelect.textContent = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = `请选择识图模型（共 ${models.length} 个）`;
    dom.settingVisionModelSelect.appendChild(head);
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      dom.settingVisionModelSelect.appendChild(opt);
    });
    const cur = dom.settingVisionModel?.value.trim() || '';
    dom.settingVisionModelSelect.value = models.some((m) => m.id === cur) ? cur : '';
  }

  function syncModelPickerForBase(scope) {
    if (scope === 'vision') {
      setTestStatus(dom.visionModelsStatus, '', '');
      renderVisionModelOptions();
      return;
    }
    setTestStatus(dom.llmModelsStatus, '', '');
    if (dom.settingModelFilter) dom.settingModelFilter.value = '';
    renderLlmModelOptions();
  }

  function hasUnreboundKey(apiKey, baseURL, boundEndpoint) {
    return Boolean(apiKey && boundEndpoint && normalizeEndpointForBinding(baseURL) !== boundEndpoint);
  }

  async function handleFetchModels(scope = 'llm') {
    const isVision = scope === 'vision';
    const btn = isVision ? dom.btnFetchVisionModels : dom.btnFetchLlmModels;
    const statusEl = isVision ? dom.visionModelsStatus : dom.llmModelsStatus;
    if (!btn) return;

    const llmSnap = readLlmFormSnapshot();
    const visionSnap = {
      apiKey: dom.settingVisionApiKey?.value.trim() || '',
      baseURL: dom.settingVisionBaseUrl?.value.trim() || '',
      model: dom.settingVisionModel?.value.trim() || '',
    };
    if (!isVision && llmSnap.apiKey && !llmSnap.baseURL) {
      setTestStatus(statusEl, 'error', '填写 API Key 时，请先选择上方厂商预设或填写对应的 Base URL');
      dom.settingBaseUrl.focus();
      return;
    }
    if (!isVision && hasUnreboundKey(llmSnap.apiKey, llmSnap.baseURL, state.modalLlmKeyEndpoint)) {
      setTestStatus(statusEl, 'error', '接口地址已变更，请重新填写该地址对应的 API Key（或先清空旧 Key）');
      dom.settingApiKey.focus();
      return;
    }
    if (isVision && visionSnap.apiKey && !visionSnap.baseURL) {
      setTestStatus(statusEl, 'error', '填写独立识图 API Key 时，请先选择上方识图厂商预设或填写对应的识图 Base URL');
      dom.settingVisionBaseUrl?.focus();
      return;
    }
    if (isVision && hasUnreboundKey(visionSnap.apiKey, visionSnap.baseURL, state.modalVisionKeyEndpoint)) {
      setTestStatus(statusEl, 'error', '识图接口地址已变更，请重新填写该地址对应的识图 API Key（或先清空旧 Key）');
      dom.settingVisionApiKey?.focus();
      return;
    }
    if (isVision && !visionSnap.apiKey && !visionSnap.baseURL && llmSnap.apiKey && !llmSnap.baseURL) {
      setTestStatus(statusEl, 'error', '主模型填写了 API Key 但未填写 Base URL，请先在上方补全接口地址');
      dom.settingBaseUrl.focus();
      return;
    }
    if (isVision && !visionSnap.apiKey && !visionSnap.baseURL && hasUnreboundKey(llmSnap.apiKey, llmSnap.baseURL, state.modalLlmKeyEndpoint)) {
      setTestStatus(statusEl, 'error', '主模型接口地址已变更，请先在上方重新确认对应的 API Key');
      dom.settingApiKey.focus();
      return;
    }

    btn.disabled = true;
    setTestStatus(statusEl, 'loading', '正在连接接口并拉取最新模型列表…');

    try {
      const body = isVision
        ? {
            scope: 'vision',
            ...buildCredsPayload(llmSnap),
            ...buildVisionPayload(visionSnap),
          }
        : { scope: 'llm', ...buildCredsPayload(llmSnap) };

      const data = await apiJson('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!data.supported) {
        setTestStatus(statusEl, 'error', data.message || '该接口未开放模型列表，请手动输入模型名称');
        return;
      }

      const targetBase = isVision
        ? (dom.settingVisionBaseUrl?.value.trim() || llmSnap.baseURL)
        : llmSnap.baseURL;
      state.llmModelsCache.set(modelCacheKey(scope, targetBase), data.models || []);

      if (isVision) {
        renderVisionModelOptions();
        if (!dom.settingVisionModel.value.trim() && data.models?.length === 1) {
          dom.settingVisionModel.value = data.models[0].id;
          dom.settingVisionModelSelect.value = data.models[0].id;
        }
        setTestStatus(statusEl, 'ok', `已拉取 ${data.count} 个模型（${data.latencyMs}ms），请从下拉列表选择`);
      } else {
        if (dom.settingModelFilter) dom.settingModelFilter.value = '';
        renderLlmModelOptions();
        if (data.models?.length && !data.models.some((m) => m.id === dom.settingModel.value.trim())) {
          if (data.models.length === 1) {
            dom.settingModel.value = data.models[0].id;
            dom.settingModelSelect.value = data.models[0].id;
          }
        }
        setTestStatus(statusEl, 'ok', `接口鉴权通过 · 已拉取 ${data.count} 个模型（${data.latencyMs}ms），请在下方勾选`);
      }
    } catch (err) {
      setTestStatus(statusEl, 'error', err.message || '获取模型列表失败');
    } finally {
      btn.disabled = false;
    }
  }

  function populateSelect(selectEl, options, selectedValue, fallbackValue) {
    if (!selectEl) return '';
    selectEl.textContent = '';
    options.forEach((opt) => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      selectEl.appendChild(el);
    });
    const values = options.map((opt) => opt.value);
    const chosen = values.includes(selectedValue)
      ? selectedValue
      : values.includes(fallbackValue)
        ? fallbackValue
        : values[0] || '';
    selectEl.value = chosen;
    return chosen;
  }

  function renderVoiceSelects(voices, hostSelect, guestSelect, selectedHost, selectedGuest, defaults) {
    const orderedForHost = [...voices].sort((a, b) => (a.gender === 'male' ? 0 : 1) - (b.gender === 'male' ? 0 : 1));
    const orderedForGuest = [...voices].sort((a, b) => (a.gender === 'female' ? 0 : 1) - (b.gender === 'female' ? 0 : 1));
    populateSelect(
      hostSelect,
      orderedForHost.map((v) => ({ value: v.id, label: v.name })),
      selectedHost,
      defaults?.阿泽 || ''
    );
    populateSelect(
      guestSelect,
      orderedForGuest.map((v) => ({ value: v.id, label: v.name })),
      selectedGuest,
      defaults?.小晓 || ''
    );
  }

  function renderVolcVoicesForResource(resourceId, preferredHost, preferredGuest) {
    const provider = getCatalogProvider('volcengine');
    const allVoices = provider?.availableVoices || [];
    const compatible = allVoices.filter((v) => isVolcVoiceCompatible(resourceId, v.id));
    const defaults = getVolcDefaultVoices(resourceId);
    renderVoiceSelects(
      compatible,
      dom.settingVolcVoiceHost,
      dom.settingVolcVoiceGuest,
      preferredHost,
      preferredGuest,
      defaults
    );
  }

  function hydrateTtsControlsFromCatalog() {
    const minimax = getCatalogProvider('minimax');
    const volc = getCatalogProvider('volcengine');
    const edge = getCatalogProvider('edge');

    if (minimax) {
      populateSelect(
        dom.settingMinimaxModel,
        (minimax.availableModels || []).map((id) => ({ value: id, label: TTS_MODEL_LABELS[id] || id })),
        state.ttsConfig.minimax.model,
        minimax.defaultModel
      );
      renderVoiceSelects(
        minimax.availableVoices || [],
        dom.settingMinimaxVoiceHost,
        dom.settingMinimaxVoiceGuest,
        state.ttsConfig.minimax.voiceHost,
        state.ttsConfig.minimax.voiceGuest,
        minimax.defaultVoices
      );
      if (dom.minimaxServerHint) {
        dom.minimaxServerHint.classList.toggle('hidden', !minimax.serverConfigured);
      }
    }

    if (volc) {
      const selectedResource = populateSelect(
        dom.settingVolcResource,
        (volc.availableModels || []).map((id) => ({ value: id, label: TTS_MODEL_LABELS[id] || id })),
        state.ttsConfig.volcengine.resourceId,
        volc.defaultModel
      );
      renderVolcVoicesForResource(
        selectedResource,
        state.ttsConfig.volcengine.voiceHost,
        state.ttsConfig.volcengine.voiceGuest
      );
      if (dom.volcServerHint) {
        dom.volcServerHint.classList.toggle('hidden', !volc.serverConfigured);
      }
    }

    if (edge) {
      renderVoiceSelects(
        edge.availableVoices || [],
        dom.settingEdgeVoiceHost,
        dom.settingEdgeVoiceGuest,
        state.ttsConfig.edge.voiceHost,
        state.ttsConfig.edge.voiceGuest,
        edge.defaultVoices
      );
    }
  }

  function selectTtsProviderInModal(providerId) {
    state.modalTtsProvider = ['minimax', 'volcengine', 'edge'].includes(providerId) ? providerId : 'edge';
    dom.ttsProviderButtons.forEach((btn) => {
      const active = btn.dataset.ttsProvider === state.modalTtsProvider;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
    if (dom.ttsFieldsMinimax) dom.ttsFieldsMinimax.classList.toggle('hidden', state.modalTtsProvider !== 'minimax');
    if (dom.ttsFieldsVolcengine) dom.ttsFieldsVolcengine.classList.toggle('hidden', state.modalTtsProvider !== 'volcengine');
    if (dom.ttsFieldsEdge) dom.ttsFieldsEdge.classList.toggle('hidden', state.modalTtsProvider !== 'edge');
    if (dom.ttsProviderGuide) {
      dom.ttsProviderGuide.textContent = TTS_GUIDES[state.modalTtsProvider] || '';
    }
    setTestStatus(dom.ttsTestStatus, '', '');
  }

  function selectVolcAuthModeInModal(mode) {
    state.modalVolcAuthMode = mode === 'appIdAccessKey' ? 'appIdAccessKey' : 'apiKey';
    dom.volcAuthButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.volcAuth === state.modalVolcAuthMode);
    });
    if (dom.volcAuthApiKeyGroup) {
      dom.volcAuthApiKeyGroup.classList.toggle('hidden', state.modalVolcAuthMode !== 'apiKey');
    }
    if (dom.volcAuthAppGroup) {
      dom.volcAuthAppGroup.classList.toggle('hidden', state.modalVolcAuthMode !== 'appIdAccessKey');
    }
  }

  function positionSettingsTabIndicator(immediate) {
    const activeBtn = state.settingsTab === 'tts' ? dom.settingsTabTts : dom.settingsTabLlm;
    if (!activeBtn || !dom.settingsTabIndicator || activeBtn.offsetWidth === 0) return;
    if (immediate) {
      dom.settingsTabIndicator.style.transition = 'none';
    }
    dom.settingsTabIndicator.style.width = `${activeBtn.offsetWidth}px`;
    dom.settingsTabIndicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    if (immediate) {
      void dom.settingsTabIndicator.offsetWidth;
      dom.settingsTabIndicator.style.transition = '';
    }
  }

  function switchSettingsTab(tab, { immediateIndicator = false } = {}) {
    state.settingsTab = tab === 'tts' ? 'tts' : 'llm';
    const isTts = state.settingsTab === 'tts';

    dom.settingsTabLlm.classList.toggle('is-active', !isTts);
    dom.settingsTabLlm.setAttribute('aria-selected', String(!isTts));
    dom.settingsTabTts.classList.toggle('is-active', isTts);
    dom.settingsTabTts.setAttribute('aria-selected', String(isTts));

    dom.settingsPanelLlm.classList.toggle('hidden', isTts);
    dom.settingsPanelLlm.classList.toggle('is-active', !isTts);
    dom.settingsPanelTts.classList.toggle('hidden', !isTts);
    dom.settingsPanelTts.classList.toggle('is-active', isTts);

    positionSettingsTabIndicator(immediateIndicator);
  }

  function setTestStatus(el, kind, text) {
    if (!el) return;
    el.className = 'test-status';
    if (kind === 'ok') el.classList.add('is-ok');
    else if (kind === 'error') el.classList.add('is-error');
    else if (kind === 'loading') el.classList.add('is-loading');
    el.textContent = text || '';
  }

  function readLlmFormSnapshot() {
    return {
      apiKey: dom.settingApiKey.value.trim(),
      baseURL: dom.settingBaseUrl.value.trim(),
      model: dom.settingModel.value.trim(),
    };
  }

  function readTtsFormSnapshot() {
    const defaultsMinimax = DEFAULT_TTS_CONFIG.minimax;
    const defaultsEdge = DEFAULT_TTS_CONFIG.edge;
    const resourceId = dom.settingVolcResource.value || DEFAULT_TTS_CONFIG.volcengine.resourceId;
    const defaultsVolc = getVolcDefaultVoices(resourceId);
    return {
      provider: state.modalTtsProvider,
      minimax: {
        apiKey: dom.settingMinimaxKey.value.trim(),
        model: dom.settingMinimaxModel.value || defaultsMinimax.model,
        endpoint: dom.settingMinimaxEndpoint.value.trim(),
        voiceHost: dom.settingMinimaxVoiceHost.value || defaultsMinimax.voiceHost,
        voiceGuest: dom.settingMinimaxVoiceGuest.value || defaultsMinimax.voiceGuest,
      },
      volcengine: {
        authMode: state.modalVolcAuthMode,
        apiKey: dom.settingVolcApiKey.value.trim(),
        appId: dom.settingVolcAppId.value.trim(),
        accessKey: dom.settingVolcAccessKey.value.trim(),
        resourceId,
        endpoint: dom.settingVolcEndpoint.value.trim(),
        voiceHost: dom.settingVolcVoiceHost.value || defaultsVolc.阿泽,
        voiceGuest: dom.settingVolcVoiceGuest.value || defaultsVolc.小晓,
      },
      edge: {
        voiceHost: dom.settingEdgeVoiceHost.value || defaultsEdge.voiceHost,
        voiceGuest: dom.settingEdgeVoiceGuest.value || defaultsEdge.voiceGuest,
      },
    };
  }

  async function handleTestLlmConnection() {
    const snapshot = readLlmFormSnapshot();
    if (snapshot.apiKey && !snapshot.baseURL) {
      setTestStatus(dom.llmTestStatus, 'error', '填写 API Key 时，请先选择上方厂商预设或填写对应的 Base URL');
      dom.settingBaseUrl.focus();
      return;
    }
    if (hasUnreboundKey(snapshot.apiKey, snapshot.baseURL, state.modalLlmKeyEndpoint)) {
      setTestStatus(dom.llmTestStatus, 'error', '接口地址已变更，请重新填写该地址对应的 API Key（或先清空旧 Key）');
      dom.settingApiKey.focus();
      return;
    }
    dom.btnTestLlm.disabled = true;
    setTestStatus(dom.llmTestStatus, 'loading', '正在向所选模型发起对话测试…');
    try {
      const data = await apiJson('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildCredsPayload(snapshot), verifyChat: true }),
      });
      setTestStatus(dom.llmTestStatus, 'ok', `所选模型可用 · ${data.model} · ${data.latencyMs}ms`);
    } catch (err) {
      setTestStatus(dom.llmTestStatus, 'error', err.message || '模型连接测试失败');
    } finally {
      dom.btnTestLlm.disabled = false;
    }
  }

  async function handleTestTtsConnection() {
    dom.btnTestTts.disabled = true;
    setTestStatus(dom.ttsTestStatus, 'loading', '正在测试语音合成…');
    try {
      const snapshot = readTtsFormSnapshot();
      const data = await apiJson('/api/tts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: buildTtsPayload(snapshot, snapshot.provider) }),
      });
      if (data.provider === 'edge') {
        setTestStatus(dom.ttsTestStatus, 'ok', data.message || 'Edge 免密钥已就绪');
      } else {
        const dur = Number.isFinite(data.duration) ? `${data.duration.toFixed(1)}s 音频 · ` : '';
        setTestStatus(dom.ttsTestStatus, 'ok', `合成可用 · ${dur}${data.latencyMs}ms`);
      }
    } catch (err) {
      setTestStatus(dom.ttsTestStatus, 'error', err.message || '语音连接测试失败');
    } finally {
      dom.btnTestTts.disabled = false;
    }
  }

  function updateConfirmTtsBadge() {
    if (!dom.confirmTtsBadge) return;
    const providerId = resolveEffectiveTtsProviderId();
    dom.confirmTtsBadge.textContent = `语音：${TTS_SHORT_LABELS[providerId] || providerId}`;
  }

  function updateApiKeyStatus() {
    const configured = Boolean(state.apiKey && state.apiKey.trim());
    const ttsId = resolveEffectiveTtsProviderId();
    dom.apiKeyStatusDot.classList.toggle('is-configured', configured);
    dom.btnSettings.title = `模型：${state.model || '服务端默认'}（${configured ? '本地 Key 已配置' : '留空将尝试服务端 .env'}）｜ 语音：${TTS_SHORT_LABELS[ttsId] || ttsId}`;
    updateConfirmTtsBadge();
  }

  function resetSecretFieldVisibility(inputEl, btnEl) {
    if (!inputEl || !btnEl) return;
    inputEl.type = 'password';
    btnEl.textContent = '显示';
  }

  function detectVisionPresetId(baseURL, model) {
    const normalized = normalizeBaseUrlForMatch(baseURL);
    if (!normalized && !String(model || '').trim()) return 'reuse';
    for (const preset of VISION_PRESETS) {
      if (preset.id === 'reuse') continue;
      if (normalized === normalizeBaseUrlForMatch(preset.baseURL)) {
        return preset.id;
      }
    }
    return 'reuse';
  }

  function updateVisionPresetSelection(presetId) {
    dom.visionPresetPills.forEach((pill) => {
      pill.classList.toggle('is-active', pill.dataset.visionPreset === presetId);
    });
  }

  function applyVisionPreset(presetId) {
    const preset = VISION_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const prevBase = normalizeEndpointForBinding(dom.settingVisionBaseUrl?.value);
    const nextBase = preset.id === 'reuse' ? '' : normalizeEndpointForBinding(preset.baseURL);
    const hadKey = Boolean(dom.settingVisionApiKey?.value.trim());
    const endpointChanged = Boolean(
      (prevBase && prevBase !== nextBase) ||
      (state.modalVisionKeyEndpoint && state.modalVisionKeyEndpoint !== nextBase)
    );
    if (preset.id === 'reuse') {
      dom.settingVisionApiKey.value = '';
      dom.settingVisionBaseUrl.value = '';
      dom.settingVisionModel.value = '';
      state.modalVisionKeyEndpoint = '';
    } else {
      dom.settingVisionBaseUrl.value = preset.baseURL;
      if (hadKey && endpointChanged) {
        dom.settingVisionApiKey.value = '';
        dom.settingVisionModel.value = '';
        state.modalVisionKeyEndpoint = '';
      } else if (hadKey && !state.modalVisionKeyEndpoint && nextBase) {
        state.modalVisionKeyEndpoint = nextBase;
      }
    }
    updateVisionPresetSelection(preset.id);
    syncModelPickerForBase('vision');
    if (preset.id !== 'reuse' && hadKey && endpointChanged) {
      setTestStatus(dom.visionModelsStatus, '', '已切换识图厂商，为防密钥串发已清空旧识图 Key，请重新填写');
      dom.settingVisionApiKey?.focus();
    }
  }

  function openSettingsModal(initialTab = 'llm', { expandVision = false } = {}) {
    dom.settingApiKey.value = state.apiKey;
    dom.settingBaseUrl.value = state.baseURL || '';
    dom.settingModel.value = state.model || '';
    state.modalLlmKeyEndpoint = dom.settingApiKey.value.trim()
      ? normalizeEndpointForBinding(dom.settingBaseUrl.value)
      : '';
    updateLlmPresetSelection(detectLlmPresetId(dom.settingBaseUrl.value));
    resetSecretFieldVisibility(dom.settingApiKey, dom.btnToggleKeyVisible);
    setTestStatus(dom.llmTestStatus, '', '');
    syncModelPickerForBase('llm');

    if (dom.settingVisionApiKey) {
      dom.settingVisionApiKey.value = state.visionConfig.apiKey || '';
      dom.settingVisionBaseUrl.value = state.visionConfig.baseURL || '';
      dom.settingVisionModel.value = state.visionConfig.model || '';
      state.modalVisionKeyEndpoint = dom.settingVisionApiKey.value.trim()
        ? normalizeEndpointForBinding(dom.settingVisionBaseUrl.value)
        : '';
      resetSecretFieldVisibility(dom.settingVisionApiKey, dom.btnToggleVisionKey);
      const hasCustomVision = Boolean(state.visionConfig.apiKey || state.visionConfig.baseURL || state.visionConfig.model);
      updateVisionPresetSelection(detectVisionPresetId(dom.settingVisionBaseUrl.value, dom.settingVisionModel.value));
      syncModelPickerForBase('vision');
      if (dom.visionSettingsDisclosure) {
        dom.visionSettingsDisclosure.open = Boolean(expandVision || hasCustomVision);
      }
    }

    dom.settingMinimaxKey.value = state.ttsConfig.minimax.apiKey;
    dom.settingMinimaxEndpoint.value = state.ttsConfig.minimax.endpoint;
    resetSecretFieldVisibility(dom.settingMinimaxKey, dom.btnToggleMinimaxKey);

    dom.settingVolcApiKey.value = state.ttsConfig.volcengine.apiKey;
    dom.settingVolcAppId.value = state.ttsConfig.volcengine.appId;
    dom.settingVolcAccessKey.value = state.ttsConfig.volcengine.accessKey;
    dom.settingVolcEndpoint.value = state.ttsConfig.volcengine.endpoint;
    resetSecretFieldVisibility(dom.settingVolcApiKey, dom.btnToggleVolcApiKey);
    resetSecretFieldVisibility(dom.settingVolcAccessKey, dom.btnToggleVolcAccessKey);

    hydrateTtsControlsFromCatalog();
    selectVolcAuthModeInModal(state.ttsConfig.volcengine.authMode);
    selectTtsProviderInModal(resolveEffectiveTtsProviderId());

    dom.settingsModal.classList.remove('hidden');
    switchSettingsTab(initialTab === 'tts' ? 'tts' : 'llm', { immediateIndicator: true });
    window.requestAnimationFrame(() => positionSettingsTabIndicator(true));
    window.setTimeout(() => {
      if (state.settingsTab === 'tts') {
        if (state.modalTtsProvider === 'minimax') dom.settingMinimaxKey.focus();
        else if (state.modalTtsProvider === 'volcengine') {
          (state.modalVolcAuthMode === 'appIdAccessKey' ? dom.settingVolcAppId : dom.settingVolcApiKey).focus();
        }
      } else if (expandVision && dom.settingVisionApiKey) {
        dom.settingVisionApiKey.focus();
      } else {
        dom.settingApiKey.focus();
      }
    }, 40);
  }

  function closeSettingsModal() {
    dom.settingsModal.classList.add('hidden');
    dom.btnSettings.focus();
  }

  function saveSettings(e) {
    e.preventDefault();
    const llm = readLlmFormSnapshot();
    const visionApiKey = dom.settingVisionApiKey?.value.trim() || '';
    const visionBaseURL = dom.settingVisionBaseUrl?.value.trim() || '';
    const visionModel = dom.settingVisionModel?.value.trim() || '';
    if (llm.apiKey && !llm.baseURL) {
      switchSettingsTab('llm');
      setTestStatus(dom.llmTestStatus, 'error', '填写 API Key 时，请先选择上方厂商预设或填写对应的 Base URL');
      dom.settingBaseUrl.focus();
      return;
    }
    if (hasUnreboundKey(llm.apiKey, llm.baseURL, state.modalLlmKeyEndpoint)) {
      switchSettingsTab('llm');
      setTestStatus(dom.llmTestStatus, 'error', '接口地址已变更，请重新填写该地址对应的 API Key（或先清空旧 Key）');
      dom.settingApiKey.focus();
      return;
    }
    if (visionApiKey && !visionBaseURL) {
      switchSettingsTab('llm');
      if (dom.visionSettingsDisclosure) dom.visionSettingsDisclosure.open = true;
      setTestStatus(dom.visionModelsStatus, 'error', '填写独立识图 API Key 时，请同时填写对应的识图 Base URL');
      dom.settingVisionBaseUrl?.focus();
      return;
    }
    if (hasUnreboundKey(visionApiKey, visionBaseURL, state.modalVisionKeyEndpoint)) {
      switchSettingsTab('llm');
      if (dom.visionSettingsDisclosure) dom.visionSettingsDisclosure.open = true;
      setTestStatus(dom.visionModelsStatus, 'error', '识图接口地址已变更，请重新填写该地址对应的识图 API Key（或先清空旧 Key）');
      dom.settingVisionApiKey?.focus();
      return;
    }
    const tts = readTtsFormSnapshot();

    state.apiKey = llm.apiKey;
    state.baseURL = llm.baseURL;
    state.model = llm.model;
    state.modalLlmKeyEndpoint = llm.apiKey ? normalizeEndpointForBinding(llm.baseURL) : '';
    state.visionConfig = {
      apiKey: visionApiKey,
      baseURL: visionBaseURL,
      model: visionModel,
    };
    state.modalVisionKeyEndpoint = visionApiKey ? normalizeEndpointForBinding(visionBaseURL) : '';
    state.ttsConfig = tts;

    writeStorage(STORAGE_KEYS.apiKey, state.apiKey);
    writeStorage(STORAGE_KEYS.baseURL, state.baseURL);
    writeStorage(STORAGE_KEYS.model, state.model);
    saveVisionConfigToStorage();
    saveTtsConfigToStorage();

    updateApiKeyStatus();
    dom.settingsModal.classList.add('hidden');
    showToast(`配置已保存 · 语音：${TTS_SHORT_LABELS[tts.provider] || tts.provider}`);
  }

  function bindPasswordToggle(inputEl, btnEl) {
    if (!inputEl || !btnEl) return;
    btnEl.addEventListener('click', () => {
      const hidden = inputEl.type === 'password';
      inputEl.type = hidden ? 'text' : 'password';
      btnEl.textContent = hidden ? '隐藏' : '显示';
    });
  }

  function bindEvents() {
    dom.tabBtnUrl.addEventListener('click', () => switchTab('url'));
    dom.tabBtnText.addEventListener('click', () => switchTab('text'));
    if (dom.tabBtnImage) dom.tabBtnImage.addEventListener('click', () => switchTab('image'));
    window.addEventListener('resize', () => positionTabIndicator(true));

    dom.inputUrl.addEventListener('input', () => {
      if (state.input.mode !== 'url') {
        window.InputSource.setMode(state.input, 'url');
      }
      invalidateConfirmedDraft();
      hideParseError();
    });

    dom.inputUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFetchUrl();
      }
    });

    const handleTextEdit = () => {
      if (state.input.mode !== 'text') {
        window.InputSource.setMode(state.input, 'text');
      }
      invalidateConfirmedDraft();
      hideParseError();
      updateTextCounter();
    };
    dom.inputTitle.addEventListener('input', handleTextEdit);
    dom.inputText.addEventListener('input', handleTextEdit);

    dom.btnFetchUrl.addEventListener('click', handleFetchUrl);
    dom.btnRetryParseUrl.addEventListener('click', handleFetchUrl);
    dom.btnSwitchToTextFromParse.addEventListener('click', () => {
      switchTab('text');
      dom.inputText.focus();
    });
    if (dom.btnOpenVisionFromParse) {
      dom.btnOpenVisionFromParse.addEventListener('click', () => {
        openSettingsModal('llm', { expandVision: true });
      });
    }

    dom.btnPreviewText.addEventListener('click', confirmTextDraft);

    if (dom.imageDropZone && dom.inputImageFiles) {
      dom.imageDropZone.addEventListener('click', () => dom.inputImageFiles.click());
      dom.imageDropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dom.inputImageFiles.click();
        }
      });
      dom.inputImageFiles.addEventListener('change', (e) => {
        appendImageFiles(e.target.files);
        e.target.value = '';
      });
      dom.imageDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dom.imageDropZone.classList.add('is-dragover');
      });
      dom.imageDropZone.addEventListener('dragleave', () => {
        dom.imageDropZone.classList.remove('is-dragover');
      });
      dom.imageDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dom.imageDropZone.classList.remove('is-dragover');
        appendImageFiles(e.dataTransfer?.files);
      });
    }
    if (dom.btnClearImages) dom.btnClearImages.addEventListener('click', clearSelectedImages);
    if (dom.btnExtractImages) dom.btnExtractImages.addEventListener('click', handleExtractImages);

    document.addEventListener('paste', (e) => {
      if (!dom.settingsModal.classList.contains('hidden')) return;
      const items = Array.from(e.clipboardData?.items || []);
      const imageFiles = items
        .filter((item) => item.kind === 'file' && /^image\//.test(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!imageFiles.length) return;
      const activeTag = document.activeElement?.tagName;
      if (state.uiInputTab !== 'image' && (activeTag === 'INPUT' || activeTag === 'TEXTAREA')) return;
      e.preventDefault();
      if (state.uiInputTab !== 'image') switchTab('image');
      appendImageFiles(imageFiles);
    });

    dom.samplePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const sample = SAMPLES[pill.dataset.sample];
        if (!sample) return;
        switchTab('text');
        dom.inputTitle.value = sample.title;
        dom.inputText.value = sample.content;
        updateTextCounter();
        confirmTextDraft();
      });
    });

    dom.btnToggleFullPreview.addEventListener('click', () => {
      state.fullPreviewExpanded = !state.fullPreviewExpanded;
      updateExcerptView();
    });
    if (dom.btnPolishDraft) {
      dom.btnPolishDraft.addEventListener('click', handlePolishDraft);
    }

    dom.btnEditInput.addEventListener('click', () => {
      const targetMode = state.confirmedDraft?.mode || state.input.mode;
      invalidateConfirmedDraft();
      if (targetMode === 'url') {
        dom.inputUrl.focus();
      } else {
        dom.inputText.focus();
      }
    });

    dom.btnStartGenerate.addEventListener('click', handleStartGenerate);
    dom.btnCancelTask.addEventListener('click', handleCancelTask);

    dom.btnRefreshHistory.addEventListener('click', async () => {
      dom.btnRefreshHistory.classList.remove('is-spinning');
      void dom.btnRefreshHistory.offsetWidth;
      dom.btnRefreshHistory.classList.add('is-spinning');
      await loadHistoryList();
    });

    dom.btnPlayPause.addEventListener('click', togglePlayPause);
    dom.btnRewind10.addEventListener('click', () => seekRelative(-10));
    dom.btnForward10.addEventListener('click', () => seekRelative(10));
    if (dom.btnBgmMode) {
      dom.btnBgmMode.addEventListener('click', async () => {
        const mode = await state.audioEngine?.cycleBgmMode?.();
        updateBgmButton(mode);
        showToast(`播客配乐已切换为：${state.audioEngine?.getBgmLabel?.(mode) || mode}`);
      });
    }
    dom.btnSpeed.addEventListener('click', cyclePlaybackSpeed);
    dom.btnCopyMarkdown.addEventListener('click', handleCopyMarkdown);
    if (dom.btnMiniPlayPause) dom.btnMiniPlayPause.addEventListener('click', togglePlayPause);
    if (dom.btnMiniSpeed) dom.btnMiniSpeed.addEventListener('click', cyclePlaybackSpeed);
    window.addEventListener('scroll', updateMobileMiniVisibility, { passive: true });
    window.addEventListener('resize', updateMobileMiniVisibility, { passive: true });

    dom.seekSlider.addEventListener('input', () => {
      state.isSeeking = true;
      const pct = Number(dom.seekSlider.value) || 0;
      dom.seekSlider.style.setProperty('--seek-pct', `${pct}%`);
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const curStr = formatTime((pct / 100) * dur);
      dom.currentTime.textContent = curStr;
      if (dom.miniTime) dom.miniTime.textContent = `${curStr} / ${formatTime(dur)}`;
    });

    dom.seekSlider.addEventListener('change', () => {
      const pct = Number(dom.seekSlider.value) || 0;
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const target = (pct / 100) * dur;
      state.isSeeking = false;
      syncHighlightToTime(target);
      if (state.audioEngine?.getPhase?.() === 'intro') {
        state.audioEngine.seekAndPlay(target).catch(() => {});
        return;
      }
      dom.mainAudio.currentTime = target;
      state.audioEngine?.syncTime(target);
    });

    dom.mainAudio.addEventListener('loadedmetadata', () => {
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      dom.totalDuration.textContent = formatTime(dur);
      if (dom.miniTime) dom.miniTime.textContent = `${formatTime(dom.mainAudio.currentTime || 0)} / ${formatTime(dur)}`;
    });

    dom.mainAudio.addEventListener('timeupdate', () => {
      if (state.isSeeking) return;
      const cur = dom.mainAudio.currentTime || 0;
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const curStr = formatTime(cur);
      dom.currentTime.textContent = curStr;
      if (dom.miniTime) dom.miniTime.textContent = `${curStr} / ${formatTime(dur)}`;
      if (dur > 0) {
        setSeekProgress((cur / dur) * 100);
      }
      syncHighlightToTime(cur);
      state.audioEngine?.syncTime(cur);
    });

    dom.mainAudio.addEventListener('play', () => {
      state.audioEngine?.handleAudioPlay();
      setDeckPlaying(true);
      syncHighlightToTime(dom.mainAudio.currentTime || 0);
    });

    dom.mainAudio.addEventListener('pause', () => {
      state.audioEngine?.handleAudioPause();
      const enginePhase = state.audioEngine?.getPhase?.();
      if (enginePhase !== 'intro' && enginePhase !== 'outro') {
        setDeckPlaying(false);
      }
    });

    dom.mainAudio.addEventListener('ended', () => {
      state.audioEngine?.handleAudioEnded();
      if (!state.audioEngine || state.audioEngine.getPhase() !== 'outro') {
        setDeckPlaying(false);
      }
      dom.playerDeck.dataset.speaker = 'none';
      if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = 'none';
    });

    dom.btnSettings.addEventListener('click', () => openSettingsModal('llm'));
    dom.btnCloseSettings.addEventListener('click', closeSettingsModal);
    dom.btnCancelSettings.addEventListener('click', closeSettingsModal);
    dom.settingsForm.addEventListener('submit', saveSettings);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) closeSettingsModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.settingsModal.classList.contains('hidden')) {
        closeSettingsModal();
      }
    });

    dom.settingsTabLlm.addEventListener('click', () => switchSettingsTab('llm'));
    dom.settingsTabTts.addEventListener('click', () => switchSettingsTab('tts'));
    window.addEventListener('resize', () => {
      if (!dom.settingsModal.classList.contains('hidden')) {
        positionSettingsTabIndicator(true);
      }
    });

    dom.llmPresetPills.forEach((pill) => {
      pill.addEventListener('click', () => applyLlmPreset(pill.dataset.llmPreset));
    });
    dom.visionPresetPills.forEach((pill) => {
      pill.addEventListener('click', () => applyVisionPreset(pill.dataset.visionPreset));
    });
    if (dom.settingVisionBaseUrl) {
      dom.settingVisionBaseUrl.addEventListener('input', () => {
        updateVisionPresetSelection(detectVisionPresetId(dom.settingVisionBaseUrl.value, dom.settingVisionModel?.value));
        syncModelPickerForBase('vision');
      });
    }
    if (dom.btnFetchVisionModels) {
      dom.btnFetchVisionModels.addEventListener('click', () => handleFetchModels('vision'));
    }
    if (dom.settingVisionModelSelect) {
      dom.settingVisionModelSelect.addEventListener('change', () => {
        if (dom.settingVisionModelSelect.value && dom.settingVisionModel) {
          dom.settingVisionModel.value = dom.settingVisionModelSelect.value;
        }
      });
    }
    dom.settingApiKey.addEventListener('input', () => {
      state.modalLlmKeyEndpoint = dom.settingApiKey.value.trim()
        ? normalizeEndpointForBinding(dom.settingBaseUrl.value)
        : '';
      setTestStatus(dom.llmTestStatus, '', '');
    });
    if (dom.settingVisionApiKey) {
      dom.settingVisionApiKey.addEventListener('input', () => {
        state.modalVisionKeyEndpoint = dom.settingVisionApiKey.value.trim()
          ? normalizeEndpointForBinding(dom.settingVisionBaseUrl?.value)
          : '';
        setTestStatus(dom.visionModelsStatus, '', '');
      });
    }
    dom.settingBaseUrl.addEventListener('input', () => {
      updateLlmPresetSelection(detectLlmPresetId(dom.settingBaseUrl.value));
      setTestStatus(dom.llmTestStatus, '', '');
      syncModelPickerForBase('llm');
    });
    if (dom.btnFetchLlmModels) {
      dom.btnFetchLlmModels.addEventListener('click', () => handleFetchModels('llm'));
    }
    if (dom.settingModelFilter) {
      dom.settingModelFilter.addEventListener('input', renderLlmModelOptions);
    }
    if (dom.settingModelSelect) {
      dom.settingModelSelect.addEventListener('change', () => {
        if (dom.settingModelSelect.value) {
          dom.settingModel.value = dom.settingModelSelect.value;
          setTestStatus(dom.llmTestStatus, '', '');
        }
      });
    }
    dom.settingModel.addEventListener('input', () => {
      setTestStatus(dom.llmTestStatus, '', '');
      if (dom.settingModelSelect) {
        const val = dom.settingModel.value.trim();
        const hasMatch = Array.from(dom.settingModelSelect.options).some((opt) => opt.value === val);
        dom.settingModelSelect.value = hasMatch ? val : '';
      }
    });
    dom.btnTestLlm.addEventListener('click', handleTestLlmConnection);

    dom.ttsProviderButtons.forEach((btn) => {
      btn.addEventListener('click', () => selectTtsProviderInModal(btn.dataset.ttsProvider));
    });
    dom.volcAuthButtons.forEach((btn) => {
      btn.addEventListener('click', () => selectVolcAuthModeInModal(btn.dataset.volcAuth));
    });
    dom.settingVolcResource.addEventListener('change', () => {
      renderVolcVoicesForResource(
        dom.settingVolcResource.value,
        dom.settingVolcVoiceHost.value,
        dom.settingVolcVoiceGuest.value
      );
      setTestStatus(dom.ttsTestStatus, '', '');
    });
    dom.btnTestTts.addEventListener('click', handleTestTtsConnection);

    bindPasswordToggle(dom.settingApiKey, dom.btnToggleKeyVisible);
    bindPasswordToggle(dom.settingVisionApiKey, dom.btnToggleVisionKey);
    bindPasswordToggle(dom.settingMinimaxKey, dom.btnToggleMinimaxKey);
    bindPasswordToggle(dom.settingVolcApiKey, dom.btnToggleVolcApiKey);
    bindPasswordToggle(dom.settingVolcAccessKey, dom.btnToggleVolcAccessKey);
  }

  async function loadTtsProviders() {
    try {
      const data = await apiJson('/api/tts/providers');
      if (Array.isArray(data?.items) && data.items.length > 0) {
        state.ttsCatalog = {
          defaultProvider: data.defaultProvider || 'edge',
          items: data.items,
        };
      }
    } catch {
      state.ttsCatalog = FALLBACK_TTS_CATALOG;
    }
    hydrateTtsControlsFromCatalog();
    updateApiKeyStatus();
  }

  async function restoreActiveTaskIfAny() {
    const savedId = readStorage(STORAGE_KEYS.activeTaskId);
    if (!savedId) return;
    try {
      const task = await apiJson(`/api/tasks/${encodeURIComponent(savedId)}`);
      if (task.status === 'completed') {
        writeStorage(STORAGE_KEYS.activeTaskId, '');
        if (task.podcast && !state.currentPodcast) {
          loadPodcast(task.podcast, { autoplay: false });
        }
        return;
      }
      setActiveTask(task);
      if (['queued', 'running'].includes(task.status)) {
        startPolling();
      }
    } catch {
      writeStorage(STORAGE_KEYS.activeTaskId, '');
    }
  }

  async function bootstrap() {
    state.audioEngine = window.PodcastAudioEngine?.createAudioEngine(dom.mainAudio, {
      onPhaseChange: handleAudioPhaseChange,
    }) || null;
    updateBgmButton();
    initWaveformBars();
    hydrateTtsControlsFromCatalog();
    updateApiKeyStatus();
    updateTextCounter();
    renderImageSelection();
    bindEvents();
    positionTabIndicator(true);

    await Promise.all([loadTtsProviders(), loadHistoryList()]);
    await restoreActiveTaskIfAny();

    if (!state.currentPodcast && state.historyItems.length > 0) {
      await handleSelectHistory(state.historyItems[0].id);
    }
  }

  window.addEventListener('DOMContentLoaded', bootstrap);
})();
