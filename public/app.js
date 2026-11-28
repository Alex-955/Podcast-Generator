(function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-flash';
  const MAX_CONTENT_LENGTH = 12000;
  const MAX_LINE_TEXT_LENGTH = 2000;
  const FULL_PREVIEW_THRESHOLD = 150;
  const POLL_INTERVAL_MS = 1000;
  const SPEEDS = [0.8, 1.0, 1.25, 1.5, 1.75, 2.0];
  const STAGE_ORDER = ['extract', 'script', 'tts', 'merge'];
  const PODCAST_STYLES = ['deep_dive', 'dialogue', 'debate'];
  const COLLECTION_COLORS = ['ink', 'vermilion', 'indigo', 'jade', 'amber', 'plum'];

  function normalizePodcastStyleClient(value) {
    return PODCAST_STYLES.includes(value) ? value : 'deep_dive';
  }

  const STORAGE_KEYS = {
    apiKey: 'ai_podcast_apikey',
    baseURL: 'ai_podcast_baseurl',
    model: 'ai_podcast_model',
    visionConfig: 'ai_podcast_vision_config',
    ttsConfig: 'ai_podcast_tts_config',
    podcastStyle: 'ai_podcast_script_style',
    activeTaskId: 'ai_podcast_active_task_id',
    autoCheckUpdates: 'ai_podcast_auto_check_updates',
    ignoredUpdateVersion: 'ai_podcast_ignored_update_version',
  };

  const DEFAULT_APP_VERSION = '1.1.0';
  const OFFICIAL_DOWNLOAD_URL = 'https://podcast.ai955.xyz/#onboarding';
  const OFFICIAL_RELEASE_URL = 'https://github.com/Alex-955/Podcast-Generator/releases/latest';
  const WELCOME_SAMPLE_META = [
    { key: 'ai', tag: '技术长文', label: 'AI 智能体工作流' },
    { key: 'deepseek', tag: '深度拆解', label: 'DeepSeek 技术剖析' },
    { key: 'work', tag: '生活方式', label: '数字游民的自律' },
  ];

  const PODCAST_STYLE_DESCS = {
    deep_dive: '7:3 主讲拆解 + 主持追问 · 沉浸式深度拆解',
    dialogue: '阿泽与小晓 5:5 轻快接力对谈',
    debate: '阿泽力挺原文 × 小晓理性挑刺 · 5:5 克制思辨',
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

  const TTS_COMPACT_LABELS = {
    minimax: 'MiniMax',
    volcengine: '豆包',
    edge: 'Edge 免费',
  };

  const SOURCE_TYPE_LABELS = {
    url: '链接',
    text: '正文',
    image: '识图',
  };

  const PODCAST_STYLE_LABELS = {
    deep_dive: '深度主讲',
    dialogue: '轻松对谈',
    debate: '正反交锋',
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
    volcengine: '字节跳动豆包大模型语音（小天 2.0 + Vivi 2.0 搭配自然）。在 console.volcengine.com/speech/app 开通「大模型语音合成」后获取 API Key。',
    edge: '免配置密钥的微软神经网络语音试用通道；因非官方公开接口，近期偶发 403 限流且拟真度一般，长期稳定制作建议使用 MiniMax 或火山豆包。',
  };

  const DEFAULT_TTS_CONFIG = {
    provider: '',
    speechSpeed: 'relaxed',
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
    modalTtsSpeed: 'relaxed',
    modalTtsSpeedChanged: false,
    ttsSpeedOverrideTaskId: null,
    ttsSettingsOverrideTaskId: null,
    modalVolcAuthMode: 'apiKey',
    uiInputTab: 'url',
    podcastStyle: normalizePodcastStyleClient(readStorage(STORAGE_KEYS.podcastStyle)),
    input: window.InputSource.createState(),
    imageSlices: [],
    extractingImages: false,
    extractAbortController: null,
    extractTimer: null,
    draftSeq: 0,
    confirmedDraft: null,
    styleRecommendAbortController: null,
    polishingDraft: false,
    polishAbortController: null,
    polishTimer: null,
    fullPreviewExpanded: false,
    llmModelsCache: new Map(),
    activeTask: null,
    pollTimer: null,
    pollInFlight: false,
    elapsedTimer: null,
    historyItems: [],
    collections: [],
    collectionsTotalCount: 0,
    collectionsUnassignedCount: 0,
    selectedCollectionFilter: 'all',
    collectionDeleteConfirmId: null,
    collectionHighlightsExpanded: false,
    activeCollectionDetail: null,
    collectionDetailSeq: 0,
    collectionModal: {
      mode: 'create',
      collectionId: null,
      color: 'ink',
      submitting: false,
    },
    assignModal: {
      podcastId: null,
      sessionSeq: 0,
      suggestSeq: 0,
      submitting: false,
      suggesting: false,
      suggestion: null,
      suggestionError: null,
      suggestAbortController: null,
    },
    lanCompanion: {
      running: false,
      port: null,
      activeHost: null,
      candidates: [],
      url: null,
      qrSvg: null,
      connectedHint: '',
      busy: false,
    },
    updateCheck: {
      currentVersion: DEFAULT_APP_VERSION,
      checking: false,
      result: null,
      startupTimer: null,
      lastTriggerEl: null,
    },
    pendingDeleteId: null,
    deletingPodcastId: null,
    historySelectSeq: 0,
    deletedPodcastIds: new Set(),
    currentPodcast: null,
    currentMetaBaseText: '尚无已选播客',
    audioEngine: null,
    playbackRate: 1.0,
    isSeeking: false,
    subtitleElements: [],
    lastSpeakerRole: 'none',
    lastRenderedTimeText: '',
    lastRenderedMiniTimeText: '',
    lastRenderedSeekPct: -1,
    subtitleScrollRaf: 0,
    mobileMiniRaf: 0,
    userScrollingSubtitlesUntil: 0,
    scriptEdit: {
      active: false,
      podcastId: null,
      baseVersion: null,
      original: [],
      draft: [],
      submitting: false,
    },
  };

  const dom = {
    btnUpdateBadge: document.getElementById('btnUpdateBadge'),
    updateBadgeText: document.getElementById('updateBadgeText'),
    btnLanCompanion: document.getElementById('btnLanCompanion'),
    lanCompanionStatusDot: document.getElementById('lanCompanionStatusDot'),
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
    ttsSpeedButtons: document.querySelectorAll('[data-tts-speed]'),
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
    imageProgressPanel: document.getElementById('imageProgressPanel'),
    imageProgressStage: document.getElementById('imageProgressStage'),
    imageProgressElapsed: document.getElementById('imageProgressElapsed'),
    imageProgressFill: document.getElementById('imageProgressFill'),
    btnCancelExtractImages: document.getElementById('btnCancelExtractImages'),
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
    confirmStyleButtons: document.querySelectorAll('[data-podcast-style]'),
    confirmStyleAiTags: document.querySelectorAll('[data-style-ai-tag]'),
    confirmStyleDesc: document.getElementById('confirmStyleDesc'),
    btnToggleFullPreview: document.getElementById('btnToggleFullPreview'),
    btnPolishDraft: document.getElementById('btnPolishDraft'),
    polishBanner: document.getElementById('polishBanner'),
    polishProgressBar: document.getElementById('polishProgressBar'),
    polishProgressFill: document.getElementById('polishProgressFill'),
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
    btnNewCollection: document.getElementById('btnNewCollection'),
    btnRefreshHistory: document.getElementById('btnRefreshHistory'),
    collectionFilterBar: document.getElementById('collectionFilterBar'),
    collectionHeaderCard: document.getElementById('collectionHeaderCard'),
    collectionHeaderDot: document.getElementById('collectionHeaderDot'),
    collectionHeaderName: document.getElementById('collectionHeaderName'),
    collectionHeaderCount: document.getElementById('collectionHeaderCount'),
    collectionHeaderActions: document.getElementById('collectionHeaderActions'),
    btnEditCollection: document.getElementById('btnEditCollection'),
    btnDeleteCollection: document.getElementById('btnDeleteCollection'),
    collectionDeleteConfirm: document.getElementById('collectionDeleteConfirm'),
    btnConfirmDeleteCollection: document.getElementById('btnConfirmDeleteCollection'),
    btnCancelDeleteCollection: document.getElementById('btnCancelDeleteCollection'),
    collectionHeaderDesc: document.getElementById('collectionHeaderDesc'),
    btnToggleCollectionHighlights: document.getElementById('btnToggleCollectionHighlights'),
    collectionHighlightsLabel: document.getElementById('collectionHighlightsLabel'),
    collectionHighlightsPanel: document.getElementById('collectionHighlightsPanel'),
    historyList: document.getElementById('historyList'),

    playerDeck: document.getElementById('playerDeck'),
    waveVisualizer: document.getElementById('waveVisualizer'),
    currentPodcastMeta: document.getElementById('currentPodcastMeta'),
    currentPodcastBadges: document.getElementById('currentPodcastBadges'),
    btnAssignCurrentCollection: document.getElementById('btnAssignCurrentCollection'),
    currentCollectionDot: document.getElementById('currentCollectionDot'),
    currentCollectionLabel: document.getElementById('currentCollectionLabel'),

    collectionModal: document.getElementById('collectionModal'),
    collectionModalTitle: document.getElementById('collectionModalTitle'),
    collectionModalSubtitle: document.getElementById('collectionModalSubtitle'),
    btnCloseCollectionModal: document.getElementById('btnCloseCollectionModal'),
    collectionForm: document.getElementById('collectionForm'),
    collectionNameInput: document.getElementById('collectionNameInput'),
    collectionDescInput: document.getElementById('collectionDescInput'),
    collectionColorSwatches: document.querySelectorAll('[data-collection-color]'),
    collectionModalError: document.getElementById('collectionModalError'),
    btnCancelCollectionModal: document.getElementById('btnCancelCollectionModal'),
    btnSaveCollectionModal: document.getElementById('btnSaveCollectionModal'),

    assignCollectionModal: document.getElementById('assignCollectionModal'),
    assignCollectionPodcastTitle: document.getElementById('assignCollectionPodcastTitle'),
    btnCloseAssignModal: document.getElementById('btnCloseAssignModal'),
    btnSuggestCollection: document.getElementById('btnSuggestCollection'),
    aiSuggestResult: document.getElementById('aiSuggestResult'),
    assignCollectionList: document.getElementById('assignCollectionList'),
    quickCreateCollectionForm: document.getElementById('quickCreateCollectionForm'),
    quickCollectionNameInput: document.getElementById('quickCollectionNameInput'),
    btnQuickCreateCollection: document.getElementById('btnQuickCreateCollection'),

    lanCompanionModal: document.getElementById('lanCompanionModal'),
    btnCloseLanCompanionModal: document.getElementById('btnCloseLanCompanionModal'),
    lanCompanionStoppedView: document.getElementById('lanCompanionStoppedView'),
    lanCompanionRunningView: document.getElementById('lanCompanionRunningView'),
    lanCompanionStoppedError: document.getElementById('lanCompanionStoppedError'),
    lanCompanionRunningError: document.getElementById('lanCompanionRunningError'),
    btnStartLanCompanion: document.getElementById('btnStartLanCompanion'),
    lanCompanionPortBadge: document.getElementById('lanCompanionPortBadge'),
    lanCompanionQrBox: document.getElementById('lanCompanionQrBox'),
    lanCompanionUrlInput: document.getElementById('lanCompanionUrlInput'),
    btnCopyLanCompanionUrl: document.getElementById('btnCopyLanCompanionUrl'),
    lanCompanionHostWrap: document.getElementById('lanCompanionHostWrap'),
    lanCompanionHostSelect: document.getElementById('lanCompanionHostSelect'),
    btnRotateLanCompanion: document.getElementById('btnRotateLanCompanion'),
    btnStopLanCompanion: document.getElementById('btnStopLanCompanion'),
    settingsCurrentVersion: document.getElementById('settingsCurrentVersion'),
    settingAutoCheckUpdates: document.getElementById('settingAutoCheckUpdates'),
    btnCheckUpdatesNow: document.getElementById('btnCheckUpdatesNow'),
    updateCheckInlineStatus: document.getElementById('updateCheckInlineStatus'),
    updateModal: document.getElementById('updateModal'),
    btnCloseUpdateModal: document.getElementById('btnCloseUpdateModal'),
    updateCurrentVersionBadge: document.getElementById('updateCurrentVersionBadge'),
    updateLatestVersionBadge: document.getElementById('updateLatestVersionBadge'),
    updateReleaseDate: document.getElementById('updateReleaseDate'),
    updateNotesList: document.getElementById('updateNotesList'),
    btnUpdateDownloadOfficial: document.getElementById('btnUpdateDownloadOfficial'),
    btnUpdateGithubRelease: document.getElementById('btnUpdateGithubRelease'),
    btnIgnoreUpdateVersion: document.getElementById('btnIgnoreUpdateVersion'),
    btnDismissUpdateModal: document.getElementById('btnDismissUpdateModal'),
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
    btnEditScript: document.getElementById('btnEditScript'),
    scriptEditorBar: document.getElementById('scriptEditorBar'),
    scriptEditorStatus: document.getElementById('scriptEditorStatus'),
    scriptEditorCacheHint: document.getElementById('scriptEditorCacheHint'),
    btnResetScriptEdits: document.getElementById('btnResetScriptEdits'),
    btnCancelScriptEdit: document.getElementById('btnCancelScriptEdit'),
    btnResynthesizeScript: document.getElementById('btnResynthesizeScript'),
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
      speechSpeed: ['relaxed', 'standard'].includes(parsed?.speechSpeed) ? parsed.speechSpeed : DEFAULT_TTS_CONFIG.speechSpeed,
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
    if (state.styleRecommendAbortController) {
      state.styleRecommendAbortController.abort();
      state.styleRecommendAbortController = null;
    }
    if (state.polishAbortController) {
      state.polishAbortController.abort();
      state.polishAbortController = null;
    }
    if (state.polishTimer) {
      window.clearInterval(state.polishTimer);
      state.polishTimer = null;
    }
    state.confirmedDraft = null;
    state.fullPreviewExpanded = false;
    dom.confirmCard.classList.add('hidden');
    if (dom.polishBanner) dom.polishBanner.classList.remove('is-loading');
    if (dom.polishProgressBar) dom.polishProgressBar.classList.add('hidden');
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

  function updatePodcastStyleUI() {
    const style = normalizePodcastStyleClient(state.podcastStyle);
    const draft = state.confirmedDraft;
    const rec = draft?.styleRecommendation;
    dom.confirmStyleButtons?.forEach((btn) => {
      const active = btn.dataset.podcastStyle === style;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
    dom.confirmStyleAiTags?.forEach((tag) => {
      tag.classList.toggle('hidden', !rec || tag.dataset.styleAiTag !== rec.style);
    });
    if (dom.confirmStyleDesc) {
      if (rec) {
        const recLabel = PODCAST_STYLE_LABELS[rec.style] || rec.style;
        const isOnRec = style === rec.style;
        dom.confirmStyleDesc.classList.toggle('is-recommended', isOnRec);
        if (isOnRec) {
          dom.confirmStyleDesc.textContent = rec.reason
            ? `AI 推荐 · ${recLabel}：${rec.reason}`
            : `AI 推荐 · ${recLabel}`;
        } else {
          dom.confirmStyleDesc.textContent = `${PODCAST_STYLE_DESCS[style] || PODCAST_STYLE_DESCS.deep_dive}（AI 推荐${recLabel}）`;
        }
      } else {
        dom.confirmStyleDesc.classList.remove('is-recommended');
        const baseDesc = PODCAST_STYLE_DESCS[style] || PODCAST_STYLE_DESCS.deep_dive;
        dom.confirmStyleDesc.textContent = draft?.styleRecommendLoading
          ? `${baseDesc} · AI 正在判断更适合的风格…`
          : baseDesc;
      }
    }
  }

  async function requestStyleRecommendation(draft) {
    if (!draft || !draft.content?.trim()) return;
    const draftId = draft.draftId;
    if (state.styleRecommendAbortController) {
      state.styleRecommendAbortController.abort();
    }
    const controller = new AbortController();
    state.styleRecommendAbortController = controller;
    draft.styleRecommendLoading = true;
    updatePodcastStyleUI();

    try {
      const data = await apiJson('/api/recommend-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          title: draft.title || '',
          content: draft.content,
          ...buildCredsPayload(),
        }),
      });
      const current = state.confirmedDraft;
      if (!current || current.draftId !== draftId) return;
      current.styleRecommendLoading = false;
      const recStyle = PODCAST_STYLES.includes(data?.style) ? data.style : '';
      if (recStyle) {
        current.styleRecommendation = {
          style: recStyle,
          reason: typeof data.reason === 'string' ? data.reason : '',
        };
        if (!current.userPickedStyle) {
          state.podcastStyle = recStyle;
        }
      }
      updatePodcastStyleUI();
    } catch {
      const current = state.confirmedDraft;
      if (current && current.draftId === draftId) {
        current.styleRecommendLoading = false;
        updatePodcastStyleUI();
      }
    } finally {
      if (state.styleRecommendAbortController === controller) {
        state.styleRecommendAbortController = null;
      }
    }
  }

  function renderPolishBanner() {
    const draft = state.confirmedDraft;
    if (!dom.polishBanner || !draft) return;

    dom.polishBannerActions.textContent = '';
    dom.polishBanner.classList.remove('is-done', 'is-loading');
    if (dom.polishProgressBar) dom.polishProgressBar.classList.add('hidden');
    if (dom.polishProgressFill) dom.polishProgressFill.style.width = '0%';

    if (draft.polishedFrom) {
      dom.polishBanner.classList.remove('hidden');
      dom.polishBanner.classList.add('is-done');
      dom.polishBannerText.textContent = draft.changeSummary || '已完成上下文纠错与语句顺滑处理';
      const undoBtn = createActionBtn('恢复润色前原文', 'btn btn-subtle btn-sm', restoreDraftBeforePolish);
      dom.polishBannerActions.appendChild(undoBtn);
      return;
    }

    if (draft.changeSummary) {
      dom.polishBanner.classList.remove('hidden');
      dom.polishBanner.classList.add('is-done');
      dom.polishBannerText.textContent = draft.changeSummary;
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

  function renderPolishLoading(elapsedSeconds) {
    if (!dom.polishBanner) return;
    dom.polishBanner.classList.remove('hidden', 'is-done');
    dom.polishBanner.classList.add('is-loading');
    if (dom.polishProgressBar) dom.polishProgressBar.classList.remove('hidden');
    const pct = Math.min(88, Math.round(16 + 72 * (1 - Math.exp(-elapsedSeconds / 6))));
    if (dom.polishProgressFill) dom.polishProgressFill.style.width = `${pct}%`;
    let stage = '正在扫描错别字并清理首尾杂讯…';
    if (elapsedSeconds >= 8) stage = '正文较长，正分段并发精细校对，请稍候…';
    else if (elapsedSeconds >= 3) stage = '正在结合上下文清理署名声明与修正片段…';
    dom.polishBannerText.textContent = `${stage} · 已耗时 ${Math.floor(elapsedSeconds)}s`;
    if (!dom.polishBannerActions.querySelector('[data-polish-cancel]')) {
      dom.polishBannerActions.textContent = '';
      const cancelBtn = createActionBtn('取消', 'btn btn-ghost btn-sm', () => {
        state.polishAbortController?.abort();
      });
      cancelBtn.dataset.polishCancel = '1';
      dom.polishBannerActions.appendChild(cancelBtn);
    }
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
    const controller = new AbortController();
    state.polishAbortController = controller;
    const startedAt = Date.now();
    const polishBtnSpan = dom.btnPolishDraft?.querySelector('span');
    if (dom.btnPolishDraft) dom.btnPolishDraft.disabled = true;
    if (polishBtnSpan) polishBtnSpan.textContent = '润色校对中…';

    renderPolishLoading(0);
    state.polishTimer = window.setInterval(() => {
      renderPolishLoading((Date.now() - startedAt) / 1000);
    }, 250);

    try {
      const data = await apiJson('/api/polish-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          title: draft.title,
          content: draft.content,
          ...buildCredsPayload(),
        }),
      });

      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (dom.polishProgressFill) dom.polishProgressFill.style.width = '100%';

      const noChanges = data.mode === 'patch' && data.editCount === 0 && (data.title || draft.title) === draft.title;
      if (noChanges) {
        renderConfirmationCard({
          ...draft,
          truncated: Boolean(draft.truncated || data.truncated),
          hasIssues: false,
          issueHint: '',
          polishedFrom: draft.polishedFrom || null,
          changeSummary: `核对完成（用时 ${elapsedSec}s）：未发现明显错别字，原文已保持不变`,
        });
        showToast(`已完成全文核对（${elapsedSec}s），未发现需要修改的错别字`);
        return;
      }

      const originalSnapshot = draft.polishedFrom || {
        title: draft.title,
        content: draft.content,
        truncated: Boolean(draft.truncated),
        hasIssues: Boolean(draft.hasIssues),
        issueHint: draft.issueHint || '',
      };

      const editPrefix = data.editCount > 0 ? `已修正 ${data.editCount} 处 · ` : '';
      renderConfirmationCard({
        ...draft,
        title: data.title || draft.title,
        content: data.content,
        length: data.length,
        truncated: Boolean(draft.truncated || data.truncated),
        hasIssues: false,
        issueHint: '',
        polishedFrom: originalSnapshot,
        changeSummary: `${editPrefix}用时 ${elapsedSec}s · ${data.changeSummary || '已完成上下文纠错与语句顺滑处理'}`,
      });

      if (state.uiInputTab === 'text') {
        dom.inputTitle.value = data.title || '';
        dom.inputText.value = data.content || '';
        updateTextCounter();
      }
      showToast(`已完成 AI 纠错润色（${elapsedSec}s），可核对或一键还原`);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (state.confirmedDraft === draft) {
          renderPolishBanner();
          showToast('已取消 AI 纠错润色');
        }
        return;
      }
      if (state.confirmedDraft === draft) renderPolishBanner();
      handleCredentialOrTaskError(err);
    } finally {
      if (state.polishTimer) {
        window.clearInterval(state.polishTimer);
        state.polishTimer = null;
      }
      if (state.polishAbortController === controller) {
        state.polishAbortController = null;
      }
      state.polishingDraft = false;
      if (dom.btnPolishDraft) dom.btnPolishDraft.disabled = false;
      if (polishBtnSpan) polishBtnSpan.textContent = 'AI 纠错润色';
    }
  }

  function renderConfirmationCard(draft, { recommendStyle = false } = {}) {
    if (recommendStyle) {
      state.podcastStyle = normalizePodcastStyleClient(readStorage(STORAGE_KEYS.podcastStyle));
    }
    if (recommendStyle || !draft.draftId) {
      draft.draftId = ++state.draftSeq;
    }
    state.confirmedDraft = draft;
    state.fullPreviewExpanded = false;

    const badgeText = draft.mode === 'url' ? '链接解析' : draft.mode === 'image' ? '长图识字' : '直接贴正文';
    dom.confirmSourceBadge.textContent = badgeText;
    dom.confirmCharBadge.textContent = `${draft.length.toLocaleString('zh-CN')} 字`;
    updateConfirmTtsBadge();
    dom.confirmTruncatedBadge.classList.toggle('hidden', !draft.truncated);
    dom.confirmTitle.textContent = draft.title || '未命名文章（生成时将自动提炼标题）';

    updateExcerptView();
    updatePodcastStyleUI();
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
    if (recommendStyle) {
      requestStyleRecommendation(draft);
    }
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
      }, { recommendStyle: true });
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
    }, { recommendStyle: true });
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
    try {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async function sliceImageFile(file, remainingQuota) {
    const img = await loadImageFromFile(file);
    try {
      const natW = img.naturalWidth || img.width;
      const natH = img.naturalHeight || img.height;
      if (!natW || !natH) throw new Error('图片尺寸无效');

      const targetW = Math.min(natW, 1120);
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
    } finally {
      img.src = '';
    }
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
    const controller = new AbortController();
    state.extractAbortController = controller;
    const sliceCount = state.imageSlices.length;
    const startedAt = Date.now();
    dom.btnExtractImages.disabled = true;
    if (dom.btnClearImages) dom.btnClearImages.disabled = true;
    const btnSpan = dom.btnExtractImages.querySelector('span');
    if (btnSpan) btnSpan.textContent = '识别中…';

    const updateProgress = (elapsedSec) => {
      if (dom.imageProgressElapsed) {
        dom.imageProgressElapsed.textContent = `已耗时 ${Math.floor(elapsedSec)}s`;
      }
      if (dom.imageProgressStage) {
        let stage = `正在将 ${sliceCount} 个图片片段上传至识图模型…`;
        if (elapsedSec >= 14) stage = '正在核对专名、标点与疑似错字…';
        else if (elapsedSec >= 2.5) stage = '模型正在逐字转录正文并去重拼接…';
        dom.imageProgressStage.textContent = stage;
      }
      if (dom.imageProgressFill) {
        const pct = Math.min(88, Math.round(14 + 74 * (1 - Math.exp(-elapsedSec / 12))));
        dom.imageProgressFill.style.width = `${pct}%`;
      }
    };

    if (dom.imagePreviewStrip) dom.imagePreviewStrip.classList.add('is-scanning');
    if (dom.imageProgressPanel) dom.imageProgressPanel.classList.remove('hidden');
    updateProgress(0);
    state.extractTimer = window.setInterval(() => {
      updateProgress((Date.now() - startedAt) / 1000);
    }, 250);

    try {
      const data = await apiJson('/api/extract-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          images: state.imageSlices.map((s) => s.dataUrl),
          ...buildCredsPayload(),
          ...buildVisionPayload(),
        }),
      });

      if (dom.imageProgressFill) dom.imageProgressFill.style.width = '100%';
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

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
      }, { recommendStyle: true });
      showToast(data.hasIssues
        ? `已识别 ${data.length.toLocaleString('zh-CN')} 字（用时 ${elapsedSec}s · 检测到疑似错字，可点「AI 纠错润色」）`
        : `已从截图识别 ${data.length.toLocaleString('zh-CN')} 字（用时 ${elapsedSec}s），请核对后生成播客`);
    } catch (err) {
      if (err.name === 'AbortError') {
        showToast('已取消图片识别');
        return;
      }
      const msg = err.message || '图片文字识别失败，建议换清晰截图或直接贴正文';
      const needsVisionConfig = err.status === 400 && /识图|图片|视觉|多模态|API Key/i.test(msg);
      showParseError(msg, null, { source: 'image', showVisionConfig: needsVisionConfig });
    } finally {
      if (state.extractTimer) {
        window.clearInterval(state.extractTimer);
        state.extractTimer = null;
      }
      if (state.extractAbortController === controller) {
        state.extractAbortController = null;
      }
      state.extractingImages = false;
      if (dom.imagePreviewStrip) dom.imagePreviewStrip.classList.remove('is-scanning');
      if (dom.imageProgressPanel) dom.imageProgressPanel.classList.add('hidden');
      if (dom.imageProgressFill) dom.imageProgressFill.style.width = '0%';
      if (btnSpan) btnSpan.textContent = '识别图片文字';
      if (dom.btnClearImages) dom.btnClearImages.disabled = false;
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
    const speechSpeed = cfg.speechSpeed === 'standard' ? 'standard' : 'relaxed';
    if (provider === 'minimax') {
      const out = {
        provider: 'minimax',
        speechSpeed,
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
        speechSpeed,
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
      speechSpeed,
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
          sourceType: ['url', 'text', 'image'].includes(draftSnapshot.mode) ? draftSnapshot.mode : 'text',
          title: draftSnapshot.title,
          content: draftSnapshot.content,
          podcastStyle: state.podcastStyle,
          ...buildCredsPayload(),
          tts: buildTtsPayload(),
        }),
      });

      invalidateConfirmedDraft();
      state.ttsSpeedOverrideTaskId = null;
      state.ttsSettingsOverrideTaskId = null;
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
    updateScriptEditAvailability();
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
        if (task.targetPodcastId) {
          const cached = task.progress?.cachedSegments || 0;
          const total = task.progress?.totalSegments || task.podcast?.sentences?.length || 0;
          showToast(`《${task.podcastTitle || '当前播客'}》微调重拼完成（缓存命中 ${cached}/${total} 句）`);
        } else {
          showToast(`播客《${task.podcastTitle || '新剧集'}》已生成完毕`);
        }
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
      const isResynthesize = Boolean(state.activeTask?.id === taskId && state.activeTask?.targetPodcastId);
      let ttsPayload;
      if (isResynthesize && state.ttsSettingsOverrideTaskId !== taskId) {
        ttsPayload = buildResynthesizeTtsPayload(state.activeTask);
      } else {
        ttsPayload = buildTtsPayload();
        if (state.ttsSpeedOverrideTaskId !== taskId) {
          delete ttsPayload.speechSpeed;
        }
      }
      const body = isResynthesize
        ? { tts: ttsPayload }
        : { ...buildCredsPayload(), tts: ttsPayload };
      const task = await apiJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.ttsSpeedOverrideTaskId = null;
      state.ttsSettingsOverrideTaskId = null;
      setActiveTask(task);
      startPolling();
      showToast('已从断点恢复生成');
    } catch (err) {
      handleCredentialOrTaskError(err);
    }
  }

  function codePointLength(value) {
    return Array.from(String(value || '')).length;
  }

  function collectKnownClientSecrets() {
    const credentialKeys = [
      state.apiKey,
      state.visionConfig?.apiKey,
      state.ttsConfig?.minimax?.apiKey,
      state.ttsConfig?.volcengine?.apiKey,
      state.ttsConfig?.volcengine?.appId,
      state.ttsConfig?.volcengine?.accessKey,
    ]
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    const customEndpoints = [
      state.ttsConfig?.minimax?.endpoint,
      state.ttsConfig?.volcengine?.endpoint,
      state.visionConfig?.baseURL,
      state.baseURL && state.baseURL !== DEFAULT_BASE_URL ? state.baseURL : '',
    ]
      .map((v) => String(v || '').trim())
      .filter((v) => v.length >= 4);
    return Array.from(new Set([...credentialKeys, ...customEndpoints]));
  }

  function containsClientSecretOrPath(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    const secrets = collectKnownClientSecrets();
    if (secrets.some((secret) => value.includes(secret))) return true;
    if (/\bsk-[A-Za-z0-9_-]{6,}|\bfile:(?:\/\/)?\/?[^\s"'<>]+/i.test(value)) return true;
    const slashMatches = value.matchAll(/\/\/[^\s"'<>),\]，。）】》」』；、]+/gu);
    for (const match of slashMatches) {
      const before = value.slice(0, match.index);
      if (!/(?:^|[\s"'=(\[（【《「『；、，。]|[^\x00-\x7f])(?:https?|wss?):$/i.test(before) &&
          !/^(?:https?|wss?):$/i.test(before)) {
        return true;
      }
    }
    return false;
  }

  function normalizeCollectionColor(color) {
    return COLLECTION_COLORS.includes(color) ? color : 'ink';
  }

  function findCollectionById(id) {
    if (!id) return null;
    return state.collections.find((col) => col.id === id) || null;
  }

  function pickNextCollectionColor() {
    const used = new Set(state.collections.map((c) => c.color));
    return COLLECTION_COLORS.find((c) => !used.has(c)) || COLLECTION_COLORS[state.collections.length % COLLECTION_COLORS.length];
  }

  function applyCollectionCountsFromLocalHistory() {
    const validIds = new Set(state.collections.map((c) => c.id));
    const counts = new Map();
    let unassigned = 0;
    state.historyItems.forEach((item) => {
      const colId = item.collectionId && validIds.has(item.collectionId) ? item.collectionId : null;
      if (colId) {
        counts.set(colId, (counts.get(colId) || 0) + 1);
      } else {
        unassigned += 1;
      }
    });
    state.collections = state.collections.map((col) => ({
      ...col,
      podcastCount: counts.get(col.id) || 0,
    }));
    state.collectionsTotalCount = state.historyItems.length;
    state.collectionsUnassignedCount = unassigned;
  }

  async function loadCollections({ render = true } = {}) {
    try {
      const data = await apiJson('/api/collections');
      state.collections = Array.isArray(data?.items) ? data.items : [];
      state.collectionsTotalCount = Number.isFinite(data?.totalPodcastCount) ? data.totalPodcastCount : state.historyItems.length;
      state.collectionsUnassignedCount = Number.isFinite(data?.unassignedCount) ? data.unassignedCount : 0;
      if (state.selectedCollectionFilter !== 'all' &&
          state.selectedCollectionFilter !== 'unassigned' &&
          !findCollectionById(state.selectedCollectionFilter)) {
        state.selectedCollectionFilter = 'all';
        state.collectionDeleteConfirmId = null;
        state.collectionHighlightsExpanded = false;
        state.activeCollectionDetail = null;
      }
      if (render) {
        renderCollectionFilterBar();
        renderCollectionHeaderCard();
        renderCurrentPodcastCollectionTrigger();
      }
    } catch {
      // 保留现有内存态，避免影响历史列表展示
    }
  }

  async function loadCollectionDetail(collectionId) {
    if (!collectionId) return;
    const seq = ++state.collectionDetailSeq;
    try {
      const detail = await apiJson(`/api/collections/${encodeURIComponent(collectionId)}`);
      if (seq !== state.collectionDetailSeq || state.selectedCollectionFilter !== collectionId) return;
      state.activeCollectionDetail = detail;
      renderCollectionHeaderCard();
    } catch {
      if (seq === state.collectionDetailSeq && state.selectedCollectionFilter === collectionId) {
        renderCollectionHeaderCard();
      }
    }
  }

  function renderCollectionFilterBar() {
    if (!dom.collectionFilterBar) return;
    dom.collectionFilterBar.textContent = '';

    const total = Number.isFinite(state.collectionsTotalCount) ? state.collectionsTotalCount : state.historyItems.length;
    const validIds = new Set(state.collections.map((c) => c.id));
    const computedUnassigned = state.historyItems.filter((item) => !item.collectionId || !validIds.has(item.collectionId)).length;
    const unassigned = state.historyItems.length ? computedUnassigned : (state.collectionsUnassignedCount || 0);

    const pills = [
      { id: 'all', label: '全部', count: state.historyItems.length || total, color: null },
      { id: 'unassigned', label: '未归类', count: unassigned, color: null },
      ...state.collections.map((col) => ({
        id: col.id,
        label: col.name,
        count: col.podcastCount || 0,
        color: normalizeCollectionColor(col.color),
      })),
    ];

    const fragment = document.createDocumentFragment();
    pills.forEach((pill) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'collection-filter-pill';
      const active = state.selectedCollectionFilter === pill.id;
      if (active) btn.classList.add('is-active');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(active));
      btn.dataset.filterId = pill.id;

      if (pill.color) {
        const dot = document.createElement('span');
        dot.className = `collection-dot is-${pill.color}`;
        dot.setAttribute('aria-hidden', 'true');
        btn.appendChild(dot);
      }

      const textSpan = document.createElement('span');
      textSpan.textContent = pill.label;
      const countSpan = document.createElement('span');
      countSpan.className = 'collection-filter-count';
      countSpan.textContent = String(pill.count);
      btn.append(textSpan, countSpan);

      fragment.appendChild(btn);
    });
    dom.collectionFilterBar.appendChild(fragment);
  }

  function renderCollectionHeaderCard() {
    if (!dom.collectionHeaderCard) return;
    const filter = state.selectedCollectionFilter;
    const col = filter !== 'all' && filter !== 'unassigned' ? findCollectionById(filter) : null;
    if (!col) {
      dom.collectionHeaderCard.classList.add('hidden');
      return;
    }

    dom.collectionHeaderCard.classList.remove('hidden');
    const color = normalizeCollectionColor(col.color);
    dom.collectionHeaderDot.className = `collection-dot is-${color}`;
    dom.collectionHeaderName.textContent = col.name;
    dom.collectionHeaderCount.textContent = `${col.podcastCount || 0} 集`;

    if (col.description) {
      dom.collectionHeaderDesc.textContent = col.description;
      dom.collectionHeaderDesc.classList.remove('hidden');
    } else {
      dom.collectionHeaderDesc.textContent = '';
      dom.collectionHeaderDesc.classList.add('hidden');
    }

    const confirmingDelete = state.collectionDeleteConfirmId === col.id;
    dom.collectionHeaderActions.classList.toggle('hidden', confirmingDelete);
    dom.collectionDeleteConfirm.classList.toggle('hidden', !confirmingDelete);

    const detail = state.activeCollectionDetail?.id === col.id ? state.activeCollectionDetail : null;
    const getHighlightText = (hl) => {
      const text = typeof hl?.text === 'string' ? hl.text.trim() : '';
      if (text) return text;
      return typeof hl?.quote === 'string' ? hl.quote.trim() : '';
    };
    const rawHighlights = Array.isArray(detail?.highlights) ? detail.highlights : [];
    const highlights = rawHighlights.filter((hl) => Boolean(getHighlightText(hl)));
    const highlightCount = detail ? highlights.length : (col.highlightCount || 0);
    dom.collectionHighlightsLabel.textContent = `合集金句（${highlightCount} 条）`;
    dom.btnToggleCollectionHighlights.setAttribute('aria-expanded', String(state.collectionHighlightsExpanded));
    dom.collectionHighlightsPanel.classList.toggle('hidden', !state.collectionHighlightsExpanded);

    if (state.collectionHighlightsExpanded) {
      dom.collectionHighlightsPanel.textContent = '';
      if (highlights.length === 0) {
        const emptyP = document.createElement('p');
        emptyP.className = 'collection-highlights-empty';
        emptyP.textContent = '后续版本支持收听时一键摘录金句，收藏后将自动汇总于此。';
        dom.collectionHighlightsPanel.appendChild(emptyP);
      } else {
        const ul = document.createElement('ul');
        ul.className = 'collection-highlight-list';
        highlights.forEach((hl) => {
          const li = document.createElement('li');
          li.className = 'collection-highlight-item';
          li.textContent = getHighlightText(hl);
          ul.appendChild(li);
        });
        dom.collectionHighlightsPanel.appendChild(ul);
      }
    }
  }

  function renderCurrentPodcastCollectionTrigger() {
    if (!dom.btnAssignCurrentCollection) return;
    const podcast = state.currentPodcast;
    if (!podcast) {
      dom.btnAssignCurrentCollection.classList.add('hidden');
      return;
    }
    dom.btnAssignCurrentCollection.classList.remove('hidden');
    const col = findCollectionById(podcast.collectionId);
    if (col) {
      const color = normalizeCollectionColor(col.color);
      dom.btnAssignCurrentCollection.classList.add('is-assigned');
      dom.btnAssignCurrentCollection.dataset.collectionColor = color;
      dom.currentCollectionDot.className = `collection-dot is-${color}`;
      dom.currentCollectionLabel.textContent = col.name;
      dom.btnAssignCurrentCollection.title = `当前所属合集：${col.name}（点击切换）`;
    } else {
      dom.btnAssignCurrentCollection.classList.remove('is-assigned');
      dom.btnAssignCurrentCollection.removeAttribute('data-collection-color');
      dom.currentCollectionDot.className = 'collection-dot hidden';
      dom.currentCollectionLabel.textContent = '归入合集';
      dom.btnAssignCurrentCollection.title = '将该期播客归入合集';
    }
  }

  async function loadHistoryList() {
    try {
      const [podcastData] = await Promise.all([
        apiJson('/api/podcasts'),
        loadCollections({ render: false }),
      ]);
      state.historyItems = Array.isArray(podcastData?.items) ? podcastData.items : [];
      if (state.currentPodcast) {
        const matched = state.historyItems.find((item) => item.id === state.currentPodcast.id);
        if (matched) {
          state.currentPodcast.collectionId = matched.collectionId ?? null;
        }
      }
      renderCollectionFilterBar();
      renderCollectionHeaderCard();
      renderCurrentPodcastCollectionTrigger();
      renderHistoryList();
    } catch {
      dom.historyList.textContent = '';
      const p = document.createElement('p');
      p.className = 'history-empty';
      p.textContent = '未能获取本地历史列表，请稍后刷新重试。';
      dom.historyList.appendChild(p);
    }
  }

  function resolveVoiceShortName(providerId, voiceId) {
    if (!voiceId) return '';
    const provider = getCatalogProvider(providerId || 'edge');
    const found = provider?.availableVoices?.find((v) => v.id === voiceId);
    if (found?.name) {
      return String(found.name).replace(/[（(][^）)]*[）)]/g, '').trim() || found.name;
    }
    return voiceId;
  }

  function formatEpisodeVoiceSummary(podcast) {
    const providerId = podcast?.ttsProvider || '';
    const label = TTS_COMPACT_LABELS[providerId] || (providerId || 'Edge 免费');
    const mapping = podcast?.voiceMapping;
    if (!providerId && !mapping) {
      return { pill: 'Edge 免费', detail: '语音引擎：Edge 免费' };
    }
    const host = resolveVoiceShortName(providerId || 'edge', mapping?.阿泽);
    const guest = resolveVoiceShortName(providerId || 'edge', mapping?.小晓);
    const pair = host && guest ? `${host} × ${guest}` : (host || guest || '');
    const pill = pair ? `${label} · ${pair}` : label;
    const modelPart = podcast?.ttsModel ? ` (${podcast.ttsModel})` : '';
    return { pill, detail: `语音：${label}${modelPart}${pair ? ` · ${pair}` : ''}` };
  }

  function renderCurrentPodcastBadges(podcast) {
    if (!dom.currentPodcastBadges) return;
    dom.currentPodcastBadges.textContent = '';
    if (!podcast) {
      dom.currentPodcastBadges.classList.add('hidden');
      return;
    }
    const pills = [];
    const sourceLabel = SOURCE_TYPE_LABELS[podcast.sourceType];
    if (sourceLabel) pills.push({ text: sourceLabel });
    const styleLabel = PODCAST_STYLE_LABELS[podcast.podcastStyle];
    if (styleLabel) pills.push({ text: styleLabel });
    const voiceInfo = formatEpisodeVoiceSummary(podcast);
    if (voiceInfo?.pill) pills.push({ text: voiceInfo.pill, title: voiceInfo.detail });

    pills.forEach((p) => {
      const span = document.createElement('span');
      span.className = 'meta-pill';
      span.textContent = p.text;
      if (p.title) span.title = p.title;
      dom.currentPodcastBadges.appendChild(span);
    });
    dom.currentPodcastBadges.classList.toggle('hidden', pills.length === 0);
  }

  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    });
    children.forEach((child) => {
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else if (child) node.appendChild(child);
    });
    return node;
  }

  function loadSampleDraft(sampleKey) {
    const sample = SAMPLES[sampleKey];
    if (!sample) return;
    switchTab('text');
    dom.inputTitle.value = sample.title;
    dom.inputText.value = sample.content;
    updateTextCounter();
    confirmTextDraft();
  }

  function createWelcomeArtSvg() {
    const bars = [14, 26, 18, 40, 52, 30, 20, 44, 56, 34, 22, 46, 38, 26, 50, 32, 18];
    const barNodes = bars.map((h, i) => svgEl('rect', {
      class: 'wl-bar',
      style: `--d:${(i * 90) % 700}ms;--s:${(0.35 + (h / 56) * 0.65).toFixed(2)}`,
      x: 82 + i * 12,
      y: 212 - h / 2,
      width: 6,
      height: h,
      rx: 3,
      fill: i < 8 ? '#1C5A73' : '#B03E24',
    }));

    return svgEl('svg', {
      class: 'wl-art wl-art-geo',
      viewBox: '0 0 360 240',
      'aria-hidden': 'true',
    }, [
      svgEl('circle', { cx: 180, cy: 112, r: 104, fill: '#ECE7DC' }),
      svgEl('circle', { cx: 292, cy: 40, r: 9, fill: '#B03E24', opacity: '.85' }),
      svgEl('circle', { cx: 62, cy: 168, r: 6, fill: '#1C5A73', opacity: '.85' }),
      svgEl('rect', {
        x: 98, y: 36, width: 164, height: 132, rx: 16,
        fill: '#FDFCF9', stroke: 'rgba(26,25,22,.1)', transform: 'rotate(-7 180 102)',
      }),
      svgEl('g', { fill: '#E3DDD0', transform: 'rotate(-7 180 102)' }, [
        svgEl('rect', { x: 118, y: 56, width: 82, height: 7, rx: 3.5 }),
        svgEl('rect', { x: 118, y: 72, width: 120, height: 7, rx: 3.5 }),
        svgEl('rect', { x: 118, y: 88, width: 96, height: 7, rx: 3.5 }),
      ]),
      svgEl('g', { class: 'wl-float wl-float-1' }, [
        svgEl('circle', { cx: 138, cy: 122, r: 46, fill: '#1C5A73' }),
        svgEl('text', {
          x: 138, y: 137, 'text-anchor': 'middle', 'font-size': 40, 'font-weight': 700,
          fill: '#fff', 'font-family': 'Songti SC, Noto Serif SC, Noto Serif CJK SC, serif',
        }, ['泽']),
      ]),
      svgEl('g', { class: 'wl-float wl-float-2' }, [
        svgEl('circle', { cx: 224, cy: 122, r: 46, fill: '#B03E24', stroke: '#FDFCF9', 'stroke-width': 4 }),
        svgEl('text', {
          x: 224, y: 137, 'text-anchor': 'middle', 'font-size': 40, 'font-weight': 700,
          fill: '#fff', 'font-family': 'Songti SC, Noto Serif SC, Noto Serif CJK SC, serif',
        }, ['晓']),
      ]),
      ...barNodes,
    ]);
  }

  function createWelcomeEmptyElement() {
    const empty = document.createElement('div');
    empty.className = 'subtitles-empty is-welcome';

    const title = document.createElement('h2');
    title.className = 'wl-title';
    title.textContent = '粘贴一篇文章，生成你的第一期';

    const sub = document.createElement('p');
    sub.className = 'wl-sub';
    sub.append('几分钟，在本机变成');
    const host = document.createElement('b');
    host.className = 'wl-host';
    host.textContent = '阿泽';
    const guest = document.createElement('b');
    guest.className = 'wl-guest';
    guest.textContent = '小晓';
    sub.append(host, ' × ', guest, '的双人对话播客');

    const steps = document.createElement('ol');
    steps.className = 'wl-steps';
    ['粘贴链接或正文', '选择对话风格', '生成并收听'].forEach((label, idx) => {
      const li = document.createElement('li');
      const num = document.createElement('i');
      num.textContent = String(idx + 1);
      li.append(num, label);
      steps.appendChild(li);
    });

    const samplesHead = document.createElement('div');
    samplesHead.className = 'wl-samples-head';
    samplesHead.textContent = '或者先试试内置示例';

    const samplesGrid = document.createElement('div');
    samplesGrid.className = 'wl-samples';
    WELCOME_SAMPLE_META.forEach((item) => {
      if (!SAMPLES[item.key]) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wl-sample';
      btn.dataset.sample = item.key;

      const tag = document.createElement('span');
      tag.className = 'wl-sample-tag';
      tag.textContent = item.tag;

      const name = document.createElement('span');
      name.className = 'wl-sample-name';
      name.textContent = item.label;

      const go = document.createElement('span');
      go.className = 'wl-sample-go';
      go.setAttribute('aria-hidden', 'true');
      go.textContent = '→';

      btn.append(tag, name, go);
      btn.addEventListener('click', () => loadSampleDraft(item.key));
      samplesGrid.appendChild(btn);
    });

    empty.append(createWelcomeArtSvg(), title, sub, steps, samplesHead, samplesGrid);
    return empty;
  }

  function resetPlayerToEmptyState() {
    exitScriptEditMode({ rerender: false });
    cancelScheduledSubtitleScroll();
    state.currentPodcast = null;
    state.lastSpeakerRole = 'none';
    state.lastRenderedTimeText = '00:00';
    state.lastRenderedMiniTimeText = '00:00 / 00:00';
    state.lastRenderedSeekPct = -1;
    state.userScrollingSubtitlesUntil = 0;
    window.InputSource.resetPlaybackHighlight(state.input);
    state.audioEngine?.loadPodcast?.(null);
    dom.mainAudio.pause();
    dom.mainAudio.removeAttribute('src');
    dom.mainAudio.load();

    dom.currentPodcastTitle.textContent = '导入一篇文章，或从左侧选择一期播客开始收听';
    state.currentMetaBaseText = '尚无已选播客';
    dom.currentPodcastMeta.textContent = state.currentMetaBaseText;
    renderCurrentPodcastBadges(null);
    renderCurrentPodcastCollectionTrigger();
    dom.currentPodcastSummary.textContent = '';
    dom.currentPodcastSummary.classList.add('hidden');

    dom.currentTime.textContent = '00:00';
    dom.totalDuration.textContent = '00:00';
    setSeekProgress(0);
    dom.seekSlider.disabled = true;
    dom.btnPlayPause.disabled = true;
    dom.btnRewind10.disabled = true;
    dom.btnForward10.disabled = true;
    if (dom.btnBgmMode) dom.btnBgmMode.disabled = true;
    dom.btnSpeed.disabled = true;
    dom.btnCopyMarkdown.disabled = true;
    updateScriptEditAvailability();
    dom.btnDownloadAudio.removeAttribute('href');
    dom.btnDownloadAudio.classList.add('is-disabled');
    dom.btnDownloadAudio.setAttribute('aria-disabled', 'true');

    setDeckPlaying(false);
    dom.playerDeck.dataset.speaker = 'none';
    dom.miniTitle.textContent = '拾声集双人播客';
    dom.miniTime.textContent = '00:00 / 00:00';
    if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = 'none';
    updateMobileMiniVisibility();

    dom.subtitlesList.textContent = '';
    state.subtitleElements = [];
    dom.subtitlesList.appendChild(createWelcomeEmptyElement());
  }

  function createDeleteIconSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '3 6 5 6 21 6');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2');
    svg.append(poly, path);
    return svg;
  }

  async function handleDeletePodcast(podcastId) {
    if (!podcastId || state.deletingPodcastId === podcastId) return;
    state.deletingPodcastId = podcastId;
    renderHistoryList();
    try {
      await apiJson(`/api/podcasts/${encodeURIComponent(podcastId)}`, { method: 'DELETE' });
      state.deletedPodcastIds.add(podcastId);
      state.historySelectSeq += 1;
      const deletedActive = state.currentPodcast?.id === podcastId;
      state.historyItems = state.historyItems.filter((item) => item.id !== podcastId);
      state.pendingDeleteId = null;
      state.deletingPodcastId = null;
      if (deletedActive) resetPlayerToEmptyState();
      if (state.activeCollectionDetail) {
        const remainingHighlights = Array.isArray(state.activeCollectionDetail.highlights)
          ? state.activeCollectionDetail.highlights.filter((hl) => hl?.podcastId !== podcastId)
          : [];
        const remainingPodcasts = Array.isArray(state.activeCollectionDetail.podcasts)
          ? state.activeCollectionDetail.podcasts.filter((p) => p?.id !== podcastId)
          : [];
        state.activeCollectionDetail = {
          ...state.activeCollectionDetail,
          podcasts: remainingPodcasts,
          podcastCount: remainingPodcasts.length,
          highlights: remainingHighlights,
          highlightCount: remainingHighlights.length,
        };
      }
      applyCollectionCountsFromLocalHistory();
      renderCollectionFilterBar();
      renderCollectionHeaderCard();
      renderHistoryList();
      showToast('已删除该期本地播客');
      await loadCollections();
      if (state.selectedCollectionFilter !== 'all' && state.selectedCollectionFilter !== 'unassigned') {
        loadCollectionDetail(state.selectedCollectionFilter);
      }
      if (deletedActive && state.historyItems.length > 0) {
        await handleSelectHistory(state.historyItems[0].id);
      }
    } catch (err) {
      showToast(err.message || '删除播客失败');
      state.pendingDeleteId = null;
      renderHistoryList();
    } finally {
      state.deletingPodcastId = null;
    }
  }

  function updateHistoryActiveSelection() {
    const activeId = state.currentPodcast?.id || '';
    const rows = dom.historyList.querySelectorAll('.history-row');
    if (!rows.length && state.historyItems.length > 0) {
      renderHistoryList();
      return;
    }
    let matched = false;
    rows.forEach((row) => {
      const isCurrent = Boolean(activeId && row.dataset.podcastId === activeId);
      if (isCurrent) matched = true;
      row.classList.toggle('is-active', isCurrent);
      const itemBtn = row.querySelector('.history-item');
      if (itemBtn) {
        if (isCurrent) itemBtn.setAttribute('aria-current', 'true');
        else itemBtn.removeAttribute('aria-current');
      }
    });
    if (activeId && !matched && state.historyItems.some((item) => item.id === activeId)) {
      renderHistoryList();
    }
  }

  function getFilteredHistoryItems() {
    const items = state.historyItems;
    const filter = state.selectedCollectionFilter;
    if (filter === 'all') return items;
    const validIds = new Set(state.collections.map((c) => c.id));
    if (filter === 'unassigned') {
      return items.filter((item) => !item.collectionId || !validIds.has(item.collectionId));
    }
    return items.filter((item) => item.collectionId === filter);
  }

  function renderHistoryList() {
    const items = state.historyItems;
    const filtered = getFilteredHistoryItems();
    const isFiltered = state.selectedCollectionFilter !== 'all';
    dom.historyCount.textContent = isFiltered ? `${filtered.length} / ${items.length} 集` : `${items.length} 集`;
    dom.historyList.textContent = '';

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      if (items.length === 0) {
        empty.textContent = '还没有已完成的本地播客，导入第一篇文章试试看。';
      } else if (state.selectedCollectionFilter === 'unassigned') {
        empty.textContent = '当前所有播客均已归入合集，没有未归类的单集。';
      } else {
        empty.textContent = '该合集下暂无播客，可从「全部」或右侧播放器将播客归入此合集。';
      }
      dom.historyList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.dataset.podcastId = item.id;
      const isCurrent = state.currentPodcast?.id === item.id;
      if (isCurrent) row.classList.add('is-active');

      const cardBody = document.createElement('div');
      cardBody.className = 'history-card-body';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item';
      btn.dataset.action = 'select';
      btn.dataset.podcastId = item.id;
      if (isCurrent) btn.setAttribute('aria-current', 'true');

      const title = document.createElement('span');
      title.className = 'history-item-title';
      title.textContent = item.podcastTitle || '未命名播客';

      const meta = document.createElement('span');
      meta.className = 'history-item-meta';
      const sourceLabel = SOURCE_TYPE_LABELS[item.sourceType];
      if (sourceLabel) {
        const tag = document.createElement('span');
        tag.className = 'history-source-tag';
        tag.textContent = sourceLabel;
        meta.appendChild(tag);
      }
      const styleLabel = PODCAST_STYLE_LABELS[item.podcastStyle];
      if (styleLabel) {
        const styleTag = document.createElement('span');
        styleTag.className = `history-style-tag${item.podcastStyle === 'debate' ? ' is-debate' : ''}`;
        styleTag.textContent = styleLabel;
        meta.appendChild(styleTag);
      }
      const parts = [
        `${item.sentenceCount || 0} 句`,
        formatTime(item.totalDuration || 0),
        formatDateLabel(item.createAt),
      ].filter(Boolean);
      const textSpan = document.createElement('span');
      textSpan.textContent = parts.join(' · ');
      meta.appendChild(textSpan);

      btn.append(title, meta);

      const chipRow = document.createElement('div');
      chipRow.className = 'history-card-collection-row';
      const col = findCollectionById(item.collectionId);
      const colChip = document.createElement('button');
      colChip.type = 'button';
      colChip.className = `history-collection-chip${col ? '' : ' is-unassigned'}`;
      colChip.dataset.action = 'assign-collection';
      colChip.dataset.podcastId = item.id;
      if (col) {
        const color = normalizeCollectionColor(col.color);
        colChip.dataset.collectionColor = color;
        colChip.title = `合集：${col.name}（点击切换或移出）`;
        const dot = document.createElement('span');
        dot.className = `collection-dot is-${color}`;
        dot.setAttribute('aria-hidden', 'true');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'history-collection-chip-name';
        nameSpan.textContent = col.name;
        colChip.append(dot, nameSpan);
      } else {
        colChip.title = '将该播客归入合集';
        colChip.textContent = '+ 归入合集';
      }
      chipRow.appendChild(colChip);

      cardBody.append(btn, chipRow);
      row.appendChild(cardBody);

      if (state.pendingDeleteId === item.id) {
        const confirmGroup = document.createElement('div');
        confirmGroup.className = 'history-delete-confirm';
        const deletingNow = state.deletingPodcastId === item.id;

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn btn-danger-ghost btn-sm';
        confirmBtn.textContent = deletingNow ? '删除中…' : '删除';
        confirmBtn.dataset.action = 'confirm-delete';
        confirmBtn.dataset.podcastId = item.id;
        confirmBtn.disabled = deletingNow;

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-ghost btn-sm';
        cancelBtn.textContent = '取消';
        cancelBtn.dataset.action = 'cancel-delete';
        cancelBtn.dataset.podcastId = item.id;
        cancelBtn.disabled = deletingNow;

        confirmGroup.append(confirmBtn, cancelBtn);
        row.appendChild(confirmGroup);
      } else {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'history-delete-btn';
        delBtn.dataset.action = 'request-delete';
        delBtn.dataset.podcastId = item.id;
        delBtn.title = `删除《${item.podcastTitle || '未命名播客'}》`;
        delBtn.setAttribute('aria-label', `删除播客 ${item.podcastTitle || '未命名播客'}`);
        delBtn.appendChild(createDeleteIconSvg());
        row.appendChild(delBtn);
      }

      fragment.appendChild(row);
    });
    dom.historyList.appendChild(fragment);
  }

  async function handleSelectHistory(podcastId) {
    const reqSeq = ++state.historySelectSeq;
    try {
      const podcast = await apiJson(`/api/podcasts/${encodeURIComponent(podcastId)}`);
      if (reqSeq !== state.historySelectSeq || state.deletedPodcastIds.has(podcastId)) return;
      loadPodcast(podcast, { autoplay: false });
    } catch (err) {
      if (reqSeq !== state.historySelectSeq || state.deletedPodcastIds.has(podcastId)) return;
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
    exitScriptEditMode({ rerender: false });
    cancelScheduledSubtitleScroll();
    state.currentPodcast = podcast;
    state.lastSpeakerRole = 'none';
    state.lastRenderedTimeText = '00:00';
    state.lastRenderedSeekPct = -1;
    state.userScrollingSubtitlesUntil = 0;
    window.InputSource.resetPlaybackHighlight(state.input);

    const sentences = Array.isArray(podcast.sentences) ? podcast.sentences : [];
    dom.currentPodcastTitle.textContent = podcast.podcastTitle || '拾声集双人播客';
    state.currentMetaBaseText = `共 ${sentences.length} 句对话 · 全长 ${formatTime(podcast.totalDuration || 0)}`;
    dom.currentPodcastMeta.textContent = state.currentMetaBaseText;
    renderCurrentPodcastBadges(podcast);
    renderCurrentPodcastCollectionTrigger();

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

    const totalText = formatTime(podcast.totalDuration || 0);
    dom.currentTime.textContent = '00:00';
    dom.totalDuration.textContent = totalText;
    setSeekProgress(0);

    dom.seekSlider.disabled = false;
    dom.btnPlayPause.disabled = false;
    dom.btnRewind10.disabled = false;
    dom.btnForward10.disabled = false;
    if (dom.btnBgmMode) dom.btnBgmMode.disabled = false;
    dom.btnSpeed.disabled = false;
    dom.btnCopyMarkdown.disabled = sentences.length === 0;
    updateScriptEditAvailability();

    dom.btnDownloadAudio.href = podcast.fullAudioUrl;
    dom.btnDownloadAudio.download = `${podcast.podcastTitle || 'ai-podcast'}.mp3`;
    dom.btnDownloadAudio.classList.remove('is-disabled');
    dom.btnDownloadAudio.removeAttribute('aria-disabled');

    setDeckPlaying(false);
    dom.playerDeck.dataset.speaker = 'none';
    dom.miniTitle.textContent = podcast.podcastTitle || '拾声集双人播客';
    state.lastRenderedMiniTimeText = `00:00 / ${totalText}`;
    dom.miniTime.textContent = state.lastRenderedMiniTimeText;
    if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = 'none';

    state.audioEngine?.loadPodcast(podcast);
    updateBgmButton();

    renderSubtitles(sentences);
    updateHistoryActiveSelection();
    updateMobileMiniVisibility();

    if (autoplay) {
      if (state.audioEngine) {
        state.audioEngine.requestPlay().catch(() => {});
      } else {
        dom.mainAudio.play().catch(() => {});
      }
    }
  }

  function updateScriptEditAvailability() {
    const hasSentences = Boolean(state.currentPodcast?.sentences?.length);
    const busy = hasActiveRunningTask() || state.scriptEdit.submitting;
    if (dom.btnEditScript) {
      dom.btnEditScript.disabled = !hasSentences || busy;
      const label = dom.btnEditScript.querySelector('span');
      if (label) label.textContent = state.scriptEdit.active ? '微调中' : '微调剧本';
    }
    if (state.scriptEdit.active) {
      updateScriptEditorToolbar();
    }
  }

  function normalizeEditableLine(sentence, origIndex) {
    return {
      origIndex,
      speaker: displaySpeakerName(sentence.speaker),
      text: String(sentence.text || ''),
      emotion: typeof sentence.emotion === 'string' ? sentence.emotion.trim() : '',
    };
  }

  function isDraftLineModified(line, originalList) {
    if (line.origIndex < 0 || line.origIndex >= originalList.length) return true;
    const orig = originalList[line.origIndex];
    return line.speaker !== orig.speaker ||
      line.text.trim() !== orig.text.trim() ||
      line.emotion !== orig.emotion;
  }

  function computeScriptEditStats() {
    const { original, draft } = state.scriptEdit;
    const origSignatures = new Map();
    original.forEach((line) => {
      const sig = `${line.speaker}\0${line.text.trim()}\0${line.emotion}`;
      origSignatures.set(sig, (origSignatures.get(sig) || 0) + 1);
    });

    let changedCount = 0;
    let reusedCount = 0;
    let emptyCount = 0;
    let overlongCount = 0;
    let structureChanged = draft.length !== original.length;

    draft.forEach((line, idx) => {
      const trimmed = line.text.trim();
      if (!trimmed) emptyCount += 1;
      else if (trimmed.length > MAX_LINE_TEXT_LENGTH) overlongCount += 1;

      const sig = `${line.speaker}\0${trimmed}\0${line.emotion}`;
      const matched = (origSignatures.get(sig) || 0) > 0;
      if (matched) {
        reusedCount += 1;
        origSignatures.set(sig, origSignatures.get(sig) - 1);
      } else {
        changedCount += 1;
      }

      if (!structureChanged) {
        const atSameIdx = original[idx];
        if (!atSameIdx || atSameIdx.speaker !== line.speaker ||
            atSameIdx.text.trim() !== trimmed || atSameIdx.emotion !== line.emotion) {
          structureChanged = true;
        }
      }
    });

    const deletedCount = Math.max(0, original.length - draft.length);
    const hasChanges = structureChanged || changedCount > 0 || deletedCount > 0;
    return {
      totalCount: draft.length,
      changedCount,
      reusedCount,
      deletedCount,
      emptyCount,
      overlongCount,
      hasChanges,
    };
  }

  function updateScriptEditorToolbar() {
    if (!dom.scriptEditorBar || !state.scriptEdit.active) return;
    const stats = computeScriptEditStats();
    const busy = hasActiveRunningTask() || state.scriptEdit.submitting;

    dom.scriptEditorStatus.className = 'script-editor-status';
    if (stats.emptyCount > 0) {
      dom.scriptEditorStatus.classList.add('is-error');
      dom.scriptEditorStatus.textContent = `有 ${stats.emptyCount} 句台词为空，请补充或删除后再合成`;
      dom.scriptEditorCacheHint?.classList.add('hidden');
    } else if (stats.overlongCount > 0) {
      dom.scriptEditorStatus.classList.add('is-error');
      dom.scriptEditorStatus.textContent = `有 ${stats.overlongCount} 句超过 ${MAX_LINE_TEXT_LENGTH} 字上限`;
      dom.scriptEditorCacheHint?.classList.add('hidden');
    } else if (!stats.hasChanges) {
      dom.scriptEditorStatus.textContent = '点击任意句子修改台词或切换说话人';
      dom.scriptEditorCacheHint?.classList.add('hidden');
    } else {
      dom.scriptEditorStatus.classList.add('is-dirty');
      const parts = [];
      if (stats.changedCount > 0) parts.push(`已改动 ${stats.changedCount} 句`);
      if (stats.deletedCount > 0) parts.push(`删减 ${stats.deletedCount} 句`);
      dom.scriptEditorStatus.textContent = parts.length ? parts.join(' · ') : '已调整台词顺序';
      if (dom.scriptEditorCacheHint) {
        if (stats.reusedCount > 0) {
          dom.scriptEditorCacheHint.textContent = `预计 ${stats.reusedCount} 句秒级复用缓存`;
          dom.scriptEditorCacheHint.classList.remove('hidden');
        } else {
          dom.scriptEditorCacheHint.classList.add('hidden');
        }
      }
    }

    if (dom.btnResetScriptEdits) {
      dom.btnResetScriptEdits.disabled = !stats.hasChanges || busy;
    }
    if (dom.btnCancelScriptEdit) {
      dom.btnCancelScriptEdit.disabled = state.scriptEdit.submitting;
    }
    if (dom.btnResynthesizeScript) {
      dom.btnResynthesizeScript.disabled = !stats.hasChanges || stats.emptyCount > 0 || stats.overlongCount > 0 || stats.totalCount === 0 || busy;
      dom.btnResynthesizeScript.textContent = state.scriptEdit.submitting ? '正在提交…' : '重新合成';
    }
  }

  function autoSizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(58, el.scrollHeight + 2)}px`;
  }

  function syncScriptEditorRowState(rowEl, draftIndex) {
    if (!rowEl) return;
    const line = state.scriptEdit.draft[draftIndex];
    if (!line) return;
    const isHost = line.speaker === '阿泽';
    const modified = isDraftLineModified(line, state.scriptEdit.original);
    const trimmed = line.text.trim();
    const invalid = !trimmed || trimmed.length > MAX_LINE_TEXT_LENGTH;

    rowEl.classList.toggle('is-host', isHost);
    rowEl.classList.toggle('is-guest', !isHost);
    rowEl.classList.toggle('is-modified', modified && !invalid);
    rowEl.classList.toggle('is-invalid', invalid);

    const speakerBtn = rowEl.querySelector('[data-edit-action="toggle-speaker"]');
    if (speakerBtn) {
      speakerBtn.textContent = `${line.speaker} ⇄`;
      speakerBtn.setAttribute('aria-label', `第 ${draftIndex + 1} 句说话人：${line.speaker}，点击切换`);
    }
    const modTag = rowEl.querySelector('.subtitle-modified-tag');
    if (modTag) modTag.classList.toggle('hidden', !modified);
    const restoreBtn = rowEl.querySelector('[data-edit-action="restore-line"]');
    if (restoreBtn) restoreBtn.classList.toggle('hidden', !modified);
  }

  function renderScriptEditorList() {
    cancelScheduledSubtitleScroll();
    dom.subtitlesList.classList.add('is-editing');
    dom.subtitlesList.textContent = '';
    state.subtitleElements = [];

    const draft = state.scriptEdit.draft;
    const canDelete = draft.length > 1;
    const fragment = document.createDocumentFragment();
    const textareas = [];

    draft.forEach((line, idx) => {
      const isHost = line.speaker === '阿泽';
      const modified = isDraftLineModified(line, state.scriptEdit.original);
      const trimmed = line.text.trim();
      const invalid = !trimmed || trimmed.length > MAX_LINE_TEXT_LENGTH;

      const row = document.createElement('div');
      row.className = `subtitle-item ${isHost ? 'is-host' : 'is-guest'}${modified && !invalid ? ' is-modified' : ''}${invalid ? ' is-invalid' : ''}`;
      row.dataset.editIndex = String(idx);

      const meta = document.createElement('div');
      meta.className = 'subtitle-meta';

      const speakerBtn = document.createElement('button');
      speakerBtn.type = 'button';
      speakerBtn.className = 'subtitle-speaker-toggle';
      speakerBtn.dataset.editAction = 'toggle-speaker';
      speakerBtn.dataset.editIndex = String(idx);
      speakerBtn.textContent = `${line.speaker} ⇄`;
      speakerBtn.title = '点击切换说话人（阿泽 ⇄ 小晓）';
      speakerBtn.setAttribute('aria-label', `第 ${idx + 1} 句说话人：${line.speaker}，点击切换`);
      meta.appendChild(speakerBtn);

      if (line.emotion) {
        const emotion = document.createElement('span');
        emotion.className = 'subtitle-emotion';
        emotion.textContent = `· ${line.emotion}`;
        meta.appendChild(emotion);
      }

      const modTag = document.createElement('span');
      modTag.className = `subtitle-modified-tag${modified ? '' : ' hidden'}`;
      modTag.textContent = '已改动';
      meta.appendChild(modTag);

      const rowActions = document.createElement('div');
      rowActions.className = 'subtitle-row-actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = `subtitle-mini-action${modified ? '' : ' hidden'}`;
      restoreBtn.dataset.editAction = 'restore-line';
      restoreBtn.dataset.editIndex = String(idx);
      restoreBtn.textContent = '还原';
      rowActions.appendChild(restoreBtn);

      if (canDelete) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'subtitle-mini-action is-danger';
        delBtn.dataset.editAction = 'delete-line';
        delBtn.dataset.editIndex = String(idx);
        delBtn.textContent = '删除';
        rowActions.appendChild(delBtn);
      }

      const idxLabel = document.createElement('span');
      idxLabel.className = 'subtitle-time';
      idxLabel.textContent = `#${idx + 1}`;
      rowActions.appendChild(idxLabel);

      meta.appendChild(rowActions);

      const textarea = document.createElement('textarea');
      textarea.className = 'subtitle-edit-input';
      textarea.dataset.editIndex = String(idx);
      textarea.rows = 2;
      textarea.maxLength = MAX_LINE_TEXT_LENGTH;
      textarea.value = line.text;
      textarea.setAttribute('aria-label', `编辑第 ${idx + 1} 句台词`);

      row.append(meta, textarea);
      fragment.appendChild(row);
      textareas.push(textarea);
    });

    dom.subtitlesList.appendChild(fragment);
    window.requestAnimationFrame(() => {
      textareas.forEach(autoSizeTextarea);
    });
    updateScriptEditorToolbar();
  }

  function enterScriptEditMode() {
    const podcast = state.currentPodcast;
    if (!podcast?.id || !Array.isArray(podcast.sentences) || !podcast.sentences.length) return;
    if (hasActiveRunningTask()) {
      showToast('当前已有任务正在生成，请等待完成或先取消');
      return;
    }
    if (state.scriptEdit.active && state.scriptEdit.podcastId === podcast.id) return;

    const original = podcast.sentences.map((s, idx) => normalizeEditableLine(s, idx));
    state.scriptEdit = {
      active: true,
      podcastId: podcast.id,
      baseVersion: typeof podcast.audioVersion === 'string' ? podcast.audioVersion : null,
      original,
      draft: original.map((item) => ({ ...item })),
      submitting: false,
    };

    dom.scriptEditorBar?.classList.remove('hidden');
    renderScriptEditorList();
    updateScriptEditAvailability();
  }

  function exitScriptEditMode({ rerender = true } = {}) {
    const wasActive = state.scriptEdit.active;
    state.scriptEdit = {
      active: false,
      podcastId: null,
      baseVersion: null,
      original: [],
      draft: [],
      submitting: false,
    };
    dom.scriptEditorBar?.classList.add('hidden');
    dom.subtitlesList?.classList.remove('is-editing');
    if (wasActive && rerender && state.currentPodcast) {
      window.InputSource.resetPlaybackHighlight(state.input);
      renderSubtitles(Array.isArray(state.currentPodcast.sentences) ? state.currentPodcast.sentences : []);
      if (dom.mainAudio.currentTime > 0) {
        syncHighlightToTime(dom.mainAudio.currentTime);
      }
    }
    updateScriptEditAvailability();
  }

  function resetAllScriptEdits() {
    if (!state.scriptEdit.active) return;
    state.scriptEdit.draft = state.scriptEdit.original.map((item) => ({ ...item }));
    renderScriptEditorList();
    showToast('已还原全部未保存修改');
  }

  function buildResynthesizeTtsPayload(podcast) {
    const providerId = ['minimax', 'volcengine', 'edge'].includes(podcast?.ttsProvider)
      ? podcast.ttsProvider
      : resolveEffectiveTtsProviderId();
    const payload = buildTtsPayload(state.ttsConfig, providerId);
    if (podcast?.ttsProvider === providerId) {
      if (podcast.speechSpeed === 'relaxed' || podcast.speechSpeed === 'standard') {
        payload.speechSpeed = podcast.speechSpeed;
      }
      if (podcast.ttsModel && providerId !== 'edge') {
        payload.model = podcast.ttsModel;
        if (providerId === 'volcengine') payload.resourceId = podcast.ttsModel;
      }
      if (podcast.voiceMapping && typeof podcast.voiceMapping === 'object') {
        const preserved = {};
        if (podcast.voiceMapping.阿泽) preserved.阿泽 = podcast.voiceMapping.阿泽;
        if (podcast.voiceMapping.小晓) preserved.小晓 = podcast.voiceMapping.小晓;
        if (preserved.阿泽 && preserved.小晓) {
          payload.voiceMapping = preserved;
        }
      }
    }
    return payload;
  }

  async function handleResynthesizeScript() {
    if (!state.scriptEdit.active || state.scriptEdit.submitting) return;
    const podcast = state.currentPodcast;
    if (!podcast?.id || state.scriptEdit.podcastId !== podcast.id) return;
    if (hasActiveRunningTask()) {
      showToast('当前已有任务正在生成，请等待完成或先取消');
      return;
    }

    const stats = computeScriptEditStats();
    if (!stats.hasChanges || stats.emptyCount > 0 || stats.overlongCount > 0 || stats.totalCount === 0) {
      updateScriptEditorToolbar();
      return;
    }

    const dialogue = state.scriptEdit.draft.map((line) => ({
      speaker: line.speaker,
      text: line.text.trim(),
      ...(line.emotion ? { emotion: line.emotion } : {}),
    }));

    state.scriptEdit.submitting = true;
    updateScriptEditAvailability();

    try {
      const task = await apiJson(`/api/podcasts/${encodeURIComponent(podcast.id)}/resynthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVersion: state.scriptEdit.baseVersion,
          dialogue,
          tts: buildResynthesizeTtsPayload(podcast),
        }),
      });

      exitScriptEditMode({ rerender: true });
      state.ttsSpeedOverrideTaskId = null;
      state.ttsSettingsOverrideTaskId = null;
      setActiveTask(task);
      if (window.innerWidth <= 900) {
        dom.progressSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      startPolling();
      showToast(stats.reusedCount > 0
        ? `已开始微调重合成（预计 ${stats.reusedCount} 句将复用缓存）`
        : '已开始重新合成播客音频');
    } catch (err) {
      state.scriptEdit.submitting = false;
      updateScriptEditAvailability();
      handleCredentialOrTaskError(err);
      if (err.status === 409 && err.code === 'PODCAST_VERSION_CONFLICT') {
        handleSelectHistory(podcast.id);
      }
    }
  }

  function cancelScheduledSubtitleScroll() {
    if (state.subtitleScrollRaf) {
      window.cancelAnimationFrame(state.subtitleScrollRaf);
      state.subtitleScrollRaf = 0;
    }
  }

  function scrollActiveSubtitleIntoView(activeEl, { force = false } = {}) {
    if (!activeEl) return;
    cancelScheduledSubtitleScroll();
    state.subtitleScrollRaf = window.requestAnimationFrame(() => {
      state.subtitleScrollRaf = 0;
      if (!activeEl.isConnected) return;
      if (!force && Date.now() < state.userScrollingSubtitlesUntil) return;

      const container = dom.subtitlesList;
      if (container && container.scrollHeight > container.clientHeight + 2) {
        const containerRect = container.getBoundingClientRect();
        const itemRect = activeEl.getBoundingClientRect();
        const topMargin = 16;
        const bottomMargin = 24;
        const isAbove = itemRect.top < containerRect.top + topMargin;
        const isBelow = itemRect.bottom > containerRect.bottom - bottomMargin;
        if (!isAbove && !isBelow) return;

        const targetTop = Math.max(
          0,
          container.scrollTop + (itemRect.top - containerRect.top) - Math.round((container.clientHeight - itemRect.height) * 0.34)
        );
        container.scrollTo({ top: targetTop, behavior: 'smooth' });
        return;
      }

      const rect = activeEl.getBoundingClientRect();
      const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      if (force || rect.top < 110 || rect.bottom > viewHeight - 96) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function jumpToSubtitleIndex(idx) {
    const sentences = state.currentPodcast?.sentences;
    if (!dom.mainAudio.src || !Array.isArray(sentences)) return;
    const s = sentences[idx];
    if (!s) return;
    state.userScrollingSubtitlesUntil = 0;
    const target = Math.max(0, Number(s.startTime) || 0);
    syncHighlightToTime(target, { forceScroll: true });
    if (state.audioEngine) {
      state.audioEngine.seekAndPlay(target).catch(() => {});
    } else {
      dom.mainAudio.currentTime = target;
      if (dom.mainAudio.paused) {
        dom.mainAudio.play().catch(() => {});
      }
    }
  }

  function renderSubtitles(sentences) {
    cancelScheduledSubtitleScroll();
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

    const fragment = document.createDocumentFragment();
    const elements = new Array(sentences.length);
    for (let idx = 0; idx < sentences.length; idx += 1) {
      const s = sentences[idx];
      const isHost = isHostSpeaker(s.speaker);
      const speakerLabel = displaySpeakerName(s.speaker);
      const startLabel = formatTime(s.startTime);

      const row = document.createElement('div');
      row.className = `subtitle-item ${isHost ? 'is-host' : 'is-guest'}`;
      row.dataset.index = String(idx);
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `${speakerLabel} ${startLabel}：${s.text}`);

      const meta = document.createElement('div');
      meta.className = 'subtitle-meta';

      const speaker = document.createElement('span');
      speaker.className = 'subtitle-speaker';
      speaker.textContent = speakerLabel;
      meta.appendChild(speaker);

      if (s.emotion) {
        const emotion = document.createElement('span');
        emotion.className = 'subtitle-emotion';
        emotion.textContent = `· ${s.emotion}`;
        meta.appendChild(emotion);
      }

      const time = document.createElement('span');
      time.className = 'subtitle-time';
      time.textContent = startLabel;
      meta.appendChild(time);

      const text = document.createElement('p');
      text.className = 'subtitle-text';
      text.textContent = s.text;

      row.append(meta, text);
      fragment.appendChild(row);
      elements[idx] = row;
    }
    dom.subtitlesList.appendChild(fragment);
    state.subtitleElements = elements;
  }

  /** 兼容句间静音间隙：落入间隔时保持上一句高亮不闪烁，顺序快路径 + 二分查找 */
  function findActiveSentenceIndex(sentences, currentTime, hintIndex = -1) {
    const len = sentences.length;
    if (!len) return -1;
    if (hintIndex >= 0 && hintIndex < len) {
      const cur = sentences[hintIndex];
      const next = hintIndex + 1 < len ? sentences[hintIndex + 1] : null;
      if (currentTime >= cur.startTime && (!next || currentTime < next.startTime)) {
        return hintIndex;
      }
      if (next && currentTime >= next.startTime) {
        const afterNext = hintIndex + 2 < len ? sentences[hintIndex + 2] : null;
        if (!afterNext || currentTime < afterNext.startTime) {
          return hintIndex + 1;
        }
      }
    }
    if (currentTime < sentences[0].startTime) return -1;
    let lo = 0;
    let hi = len - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sentences[mid];
      if (currentTime >= s.startTime) {
        if (currentTime < s.endTime) return mid;
        candidate = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return candidate;
  }

  function syncHighlightToTime(curTime, { forceScroll = false } = {}) {
    const sentences = state.currentPodcast?.sentences;
    if (!sentences?.length) return;
    const prevIdx = state.input.activeSentenceIndex;
    const idx = findActiveSentenceIndex(sentences, curTime, prevIdx);
    if (idx === -1) return;

    const activeSentence = sentences[idx];
    const speakerRole = isHostSpeaker(activeSentence.speaker) ? 'host' : 'guest';
    if (speakerRole !== state.lastSpeakerRole) {
      state.lastSpeakerRole = speakerRole;
      dom.playerDeck.dataset.speaker = speakerRole;
      if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = speakerRole;
    }

    if (state.scriptEdit.active) return;

    if (idx !== prevIdx) {
      if (prevIdx >= 0 && state.subtitleElements[prevIdx]) {
        state.subtitleElements[prevIdx].classList.remove('is-active');
      }
      state.input.activeSentenceIndex = idx;
      const activeEl = state.subtitleElements[idx];
      if (activeEl) {
        activeEl.classList.add('is-active');
        scrollActiveSubtitleIntoView(activeEl, { force: forceScroll });
      }
    } else if (forceScroll && state.subtitleElements[idx]) {
      scrollActiveSubtitleIntoView(state.subtitleElements[idx], { force: true });
    }
  }

  function setSeekProgress(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    const rounded = Math.round(clamped * 10) / 10;
    if (rounded === state.lastRenderedSeekPct) return;
    state.lastRenderedSeekPct = rounded;
    dom.seekSlider.value = String(rounded);
    dom.seekSlider.style.setProperty('--seek-pct', `${rounded}%`);
    if (dom.miniProgressFill) dom.miniProgressFill.style.width = `${rounded}%`;
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
    state.userScrollingSubtitlesUntil = 0;
    syncHighlightToTime(target, { forceScroll: true });
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

  function scheduleMobileMiniVisibility() {
    if (!dom.mobileMiniPlayer || window.innerWidth > 900 || !state.currentPodcast) {
      dom.mobileMiniPlayer?.classList.add('hidden');
      return;
    }
    if (state.mobileMiniRaf) return;
    state.mobileMiniRaf = window.requestAnimationFrame(() => {
      state.mobileMiniRaf = 0;
      updateMobileMiniVisibility();
    });
  }

  async function handleCopyMarkdown() {
    const podcast = state.currentPodcast;
    if (!podcast || !Array.isArray(podcast.sentences) || !podcast.sentences.length) return;

    const lines = [];
    lines.push(`# ${podcast.podcastTitle || '拾声集双人播客'}`);
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

  const VERSIONED_BASE_PATH = /\/v\d+(?:alpha|beta)?(?:\/openai)?$/i;

  function normalizeBaseUrlForMatch(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  function normalizeEndpointForBinding(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password ||
          parsed.href.includes('?') || parsed.href.includes('#')) {
        return normalizeBaseUrlForMatch(raw);
      }
      const pathname = parsed.pathname.replace(/\/+$/, '');
      parsed.pathname = VERSIONED_BASE_PATH.test(pathname) ? pathname : `${pathname}/v1`;
      return parsed.href;
    } catch {
      return normalizeBaseUrlForMatch(raw);
    }
  }

  function isDoubaoArkBaseUrl(baseURL) {
    try {
      const host = new URL(String(baseURL || '').trim()).hostname.toLowerCase();
      return /(?:^|\.)(?:volces\.com|bytepluses\.com)$/.test(host) && /(?:^|\.)ark(?:\.|$)/.test(host);
    } catch {
      return false;
    }
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

      const targetBase = isVision
        ? (visionSnap.baseURL || llmSnap.baseURL)
        : llmSnap.baseURL;
      const isDoubao = isDoubaoArkBaseUrl(targetBase);

      if (!data.supported) {
        const fallbackMessage = isDoubao
          ? '当前火山方舟接口未开放自动拉取模型列表，请直接手动填写火山方舟模型 ID 或推理接入点 ID（如 ep-xxx）'
          : '该接口未开放模型列表，请手动输入模型名称';
        setTestStatus(statusEl, 'error', data.message || fallbackMessage);
        return;
      }

      const cacheKey = modelCacheKey(scope, targetBase);
      if (state.llmModelsCache.has(cacheKey)) {
        state.llmModelsCache.delete(cacheKey);
      } else if (state.llmModelsCache.size >= 20) {
        const oldestKey = state.llmModelsCache.keys().next().value;
        state.llmModelsCache.delete(oldestKey);
      }
      state.llmModelsCache.set(cacheKey, data.models || []);

      if (isVision) {
        renderVisionModelOptions();
        if (!dom.settingVisionModel.value.trim() && data.models?.length === 1) {
          dom.settingVisionModel.value = data.models[0].id;
          dom.settingVisionModelSelect.value = data.models[0].id;
        }
        if (!data.models?.length) {
          const emptyFallback = isDoubao
            ? `接口鉴权通过（${data.latencyMs}ms），但未返回可用模型，请直接手动填写火山方舟模型 ID 或推理接入点 ID（如 ep-xxx）`
            : `接口鉴权通过（${data.latencyMs}ms），但未返回可用模型，请直接手动填写识图模型名称`;
          setTestStatus(statusEl, '', data.message || emptyFallback);
        } else {
          setTestStatus(statusEl, 'ok', `已拉取 ${data.count} 个模型（${data.latencyMs}ms），请从下拉列表选择`);
        }
      } else {
        if (dom.settingModelFilter) dom.settingModelFilter.value = '';
        renderLlmModelOptions();
        if (data.models?.length && !data.models.some((m) => m.id === dom.settingModel.value.trim())) {
          if (data.models.length === 1) {
            dom.settingModel.value = data.models[0].id;
            dom.settingModelSelect.value = data.models[0].id;
          }
        }
        if (!data.models?.length) {
          const emptyFallback = isDoubao
            ? `接口鉴权通过（${data.latencyMs}ms），但未返回可用模型，请直接手动填写火山方舟模型 ID 或推理接入点 ID（如 ep-xxx）`
            : `接口鉴权通过（${data.latencyMs}ms），但未返回可用模型，请直接手动填写模型名称`;
          setTestStatus(statusEl, '', data.message || emptyFallback);
        } else {
          setTestStatus(statusEl, 'ok', `接口鉴权通过 · 已拉取 ${data.count} 个模型（${data.latencyMs}ms），请在下方勾选`);
        }
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

  function selectTtsSpeedInModal(speed) {
    state.modalTtsSpeed = speed === 'standard' ? 'standard' : 'relaxed';
    dom.ttsSpeedButtons?.forEach((btn) => {
      const active = btn.dataset.ttsSpeed === state.modalTtsSpeed;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
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
      speechSpeed: state.modalTtsSpeed === 'standard' ? 'standard' : 'relaxed',
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
    state.modalTtsSpeedChanged = false;
    selectTtsSpeedInModal(state.ttsConfig.speechSpeed || 'relaxed');
    if (dom.settingAutoCheckUpdates) {
      dom.settingAutoCheckUpdates.checked = isAutoUpdateCheckEnabled();
    }
    renderSettingsVersionBar();

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
    if (!state.activeTask?.id) {
      state.ttsSpeedOverrideTaskId = null;
      state.ttsSettingsOverrideTaskId = null;
    } else {
      state.ttsSettingsOverrideTaskId = state.activeTask.id;
      if (state.modalTtsSpeedChanged) {
        state.ttsSpeedOverrideTaskId = state.activeTask.id;
      }
    }
    state.modalTtsSpeedChanged = false;

    writeStorage(STORAGE_KEYS.apiKey, state.apiKey);
    writeStorage(STORAGE_KEYS.baseURL, state.baseURL);
    writeStorage(STORAGE_KEYS.model, state.model);
    saveVisionConfigToStorage();
    saveTtsConfigToStorage();

    updateApiKeyStatus();
    dom.settingsModal.classList.add('hidden');
    showToast(`配置已保存 · 语音：${TTS_SHORT_LABELS[tts.provider] || tts.provider}`);
  }

  function setCollectionModalColor(color) {
    const normalized = normalizeCollectionColor(color);
    state.collectionModal.color = normalized;
    dom.collectionColorSwatches?.forEach((btn) => {
      const active = btn.dataset.collectionColor === normalized;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  function showCollectionModalError(msg) {
    if (!dom.collectionModalError) return;
    if (msg) {
      dom.collectionModalError.textContent = msg;
      dom.collectionModalError.classList.remove('hidden');
    } else {
      dom.collectionModalError.textContent = '';
      dom.collectionModalError.classList.add('hidden');
    }
  }

  function openCollectionModal({ mode = 'create', collection = null } = {}) {
    if (!dom.collectionModal) return;
    state.collectionModal.mode = mode;
    state.collectionModal.collectionId = collection?.id || null;
    state.collectionModal.submitting = false;

    const isEdit = mode === 'edit' && Boolean(collection);
    dom.collectionModalTitle.textContent = isEdit ? '编辑合集' : '新建合集';
    dom.collectionModalSubtitle.textContent = isEdit ? '修改合集名称、简介或色标印记' : '按主题整理已生成的双人播客';
    dom.btnSaveCollectionModal.textContent = isEdit ? '保存修改' : '创建合集';
    dom.btnSaveCollectionModal.disabled = false;

    dom.collectionNameInput.value = isEdit ? (collection.name || '') : '';
    dom.collectionDescInput.value = isEdit ? (collection.description || '') : '';
    setCollectionModalColor(isEdit ? collection.color : pickNextCollectionColor());
    showCollectionModalError('');

    dom.collectionModal.classList.remove('hidden');
    window.setTimeout(() => dom.collectionNameInput.focus(), 20);
  }

  function closeCollectionModal() {
    if (!dom.collectionModal) return;
    dom.collectionModal.classList.add('hidden');
    state.collectionModal.submitting = false;
  }

  async function handleSaveCollectionModal(e) {
    e.preventDefault();
    if (state.collectionModal.submitting) return;
    const name = dom.collectionNameInput.value.trim();
    const description = dom.collectionDescInput.value.trim();
    const color = normalizeCollectionColor(state.collectionModal.color);

    if (!name) {
      showCollectionModalError('请输入合集名称');
      dom.collectionNameInput.focus();
      return;
    }
    if (codePointLength(name) > 30) {
      showCollectionModalError('合集名称最多 30 个字');
      dom.collectionNameInput.focus();
      return;
    }
    if (codePointLength(description) > 120) {
      showCollectionModalError('合集简介最多 120 个字');
      dom.collectionDescInput.focus();
      return;
    }
    if (containsClientSecretOrPath(name) || containsClientSecretOrPath(description)) {
      showCollectionModalError('合集内容不能包含本机已保存的 API 密钥、接口地址或本地路径');
      return;
    }

    state.collectionModal.submitting = true;
    dom.btnSaveCollectionModal.disabled = true;
    showCollectionModalError('');

    const isEdit = state.collectionModal.mode === 'edit' && Boolean(state.collectionModal.collectionId);
    const editId = isEdit ? state.collectionModal.collectionId : null;
    try {
      if (isEdit) {
        await apiJson(`/api/collections/${encodeURIComponent(editId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, color }),
        });
        showToast(`已更新合集「${name}」`);
      } else {
        await apiJson('/api/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, color }),
        });
        showToast(`已创建合集「${name}」`);
      }
      closeCollectionModal();
      await loadCollections();
      if (editId && state.selectedCollectionFilter === editId) {
        loadCollectionDetail(editId);
      }
      renderHistoryList();
    } catch (err) {
      showCollectionModalError(err.message || '保存合集失败');
    } finally {
      state.collectionModal.submitting = false;
      dom.btnSaveCollectionModal.disabled = false;
    }
  }

  async function handleConfirmDeleteCollection() {
    const colId = state.collectionDeleteConfirmId;
    if (!colId) return;
    dom.btnConfirmDeleteCollection.disabled = true;
    try {
      await apiJson(`/api/collections/${encodeURIComponent(colId)}`, { method: 'DELETE' });
      state.collectionDeleteConfirmId = null;
      state.collectionHighlightsExpanded = false;
      state.activeCollectionDetail = null;
      state.historyItems = state.historyItems.map((item) => (
        item.collectionId === colId ? { ...item, collectionId: null } : item
      ));
      if (state.currentPodcast?.collectionId === colId) {
        state.currentPodcast.collectionId = null;
      }
      if (state.selectedCollectionFilter === colId) {
        state.selectedCollectionFilter = 'all';
      }
      await loadCollections();
      renderHistoryList();
      showToast('已删除合集，原有播客已保留为未归类');
    } catch (err) {
      showToast(err.message || '删除合集失败');
    } finally {
      dom.btnConfirmDeleteCollection.disabled = false;
    }
  }

  function findPodcastSummary(podcastId) {
    if (state.currentPodcast?.id === podcastId) return state.currentPodcast;
    return state.historyItems.find((item) => item.id === podcastId) || null;
  }

  function renderAssignCollectionOptions() {
    if (!dom.assignCollectionList) return;
    const podcast = findPodcastSummary(state.assignModal.podcastId);
    const currentColId = podcast?.collectionId && findCollectionById(podcast.collectionId)
      ? podcast.collectionId
      : null;

    dom.assignCollectionList.textContent = '';
    const fragment = document.createDocumentFragment();

    const makeOption = ({ id, name, color, countText, selected }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `assign-collection-option${selected ? ' is-selected' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(selected));
      btn.dataset.targetCollectionId = id || '';
      btn.disabled = state.assignModal.submitting;

      const main = document.createElement('span');
      main.className = 'assign-option-main';
      if (color) {
        const dot = document.createElement('span');
        dot.className = `collection-dot is-${normalizeCollectionColor(color)}`;
        dot.setAttribute('aria-hidden', 'true');
        main.appendChild(dot);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'assign-option-name';
      nameSpan.textContent = name;
      main.appendChild(nameSpan);

      const metaSpan = document.createElement('span');
      metaSpan.className = 'assign-option-meta';
      metaSpan.textContent = selected ? '当前所属' : countText;

      btn.append(main, metaSpan);
      return btn;
    };

    fragment.appendChild(makeOption({
      id: '',
      name: '未归类（移出合集）',
      color: null,
      countText: '移出',
      selected: currentColId === null,
    }));

    state.collections.forEach((col) => {
      fragment.appendChild(makeOption({
        id: col.id,
        name: col.name,
        color: col.color,
        countText: `${col.podcastCount || 0} 集`,
        selected: currentColId === col.id,
      }));
    });

    dom.assignCollectionList.appendChild(fragment);
  }

  function renderAiSuggestionBox() {
    if (!dom.aiSuggestResult || !dom.btnSuggestCollection) return;
    const btnSpan = dom.btnSuggestCollection.querySelector('span');
    dom.btnSuggestCollection.disabled = state.assignModal.suggesting || state.assignModal.submitting;
    if (btnSpan) {
      btnSpan.textContent = state.assignModal.suggesting ? '分析中…' : '✨ AI 建议分类';
    }

    dom.aiSuggestResult.textContent = '';
    dom.aiSuggestResult.classList.remove('is-error');

    if (state.assignModal.suggesting) {
      dom.aiSuggestResult.classList.remove('hidden');
      const p = document.createElement('p');
      p.className = 'ai-suggest-reason';
      p.textContent = 'AI 正在阅读本期标题、摘要与前几句台词…';
      dom.aiSuggestResult.appendChild(p);
      return;
    }

    if (state.assignModal.suggestionError) {
      dom.aiSuggestResult.classList.remove('hidden');
      dom.aiSuggestResult.classList.add('is-error');
      const errInfo = state.assignModal.suggestionError;
      const p = document.createElement('p');
      p.className = 'ai-suggest-reason';
      p.textContent = errInfo.message;
      dom.aiSuggestResult.appendChild(p);
      if (errInfo.needsConfig) {
        const actions = document.createElement('div');
        actions.className = 'ai-suggest-actions';
        const cfgBtn = createActionBtn('去配置模型', 'btn btn-primary btn-sm', () => {
          closeAssignCollectionModal();
          openSettingsModal('llm');
        });
        actions.appendChild(cfgBtn);
        dom.aiSuggestResult.appendChild(actions);
      }
      return;
    }

    const sug = state.assignModal.suggestion;
    if (!sug) {
      dom.aiSuggestResult.classList.add('hidden');
      return;
    }

    dom.aiSuggestResult.classList.remove('hidden');
    const top = document.createElement('div');
    top.className = 'ai-suggest-result-top';
    const badge = document.createElement('span');
    badge.className = 'ai-suggest-badge';
    badge.textContent = sug.action === 'existing' ? '匹配已有合集' : '建议新建合集';
    const nameEl = document.createElement('span');
    nameEl.className = 'ai-suggest-name';
    nameEl.textContent = sug.suggestedName;
    top.append(nameEl, badge);
    dom.aiSuggestResult.appendChild(top);

    if (sug.reason) {
      const reasonEl = document.createElement('p');
      reasonEl.className = 'ai-suggest-reason';
      reasonEl.textContent = sug.reason;
      dom.aiSuggestResult.appendChild(reasonEl);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-suggest-actions';
    const acceptBtn = createActionBtn(
      sug.action === 'existing' ? '采纳并归入' : '创建并归入',
      'btn btn-primary btn-sm',
      handleAcceptSuggestedCollection
    );
    acceptBtn.disabled = state.assignModal.submitting;
    actions.appendChild(acceptBtn);
    dom.aiSuggestResult.appendChild(actions);
  }

  function openAssignCollectionModal(podcastId) {
    if (!dom.assignCollectionModal || !podcastId) return;
    const podcast = findPodcastSummary(podcastId);
    if (!podcast) return;

    state.assignModal.sessionSeq += 1;
    state.assignModal.suggestSeq += 1;
    state.assignModal.suggestAbortController?.abort();
    state.assignModal.suggestAbortController = null;
    state.assignModal.podcastId = podcastId;
    state.assignModal.submitting = false;
    state.assignModal.suggesting = false;
    state.assignModal.suggestion = null;
    state.assignModal.suggestionError = null;

    dom.assignCollectionPodcastTitle.textContent = podcast.podcastTitle || '未命名播客';
    if (dom.quickCollectionNameInput) dom.quickCollectionNameInput.value = '';
    if (dom.btnQuickCreateCollection) dom.btnQuickCreateCollection.disabled = false;
    renderAssignCollectionOptions();
    renderAiSuggestionBox();
    dom.assignCollectionModal.classList.remove('hidden');
  }

  function closeAssignCollectionModal() {
    if (!dom.assignCollectionModal) return;
    state.assignModal.sessionSeq += 1;
    state.assignModal.suggestSeq += 1;
    state.assignModal.suggestAbortController?.abort();
    state.assignModal.suggestAbortController = null;
    state.assignModal.suggesting = false;
    state.assignModal.submitting = false;
    state.assignModal.podcastId = null;
    dom.assignCollectionModal.classList.add('hidden');
  }

  async function assignPodcastToCollection(podcastId, collectionId, { closeModal = true } = {}) {
    if (!podcastId || state.assignModal.submitting) return;
    const sessionSeq = state.assignModal.sessionSeq;
    const normalizedId = collectionId || null;
    state.assignModal.submitting = true;
    renderAssignCollectionOptions();
    renderAiSuggestionBox();

    try {
      await apiJson(`/api/podcasts/${encodeURIComponent(podcastId)}/collection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionId: normalizedId }),
      });

      state.historyItems = state.historyItems.map((item) => (
        item.id === podcastId ? { ...item, collectionId: normalizedId } : item
      ));
      if (state.currentPodcast?.id === podcastId) {
        state.currentPodcast.collectionId = normalizedId;
      }

      if (closeModal && state.assignModal.sessionSeq === sessionSeq) {
        closeAssignCollectionModal();
      } else if (state.assignModal.sessionSeq === sessionSeq) {
        state.assignModal.submitting = false;
        renderAssignCollectionOptions();
        renderAiSuggestionBox();
      }

      await loadCollections();
      if (state.selectedCollectionFilter !== 'all' && state.selectedCollectionFilter !== 'unassigned') {
        loadCollectionDetail(state.selectedCollectionFilter);
      }
      renderHistoryList();
      const targetCol = findCollectionById(normalizedId);
      showToast(targetCol ? `已归入合集「${targetCol.name}」` : '已从合集移出');
    } catch (err) {
      showToast(err.message || '设置合集归属失败');
      if (state.assignModal.sessionSeq === sessionSeq) {
        state.assignModal.submitting = false;
        renderAssignCollectionOptions();
        renderAiSuggestionBox();
      }
    }
  }

  async function handleSuggestCollection() {
    const podcastId = state.assignModal.podcastId;
    if (!podcastId || state.assignModal.suggesting) return;

    const sessionSeq = state.assignModal.sessionSeq;
    const suggestSeq = ++state.assignModal.suggestSeq;
    state.assignModal.suggestAbortController?.abort();
    const controller = new AbortController();
    state.assignModal.suggestAbortController = controller;
    state.assignModal.suggesting = true;
    state.assignModal.suggestion = null;
    state.assignModal.suggestionError = null;
    renderAiSuggestionBox();

    try {
      const result = await apiJson('/api/collections/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          podcastId,
          ...buildCredsPayload(),
        }),
      });
      if (state.assignModal.sessionSeq !== sessionSeq || state.assignModal.suggestSeq !== suggestSeq) return;
      state.assignModal.suggestion = result;
    } catch (err) {
      if (err.name === 'AbortError' ||
          state.assignModal.sessionSeq !== sessionSeq ||
          state.assignModal.suggestSeq !== suggestSeq) {
        return;
      }
      const msg = err.message || '智能分类建议失败，请稍后重试';
      const missingKey = err.status === 400 && /请先配置.*API Key|尚未配置.*API Key/i.test(msg);
      const needsConfig = err.status === 400 && /API Key|模型|接口地址/i.test(msg);
      state.assignModal.suggestionError = {
        needsConfig,
        message: missingKey ? '尚未配置大模型 API Key，请先到「模型与语音」设置后再试。' : msg,
      };
    } finally {
      if (state.assignModal.sessionSeq === sessionSeq && state.assignModal.suggestSeq === suggestSeq) {
        if (state.assignModal.suggestAbortController === controller) {
          state.assignModal.suggestAbortController = null;
        }
        state.assignModal.suggesting = false;
        renderAiSuggestionBox();
      }
    }
  }

  async function createCollectionAndAssign(podcastId, name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      showToast('请输入新合集名称');
      dom.quickCollectionNameInput?.focus();
      return;
    }
    if (codePointLength(cleanName) > 30) {
      showToast('合集名称最多 30 个字');
      return;
    }
    if (containsClientSecretOrPath(cleanName)) {
      showToast('合集名称不能包含本机已保存的 API 密钥、接口地址或本地路径');
      return;
    }

    const existing = state.collections.find((c) => c.name.trim().toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      await assignPodcastToCollection(podcastId, existing.id);
      return;
    }

    const sessionSeq = state.assignModal.sessionSeq;
    state.assignModal.submitting = true;
    renderAssignCollectionOptions();
    renderAiSuggestionBox();
    if (dom.btnQuickCreateCollection) dom.btnQuickCreateCollection.disabled = true;

    try {
      const created = await apiJson('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanName,
          description: '',
          color: pickNextCollectionColor(),
        }),
      });
      state.collections = [...state.collections, created];
      if (state.assignModal.sessionSeq !== sessionSeq) return;
      state.assignModal.submitting = false;
      await assignPodcastToCollection(podcastId, created.id);
    } catch (err) {
      showToast(err.message || '创建合集失败');
      if (state.assignModal.sessionSeq === sessionSeq) {
        state.assignModal.submitting = false;
        renderAssignCollectionOptions();
        renderAiSuggestionBox();
      }
    } finally {
      if (state.assignModal.sessionSeq === sessionSeq && dom.btnQuickCreateCollection) {
        dom.btnQuickCreateCollection.disabled = false;
      }
    }
  }

  async function handleAcceptSuggestedCollection() {
    const podcastId = state.assignModal.podcastId;
    const sug = state.assignModal.suggestion;
    if (!podcastId || !sug) return;
    if (sug.action === 'existing' && sug.collectionId) {
      await assignPodcastToCollection(podcastId, sug.collectionId);
      return;
    }
    await createCollectionAndAssign(podcastId, sug.suggestedName);
  }

  function setLanCompanionError(msg) {
    const running = Boolean(state.lanCompanion.running);
    const activeEl = running ? dom.lanCompanionRunningError : dom.lanCompanionStoppedError;
    const otherEl = running ? dom.lanCompanionStoppedError : dom.lanCompanionRunningError;
    if (otherEl) {
      otherEl.textContent = '';
      otherEl.classList.add('hidden');
    }
    if (activeEl) {
      if (msg) {
        activeEl.textContent = msg;
        activeEl.classList.remove('hidden');
      } else {
        activeEl.textContent = '';
        activeEl.classList.add('hidden');
      }
    }
  }

  function renderSafeQrSvg(container, svgMarkup) {
    if (!container) return;
    container.replaceChildren();
    if (!svgMarkup || typeof svgMarkup !== 'string') return;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
      const root = doc.documentElement;
      if (!root || root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return;

      const viewBox = root.getAttribute('viewBox') || '';
      if (!/^\d+\s+\d+\s+\d+\s+\d+$/.test(viewBox)) return;

      const svgNS = 'http://www.w3.org/2000/svg';
      const safeSvg = document.createElementNS(svgNS, 'svg');
      safeSvg.setAttribute('viewBox', viewBox);
      safeSvg.setAttribute('role', 'img');
      safeSvg.setAttribute('aria-label', root.getAttribute('aria-label') || '手机随身听配对二维码');
      safeSvg.setAttribute('shape-rendering', 'crispEdges');

      const safeColor = (value, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(value || '') ? value : fallback);
      const safeLength = (value) => (/^(?:\d+(?:\.\d+)?%?)$/.test(value || '') ? value : null);

      for (const child of root.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'rect') {
          const rect = document.createElementNS(svgNS, 'rect');
          const x = safeLength(child.getAttribute('x'));
          const y = safeLength(child.getAttribute('y'));
          const w = safeLength(child.getAttribute('width'));
          const h = safeLength(child.getAttribute('height'));
          if (x !== null) rect.setAttribute('x', x);
          if (y !== null) rect.setAttribute('y', y);
          if (w !== null) rect.setAttribute('width', w);
          if (h !== null) rect.setAttribute('height', h);
          rect.setAttribute('fill', safeColor(child.getAttribute('fill'), '#FFFFFF'));
          safeSvg.appendChild(rect);
        } else if (tag === 'path') {
          const d = child.getAttribute('d') || '';
          if (!/^[MmHhVvLlZz0-9.,\s-]+$/.test(d)) return;
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('fill', safeColor(child.getAttribute('fill'), '#1A1916'));
          path.setAttribute('d', d);
          safeSvg.appendChild(path);
        }
      }

      container.appendChild(safeSvg);
    } catch {
      // Ignore malformed SVG markup
    }
  }

  function applyLanCompanionState(data) {
    const prevRunning = state.lanCompanion.running;
    const next = {
      running: Boolean(data?.running),
      port: Number.isFinite(data?.port) ? data.port : null,
      activeHost: typeof data?.activeHost === 'string' ? data.activeHost : null,
      candidates: Array.isArray(data?.candidates) ? data.candidates : [],
      url: typeof data?.url === 'string' ? data.url : null,
      qrSvg: typeof data?.qrSvg === 'string' ? data.qrSvg : null,
      connectedHint: typeof data?.connectedHint === 'string' ? data.connectedHint : '',
    };
    Object.assign(state.lanCompanion, next);
    renderLanCompanionModal();
    if (prevRunning !== next.running && dom.btnLanCompanion) {
      dom.btnLanCompanion.title = next.running
        ? `手机随身听运行中（${next.activeHost || ''}:${next.port || ''}）`
        : '手机同 Wi-Fi 扫码随身听';
    }
  }

  function renderLanCompanionModal() {
    const lan = state.lanCompanion;
    const busy = Boolean(lan.busy);

    if (dom.lanCompanionStatusDot) {
      dom.lanCompanionStatusDot.classList.toggle('is-running', lan.running);
    }
    if (dom.btnLanCompanion) {
      dom.btnLanCompanion.classList.toggle('is-running', lan.running);
    }

    if (dom.lanCompanionStoppedView) {
      dom.lanCompanionStoppedView.classList.toggle('hidden', lan.running);
    }
    if (dom.lanCompanionRunningView) {
      dom.lanCompanionRunningView.classList.toggle('hidden', !lan.running);
    }

    if (dom.btnStartLanCompanion) dom.btnStartLanCompanion.disabled = busy;
    if (dom.btnRotateLanCompanion) dom.btnRotateLanCompanion.disabled = busy;
    if (dom.btnStopLanCompanion) dom.btnStopLanCompanion.disabled = busy;
    if (dom.lanCompanionHostSelect) dom.lanCompanionHostSelect.disabled = busy;

    if (!lan.running) {
      renderSafeQrSvg(dom.lanCompanionQrBox, '');
      if (dom.lanCompanionUrlInput) dom.lanCompanionUrlInput.value = '';
      return;
    }

    if (dom.lanCompanionPortBadge) {
      dom.lanCompanionPortBadge.textContent = lan.port ? `端口 ${lan.port}` : '运行中';
    }
    if (dom.lanCompanionUrlInput) {
      dom.lanCompanionUrlInput.value = lan.url || '';
    }
    renderSafeQrSvg(dom.lanCompanionQrBox, lan.qrSvg);

    if (dom.lanCompanionHostWrap && dom.lanCompanionHostSelect) {
      const candidates = lan.candidates || [];
      const showSelect = candidates.length >= 2;
      dom.lanCompanionHostWrap.classList.toggle('hidden', !showSelect);
      if (showSelect) {
        dom.lanCompanionHostSelect.replaceChildren();
        candidates.forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.address;
          const ifName = item.interfaceName ? ` · ${item.interfaceName}` : '';
          const rec = item.preferred ? '（推荐）' : '';
          opt.textContent = `${item.address}${ifName}${rec}`;
          opt.selected = item.address === lan.activeHost;
          dom.lanCompanionHostSelect.appendChild(opt);
        });
      }
    }
  }

  async function refreshLanCompanionStatus({ silent = false } = {}) {
    try {
      const data = await apiJson('/api/lan-companion/status');
      applyLanCompanionState(data);
      if (!silent) setLanCompanionError('');
    } catch (err) {
      if (!silent) {
        setLanCompanionError(err.message || '无法读取随身听状态');
      }
    }
  }

  function openLanCompanionModal() {
    if (!dom.lanCompanionModal) return;
    setLanCompanionError('');
    renderLanCompanionModal();
    dom.lanCompanionModal.classList.remove('hidden');
    refreshLanCompanionStatus({ silent: false });
  }

  function closeLanCompanionModal() {
    if (!dom.lanCompanionModal) return;
    dom.lanCompanionModal.classList.add('hidden');
    dom.btnLanCompanion?.focus();
  }

  function isAutoUpdateCheckEnabled() {
    const raw = readStorage(STORAGE_KEYS.autoCheckUpdates);
    return raw !== '0' && raw !== 'false';
  }

  function getIgnoredUpdateVersion() {
    return readStorage(STORAGE_KEYS.ignoredUpdateVersion).trim();
  }

  function sanitizeOfficialUpdateUrl(rawUrl, fallbackUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fallbackUrl;
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return fallbackUrl;
      if (parsed.origin === 'https://podcast.ai955.xyz') return parsed.href;
      if (parsed.origin === 'https://github.com' && /^\/Alex-955\/Podcast-Generator(?:\/|$)/.test(parsed.pathname)) {
        return parsed.href;
      }
      return fallbackUrl;
    } catch {
      return fallbackUrl;
    }
  }

  function formatVersionLabel(ver) {
    const clean = String(ver || '').trim().replace(/^v/i, '');
    return clean ? `v${clean}` : `v${DEFAULT_APP_VERSION}`;
  }

  function renderUpdateBadge() {
    if (!dom.btnUpdateBadge) return;
    const res = state.updateCheck.result;
    const ignored = getIgnoredUpdateVersion();
    const shouldShow = Boolean(
      res &&
      res.checked &&
      res.hasUpdate &&
      res.latestVersion &&
      res.latestVersion !== ignored
    );
    dom.btnUpdateBadge.classList.toggle('hidden', !shouldShow);
    if (shouldShow && dom.updateBadgeText) {
      dom.updateBadgeText.textContent = `发现 ${formatVersionLabel(res.latestVersion)}`;
    }
  }

  function renderSettingsVersionBar() {
    if (dom.settingsCurrentVersion) {
      dom.settingsCurrentVersion.textContent = formatVersionLabel(state.updateCheck.currentVersion);
    }
    if (!dom.updateCheckInlineStatus) return;
    const statusEl = dom.updateCheckInlineStatus;
    statusEl.replaceChildren();
    statusEl.className = 'version-check-status';

    if (state.updateCheck.checking) {
      statusEl.textContent = '正在检查更新…';
      return;
    }

    const res = state.updateCheck.result;
    if (!res) return;

    if (res.offline || !res.checked) {
      statusEl.classList.add('is-offline');
      statusEl.textContent = res.message || '暂无法连接更新服务，请稍后重试';
      return;
    }

    if (res.hasUpdate && res.latestVersion) {
      statusEl.classList.add('is-update');
      const text = document.createTextNode(`发现 ${formatVersionLabel(res.latestVersion)}`);
      const detailBtn = document.createElement('button');
      detailBtn.type = 'button';
      detailBtn.className = 'version-inline-link';
      detailBtn.textContent = '查看详情';
      detailBtn.addEventListener('click', () => {
        openUpdateModal(detailBtn);
      });
      statusEl.append(text, detailBtn);
      return;
    }

    statusEl.classList.add('is-ok');
    statusEl.textContent = `已是最新版（${formatVersionLabel(res.currentVersion || state.updateCheck.currentVersion)}）`;
  }

  function renderUpdateModal() {
    const res = state.updateCheck.result;
    if (!res) return;
    if (dom.updateCurrentVersionBadge) {
      dom.updateCurrentVersionBadge.textContent = `当前 ${formatVersionLabel(res.currentVersion || state.updateCheck.currentVersion)}`;
    }
    if (dom.updateLatestVersionBadge) {
      dom.updateLatestVersionBadge.textContent = `最新 ${formatVersionLabel(res.latestVersion)}`;
    }
    if (dom.updateReleaseDate) {
      const dateStr = typeof res.releaseDate === 'string' ? res.releaseDate.trim() : '';
      dom.updateReleaseDate.textContent = dateStr;
      dom.updateReleaseDate.classList.toggle('hidden', !dateStr);
    }
    if (dom.updateNotesList) {
      dom.updateNotesList.replaceChildren();
      const notes = Array.isArray(res.notes) && res.notes.length > 0
        ? res.notes
        : ['包含体验优化与稳定性修复，欢迎前往官网或 GitHub Release 查看详情。'];
      notes.forEach((line) => {
        const li = document.createElement('li');
        li.textContent = String(line);
        dom.updateNotesList.appendChild(li);
      });
    }
    if (dom.btnUpdateDownloadOfficial) {
      dom.btnUpdateDownloadOfficial.href = sanitizeOfficialUpdateUrl(res.downloadPageUrl, OFFICIAL_DOWNLOAD_URL);
    }
    if (dom.btnUpdateGithubRelease) {
      dom.btnUpdateGithubRelease.href = sanitizeOfficialUpdateUrl(res.releaseUrl, OFFICIAL_RELEASE_URL);
    }
  }

  function openUpdateModal(triggerEl = null) {
    if (!dom.updateModal || !state.updateCheck.result?.hasUpdate) return;
    state.updateCheck.lastTriggerEl = triggerEl instanceof HTMLElement
      ? triggerEl
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    renderUpdateModal();
    dom.updateModal.classList.remove('hidden');
    window.setTimeout(() => {
      if (dom.updateModal && !dom.updateModal.classList.contains('hidden')) {
        (dom.btnUpdateDownloadOfficial || dom.btnCloseUpdateModal)?.focus();
      }
    }, 20);
  }

  function closeUpdateModal({ returnFocus = true } = {}) {
    if (!dom.updateModal) return;
    dom.updateModal.classList.add('hidden');
    const triggerEl = state.updateCheck.lastTriggerEl;
    state.updateCheck.lastTriggerEl = null;
    if (!returnFocus) return;
    if (triggerEl && triggerEl.isConnected && !triggerEl.classList.contains('hidden') && !triggerEl.closest('.hidden')) {
      triggerEl.focus();
      return;
    }
    if (dom.settingsModal && !dom.settingsModal.classList.contains('hidden')) {
      dom.btnCheckUpdatesNow?.focus();
      return;
    }
    if (dom.btnUpdateBadge && !dom.btnUpdateBadge.classList.contains('hidden')) {
      dom.btnUpdateBadge.focus();
    }
  }

  async function checkForUpdates({ force = false, silent = true } = {}) {
    if (state.updateCheck.checking) return;
    state.updateCheck.checking = true;
    if (dom.btnCheckUpdatesNow) dom.btnCheckUpdatesNow.disabled = true;
    if (!silent) renderSettingsVersionBar();

    try {
      const url = force ? '/api/update-check?force=1' : '/api/update-check';
      const data = await apiJson(url);
      if (data?.currentVersion) {
        state.updateCheck.currentVersion = data.currentVersion;
      }
      state.updateCheck.result = data || null;
      if (force && data?.hasUpdate && data?.latestVersion && getIgnoredUpdateVersion() === data.latestVersion) {
        writeStorage(STORAGE_KEYS.ignoredUpdateVersion, '');
      }
    } catch {
      if (!silent) {
        state.updateCheck.result = {
          currentVersion: state.updateCheck.currentVersion,
          checked: false,
          hasUpdate: false,
          offline: true,
          message: '暂无法连接更新服务，请稍后重试',
        };
      }
    } finally {
      state.updateCheck.checking = false;
      if (dom.btnCheckUpdatesNow) dom.btnCheckUpdatesNow.disabled = false;
      renderUpdateBadge();
      if (!silent || (dom.settingsModal && !dom.settingsModal.classList.contains('hidden'))) {
        renderSettingsVersionBar();
      }
    }
  }

  async function handleStartLanCompanion() {
    if (state.lanCompanion.busy) return;
    state.lanCompanion.busy = true;
    setLanCompanionError('');
    renderLanCompanionModal();
    try {
      const data = await apiJson('/api/lan-companion/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      applyLanCompanionState(data);
      showToast('已开启手机随身听，手机扫码即可收听');
    } catch (err) {
      setLanCompanionError(err.message || '开启手机随身听失败');
    } finally {
      state.lanCompanion.busy = false;
      renderLanCompanionModal();
    }
  }

  async function handleStopLanCompanion() {
    if (state.lanCompanion.busy) return;
    state.lanCompanion.busy = true;
    setLanCompanionError('');
    renderLanCompanionModal();
    try {
      const data = await apiJson('/api/lan-companion/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      applyLanCompanionState(data);
      showToast('已关闭手机随身听');
    } catch (err) {
      setLanCompanionError(err.message || '关闭手机随身听失败');
    } finally {
      state.lanCompanion.busy = false;
      renderLanCompanionModal();
    }
  }

  async function handleRotateLanCompanion() {
    if (state.lanCompanion.busy) return;
    state.lanCompanion.busy = true;
    setLanCompanionError('');
    renderLanCompanionModal();
    try {
      const data = await apiJson('/api/lan-companion/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      applyLanCompanionState(data);
      showToast('已刷新配对二维码，旧连接已失效');
    } catch (err) {
      setLanCompanionError(err.message || '刷新二维码失败');
    } finally {
      state.lanCompanion.busy = false;
      renderLanCompanionModal();
    }
  }

  async function handleSelectLanCompanionHost() {
    if (state.lanCompanion.busy || !dom.lanCompanionHostSelect) return;
    const host = dom.lanCompanionHostSelect.value;
    if (!host || host === state.lanCompanion.activeHost) return;
    state.lanCompanion.busy = true;
    setLanCompanionError('');
    renderLanCompanionModal();
    try {
      const data = await apiJson('/api/lan-companion/select-host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      applyLanCompanionState(data);
      showToast(`已切换局域网地址为 ${host}`);
    } catch (err) {
      setLanCompanionError(err.message || '切换局域网地址失败');
    } finally {
      state.lanCompanion.busy = false;
      renderLanCompanionModal();
    }
  }

  async function handleCopyLanCompanionUrl() {
    const url = state.lanCompanion.url;
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (dom.lanCompanionUrlInput) {
        dom.lanCompanionUrlInput.select();
        document.execCommand('copy');
      }
      showToast('已复制手机随身听链接');
    } catch {
      if (dom.lanCompanionUrlInput) {
        dom.lanCompanionUrlInput.select();
      }
      showToast('请长按或 Ctrl/Cmd+C 复制上方链接');
    }
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
    if (dom.btnCancelExtractImages) {
      dom.btnCancelExtractImages.addEventListener('click', () => {
        state.extractAbortController?.abort();
      });
    }
    dom.confirmStyleButtons?.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextStyle = normalizePodcastStyleClient(btn.dataset.podcastStyle);
        if (state.confirmedDraft) {
          state.confirmedDraft.userPickedStyle = true;
        }
        state.podcastStyle = nextStyle;
        writeStorage(STORAGE_KEYS.podcastStyle, nextStyle);
        updatePodcastStyleUI();
      });
    });

    document.addEventListener('paste', (e) => {
      if (!dom.settingsModal.classList.contains('hidden')) return;
      if (dom.collectionModal && !dom.collectionModal.classList.contains('hidden')) return;
      if (dom.assignCollectionModal && !dom.assignCollectionModal.classList.contains('hidden')) return;
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
      pill.addEventListener('click', () => loadSampleDraft(pill.dataset.sample));
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

    dom.historyList.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target || !dom.historyList.contains(target)) return;
      const action = target.dataset.action;
      const podcastId = target.dataset.podcastId;
      if (!podcastId) return;
      if (action === 'select') {
        const hadPending = state.pendingDeleteId !== null;
        state.pendingDeleteId = null;
        if (hadPending) renderHistoryList();
        handleSelectHistory(podcastId);
      } else if (action === 'assign-collection') {
        e.stopPropagation();
        openAssignCollectionModal(podcastId);
      } else if (action === 'request-delete') {
        e.stopPropagation();
        state.pendingDeleteId = podcastId;
        renderHistoryList();
      } else if (action === 'confirm-delete') {
        e.stopPropagation();
        handleDeletePodcast(podcastId);
      } else if (action === 'cancel-delete') {
        e.stopPropagation();
        state.pendingDeleteId = null;
        renderHistoryList();
      }
    });

    if (dom.btnEditScript) {
      dom.btnEditScript.addEventListener('click', () => {
        if (state.scriptEdit.active) {
          exitScriptEditMode({ rerender: true });
        } else {
          enterScriptEditMode();
        }
      });
    }
    if (dom.btnResetScriptEdits) {
      dom.btnResetScriptEdits.addEventListener('click', resetAllScriptEdits);
    }
    if (dom.btnCancelScriptEdit) {
      dom.btnCancelScriptEdit.addEventListener('click', () => exitScriptEditMode({ rerender: true }));
    }
    if (dom.btnResynthesizeScript) {
      dom.btnResynthesizeScript.addEventListener('click', handleResynthesizeScript);
    }

    dom.subtitlesList.addEventListener('click', (e) => {
      if (state.scriptEdit.active) {
        const actionBtn = e.target.closest('[data-edit-action]');
        if (!actionBtn || !dom.subtitlesList.contains(actionBtn)) return;
        const action = actionBtn.dataset.editAction;
        const idx = Number(actionBtn.dataset.editIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= state.scriptEdit.draft.length) return;
        if (action === 'toggle-speaker') {
          const line = state.scriptEdit.draft[idx];
          line.speaker = line.speaker === '阿泽' ? '小晓' : '阿泽';
          syncScriptEditorRowState(actionBtn.closest('.subtitle-item'), idx);
          updateScriptEditorToolbar();
        } else if (action === 'restore-line') {
          const line = state.scriptEdit.draft[idx];
          const orig = state.scriptEdit.original[line.origIndex];
          if (orig) {
            state.scriptEdit.draft[idx] = { ...orig };
            const row = actionBtn.closest('.subtitle-item');
            const textarea = row?.querySelector('.subtitle-edit-input');
            if (textarea) {
              textarea.value = orig.text;
              autoSizeTextarea(textarea);
            }
            syncScriptEditorRowState(row, idx);
            updateScriptEditorToolbar();
          }
        } else if (action === 'delete-line') {
          if (state.scriptEdit.draft.length <= 1) {
            showToast('剧本至少需要保留 1 句台词');
            return;
          }
          state.scriptEdit.draft.splice(idx, 1);
          renderScriptEditorList();
        }
        return;
      }
      const row = e.target.closest('.subtitle-item');
      if (!row || !dom.subtitlesList.contains(row)) return;
      const idx = Number(row.dataset.index);
      if (Number.isInteger(idx)) jumpToSubtitleIndex(idx);
    });

    dom.subtitlesList.addEventListener('input', (e) => {
      if (!state.scriptEdit.active) return;
      const textarea = e.target.closest('.subtitle-edit-input');
      if (!textarea || !dom.subtitlesList.contains(textarea)) return;
      const idx = Number(textarea.dataset.editIndex);
      if (!Number.isInteger(idx) || !state.scriptEdit.draft[idx]) return;
      state.scriptEdit.draft[idx].text = textarea.value;
      autoSizeTextarea(textarea);
      syncScriptEditorRowState(textarea.closest('.subtitle-item'), idx);
      updateScriptEditorToolbar();
    });

    dom.subtitlesList.addEventListener('keydown', (e) => {
      if (state.scriptEdit.active) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.subtitle-item');
      if (!row || !dom.subtitlesList.contains(row)) return;
      e.preventDefault();
      const idx = Number(row.dataset.index);
      if (Number.isInteger(idx)) jumpToSubtitleIndex(idx);
    });

    const markUserScrollingSubtitles = () => {
      state.userScrollingSubtitlesUntil = Date.now() + 2500;
    };
    dom.subtitlesList.addEventListener('wheel', markUserScrollingSubtitles, { passive: true });
    dom.subtitlesList.addEventListener('touchstart', markUserScrollingSubtitles, { passive: true });

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
    window.addEventListener('scroll', scheduleMobileMiniVisibility, { passive: true });
    window.addEventListener('resize', scheduleMobileMiniVisibility, { passive: true });

    dom.seekSlider.addEventListener('input', () => {
      state.isSeeking = true;
      const pct = Number(dom.seekSlider.value) || 0;
      const clamped = Math.max(0, Math.min(100, pct));
      const rounded = Math.round(clamped * 10) / 10;
      state.lastRenderedSeekPct = rounded;
      dom.seekSlider.style.setProperty('--seek-pct', `${rounded}%`);
      if (dom.miniProgressFill) dom.miniProgressFill.style.width = `${rounded}%`;
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const curStr = formatTime((clamped / 100) * dur);
      if (curStr !== state.lastRenderedTimeText) {
        state.lastRenderedTimeText = curStr;
        dom.currentTime.textContent = curStr;
      }
      if (dom.miniTime) {
        const miniStr = `${curStr} / ${formatTime(dur)}`;
        if (miniStr !== state.lastRenderedMiniTimeText) {
          state.lastRenderedMiniTimeText = miniStr;
          dom.miniTime.textContent = miniStr;
        }
      }
    });

    dom.seekSlider.addEventListener('change', () => {
      const pct = Number(dom.seekSlider.value) || 0;
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const target = (pct / 100) * dur;
      state.isSeeking = false;
      state.userScrollingSubtitlesUntil = 0;
      syncHighlightToTime(target, { forceScroll: true });
      if (state.audioEngine?.getPhase?.() === 'intro') {
        state.audioEngine.seekAndPlay(target).catch(() => {});
        return;
      }
      dom.mainAudio.currentTime = target;
      state.audioEngine?.syncTime(target);
    });

    dom.mainAudio.addEventListener('loadedmetadata', () => {
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const durStr = formatTime(dur);
      dom.totalDuration.textContent = durStr;
      if (dom.miniTime) {
        const miniStr = `${formatTime(dom.mainAudio.currentTime || 0)} / ${durStr}`;
        state.lastRenderedMiniTimeText = miniStr;
        dom.miniTime.textContent = miniStr;
      }
    });

    dom.mainAudio.addEventListener('timeupdate', () => {
      if (state.isSeeking) return;
      const cur = dom.mainAudio.currentTime || 0;
      const dur = dom.mainAudio.duration || state.currentPodcast?.totalDuration || 0;
      const curStr = formatTime(cur);
      if (curStr !== state.lastRenderedTimeText) {
        state.lastRenderedTimeText = curStr;
        dom.currentTime.textContent = curStr;
      }
      if (dom.miniTime) {
        const miniStr = `${curStr} / ${formatTime(dur)}`;
        if (miniStr !== state.lastRenderedMiniTimeText) {
          state.lastRenderedMiniTimeText = miniStr;
          dom.miniTime.textContent = miniStr;
        }
      }
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
      state.lastSpeakerRole = 'none';
      dom.playerDeck.dataset.speaker = 'none';
      if (dom.mobileMiniPlayer) dom.mobileMiniPlayer.dataset.speaker = 'none';
    });

    window.addEventListener('pagehide', (e) => {
      stopPolling();
      stopElapsedTimer();
      cancelScheduledSubtitleScroll();
      if (state.mobileMiniRaf) {
        window.cancelAnimationFrame(state.mobileMiniRaf);
        state.mobileMiniRaf = 0;
      }
      if (state.extractTimer) {
        window.clearInterval(state.extractTimer);
        state.extractTimer = null;
      }
      if (state.polishTimer) {
        window.clearInterval(state.polishTimer);
        state.polishTimer = null;
      }
      if (state.updateCheck.startupTimer) {
        window.clearTimeout(state.updateCheck.startupTimer);
        state.updateCheck.startupTimer = null;
      }
      state.extractAbortController?.abort();
      state.styleRecommendAbortController?.abort();
      state.polishAbortController?.abort();
      state.assignModal.suggestAbortController?.abort();
      dom.mainAudio.pause();
      if (e.persisted) {
        state.audioEngine?.suspend?.();
      } else {
        state.audioEngine?.dispose?.();
      }
    });

    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      updateMobileMiniVisibility();
      if (hasActiveRunningTask()) {
        startPolling();
        pollCurrentTask();
      }
    });

    dom.btnSettings.addEventListener('click', () => openSettingsModal('llm'));
    if (dom.btnUpdateBadge) dom.btnUpdateBadge.addEventListener('click', () => openUpdateModal(dom.btnUpdateBadge));
    if (dom.btnCloseUpdateModal) dom.btnCloseUpdateModal.addEventListener('click', () => closeUpdateModal());
    if (dom.btnDismissUpdateModal) dom.btnDismissUpdateModal.addEventListener('click', () => closeUpdateModal());
    if (dom.btnIgnoreUpdateVersion) {
      dom.btnIgnoreUpdateVersion.addEventListener('click', () => {
        const latest = state.updateCheck.result?.latestVersion;
        if (latest) {
          writeStorage(STORAGE_KEYS.ignoredUpdateVersion, latest);
        }
        renderUpdateBadge();
        const openedFromSettings = Boolean(dom.settingsModal && !dom.settingsModal.classList.contains('hidden'));
        closeUpdateModal({ returnFocus: openedFromSettings });
        showToast(latest ? `已忽略 ${formatVersionLabel(latest)} 更新提醒` : '已忽略当前版本提醒');
      });
    }
    if (dom.updateModal) {
      dom.updateModal.addEventListener('click', (e) => {
        if (e.target === dom.updateModal) closeUpdateModal();
      });
    }
    if (dom.settingAutoCheckUpdates) {
      dom.settingAutoCheckUpdates.addEventListener('change', () => {
        const enabled = Boolean(dom.settingAutoCheckUpdates.checked);
        writeStorage(STORAGE_KEYS.autoCheckUpdates, enabled ? '1' : '0');
        if (!enabled && state.updateCheck.startupTimer) {
          window.clearTimeout(state.updateCheck.startupTimer);
          state.updateCheck.startupTimer = null;
        }
      });
    }
    if (dom.btnCheckUpdatesNow) {
      dom.btnCheckUpdatesNow.addEventListener('click', () => {
        checkForUpdates({ force: true, silent: false });
      });
    }
    if (dom.btnLanCompanion) dom.btnLanCompanion.addEventListener('click', openLanCompanionModal);
    if (dom.btnCloseLanCompanionModal) dom.btnCloseLanCompanionModal.addEventListener('click', closeLanCompanionModal);
    if (dom.lanCompanionModal) {
      dom.lanCompanionModal.addEventListener('click', (e) => {
        if (e.target === dom.lanCompanionModal) closeLanCompanionModal();
      });
    }
    if (dom.btnStartLanCompanion) dom.btnStartLanCompanion.addEventListener('click', handleStartLanCompanion);
    if (dom.btnStopLanCompanion) dom.btnStopLanCompanion.addEventListener('click', handleStopLanCompanion);
    if (dom.btnRotateLanCompanion) dom.btnRotateLanCompanion.addEventListener('click', handleRotateLanCompanion);
    if (dom.btnCopyLanCompanionUrl) dom.btnCopyLanCompanionUrl.addEventListener('click', handleCopyLanCompanionUrl);
    if (dom.lanCompanionHostSelect) dom.lanCompanionHostSelect.addEventListener('change', handleSelectLanCompanionHost);
    dom.btnCloseSettings.addEventListener('click', closeSettingsModal);
    dom.btnCancelSettings.addEventListener('click', closeSettingsModal);
    dom.settingsForm.addEventListener('submit', saveSettings);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) closeSettingsModal();
    });

    if (dom.btnNewCollection) {
      dom.btnNewCollection.addEventListener('click', () => openCollectionModal({ mode: 'create' }));
    }
    if (dom.collectionFilterBar) {
      dom.collectionFilterBar.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-filter-id]');
        if (!pill || !dom.collectionFilterBar.contains(pill)) return;
        const nextFilter = pill.dataset.filterId || 'all';
        if (nextFilter === state.selectedCollectionFilter) return;
        state.selectedCollectionFilter = nextFilter;
        state.collectionDeleteConfirmId = null;
        state.collectionHighlightsExpanded = false;
        state.activeCollectionDetail = null;
        renderCollectionFilterBar();
        renderCollectionHeaderCard();
        renderHistoryList();
        if (nextFilter !== 'all' && nextFilter !== 'unassigned') {
          loadCollectionDetail(nextFilter);
        }
      });
    }
    if (dom.btnEditCollection) {
      dom.btnEditCollection.addEventListener('click', () => {
        const col = findCollectionById(state.selectedCollectionFilter);
        if (col) openCollectionModal({ mode: 'edit', collection: col });
      });
    }
    if (dom.btnDeleteCollection) {
      dom.btnDeleteCollection.addEventListener('click', () => {
        const col = findCollectionById(state.selectedCollectionFilter);
        if (!col) return;
        state.collectionDeleteConfirmId = col.id;
        renderCollectionHeaderCard();
      });
    }
    if (dom.btnCancelDeleteCollection) {
      dom.btnCancelDeleteCollection.addEventListener('click', () => {
        state.collectionDeleteConfirmId = null;
        renderCollectionHeaderCard();
      });
    }
    if (dom.btnConfirmDeleteCollection) {
      dom.btnConfirmDeleteCollection.addEventListener('click', handleConfirmDeleteCollection);
    }
    if (dom.btnToggleCollectionHighlights) {
      dom.btnToggleCollectionHighlights.addEventListener('click', () => {
        state.collectionHighlightsExpanded = !state.collectionHighlightsExpanded;
        renderCollectionHeaderCard();
        if (state.collectionHighlightsExpanded &&
            state.selectedCollectionFilter !== 'all' &&
            state.selectedCollectionFilter !== 'unassigned' &&
            state.activeCollectionDetail?.id !== state.selectedCollectionFilter) {
          loadCollectionDetail(state.selectedCollectionFilter);
        }
      });
    }
    if (dom.btnAssignCurrentCollection) {
      dom.btnAssignCurrentCollection.addEventListener('click', () => {
        if (state.currentPodcast?.id) openAssignCollectionModal(state.currentPodcast.id);
      });
    }

    if (dom.btnCloseCollectionModal) dom.btnCloseCollectionModal.addEventListener('click', closeCollectionModal);
    if (dom.btnCancelCollectionModal) dom.btnCancelCollectionModal.addEventListener('click', closeCollectionModal);
    if (dom.collectionForm) dom.collectionForm.addEventListener('submit', handleSaveCollectionModal);
    if (dom.collectionModal) {
      dom.collectionModal.addEventListener('click', (e) => {
        if (e.target === dom.collectionModal) closeCollectionModal();
      });
    }
    dom.collectionColorSwatches?.forEach((btn) => {
      btn.addEventListener('click', () => setCollectionModalColor(btn.dataset.collectionColor));
    });

    if (dom.btnCloseAssignModal) dom.btnCloseAssignModal.addEventListener('click', closeAssignCollectionModal);
    if (dom.assignCollectionModal) {
      dom.assignCollectionModal.addEventListener('click', (e) => {
        if (e.target === dom.assignCollectionModal) closeAssignCollectionModal();
      });
    }
    if (dom.btnSuggestCollection) dom.btnSuggestCollection.addEventListener('click', handleSuggestCollection);
    if (dom.assignCollectionList) {
      dom.assignCollectionList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-target-collection-id]');
        if (!btn || !dom.assignCollectionList.contains(btn)) return;
        const podcastId = state.assignModal.podcastId;
        if (!podcastId) return;
        assignPodcastToCollection(podcastId, btn.dataset.targetCollectionId || null);
      });
    }
    if (dom.quickCreateCollectionForm) {
      dom.quickCreateCollectionForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const podcastId = state.assignModal.podcastId;
        if (!podcastId) return;
        createCollectionAndAssign(podcastId, dom.quickCollectionNameInput?.value || '');
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dom.updateModal && !dom.updateModal.classList.contains('hidden')) {
        closeUpdateModal();
      } else if (dom.lanCompanionModal && !dom.lanCompanionModal.classList.contains('hidden')) {
        closeLanCompanionModal();
      } else if (dom.collectionModal && !dom.collectionModal.classList.contains('hidden')) {
        closeCollectionModal();
      } else if (dom.assignCollectionModal && !dom.assignCollectionModal.classList.contains('hidden')) {
        closeAssignCollectionModal();
      } else if (!dom.settingsModal.classList.contains('hidden')) {
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
    dom.ttsSpeedButtons?.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modalTtsSpeedChanged = true;
        selectTtsSpeedInModal(btn.dataset.ttsSpeed);
      });
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
    updatePodcastStyleUI();
    updateTextCounter();
    renderImageSelection();
    bindEvents();
    positionTabIndicator(true);

    await Promise.all([loadTtsProviders(), loadHistoryList(), refreshLanCompanionStatus({ silent: true })]);
    await restoreActiveTaskIfAny();

    if (!state.currentPodcast && state.historyItems.length > 0) {
      await handleSelectHistory(state.historyItems[0].id);
    }
    if (!state.currentPodcast) {
      resetPlayerToEmptyState();
    }

    if (isAutoUpdateCheckEnabled()) {
      state.updateCheck.startupTimer = window.setTimeout(() => {
        state.updateCheck.startupTimer = null;
        if (!isAutoUpdateCheckEnabled()) return;
        checkForUpdates({ force: false, silent: true });
      }, 1500);
    }
  }

  window.addEventListener('DOMContentLoaded', bootstrap);
})();
