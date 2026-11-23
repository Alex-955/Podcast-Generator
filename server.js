require('dotenv').config();
// 说明：node-edge-tts 内部建立 TLS 连接、无法注入定制 agent，
// 本机证书链（公司代理/自签 CA）会导致 UNABLE_TO_GET_ISSUER_CERT_LOCALLY，
// 因此在服务入口临时关闭全局证书校验。仅限本地个人使用，部署到公网前必须移除。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { extractArticle } = require('./src/services/extractor');
const { generatePodcastScript, normalizeDialogue } = require('./src/services/scriptEngine');
const { synthesizeDialogueScript, AVAILABLE_VOICES, DEFAULT_VOICES } = require('./src/services/ttsService');
const { concatenateAudioFiles } = require('./src/services/audioMerger');
const { generateAmbientChordsWav } = require('./src/services/bgmGenerator');
const {
  InputError,
  validateScriptRequest,
  validateDialogueList,
  validateVoiceMapping,
  redactSecrets,
} = require('./src/services/validation');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态资源服务
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.join(__dirname, 'public', 'podcasts');
const BGM_DIR = path.join(__dirname, 'public', 'audio', 'bgm');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(BGM_DIR)) fs.mkdirSync(BGM_DIR, { recursive: true });

// 初始化生成一份默认 BGM
const defaultBgmPath = path.join(BGM_DIR, 'coffee_ambient.wav');
if (!fs.existsSync(defaultBgmPath)) {
  try {
    generateAmbientChordsWav(defaultBgmPath, 30);
  } catch (err) {
    console.error('生成默认 BGM 失败:', err);
  }
}

app.use(express.static(PUBLIC_DIR));

/**
 * 获取可用声音列表
 */
app.get('/api/voices', (req, res) => {
  res.json({
    success: true,
    voices: AVAILABLE_VOICES,
    defaultMapping: DEFAULT_VOICES,
  });
});

/**
 * 获取可用的 BGM 列表
 */
app.get('/api/bgm-list', (req, res) => {
  res.json({
    success: true,
    bgmList: [
      { id: 'coffee_ambient', name: '晨间咖啡·温暖电钢 (推荐)', url: '/audio/bgm/coffee_ambient.wav' },
      { id: 'none', name: '纯净人声 (无背景音乐)', url: '' },
    ],
  });
});

/**
 * 拦截把链接当作正文传进来的情况（LLM 拿到一个 URL 只能凭空编对话）
 */
function assertNotRawUrl(content) {
  if (typeof content === 'string' && /^https?:\/\/\S+$/i.test(content.trim())) {
    throw new InputError('正文内容不能是一个链接：请先点击「解析文章」提取正文，或直接粘贴文章正文文字');
  }
}

/**
 * B0-3 统一错误响应：输入错误 400 / 上游错误 502 / 内部错误 500；
 * 消息经脱敏，内部日志不输出堆栈（含本机路径）。
 */
function sendError(res, error, fallbackMessage) {
  const status = error && error.statusCode ? error.statusCode : 500;
  const raw = error && error.message ? error.message : fallbackMessage;
  const message = redactSecrets(raw || fallbackMessage);
  if (status >= 500) {
    console.error(redactSecrets(`[server] ${error && error.name ? error.name + ': ' : ''}${raw || error}`));
  }
  res.status(status).json({ success: false, error: message || fallbackMessage });
}

/** meta.json / 接口响应中剔除服务器内部绝对路径 */
function serializeSentences(sentences) {
  return sentences.map(({ filePath, ...rest }) => rest);
}

/**
 * 1. 抓取文章内容
 */
app.post('/api/extract-article', async (req, res) => {
  try {
    const { url, rawText } = req.body || {};
    if (url !== undefined && typeof url !== 'string') {
      throw new InputError('url 必须是文本');
    }
    if (rawText !== undefined && typeof rawText !== 'string') {
      throw new InputError('rawText 必须是文本');
    }
    const extracted = await extractArticle({ url, rawText });

    if (!extracted.content || !extracted.content.trim()) {
      throw new InputError(
        '未能提取到文章正文，可能需要登录/验证或链接已失效；也可以直接把文章正文粘贴到「直接贴文字」生成播客'
      );
    }

    res.json({
      success: true,
      data: extracted,
    });
  } catch (error) {
    sendError(res, error, '文章解析失败');
  }
});

/**
 * 2. 生成双人播客剧本
 */
app.post('/api/generate-script', async (req, res) => {
  try {
    const { title, content, url, apiKey, baseURL, model } = req.body || {};

    // 支持直接传链接：未解析过时先抓取正文
    let articleTitle = typeof title === 'string' ? title : '';
    let articleContent = typeof content === 'string' ? content : '';
    let sourceTruncated = false;
    if ((!articleContent || !articleContent.trim()) && url) {
      const extracted = await extractArticle({ url });
      articleTitle = articleTitle || extracted.title;
      articleContent = extracted.content;
      sourceTruncated = Boolean(extracted.truncated);
    }

    assertNotRawUrl(articleContent);

    // B0-3 校验 + 确定性截断（超长输入有确定结果）
    const validated = validateScriptRequest({ title: articleTitle, content: articleContent, url });

    const scriptData = await generatePodcastScript({
      title: validated.title,
      content: validated.content,
      apiKey: (typeof apiKey === 'string' && apiKey) || process.env.DEEPSEEK_API_KEY,
      baseURL: (typeof baseURL === 'string' && baseURL) || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
      model: (typeof model === 'string' && model) || process.env.LLM_MODEL || 'deepseek-flash',
    });

    res.json({
      success: true,
      data: { ...scriptData, sourceTruncated: sourceTruncated || validated.truncated },
    });
  } catch (error) {
    sendError(res, error, '剧本生成失败');
  }
});

/**
 * 3. 语音合成与播客生成全流程
 */
app.post('/api/synthesize-podcast', async (req, res) => {
  try {
    const { podcastTitle, dialogue, voiceMapping } = req.body || {};

    if (typeof podcastTitle === 'string' && podcastTitle.length > 200) {
      throw new InputError('标题超过 200 字上限');
    }

    // B-D1：先校验用户输入（非法行按 400 明确拒绝，不再静默丢行），再归一清洗；文件名只用内部 ID
    validateDialogueList(dialogue);
    const normalizedDialogue = normalizeDialogue(dialogue);
    const safeVoiceMapping = validateVoiceMapping(voiceMapping);

    const podcastId = uuidv4();
    const podcastWorkDir = path.join(STORAGE_DIR, podcastId);

    // 批量合成各句语音
    const synthResult = await synthesizeDialogueScript(
      normalizedDialogue,
      podcastWorkDir,
      safeVoiceMapping || DEFAULT_VOICES
    );

    // 合并完整音频（缺失/无效片段会抛错，不再静默跳过）
    const fullAudioFilename = 'full_podcast.mp3';
    const fullAudioPath = path.join(podcastWorkDir, fullAudioFilename);
    const audioFileList = synthResult.dialogue.map((s) => s.filePath);

    concatenateAudioFiles(audioFileList, fullAudioPath);

    // 构造对前端友好的播放路径
    const fullAudioUrl = `/podcasts/${podcastId}/${fullAudioFilename}`;
    const sentencesWithUrl = synthResult.dialogue.map((s) => ({
      ...s,
      audioUrl: `/podcasts/${podcastId}/${s.fileName}`,
    }));

    // 保存元数据便于归档或再次加载（不包含服务器内部绝对路径）
    const metaData = {
      id: podcastId,
      podcastTitle: podcastTitle || '未命名播客',
      createAt: new Date().toISOString(),
      totalDuration: synthResult.totalDuration,
      sentenceGap: synthResult.sentenceGap,
      measurement: synthResult.measurement,
      fullAudioUrl,
      sentences: serializeSentences(sentencesWithUrl),
    };
    fs.writeFileSync(path.join(podcastWorkDir, 'meta.json'), JSON.stringify(metaData, null, 2));

    res.json({
      success: true,
      data: metaData,
    });
  } catch (error) {
    sendError(res, error, '合成播客失败');
  }
});

/**
 * 快捷一键全自动生成端点：接收文章 -> 抓取 -> LLM 剧本 -> TTS 合成
 */
app.post('/api/one-click-generate', async (req, res) => {
  try {
    const { url, rawText, title, apiKey, baseURL, model, voiceMapping } = req.body || {};
    const safeVoiceMapping = validateVoiceMapping(voiceMapping);

    // 1. 内容解析（extractor 失败会抛出带指引的错误）
    let articleTitle = typeof title === 'string' ? title : '';
    let articleContent = typeof rawText === 'string' ? rawText : '';
    let truncated = false;

    if (url) {
      const extracted = await extractArticle({ url, rawText });
      articleTitle = articleTitle || extracted.title;
      articleContent = extracted.content;
      truncated = Boolean(extracted.truncated);
    }

    assertNotRawUrl(articleContent);

    // B0-3 校验 + 确定性截断
    const validated = validateScriptRequest({ title: articleTitle, content: articleContent, url });
    truncated = truncated || validated.truncated;

    // 2. 生成剧本
    const scriptData = await generatePodcastScript({
      title: validated.title,
      content: validated.content,
      apiKey: (typeof apiKey === 'string' && apiKey) || process.env.DEEPSEEK_API_KEY,
      baseURL: (typeof baseURL === 'string' && baseURL) || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
      model: (typeof model === 'string' && model) || process.env.LLM_MODEL || 'deepseek-flash',
    });

    // 3. 合成音频
    const podcastId = uuidv4();
    const podcastWorkDir = path.join(STORAGE_DIR, podcastId);
    const synthResult = await synthesizeDialogueScript(
      scriptData.dialogue,
      podcastWorkDir,
      safeVoiceMapping || DEFAULT_VOICES
    );

    // 4. 合并音频（缺失/无效片段会抛错，不再静默跳过）
    const fullAudioFilename = 'full_podcast.mp3';
    const fullAudioPath = path.join(podcastWorkDir, fullAudioFilename);
    const audioFileList = synthResult.dialogue.map((s) => s.filePath);
    concatenateAudioFiles(audioFileList, fullAudioPath);

    const fullAudioUrl = `/podcasts/${podcastId}/${fullAudioFilename}`;
    const sentencesWithUrl = synthResult.dialogue.map((s) => ({
      ...s,
      audioUrl: `/podcasts/${podcastId}/${s.fileName}`,
    }));

    const metaData = {
      id: podcastId,
      podcastTitle: scriptData.podcastTitle || validated.title || 'AI妙听播客',
      summary: scriptData.summary || '',
      sourceTruncated: truncated,
      createAt: new Date().toISOString(),
      totalDuration: synthResult.totalDuration,
      sentenceGap: synthResult.sentenceGap,
      measurement: synthResult.measurement,
      fullAudioUrl,
      sentences: serializeSentences(sentencesWithUrl),
      usage: scriptData.usage,
    };
    fs.writeFileSync(path.join(podcastWorkDir, 'meta.json'), JSON.stringify(metaData, null, 2));

    res.json({
      success: true,
      data: metaData,
    });
  } catch (error) {
    sendError(res, error, '一键生成失败');
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// B-D1：可测试导出——路由测试直接 require app，不起端口；命令行启动行为不变
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🎙️  AI 妙听播客生成器服务已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
