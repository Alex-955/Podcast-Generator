/**
 * AI 妙听播客生成器 - 交互原型控制器 (A1 收尾精修版本)
 * 严格遵循 A-F1, A-F2, A-D1, A-D2, A-D3, A-D4 修复规范
 */

// 全局状态与版本管理 (A-F2 防串线)
let currentRunId = 0;
let activeTimers = [];
let activeInputTab = 'url';
let currentConfirmedDraft = null; // 当前已成功解析并确认的草稿对象
let inputDraftVersion = 0;        // 用户修改输入时的版本计数器
let currentRenderedArticle = null;// 确认卡当前展示的文章对象
let isSummaryExpanded = false;

// 播放器状态
let currentLoadedTask = null;
let isPlaying = false;
let playClockTimer = null;
let currentPlaybackTime = 0;
let currentPlaybackRate = 1.0;
const playbackRates = [1.0, 1.25, 1.5, 2.0];

// 定时器安全注册与清除 (A-F1/A-F2)
function registerTimeout(fn, delay) {
  const thisRun = currentRunId;
  const timer = setTimeout(() => {
    if (thisRun === currentRunId) {
      fn();
    }
  }, delay);
  activeTimers.push(timer);
  return timer;
}

function clearAllTimers() {
  activeTimers.forEach(t => clearTimeout(t));
  activeTimers = [];
  if (playClockTimer) {
    clearInterval(playClockTimer);
    playClockTimer = null;
  }
}

// XSS 安全转义 (A-D4)
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 顶部演示场景快速切换
function triggerScenario(sceneKey) {
  currentRunId++;
  clearAllTimers();
  pausePlayback();
  resetAllPanels();

  // 更新顶部场景按钮高亮
  const sceneBtns = {
    'happy': 'btn-scene-happy',
    'antispider': 'btn-scene-antispider',
    'tts_error': 'btn-scene-tts-error'
  };
  Object.keys(sceneBtns).forEach(k => {
    const btn = document.getElementById(sceneBtns[k]);
    if (btn) btn.classList.toggle('active', k === sceneKey);
  });

  if (sceneKey === 'happy') {
    switchInputTab('url');
    const urlInput = document.getElementById('input-url');
    if (urlInput) urlInput.value = window.MOCK_DATA.happyArticle.url;
    handleParseArticle();
  } else if (sceneKey === 'antispider') {
    switchInputTab('url');
    const urlInput = document.getElementById('input-url');
    if (urlInput) urlInput.value = 'https://mp.weixin.qq.com/s/sample-antispider-blocked';
    runAntiSpiderScenario();
  } else if (sceneKey === 'tts_error') {
    switchInputTab('url');
    const urlInput = document.getElementById('input-url');
    if (urlInput) urlInput.value = window.MOCK_DATA.happyArticle.url;
    runTtsStallScenario();
  }
}

// 标签页切换 (文章链接 / 直接粘贴正文)
function switchInputTab(tab) {
  activeInputTab = tab;
  const tabUrl = document.getElementById('tab-url');
  const tabText = document.getElementById('tab-text');
  const panelUrl = document.getElementById('panel-input-url');
  const panelText = document.getElementById('panel-input-text');

  if (tab === 'url') {
    if (tabUrl) { tabUrl.classList.add('active'); tabUrl.setAttribute('aria-selected', 'true'); }
    if (tabText) { tabText.classList.remove('active'); tabText.setAttribute('aria-selected', 'false'); }
    if (panelUrl) panelUrl.style.display = 'block';
    if (panelText) panelText.style.display = 'none';
  } else {
    if (tabUrl) { tabUrl.classList.remove('active'); tabUrl.setAttribute('aria-selected', 'false'); }
    if (tabText) { tabText.classList.add('active'); tabText.setAttribute('aria-selected', 'true'); }
    if (panelUrl) panelUrl.style.display = 'none';
    if (panelText) panelText.style.display = 'block';
    const textInput = document.getElementById('input-raw-text');
    if (textInput) {
      textInput.focus();
      updateRawTextLengthIndicator(textInput.value.length);
    }
  }
}

// 输入内容变化监听 (A-F2: 关键防串线处理)
function handleInputChange() {
  inputDraftVersion++;
  currentConfirmedDraft = null; // 立即销毁旧草稿快照！禁止用失效内容启动生成！

  // 立即隐藏确认卡并给出提示
  const confirmBox = document.getElementById('box-confirm-article');
  if (confirmBox) confirmBox.style.display = 'none';

  // 清除旧错误与校验横幅
  hideValidationMsg();
  hideErrorCallout();

  // 若在正文模式，更新字数统计指示器
  if (activeInputTab === 'text') {
    const textInput = document.getElementById('input-raw-text');
    if (textInput) updateRawTextLengthIndicator(textInput.value.length);
  }
}

function updateRawTextLengthIndicator(len) {
  const indicator = document.getElementById('text-length-indicator');
  if (indicator) {
    indicator.innerText = `已输入 ${len} 字`;
    indicator.style.color = len < 20 ? '#f87171' : (len < 50 ? '#fbbf24' : '#64748b');
  }
}

// 校验横幅操作
function showValidationMsg(text, type = 'error') {
  const msgEl = document.getElementById('input-validation-msg');
  if (!msgEl) return;
  msgEl.innerText = text;
  msgEl.className = `validation-msg ${type}`;
  msgEl.style.display = 'flex';
}

function hideValidationMsg() {
  const msgEl = document.getElementById('input-validation-msg');
  if (msgEl) {
    msgEl.style.display = 'none';
    msgEl.innerText = '';
  }
}

// 解析文章链接 (URL 模式)
function handleParseArticle() {
  if (activeInputTab === 'text') {
    handleParseRawText();
    return;
  }

  const thisRun = currentRunId;
  const urlInput = document.getElementById('input-url');
  const url = urlInput ? urlInput.value.trim() : '';

  hideValidationMsg();
  hideErrorCallout();

  if (!url) {
    showValidationMsg('文章链接不能为空，请输入有效的微信公众号或网页 URL', 'error');
    return;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    showValidationMsg('链接格式无效，必须以 http:// 或 https:// 开头', 'error');
    return;
  }

  const btn = document.getElementById('btn-parse-article');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '正在抓取正文...';
  }

  registerTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔍 解析文章';
    }
    if (thisRun !== currentRunId) return;

    // 匹配 Mock 样本或根据 URL 动态构造文章信息
    let articleData;
    if (url.includes('sample-multimodal-agent')) {
      articleData = JSON.parse(JSON.stringify(window.MOCK_DATA.happyArticle));
    } else {
      articleData = {
        title: '网页文章：' + url.split('/').pop().slice(0, 24),
        source: '在线网页提取',
        wordCount: 2180,
        estimatedDuration: '01:40',
        summary: '本文系统讨论了大模型与智能体系统的核心演进方向，重点聚焦端侧多模态协同与流式音频处理架构，展望未来技术在跨模态落地中的关键瓶颈与优化实践。',
        fullText: '本文系统讨论了大模型与智能体系统的核心演进方向，重点聚焦端侧多模态协同与流式音频处理架构，展望未来技术在跨模态落地中的关键瓶颈与优化实践。\n\n第一部分深入分析端侧部署的能耗与发热平衡，针对当前主流芯片在 INT4 量化下的算力消耗进行了实测对比。\n\n第二部分着重探讨全双工语音交互背后的低延迟链路，提出基于客户端状态预测与服务端分片合成的混合架构，在弱网环境下将首包延迟压缩至 400ms 以内。\n\n第三部分围绕人机对话中的语气承托与打断容错设计，给出了双角色对话模型生成的原则与启发式规则。',
        isTruncated: false
      };
    }

    // 绑定为当前有效草稿快照 (A-F2)
    currentConfirmedDraft = {
      version: ++inputDraftVersion,
      ...articleData
    };

    renderConfirmBox(currentConfirmedDraft);
  }, 600);
}

// 解析纯文本正文 (Text 模式)
function handleParseRawText() {
  const thisRun = currentRunId;
  const rawInput = document.getElementById('input-raw-text');
  const text = rawInput ? rawInput.value.trim() : '';

  hideValidationMsg();
  hideErrorCallout();

  if (!text) {
    showValidationMsg('正文内容不能为空，请先粘贴文章正文', 'error');
    const confirmBox = document.getElementById('box-confirm-article');
    if (confirmBox) confirmBox.style.display = 'none';
    return;
  }

  if (text.length < 20) {
    showValidationMsg(`当前正文仅 ${text.length} 字，内容过少无法提取有效论点，请至少输入 20 字以上内容`, 'error');
    const confirmBox = document.getElementById('box-confirm-article');
    if (confirmBox) confirmBox.style.display = 'none';
    return;
  }

  const btn = document.getElementById('btn-parse-raw-text');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '正在校验正文...';
  }

  registerTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔍 解析并确认';
    }
    if (thisRun !== currentRunId) return;

    // 动态提取正文元数据 (A-D3)
    const firstLine = text.split('\n')[0].replace(/^[#\s\d.-]+/, '').trim();
    const derivedTitle = firstLine ? firstLine.slice(0, 32) + (firstLine.length > 32 ? '...' : '') : '手动输入正文对话生成';
    const estSeconds = Math.max(30, Math.min(180, Math.round(text.length * 0.4)));
    const estMin = Math.floor(estSeconds / 60);
    const estSec = estSeconds % 60;
    const estDurationStr = `${String(estMin).padStart(2, '0')}:${String(estSec).padStart(2, '0')}`;

    currentConfirmedDraft = {
      version: ++inputDraftVersion,
      title: derivedTitle,
      source: '剪贴板 / 直接粘贴正文',
      wordCount: text.length,
      estimatedDuration: estDurationStr,
      summary: text.slice(0, 150) + (text.length > 150 ? '...' : ''),
      fullText: text,
      isTruncated: false
    };

    renderConfirmBox(currentConfirmedDraft);
  }, 400);
}

// 渲染解析确认卡片 (A-D3 全文展开与字数警示)
function renderConfirmBox(article) {
  currentRenderedArticle = article;
  isSummaryExpanded = false;

  const box = document.getElementById('box-confirm-article');
  if (!box) return;

  const titleEl = document.getElementById('confirm-article-title');
  const sourceEl = document.getElementById('confirm-source');
  const wordsEl = document.getElementById('confirm-words');
  const durEl = document.getElementById('confirm-duration');
  const shortWarnEl = document.getElementById('confirm-short-warning');
  const summaryEl = document.getElementById('confirm-summary');
  const toggleBtn = document.getElementById('btn-toggle-summary');

  if (titleEl) titleEl.innerText = article.title;
  if (sourceEl) sourceEl.innerText = article.source;
  if (wordsEl) wordsEl.innerText = `检测到 ${article.wordCount} 字`;
  if (durEl) durEl.innerText = `预计生成播客 ${article.estimatedDuration || '约 1 分钟'}`;

  // 短正文黄色警示
  if (shortWarnEl) {
    if (article.wordCount < 50) {
      shortWarnEl.style.display = 'flex';
      shortWarnEl.innerText = `⚠️ 当前正文仅 ${article.wordCount} 字，篇幅较短，重构生成的双人对话可能会较精简。`;
    } else {
      shortWarnEl.style.display = 'none';
    }
  }

  // A-D3: 正文预览与全文展开逻辑
  if (summaryEl) {
    summaryEl.innerText = article.summary || '';
    summaryEl.classList.remove('expanded');
  }

  if (toggleBtn) {
    if (article.fullText && article.fullText.length > 150) {
      toggleBtn.style.display = 'inline-block';
      toggleBtn.innerText = article.isTruncated ? '展开正文摘要 ▼' : '展开全文预览 ▼';
    } else {
      toggleBtn.style.display = 'none';
    }
  }

  box.style.display = 'block';
}

// A-D3: 切换正文全文 / 摘要展开
function toggleSummaryExpand() {
  if (!currentRenderedArticle) return;
  const summaryEl = document.getElementById('confirm-summary');
  const toggleBtn = document.getElementById('btn-toggle-summary');
  if (!summaryEl || !toggleBtn) return;

  if (isSummaryExpanded) {
    // 收起为摘要
    summaryEl.innerText = currentRenderedArticle.summary;
    summaryEl.classList.remove('expanded');
    toggleBtn.innerText = currentRenderedArticle.isTruncated ? '展开正文摘要 ▼' : '展开全文预览 ▼';
    isSummaryExpanded = false;
  } else {
    // 真实展开为完整文本 (A-D3 彻底修复)
    summaryEl.innerText = currentRenderedArticle.fullText || currentRenderedArticle.summary;
    summaryEl.classList.add('expanded');
    toggleBtn.innerText = '收起全文 ▲';
    isSummaryExpanded = true;
  }
}

// 模拟场景二：微信防爬拦截 (A-D1/A-F2)
function runAntiSpiderScenario() {
  const thisRun = currentRunId;
  const btn = document.getElementById('btn-parse-article');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '正在抓取公众号文章...';
  }

  registerTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔍 解析文章';
    }
    if (thisRun !== currentRunId) return;

    showErrorCallout(
      '[ERR_FETCH_ANTISPIDER] 该链接触发目标平台防爬验证',
      '检测到微信公众号防爬环境拦截校验，无法直接抓取全文。建议直接复制微信正文并粘贴。',
      'antispider'
    );
  }, 600);
}

// 主动作：切换到正文粘贴 Tab (不自动写入伪造内容，由用户掌控)
function handleSwitchToRawTextTab() {
  hideErrorCallout();
  switchInputTab('text');
}

// 辅助演示动作：填入降级示例正文 (明确标注为演示模式)
function handleFillDemoText() {
  hideErrorCallout();
  switchInputTab('text');
  const textInput = document.getElementById('input-raw-text');
  if (textInput) {
    textInput.value = window.MOCK_DATA.antiSpiderError.sampleFallbackText;
    updateRawTextLengthIndicator(textInput.value.length);
  }
  showValidationMsg('【演示模式】已填入反爬降级示例正文。请点击“解析并确认”核对字数。', 'warning');
}

function handleRetryStep() {
  hideErrorCallout();
  handleParseArticle();
}

// 启动生成流水线 (A-F2: 严格校验当前草稿快照，不可变冻结)
function handleStartGenerate() {
  if (!currentConfirmedDraft) {
    showValidationMsg('当前输入尚未解析或已发生变更，请先点击“解析”确认后再开始生成', 'error');
    return;
  }

  // 冻结当前生成的不可变快照 (A-F2 核心保证)
  const activePayload = Object.freeze(JSON.parse(JSON.stringify(currentConfirmedDraft)));
  const thisRun = ++currentRunId;
  clearAllTimers();

  showProgressCard();
  resetProgressSteps();
  hideErrorCallout();
  hideValidationMsg();

  // 隐藏确认卡，避免生成中途误操作
  const confirmBox = document.getElementById('box-confirm-article');
  if (confirmBox) confirmBox.style.display = 'none';

  // 阶段 1: 抓取正文验证
  setStepStatus('step-fetch', 'active', '处理中');
  updateProgressPhaseText('阶段 1/4: 抓取与清洗正文', '耗时 1.1s', true);

  registerTimeout(() => {
    if (thisRun !== currentRunId) return;
    setStepStatus('step-fetch', 'done', '完成');

    // 阶段 2: 剧本重构
    setStepStatus('step-script', 'active', '处理中');
    updateProgressPhaseText('阶段 2/4: LLM 双人对话剧本重构', '耗时 2.4s', true);

    registerTimeout(() => {
      if (thisRun !== currentRunId) return;
      setStepStatus('step-script', 'done', '完成');

      // 阶段 3: 逐句 TTS 合成 (A-D2: 严格展示 completedSegments / totalSegments)
      setStepStatus('step-tts', 'active', '合成中');
      const dialogues = window.MOCK_DATA.happyArticle.dialogues;
      const totalSegments = dialogues.length;
      let currentSegment = 0;

      function synthesizeNextSentence() {
        if (thisRun !== currentRunId) return;
        if (currentSegment < totalSegments) {
          const d = dialogues[currentSegment];
          const speakerName = d.role === 'host' ? '阿泽' : '小晓';
          
          // A-D2 进度语义：阶段内已完成计数
          updateProgressPhaseText(
            `阶段 3/4: 语音合成 · 正在合成第 ${currentSegment + 1}/${totalSegments} 句 (${speakerName}: ${d.tone})`,
            `已完成 ${currentSegment}/${totalSegments} 句`,
            false,
            Math.round((currentSegment / totalSegments) * 100)
          );

          currentSegment++;
          registerTimeout(synthesizeNextSentence, 450);
        } else {
          // TTS 完成
          setStepStatus('step-tts', 'done', '完成');

          // 阶段 4: 音频拼接与对齐校验 (A-D2 不定进度条动画)
          setStepStatus('step-merge', 'active', '拼接中');
          updateProgressPhaseText('阶段 4/4: 音频切片拼接与时间戳校验', '耗时 0.6s', true);

          registerTimeout(() => {
            if (thisRun !== currentRunId) return;
            setStepStatus('step-merge', 'done', '完成');
            hideProgressCard();

            // 载入生成的播客任务到播放器
            const finalTask = {
              id: `task-gen-${Date.now()}`,
              title: activePayload.title,
              duration: window.MOCK_DATA.happyArticle.duration,
              durationSeconds: window.MOCK_DATA.happyArticle.durationSeconds,
              dialogues: dialogues
            };
            loadPodcastToPlayer(finalTask);
            togglePlay();
          }, 700);
        }
      }

      synthesizeNextSentence();
    }, 1200);
  }, 800);
}

// 模拟场景三：TTS 中断与断点恢复 (A-D2)
function runTtsStallScenario() {
  const thisRun = ++currentRunId;
  clearAllTimers();

  showProgressCard();
  resetProgressSteps();
  hideErrorCallout();

  setStepStatus('step-fetch', 'done', '完成');
  setStepStatus('step-script', 'done', '完成');
  setStepStatus('step-tts', 'active', '合成中');

  const dialogues = window.MOCK_DATA.ttsStallScenario.partialDialogues;
  const totalSegments = window.MOCK_DATA.ttsStallScenario.totalSegments;
  let currentSegment = 0;

  function runPartialTTS() {
    if (thisRun !== currentRunId) return;
    if (currentSegment < dialogues.length) {
      const d = dialogues[currentSegment];
      const speakerName = d.role === 'host' ? '阿泽' : '小晓';
      
      updateProgressPhaseText(
        `阶段 3/4: 语音合成 · 正在合成第 ${currentSegment + 1}/${totalSegments} 句 (${speakerName}: ${d.tone})`,
        `已完成 ${currentSegment}/${totalSegments} 句`,
        false,
        Math.round((currentSegment / totalSegments) * 100)
      );

      currentSegment++;
      registerTimeout(runPartialTTS, 400);
    } else {
      // 触发限流超时中断
      setStepStatus('step-tts', 'error', '超时挂起');
      const retryRow = document.getElementById('progress-retry-status');
      if (retryRow) {
        retryRow.style.display = 'block';
        retryRow.innerText = '⏳ 正在进行自动重试 (第 2/3 次)，已等待 12s...';
      }

      registerTimeout(() => {
        if (thisRun !== currentRunId) return;
        if (retryRow) retryRow.style.display = 'none';

        const failedIndex = window.MOCK_DATA.ttsStallScenario.failedIndex; // 3 (0-based)
        showErrorCallout(
          `[ERR_TTS_TIMEOUT] 语音合成响应超时 (第 ${failedIndex + 1} 句)`,
          `合成第 ${failedIndex + 1} 句 (小晓) 时 TTS 供应商响应超时。前 ${failedIndex} 句音频已完整缓存，支持断点快速续跑。`,
          'tts_stall'
        );
      }, 900);
    }
  }

  runPartialTTS();
}

// 从断点续跑 TTS
function handleResumeTtsStep() {
  const thisRun = ++currentRunId;
  clearAllTimers();
  hideErrorCallout();

  const retryRow = document.getElementById('progress-retry-status');
  if (retryRow) retryRow.style.display = 'none';

  setStepStatus('step-tts', 'active', '续跑中');
  const remaining = window.MOCK_DATA.ttsStallScenario.remainingDialogues;
  const totalSegments = window.MOCK_DATA.ttsStallScenario.totalSegments;
  let currentIndex = window.MOCK_DATA.ttsStallScenario.failedIndex; // 从索引 3 (第 4 句) 续跑
  let rIdx = 0;

  function synthesizeResumeNext() {
    if (thisRun !== currentRunId) return;
    if (rIdx < remaining.length) {
      const d = remaining[rIdx];
      const speakerName = d.role === 'host' ? '阿泽' : '小晓';

      updateProgressPhaseText(
        `阶段 3/4: 语音合成 · 正在断点合成第 ${currentIndex + 1}/${totalSegments} 句 (${speakerName}: ${d.tone})`,
        `已完成 ${currentIndex}/${totalSegments} 句`,
        false,
        Math.round((currentIndex / totalSegments) * 100)
      );

      currentIndex++;
      rIdx++;
      registerTimeout(synthesizeResumeNext, 450);
    } else {
      setStepStatus('step-tts', 'done', '完成');
      setStepStatus('step-merge', 'active', '拼接中');
      updateProgressPhaseText('阶段 4/4: 音频切片拼接与时间戳校验', '耗时 0.6s', true);

      registerTimeout(() => {
        if (thisRun !== currentRunId) return;
        setStepStatus('step-merge', 'done', '完成');
        hideProgressCard();

        const recoveredTask = {
          id: 'task-recovered',
          title: window.MOCK_DATA.happyArticle.title,
          duration: window.MOCK_DATA.happyArticle.duration,
          durationSeconds: window.MOCK_DATA.happyArticle.durationSeconds,
          dialogues: [
            ...window.MOCK_DATA.ttsStallScenario.partialDialogues,
            ...window.MOCK_DATA.ttsStallScenario.remainingDialogues
          ]
        };
        loadPodcastToPlayer(recoveredTask);
        togglePlay();
      }, 700);
    }
  }

  synthesizeResumeNext();
}

// 取消当前播客生成 (A-D4 文案严谨性)
function handleCancelGeneration() {
  currentRunId++;
  clearAllTimers();
  hideProgressCard();
  resetProgressSteps();

  // A-D4: 诚实文案，不宣称“后台资源已释放”
  showValidationMsg('已取消当前播客生成。模拟任务已停止。', 'warning');
}

// 载入播客任务至播放器 (A-D1, A-D3)
function loadPodcastToPlayer(task) {
  currentLoadedTask = task;
  pausePlayback();
  currentPlaybackTime = 0;

  const titleEl = document.getElementById('player-podcast-title');
  const badgeEl = document.getElementById('player-status-badge');
  const errorBanner = document.getElementById('player-error-banner');
  const scrubber = document.getElementById('player-scrubber');
  const playBtn = document.getElementById('btn-play-toggle');
  const durLabel = document.getElementById('total-time-label');
  const curLabel = document.getElementById('current-time-label');
  const seekBack = document.getElementById('btn-seek-back');
  const seekFwd = document.getElementById('btn-seek-forward');
  const speedBtn = document.getElementById('btn-speed-toggle');
  const copyBtn = document.getElementById('btn-copy-script');
  const exportBtn = document.getElementById('btn-export-mp3');

  if (titleEl) titleEl.innerText = task.title || '-- 暂无播放内容 --';

  // 检查是否为异常损坏用例
  if (task.isCorrupted) {
    if (badgeEl) { badgeEl.innerText = '音频异常'; badgeEl.style.color = '#f87171'; }
    if (errorBanner) {
      errorBanner.style.display = 'flex';
      const msg = errorBanner.querySelector('#player-error-msg');
      if (msg) msg.innerText = task.errorMessage || '本地音频文件缺失或格式损坏';
    }
    if (scrubber) scrubber.disabled = true;
    if (playBtn) playBtn.disabled = true;
    if (seekBack) seekBack.disabled = true;
    if (seekFwd) seekFwd.disabled = true;
    if (speedBtn) speedBtn.disabled = true;
    if (copyBtn) copyBtn.disabled = true;
    if (exportBtn) exportBtn.disabled = true;
    renderDialogues([]);
    return;
  }

  // 正常任务就绪
  if (errorBanner) errorBanner.style.display = 'none';
  if (badgeEl) { badgeEl.innerText = '就绪 (可播放)'; badgeEl.style.color = '#34d399'; }
  if (durLabel) durLabel.innerText = task.duration || '00:00';
  if (curLabel) curLabel.innerText = '00:00';
  if (scrubber) {
    scrubber.disabled = false;
    scrubber.min = 0;
    scrubber.max = task.durationSeconds || 48;
    scrubber.value = 0;
  }
  if (playBtn) playBtn.disabled = false;
  if (seekBack) seekBack.disabled = false;
  if (seekFwd) seekFwd.disabled = false;
  if (speedBtn) speedBtn.disabled = false;
  if (copyBtn) copyBtn.disabled = false;
  if (exportBtn) exportBtn.disabled = false;

  renderDialogues(task.dialogues || []);
}

// 渲染对话字幕 (A-D4: 严格 escapeHtml 避免 XSS / HTML 解析漏洞)
function renderDialogues(dialogues) {
  const container = document.getElementById('dialogue-container');
  if (!container) return;
  container.innerHTML = '';

  if (!dialogues || dialogues.length === 0) {
    const tip = document.createElement('div');
    tip.id = 'dialogue-empty-tip';
    tip.style.cssText = 'color: #64748b; font-size: 13px; text-align: center; margin-top: 60px;';
    tip.innerText = '暂无剧本，请在左侧解析并生成播客，或从历史列表中选择载入。';
    container.appendChild(tip);
    return;
  }

  dialogues.forEach((d, idx) => {
    const bubble = document.createElement('div');
    bubble.className = `dialogue-bubble ${d.role}`;
    bubble.id = `bubble-${idx}`;
    bubble.tabIndex = 0;
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('aria-label', `跳转到 ${formatTime(d.start)}: ${d.speaker} 说: ${d.text}`);

    bubble.onclick = () => jumpToTime(d.start);
    bubble.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        jumpToTime(d.start);
      }
    };

    // A-D4: 严格使用 escapeHtml 转义所有字符串
    const safeSpeaker = escapeHtml(d.speaker || (d.role === 'host' ? '阿泽 (主持人)' : '小晓 (行业洞察)'));
    const safeTone = escapeHtml(d.tone || '自然');
    const safeText = escapeHtml(d.text || '');

    bubble.innerHTML = `
      <div class="bubble-meta">
        <span class="bubble-speaker ${escapeHtml(d.role)}">${safeSpeaker}</span>
        <span class="bubble-tone">${safeTone}</span>
      </div>
      <div class="bubble-text">${safeText}</div>
      <div style="font-size: 10px; color: #64748b; margin-top: 4px; display: flex; justify-content: space-between;">
        <span>${formatTime(d.start)} - ${formatTime(d.end)}</span>
        <span>点击跳播 ⏩</span>
      </div>
    `;
    container.appendChild(bubble);
  });
}

// 播放控制与时钟模拟
function togglePlay() {
  if (!currentLoadedTask || currentLoadedTask.isCorrupted) return;
  if (isPlaying) {
    pausePlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  isPlaying = true;
  const playBtn = document.getElementById('btn-play-toggle');
  if (playBtn) {
    playBtn.innerText = '⏸';
    playBtn.setAttribute('aria-label', '暂停');
  }

  const badgeEl = document.getElementById('player-status-badge');
  if (badgeEl) { badgeEl.innerText = '播放中'; badgeEl.style.color = '#38bdf8'; }

  if (playClockTimer) clearInterval(playClockTimer);
  playClockTimer = setInterval(() => {
    currentPlaybackTime += 0.25 * currentPlaybackRate;
    const maxDur = currentLoadedTask.durationSeconds || 48;

    if (currentPlaybackTime >= maxDur) {
      currentPlaybackTime = maxDur;
      updatePlayerClock(currentPlaybackTime);
      pausePlayback();
      return;
    }

    updatePlayerClock(currentPlaybackTime);
  }, 250);
}

function pausePlayback() {
  isPlaying = false;
  if (playClockTimer) {
    clearInterval(playClockTimer);
    playClockTimer = null;
  }

  const playBtn = document.getElementById('btn-play-toggle');
  if (playBtn) {
    playBtn.innerText = '▶';
    playBtn.setAttribute('aria-label', '播放');
  }

  const badgeEl = document.getElementById('player-status-badge');
  if (badgeEl && currentLoadedTask && !currentLoadedTask.isCorrupted) {
    badgeEl.innerText = '已暂停';
    badgeEl.style.color = '#94a3b8';
  }

  updateSpeakerAvatars(null);
}

function seekBy(seconds) {
  if (!currentLoadedTask || currentLoadedTask.isCorrupted) return;
  const maxDur = currentLoadedTask.durationSeconds || 48;
  currentPlaybackTime = Math.max(0, Math.min(maxDur, currentPlaybackTime + seconds));
  updatePlayerClock(currentPlaybackTime);
}

function jumpToTime(timestamp) {
  if (!currentLoadedTask || currentLoadedTask.isCorrupted) return;
  currentPlaybackTime = timestamp;
  updatePlayerClock(currentPlaybackTime);
  if (!isPlaying) startPlayback();
}

function handleScrub(val) {
  currentPlaybackTime = parseFloat(val);
  updatePlayerClock(currentPlaybackTime);
}

function updatePlayerClock(time) {
  const curLabel = document.getElementById('current-time-label');
  const scrubber = document.getElementById('player-scrubber');

  if (curLabel) curLabel.innerText = formatTime(time);
  if (scrubber) scrubber.value = time;

  syncDialogueWithClock(time);
}

function syncDialogueWithClock(time) {
  if (!currentLoadedTask || !currentLoadedTask.dialogues) return;

  let activeRole = null;
  currentLoadedTask.dialogues.forEach((d, idx) => {
    const bubble = document.getElementById(`bubble-${idx}`);
    if (!bubble) return;

    if (time >= d.start && time <= d.end) {
      bubble.classList.add('active');
      activeRole = d.role;
      // 自动滚动到激活字幕
      bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      bubble.classList.remove('active');
    }
  });

  updateSpeakerAvatars(activeRole);
}

function updateSpeakerAvatars(speakingRole) {
  const hostAvatar = document.getElementById('avatar-host');
  const guestAvatar = document.getElementById('avatar-guest');
  const waveBars = document.getElementById('waveform-bars');

  if (hostAvatar) hostAvatar.classList.toggle('speaking', speakingRole === 'host');
  if (guestAvatar) guestAvatar.classList.toggle('speaking', speakingRole === 'guest');

  if (waveBars) {
    const bars = waveBars.querySelectorAll('span');
    bars.forEach(bar => {
      bar.style.animationPlayState = speakingRole ? 'running' : 'paused';
    });
  }
}

function cycleSpeed() {
  const idx = playbackRates.indexOf(currentPlaybackRate);
  const nextIdx = (idx + 1) % playbackRates.length;
  currentPlaybackRate = playbackRates[nextIdx];

  const btn = document.getElementById('btn-speed-toggle');
  if (btn) btn.innerText = `${currentPlaybackRate.toFixed(1)}x`;
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function handleReloadCurrentTask() {
  if (currentLoadedTask) {
    loadPodcastToPlayer(currentLoadedTask);
  }
}

// 渲染历史记录列表 (A-D1 原生 <button> 键盘无障碍访问)
function renderRecentTasksList() {
  const container = document.getElementById('recent-tasks-container');
  if (!container || !window.MOCK_DATA || !window.MOCK_DATA.recentTasks) return;

  container.innerHTML = '';
  window.MOCK_DATA.recentTasks.forEach(task => {
    const btn = document.createElement('button');
    btn.className = 'recent-task-item';
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', `载入历史任务: ${task.title}, 时长 ${task.duration}`);

    btn.onclick = () => {
      loadPodcastToPlayer(task);
      if (!task.isCorrupted) togglePlay();
    };

    const isErr = task.isCorrupted;
    btn.innerHTML = `
      <div class="task-info">
        <div class="task-title" style="${isErr ? 'color: #f87171;' : ''}">${escapeHtml(task.title)}</div>
        <div class="task-meta">${escapeHtml(task.time)} · 时长 ${escapeHtml(task.duration)} ${isErr ? '· <span style="color: #f87171;">音频损坏</span>' : ''}</div>
      </div>
      <span class="task-action-link" style="${isErr ? 'color: #f87171;' : ''}">${isErr ? '查看详情 ⚠️' : '载入播放 ▶'}</span>
    `;
    container.appendChild(btn);
  });
}

// 流水线卡片与阶段辅助 (A-D2 进度语义)
function showProgressCard() {
  const card = document.getElementById('card-progress');
  if (card) card.style.display = 'block';
}

function hideProgressCard() {
  const card = document.getElementById('card-progress');
  if (card) card.style.display = 'none';
}

function resetProgressSteps() {
  ['step-fetch', 'step-script', 'step-tts', 'step-merge'].forEach(id => {
    setStepStatus(id, 'waiting', '等待');
  });
  const fill = document.getElementById('progress-fill');
  if (fill) {
    fill.className = 'progress-bar-fill';
    fill.style.width = '0%';
  }
}

function setStepStatus(stepId, state, statusText) {
  const step = document.getElementById(stepId);
  const statusSpan = document.getElementById(`${stepId}-status`);
  if (!step) return;

  step.className = `step-item ${state}`;
  if (statusSpan) statusSpan.innerText = statusText;
}

// A-D2 进度展示核心更新器：彻底移除伪百分比
function updateProgressPhaseText(phaseName, metricText, isIndeterminate = false, ttsPercentage = null) {
  const msgEl = document.getElementById('progress-msg');
  const counterEl = document.getElementById('progress-counter');
  const fillEl = document.getElementById('progress-fill');

  if (msgEl) msgEl.innerText = phaseName;
  if (counterEl) counterEl.innerText = metricText || '';

  if (fillEl) {
    if (isIndeterminate) {
      fillEl.className = 'progress-bar-fill indeterminate';
      fillEl.style.width = '100%';
    } else {
      fillEl.className = 'progress-bar-fill';
      fillEl.style.width = `${ttsPercentage || 0}%`;
    }
  }
}

// 错误横幅展示
function showErrorCallout(title, msg, type) {
  const box = document.getElementById('box-error-callout');
  const titleEl = document.getElementById('error-title');
  const textEl = document.getElementById('error-text');
  const antiActions = document.getElementById('actions-antispider');
  const ttsActions = document.getElementById('actions-tts-stall');

  if (!box) return;
  if (titleEl) titleEl.innerText = title;
  if (textEl) textEl.innerText = msg;

  if (antiActions) antiActions.style.display = type === 'antispider' ? 'flex' : 'none';
  if (ttsActions) ttsActions.style.display = type === 'tts_stall' ? 'flex' : 'none';

  box.style.display = 'block';
}

function hideErrorCallout() {
  const box = document.getElementById('box-error-callout');
  if (box) box.style.display = 'none';
}

function resetAllPanels() {
  hideProgressCard();
  hideErrorCallout();
  hideValidationMsg();
  currentConfirmedDraft = null;
  const confirmBox = document.getElementById('box-confirm-article');
  if (confirmBox) confirmBox.style.display = 'none';
}

// 复制剧本 Markdown
function copyScriptMarkdown() {
  if (!currentLoadedTask || !currentLoadedTask.dialogues) return;
  const md = currentLoadedTask.dialogues.map(d => `**${d.speaker}** (${d.tone}): ${d.text}`).join('\n\n');
  navigator.clipboard.writeText(md).then(() => {
    alert('【原型模拟】播客剧本 Markdown 已复制到剪贴板！');
  }).catch(() => {
    alert('复制失败，请检查剪贴板权限');
  });
}

function handleExportMp3() {
  alert('【原型模拟】已触发本地生成的 MP3 音频切片流导出。');
}

// 统一的原型初始化函数 (A-F1)
function initPrototype() {
  renderRecentTasksList();
  // 默认装载一个演示播客到播放器供用户即时试听体验
  if (window.MOCK_DATA && window.MOCK_DATA.recentTasks && window.MOCK_DATA.recentTasks.length > 0) {
    loadPodcastToPlayer(window.MOCK_DATA.recentTasks[0]);
  }
}

// 导出全局函数供 HTML 与 DOM 事件无障碍调用 (A-F1 严格核对真实存在的方法)
if (typeof window !== 'undefined') {
  window.initPrototype = initPrototype;
  window.triggerScenario = triggerScenario;
  window.switchInputTab = switchInputTab;
  window.handleInputChange = handleInputChange;
  window.handleParseArticle = handleParseArticle;
  window.handleParseRawText = handleParseRawText;
  window.toggleSummaryExpand = toggleSummaryExpand;
  window.handleStartGenerate = handleStartGenerate;
  window.handleCancelGeneration = handleCancelGeneration;
  window.handleSwitchToRawTextTab = handleSwitchToRawTextTab;
  window.handleFillDemoText = handleFillDemoText;
  window.handleRetryStep = handleRetryStep;
  window.handleResumeTtsStep = handleResumeTtsStep;
  window.loadPodcastToPlayer = loadPodcastToPlayer;
  window.handleReloadCurrentTask = handleReloadCurrentTask;
  window.togglePlay = togglePlay;
  window.seekBy = seekBy;
  window.handleScrub = handleScrub;
  window.cycleSpeed = cycleSpeed;
  window.jumpToTime = jumpToTime;
  window.copyScriptMarkdown = copyScriptMarkdown;
  window.handleExportMp3 = handleExportMp3;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPrototype);
  } else {
    initPrototype();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initPrototype,
    triggerScenario,
    switchInputTab,
    handleInputChange,
    handleParseArticle,
    handleParseRawText,
    handleStartGenerate,
    handleCancelGeneration,
    loadPodcastToPlayer,
    escapeHtml
  };
}
