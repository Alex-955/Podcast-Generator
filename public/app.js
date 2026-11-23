// 示例文章数据库
const SAMPLES = {
  ai: {
    title: 'AI 智能体 Agent 正在重构现代个人工作流',
    content: `随着大语言模型推理能力的跃升，AI 不再只是问答机器，而是演化为具备自主规划、工具调用与协作能力的智能体。在传统认知中，人类需要学习各种复杂的工具软件；而在智能体时代，工具主动适应人类的意图。
智能体的核心价值在于“解耦认知与执行”。比如在过去的写作流程中，收集资料、校对格式、排版发布都需要消耗大量精力。现在，一个经过精心编排的智能体可以同时调用网络搜索、阅读长文档、提炼核心论点，并直接生成结构化内容。
然而，智能体并不是万能的。它的真正护城河依然在人类的输入——即深刻的领域经验、品味与判断力。正如很多行业专家所指出的那样：“AI 不会取代人，但善用 AI 智能体的人会迅速拉开与普通人的差距。”`,
  },
  deepseek: {
    title: 'DeepSeek 的技术突围：算力性价比与架构创新',
    content: `近年来，全球大模型领域一直被庞大的算力军备竞赛所主导。然而，DeepSeek 的横空出世打破了这一固有格局。通过在模型架构（如 MoE 混合专家模型、MLA 多头潜在注意力）以及训练策略上的深度极致优化，它实现了以远低于硅谷同行的算力成本，逼近甚至超越顶尖闭源模型的性能。
更关键的是，DeepSeek 采取了极度开放和普惠的 API 定价策略。它让原本高昂的百万 token 推理成本降低到了人民币几毛钱甚至几分钱的级别。这极大降低了全球中小团队、独立开发者将 AI 融入日常产品的门槛。
对于广大普通用户和开发者来说，底层模型的性价比变革，意味着我们可以更肆无忌惮地让 AI 帮我们进行长文转播客、多轮对抗推演、代码全自动重构等高耗能任务，而完全不必担心钱包承受不起。`,
  },
  work: {
    title: '数字游民时代的“自由”真相：自律才是终极生产力',
    content: `随着远程办公常态化与在线协作工具的成熟，“背着电脑环游世界”的数字游民生活方式吸引了无数年轻人。海滩边的咖啡馆、雪山脚下的民宿，似乎成了打破写字楼工位禁锢的乌托邦。
但真正经历过半年以上游民生活的人会告诉你，这种看似浪漫的背后隐藏着剧烈的熵增：时区混乱、网络波动、社交孤独感，以及因为缺乏固定作息带来的拖延与焦虑。
真正的自由绝不是随心所欲，而是建立在极高自我管理意识上的自律。那些能够长期维持游民状态并持续创造高价值收入的人，无一例外都拥有一套近乎严苛的个人操作系统：固定的深度工作时段、模块化的任务管理，以及清晰的工作生活边界。`,
  },
};

// 替换原生阻塞性 alert，使用轻量优雅 toast
function showToast(msg, type = 'info') {
  let toast = document.getElementById('toast-notification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.style.position = 'fixed';
    toast.style.top = '24px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '30px';
    toast.style.background = 'rgba(24, 28, 48, 0.95)';
    toast.style.border = '1px solid rgba(99, 102, 241, 0.5)';
    toast.style.color = '#fff';
    toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
    toast.style.zIndex = '99999';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '500';
    toast.style.transition = 'all 0.3s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.pointerEvents = 'auto';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
  }, 3500);
}
const state = {
  apiKey: localStorage.getItem('ai_podcast_apikey') || '',
  baseURL: localStorage.getItem('ai_podcast_baseurl') || 'https://api.deepseek.com',
  model: localStorage.getItem('ai_podcast_model') || 'deepseek-flash',
  currentPodcast: null,
  isPlaying: false,
  playbackRate: 1.0,
  activeSentenceIndex: -1,
  bgmVolume: 0.15, // 播客背景音量（柔和避让）
  // B0-1：输入来源状态机（唯一事实来源/操作互斥/过期结果丢弃），见 inputSource.js
  input: InputSource.createState(),
};

// DOM 元素引用
const dom = {
  btnSettings: document.getElementById('btnSettings'),
  apiKeyStatusDot: document.getElementById('apiKeyStatusDot'),
  settingsModal: document.getElementById('settingsModal'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  settingApiKey: document.getElementById('settingApiKey'),
  settingBaseUrl: document.getElementById('settingBaseUrl'),
  settingModel: document.getElementById('settingModel'),

  tabBtns: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tab-content'),
  inputUrl: document.getElementById('inputUrl'),
  btnFetchUrl: document.getElementById('btnFetchUrl'),
  inputTitle: document.getElementById('inputTitle'),
  inputText: document.getElementById('inputText'),
  bgmSelect: document.getElementById('bgmSelect'),
  chips: document.querySelectorAll('.chip'),

  btnOneClick: document.getElementById('btnOneClick'),
  btnOnlyScript: document.getElementById('btnOnlyScript'),
  statusContainer: document.getElementById('statusContainer'),
  statusMessage: document.getElementById('statusMessage'),
  progressBar: document.getElementById('progressBar'),

  scriptSection: document.getElementById('scriptSection'),
  podcastSummary: document.getElementById('podcastSummary'),
  dialogueList: document.getElementById('dialogueList'),
  btnRegenerateAudio: document.getElementById('btnRegenerateAudio'),

  mainAudio: document.getElementById('mainAudioPlayer'),
  bgmAudio: document.getElementById('bgmAudioPlayer'),
  waveVisualizer: document.getElementById('waveVisualizer'),
  currentPodcastTitle: document.getElementById('currentPodcastTitle'),
  currentPodcastMeta: document.getElementById('currentPodcastMeta'),
  currentTime: document.getElementById('currentTime'),
  totalDuration: document.getElementById('totalDuration'),
  seekSlider: document.getElementById('seekSlider'),
  btnPlayPause: document.getElementById('btnPlayPause'),
  playIcon: document.getElementById('playIcon'),
  pauseIcon: document.getElementById('pauseIcon'),
  btnRewind10: document.getElementById('btnRewind10'),
  btnForward10: document.getElementById('btnForward10'),
  btnSpeed: document.getElementById('btnSpeed'),
  btnDownloadAudio: document.getElementById('btnDownloadAudio'),
  subtitlesList: document.getElementById('subtitlesList'),
};

// 初始化
function init() {
  bindEvents();
  updateApiKeyStatus();

  // 恢复配置输入框
  dom.settingApiKey.value = state.apiKey;
  dom.settingBaseUrl.value = state.baseURL;
  dom.settingModel.value = state.model;
}

// 绑定交互事件
function bindEvents() {
  // 设置弹窗
  dom.btnSettings.addEventListener('click', () => {
    dom.settingsModal.classList.remove('hidden');
  });
  dom.btnCloseSettings.addEventListener('click', () => {
    dom.settingsModal.classList.add('hidden');
  });
  dom.btnSaveSettings.addEventListener('click', saveSettings);

  // 标签页切换（同时更新事实来源模式：链接 Tab = URL 模式，文字 Tab = 文本模式）
  dom.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 示例文章点击填充
  dom.chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const sampleKey = chip.dataset.sample;
      const sample = SAMPLES[sampleKey];
      if (sample) {
        // 自动切换到文字输入 Tab 并填充
        dom.tabBtns[1].click();
        dom.inputTitle.value = sample.title;
        dom.inputText.value = sample.content;
      }
    });
  });

  // 解析 URL
  dom.btnFetchUrl.addEventListener('click', handleFetchUrl);

  // B0-1：手动编辑输入即切换事实来源——编辑链接回到 URL 模式（已解析正文作废），
  // 编辑正文切到文本模式（此后生成以正文为准）。程序化填充不会触发 input 事件。
  dom.inputUrl.addEventListener('input', () => switchTab('tab-url'));
  dom.inputText.addEventListener('input', () => switchTab('tab-text'));

  // 一键生成播客
  dom.btnOneClick.addEventListener('click', handleOneClickGenerate);

  // 仅生成剧本
  dom.btnOnlyScript.addEventListener('click', handleOnlyScriptGenerate);

  // 按修改后剧本重新配音
  dom.btnRegenerateAudio.addEventListener('click', handleRegenerateAudio);

  // 音频播放器相关事件
  dom.btnPlayPause.addEventListener('click', togglePlayPause);
  dom.btnRewind10.addEventListener('click', () => seekRelative(-10));
  dom.btnForward10.addEventListener('click', () => seekRelative(10));
  dom.btnSpeed.addEventListener('click', toggleSpeed);

  dom.seekSlider.addEventListener('input', () => {
    const seekTo = (dom.seekSlider.value / 100) * (dom.mainAudio.duration || 0);
    dom.currentTime.textContent = formatTime(seekTo);
  });

  dom.seekSlider.addEventListener('change', () => {
    const seekTo = (dom.seekSlider.value / 100) * (dom.mainAudio.duration || 0);
    dom.mainAudio.currentTime = seekTo;
  });

  dom.mainAudio.addEventListener('timeupdate', onAudioTimeUpdate);
  dom.mainAudio.addEventListener('loadedmetadata', onAudioLoadedMetadata);
  dom.mainAudio.addEventListener('ended', onAudioEnded);
  dom.mainAudio.addEventListener('play', () => {
    setPlayState(true);
    // 主音频开始播放时同步启动 BGM（修复生成后 BGM 从不播放的问题）
    startBgm();
  });
  dom.mainAudio.addEventListener('pause', () => {
    setPlayState(false);
    stopBgm();
  });

  dom.bgmSelect.addEventListener('change', onBgmChange);
}

// 检查 API Key 状态
function updateApiKeyStatus() {
  if (state.apiKey && state.apiKey.trim()) {
    dom.apiKeyStatusDot.classList.add('configured');
    dom.apiKeyStatusDot.title = 'DeepSeek API Key 已配置';
  } else {
    dom.apiKeyStatusDot.classList.remove('configured');
    dom.apiKeyStatusDot.title = '尚未配置 API Key，点击设置';
  }
}

// 保存设置
function saveSettings() {
  state.apiKey = dom.settingApiKey.value.trim();
  state.baseURL = dom.settingBaseUrl.value.trim() || 'https://api.deepseek.com';
  state.model = dom.settingModel.value.trim() || 'deepseek-flash';

  localStorage.setItem('ai_podcast_apikey', state.apiKey);
  localStorage.setItem('ai_podcast_baseurl', state.baseURL);
  localStorage.setItem('ai_podcast_model', state.model);

  updateApiKeyStatus();
  dom.settingsModal.classList.add('hidden');
  showToast('设置已保存');
}

// 提取文章 URL 内容（B0-1：解析结果按 seq + URL 配对应用，过期结果不覆盖当前输入）
async function handleFetchUrl() {
  const url = dom.inputUrl.value.trim();
  if (!url) {
    showToast('请输入有效的文章或公众号链接');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast('请粘贴以 http 开头的完整链接；正文请切换到「直接贴文字」粘贴');
    showStatus('链接格式不正确：请粘贴完整的 http(s) 链接；若想用文章正文，请切换到「直接贴文字」标签', 0);
    return;
  }

  const opSeq = InputSource.beginOperation(state.input, url);
  if (opSeq === null) {
    showToast('已有任务在进行中，请稍候');
    return;
  }
  setBusyButtons(true);
  showStatus('正在解析网页正文...', 30);
  try {
    const res = await fetch('/api/extract-article', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error);

    // 过期结果（URL 已被改/期间有过新操作/已切文本模式）一律丢弃，不覆盖用户当前输入
    const applied = InputSource.applyParseResult(state.input, {
      seq: opSeq,
      url,
      currentUrl: dom.inputUrl.value,
      title: result.data.title,
      content: result.data.content,
    });
    if (applied !== 'applied') {
      showStatus('输入已变化，已丢弃过期的解析结果', 0);
      showToast('输入已变化，解析结果未套用；请重新点击「解析文章」');
      return;
    }

    // 填充到文字框并切换过去供用户确认（此后文本框成为生成的事实来源）
    dom.inputTitle.value = result.data.title;
    dom.inputText.value = result.data.content;
    switchTab('tab-text');

    if (result.data.truncated) {
      showToast('文章较长，已截取前 1.2 万字用于生成播客');
    }
    showStatus('文章解析成功！可检查标题与正文后生成播客', 100);
    setTimeout(hideStatus, 1500);
  } catch (err) {
    showStatus('解析失败: ' + err.message, 0);
    showToast('解析文章失败: ' + err.message);
  } finally {
    InputSource.finishOperation(state.input, opSeq);
    setBusyButtons(false);
  }
}

// 切换输入标签页（同时更新 InputSource 的事实来源模式）
function switchTab(tabId) {
  dom.tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  dom.tabContents.forEach((c) => c.classList.toggle('active', c.id === tabId));
  InputSource.setMode(state.input, tabId === 'tab-url' ? 'url' : 'text');
}

// 解析/生成期间统一禁用动作按钮，防止重复提交产生互相覆盖的并发任务
function setBusyButtons(busy) {
  dom.btnFetchUrl.disabled = busy;
  dom.btnOneClick.disabled = busy;
  dom.btnOnlyScript.disabled = busy;
  dom.btnRegenerateAudio.disabled = busy;
}

// 一键全流程生成（B0-1：输入按当前模式取唯一事实来源，显式不混用）
async function handleOneClickGenerate() {
  const input = getCurrentInputContent();
  if (!input.content && !input.url) {
    showToast('请提供文章链接或输入文章正文');
    return;
  }

  if (!state.apiKey) {
    dom.settingsModal.classList.remove('hidden');
    showToast('请先在右上角设置中填写你的 DeepSeek API Key 即可开始！');
    return;
  }

  const opSeq = InputSource.beginOperation(state.input, input.url);
  if (opSeq === null) {
    showToast('已有任务在进行中，请稍候');
    return;
  }
  setBusyButtons(true);
  showStatus(input.url ? '正在解析文章并生成双人播客剧本...' : '正在让大模型将文章重构为生动的双人播客剧本...', 35);

  try {
    const res = await fetch('/api/one-click-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        // 唯一事实来源：URL 模式只传 url，文本模式只传正文，绝不混用
        url: input.url,
        rawText: input.content,
        apiKey: state.apiKey,
        baseURL: state.baseURL,
        model: state.model,
      }),
    });

    const result = await res.json();
    if (!result.success) throw new Error(result.error);

    showStatus('播客生成完毕，正在载入播放器...', 100);
    loadPodcastData(result.data);
    renderScript(result.data.sentences, result.data.summary);
    if (result.data.sourceTruncated) {
      showToast('原文较长，本次播客基于截取的前 1.2 万字生成');
    }

    setTimeout(hideStatus, 1000);
  } catch (err) {
    console.error(err);
    // 错误持久显示在状态栏，不自动消失，避免用户不知道发生了什么
    showStatus('生成播客失败: ' + (err.message || '未知错误') + ' —— 可直接重试', 0);
    showToast('生成播客失败: ' + (err.message || '未知错误'));
  } finally {
    InputSource.finishOperation(state.input, opSeq);
    setBusyButtons(false);
  }
}

// 仅生成剧本（B0-1：输入按当前模式取唯一事实来源）
async function handleOnlyScriptGenerate() {
  const input = getCurrentInputContent();
  if (!input.content && !input.url) {
    showToast('请先解析文章链接，或直接输入文章内容');
    return;
  }

  if (!state.apiKey) {
    dom.settingsModal.classList.remove('hidden');
    showToast('请先填写 DeepSeek API Key');
    return;
  }

  const opSeq = InputSource.beginOperation(state.input, input.url);
  if (opSeq === null) {
    showToast('已有任务在进行中，请稍候');
    return;
  }
  setBusyButtons(true);
  showStatus('正在生成双人播客剧本草稿...', 50);
  try {
    const res = await fetch('/api/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        // 唯一事实来源：URL 模式只传 url，文本模式只传正文，绝不混用
        url: input.url,
        content: input.content,
        apiKey: state.apiKey,
        baseURL: state.baseURL,
        model: state.model,
      }),
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error);

    state.input.scriptTitle = result.data.podcastTitle || input.title || 'AI妙听播客';
    renderScript(result.data.dialogue, result.data.summary);
    if (result.data.sourceTruncated) {
      showToast('原文较长，剧本基于截取的前 1.2 万字生成');
    }
    showStatus('剧本生成完成！你可以随意编辑台词，然后点击下方重新配音', 100);
    setTimeout(hideStatus, 2000);
  } catch (err) {
    showStatus('生成剧本失败: ' + (err.message || '未知错误') + ' —— 可直接重试', 0);
    showToast('生成剧本失败: ' + (err.message || '未知错误'));
  } finally {
    InputSource.finishOperation(state.input, opSeq);
    setBusyButtons(false);
  }
}

// 按修改后的剧本重新配音（标题取 state.scriptTitle，不再读 DOM）
async function handleRegenerateAudio() {
  const items = document.querySelectorAll('.dialogue-item');
  const dialogue = [];
  items.forEach((item) => {
    const speaker = item.dataset.speaker;
    const text = item.querySelector('.dialogue-content').innerText.trim();
    if (text) {
      dialogue.push({ speaker, text });
    }
  });

  if (dialogue.length === 0) {
    showToast('剧本台词为空');
    return;
  }

  const opSeq = InputSource.beginOperation(state.input);
  if (opSeq === null) {
    showToast('已有任务在进行中，请稍候');
    return;
  }
  setBusyButtons(true);
  showStatus('正在使用 Edge-TTS 合成男女声对话音频并拼接...', 60);
  try {
    const res = await fetch('/api/synthesize-podcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        podcastTitle: state.input.scriptTitle || 'AI妙听播客',
        dialogue,
      }),
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error);

    loadPodcastData(result.data);
    showStatus('重新配音合成完成！', 100);
    setTimeout(hideStatus, 1500);
  } catch (err) {
    showStatus('合成失败: ' + (err.message || '未知错误') + ' —— 可直接重试', 0);
    showToast('合成失败: ' + (err.message || '未知错误'));
  } finally {
    InputSource.finishOperation(state.input, opSeq);
    setBusyButtons(false);
  }
}

// 获取当前生成输入（唯一事实来源：URL 模式用链接框，文本模式用正文框；显式不混用）
function getCurrentInputContent() {
  const input = InputSource.selectGenerationInput(state.input, {
    urlInput: dom.inputUrl.value,
    textTitle: dom.inputTitle.value,
    textContent: dom.inputText.value,
  });
  if (input.kind === 'url') {
    return { title: '', content: '', url: input.url };
  }
  return { title: input.title, content: input.content, url: '' };
}

// 载入生成的播客并准备播放
function loadPodcastData(podcastData) {
  state.currentPodcast = podcastData;
  // B0-1：记住剧本标题供「重新配音」使用；加载新数据时重置逐句高亮
  state.input.scriptTitle = podcastData.podcastTitle || 'AI妙听播客';
  state.activeSentenceIndex = -1;
  InputSource.resetPlaybackHighlight(state.input);

  dom.currentPodcastTitle.textContent = podcastData.podcastTitle || 'AI妙听双人播客';
  dom.currentPodcastMeta.textContent = `共 ${podcastData.sentences.length} 句对话 · 全长 ${formatTime(podcastData.totalDuration)}`;

  dom.mainAudio.src = podcastData.fullAudioUrl;
  dom.mainAudio.load();

  // 设置下载链接
  dom.btnDownloadAudio.href = podcastData.fullAudioUrl;
  dom.btnDownloadAudio.download = `${podcastData.podcastTitle || 'AI妙听播客'}.mp3`;
  dom.btnDownloadAudio.classList.remove('disabled');

  // 配置背景音乐
  setupBgm();

  // 渲染高亮对话字幕
  renderSubtitles(podcastData.sentences);

  // 自动开始播放
  dom.mainAudio.play().catch(() => {
    // 某些浏览器需要用户手势后才允许 autoplay
  });
}

// 渲染左侧可编辑剧本卡片
function renderScript(dialogue, summary) {
  dom.scriptSection.classList.remove('hidden');
  dom.podcastSummary.textContent = summary ? `【本期看点】${summary}` : '';
  dom.dialogueList.innerHTML = '';

  dialogue.forEach((line, idx) => {
    const isHost = line.speaker === '主持人' || line.speaker.includes('泽') || line.speaker === 'Host';
    const speakerName = isHost ? '阿泽' : '小晓';
    const speakerClass = isHost ? 'host' : 'guest';

    const item = document.createElement('div');
    item.className = 'dialogue-item';
    item.dataset.speaker = line.speaker;
    item.innerHTML = `
      <span class="dialogue-speaker ${speakerClass}">${speakerName}：</span>
      <div class="dialogue-content" contenteditable="true">${escapeHtml(line.text)}</div>
    `;
    dom.dialogueList.appendChild(item);
  });
}

// 渲染右侧滚动高亮字幕
function renderSubtitles(sentences) {
  dom.subtitlesList.innerHTML = '';

  sentences.forEach((s, idx) => {
    const isHost = s.speaker === '主持人' || s.speaker.includes('泽') || s.speaker === 'Host';
    const speakerName = isHost ? '阿泽' : '小晓';
    const bubbleClass = isHost ? 'host' : 'guest';

    const bubble = document.createElement('div');
    bubble.className = `subtitle-bubble ${bubbleClass}`;
    bubble.id = `sub-item-${idx}`;
    bubble.innerHTML = `
      <div class="subtitle-meta">
        <span class="subtitle-speaker">${speakerName}</span>
        <span class="subtitle-time">${formatTime(s.startTime)}</span>
      </div>
      <div class="subtitle-text">${escapeHtml(s.text)}</div>
    `;

    // 点击字幕直接跳转到对应时间点
    bubble.addEventListener('click', () => {
      dom.mainAudio.currentTime = s.startTime;
      if (dom.mainAudio.paused) {
        dom.mainAudio.play();
      }
    });

    dom.subtitlesList.appendChild(bubble);
  });
}

// 处理背景音乐
function startBgm() {
  if (dom.bgmSelect.value === 'none') return;
  if (!dom.bgmAudio.src) {
    dom.bgmAudio.src = '/audio/bgm/coffee_ambient.wav';
  }
  dom.bgmAudio.volume = state.bgmVolume;
  dom.bgmAudio.play().catch(() => {});
}

function stopBgm() {
  dom.bgmAudio.pause();
}

function setupBgm() {
  if (dom.bgmSelect.value === 'none') {
    stopBgm();
    dom.bgmAudio.removeAttribute('src');
  } else if (!dom.mainAudio.paused) {
    // 仅在主音频已经在播放时才启动；未播放时等 play 事件触发后再启动
    startBgm();
  }
}

function onBgmChange() {
  setupBgm();
}

// 音频时间进度更新
function onAudioTimeUpdate() {
  const cur = dom.mainAudio.currentTime || 0;
  const dur = dom.mainAudio.duration || 1;

  dom.currentTime.textContent = formatTime(cur);
  dom.seekSlider.value = (cur / dur) * 100;

  // 查找并高亮对应字幕
  if (state.currentPodcast && state.currentPodcast.sentences) {
    const sentences = state.currentPodcast.sentences;
    const currentIdx = sentences.findIndex((s) => cur >= s.startTime && cur < s.endTime);

    if (currentIdx !== -1 && currentIdx !== state.activeSentenceIndex) {
      state.activeSentenceIndex = currentIdx;

      // 更新高亮
      document.querySelectorAll('.subtitle-bubble').forEach((el, i) => {
        if (i === currentIdx) {
          el.classList.add('active');
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          el.classList.remove('active');
        }
      });
    }
  }
}

function onAudioLoadedMetadata() {
  dom.totalDuration.textContent = formatTime(dom.mainAudio.duration || 0);
}

function onAudioEnded() {
  setPlayState(false);
}

// 播放 / 暂停切换（BGM 跟随主音频的 play/pause 事件自动启停）
function togglePlayPause() {
  if (!dom.mainAudio.src) return;
  if (dom.mainAudio.paused) {
    dom.mainAudio.play();
  } else {
    dom.mainAudio.pause();
  }
}

function setPlayState(playing) {
  state.isPlaying = playing;
  if (playing) {
    dom.playIcon.classList.add('hidden');
    dom.pauseIcon.classList.remove('hidden');
    dom.waveVisualizer.classList.add('playing');
  } else {
    dom.playIcon.classList.remove('hidden');
    dom.pauseIcon.classList.add('hidden');
    dom.waveVisualizer.classList.remove('playing');
  }
}

function seekRelative(seconds) {
  if (!dom.mainAudio.src) return;
  dom.mainAudio.currentTime = Math.max(0, Math.min(dom.mainAudio.duration, dom.mainAudio.currentTime + seconds));
}

function toggleSpeed() {
  const speeds = [1.0, 1.25, 1.5, 1.75, 2.0];
  const nextIdx = (speeds.indexOf(state.playbackRate) + 1) % speeds.length;
  state.playbackRate = speeds[nextIdx];
  dom.mainAudio.playbackRate = state.playbackRate;
  dom.btnSpeed.textContent = `${state.playbackRate}x`;
}

// 状态提示条工具函数
function showStatus(text, progress = 0) {
  dom.statusContainer.classList.remove('hidden');
  dom.statusMessage.textContent = text;
  dom.progressBar.style.width = `${progress}%`;
}

function hideStatus() {
  dom.statusContainer.classList.add('hidden');
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

// 页面加载完成启动
window.addEventListener('DOMContentLoaded', init);
