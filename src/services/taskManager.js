const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./atomicWrite');
const { extractArticle, assertValidUrl, assertSafeFetchTarget } = require('./extractor');
const { generatePodcastScript } = require('./scriptEngine');
const { synthesizeDialogueScript, DEFAULT_VOICES } = require('./ttsService');
const { getTtsProvider } = require('./ttsProvider');
const { createTtsCache } = require('./ttsCache');
const { concatenateAudioFiles } = require('./audioMerger');
const { InputError, validateScriptRequest, validateVoiceMapping, redactSecrets } = require('./validation');

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const STAGES = {
  extract: [1, '抓取正文'], script: [2, '剧本重构'], tts: [3, '语音合成'],
  merge: [4, '音频拼接'], done: [4, '生成完成'],
};
const now = () => new Date().toISOString();
const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });

function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new InputError('无效的资源 ID');
}

function readDirectory(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function normalizeBaseURL(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputError('使用自定义接口地址时请提供对应的 API Key');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.href;
}

function getCredentials(payload) {
  const setting = value => typeof value === 'string' ? value.trim() : '';
  const requestKey = setting(payload.apiKey);
  const apiKey = requestKey || setting(process.env.DEEPSEEK_API_KEY);
  const requestURL = setting(payload.baseURL);
  const serverURL = setting(process.env.LLM_BASE_URL) || 'https://api.deepseek.com';
  if (!requestKey && requestURL && normalizeBaseURL(requestURL) !== normalizeBaseURL(serverURL)) {
    throw new InputError('使用自定义接口地址时请提供对应的 API Key');
  }
  return {
    apiKey,
    baseURL: requestKey && requestURL ? requestURL : serverURL,
    model: setting(payload.model) || setting(process.env.LLM_MODEL) || undefined,
  };
}

function assertNotRawUrl(content) {
  if (typeof content === 'string' && /^https?:\/\/\S+$/i.test(content.trim())) {
    throw new InputError('正文内容不能是一个链接，请先解析文章或直接粘贴文章正文');
  }
}

function getInput(payload) {
  if (payload.mode === 'url') {
    if (typeof payload.url !== 'string') throw new InputError('请输入文章链接');
    const url = assertValidUrl(payload.url);
    assertSafeFetchTarget(url);
    if (!URL.canParse(url)) throw new InputError('文章链接格式不正确');
    const { username, password } = new URL(url);
    if (username || password) throw new InputError('请使用不带登录凭据的文章链接');
    return { input: { mode: 'url', url, title: '', contentLength: 0, sourceTruncated: false }, sourceContent: '' };
  }
  if (payload.mode !== 'text') throw new InputError('mode 必须是 url 或 text');
  assertNotRawUrl(payload.content);
  const { title, content, truncated } = validateScriptRequest({ title: payload.title, content: payload.content });
  return { input: { mode: 'text', title, contentLength: content.length, sourceTruncated: truncated }, sourceContent: content };
}

function stageProgress(stage) {
  const [stageIndex, stageLabel] = STAGES[stage];
  return { stageIndex, totalStages: 4, stageLabel, message: stageLabel, currentSpeaker: null, stageStartedAt: now() };
}

function validTaskRecord(task, id) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasText = value => typeof value === 'string' && value.trim().length > 0;
  if (!object(task) || task.id !== id || !object(task.input) || !object(task.progress)) return false;
  if (task.voiceMapping != null && !object(task.voiceMapping)) return false;
  if (!['queued', 'running', 'failed', 'cancelled', 'completed'].includes(task.status)) return false;
  if (typeof task.stage !== 'string' || !Object.hasOwn(STAGES, task.stage)) return false;
  if (!['text', 'url'].includes(task.input.mode)) return false;
  if (task.script != null) {
    const lines = task.script.dialogue;
    return Array.isArray(lines) && lines.length > 0 && lines.every(line => hasText(line?.text));
  }
  return hasText(task.sourceContent) || (task.input.mode === 'url' && hasText(task.input.url));
}

function containsApiKey(apiKey, ...fields) {
  return Boolean(apiKey) && fields.some(value => typeof value === 'string' && value.includes(apiKey));
}

function assertScriptSafeToSave({ podcastTitle, summary, dialogue }, apiKey) {
  if (containsApiKey(apiKey, podcastTitle, summary) ||
      dialogue.some(line => containsApiKey(apiKey, line.text, line.emotion))) {
    throw new Error('模型返回内容包含敏感凭据，已拦截并中止保存');
  }
}

// Only persist public dialogue fields, including when reading older metadata.
function publicSentences(id, sentences) {
  return sentences.map(({ index, speaker, text, emotion, startTime, endTime, duration, fileName }) => ({
    index, speaker, text, emotion, startTime, endTime, duration, ...(fileName && {
      fileName: path.basename(fileName), audioUrl: `/podcasts/${id}/${encodeURIComponent(path.basename(fileName))}`,
    }),
  }));
}

function createTaskManager({
  tasksDir, podcastsDir, cacheDir, extractor = extractArticle, scriptGenerator = generatePodcastScript,
  ttsSynthesizer = synthesizeDialogueScript, audioMerger = concatenateAudioFiles, ttsProvider = getTtsProvider(),
}) {
  const cache = createTtsCache(cacheDir);
  let active = null;

  function save(task) {
    task.updatedAt = now();
    const record = { ...toDTO(task), sourceContent: task.sourceContent, script: task.script, voiceMapping: task.voiceMapping };
    atomicWrite(path.join(tasksDir, task.id + '.json'), JSON.stringify(record));
  }

  function readTask(id, { startup = false } = {}) {
    checkId(id);
    const file = path.join(tasksDir, id + '.json');
    if (!fs.existsSync(file)) throw httpError(404, '任务不存在');
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validTaskRecord(task, id)) throw new Error('任务记录无效');
    if (['queued', 'running'].includes(task.status) && active?.task.id !== id) {
      task.status = 'failed';
      task.error = {
        stage: task.stage, retryable: true, failedSegmentIndex: null,
        message: startup ? '服务已重启，上次生成被中断，可点击「从断点继续生成」恢复'
          : '上次生成已中断，可点击「从断点继续生成」恢复',
      };
      try {
        save(task);
      } catch {
        // The checkpoint stays readable on a read-only volume. A later read or resume retries the write.
      }
    }
    return task;
  }

  for (const entry of readDirectory(tasksDir)) {
    const id = path.basename(entry.name, '.json');
    if (!entry.isFile() || !entry.name.endsWith('.json') || !SAFE_ID.test(id)) continue;
    try {
      readTask(id, { startup: true });
    } catch {
      console.warn('启动恢复时跳过了一条无法读取的任务记录');
    }
  }

  function getPodcast(id) {
    checkId(id);
    const dir = path.join(podcastsDir, id);
    const missing = () => httpError(404, '播客不存在或尚未生成完成');
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw missing();
      const audio = fs.lstatSync(path.join(dir, 'full_podcast.mp3'));
      const metaFile = path.join(dir, 'meta.json');
      if (!audio.isFile() || !audio.size || !fs.lstatSync(metaFile).isFile()) throw missing();
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw missing();
      if (meta.sentences !== undefined && !Array.isArray(meta.sentences)) throw missing();
      const { podcastTitle, summary = '', sourceTruncated = false, createAt, totalDuration, sentenceGap, measurement } = meta;
      return {
        id, podcastTitle, summary, sourceTruncated, createAt, totalDuration, sentenceGap, measurement,
        fullAudioUrl: `/podcasts/${id}/full_podcast.mp3`, sentences: publicSentences(id, meta.sentences || []),
      };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError || error instanceof TypeError) throw missing();
      throw error;
    }
  }

  function listPodcasts() {
    const items = [];
    for (const entry of readDirectory(podcastsDir)) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try {
        const { id, podcastTitle, summary, createAt, totalDuration, sentences, fullAudioUrl } = getPodcast(entry.name);
        items.push({ id, podcastTitle, summary, createAt, totalDuration, sentenceCount: sentences.length, fullAudioUrl });
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
    return { items: items.sort((a, b) => (Date.parse(b.createAt) || 0) - (Date.parse(a.createAt) || 0)) };
  }

  function toDTO(task) {
    const { id, status, stage, input, progress, script, podcastId, error, createdAt, updatedAt } = task;
    return {
      id, status, stage, input: { ...input }, progress: { ...progress }, hasScript: Boolean(script),
      podcastTitle: script?.podcastTitle || '', summary: script?.summary || '', podcastId,
      podcast: status === 'completed' ? getPodcast(podcastId) : null, error, createdAt, updatedAt,
    };
  }

  function assertIdle() {
    if (active) throw httpError(409, '当前已有任务正在生成，请等待完成或先取消当前任务', 'TASK_ALREADY_RUNNING');
  }

  async function runPipeline(task, creds, signal) {
    const workDir = path.join(podcastsDir, task.id);
    function enter(stage) {
      signal.throwIfAborted();
      task.stage = stage;
      Object.assign(task.progress, stageProgress(stage));
      save(task);
    }
    try {
      task.status = 'running';
      if (!task.sourceContent && !task.script) {
        enter('extract');
        const article = await extractor({ url: task.input.url }, { signal });
        signal.throwIfAborted();
        if (containsApiKey(creds.apiKey, article.title, article.content)) {
          throw new Error('抓取内容包含敏感凭据，已拦截并中止保存');
        }
        const source = validateScriptRequest(article);
        task.sourceContent = source.content;
        Object.assign(task.input, {
          title: source.title, contentLength: source.content.length, sourceTruncated: Boolean(article.truncated || source.truncated),
        });
      }
      if (!task.script) {
        enter('script');
        const script = await scriptGenerator({
          title: task.input.title, content: task.sourceContent, ...creds, signal,
        });
        signal.throwIfAborted();
        assertScriptSafeToSave(script, creds.apiKey);
        const { podcastTitle, summary, dialogue } = script;
        task.script = {
          podcastTitle, summary,
          dialogue: dialogue.map(({ speaker, text, emotion, rate, pitch }) => ({ speaker, text, emotion, rate, pitch })),
        };
      }

      Object.assign(task.progress, { completedSegments: 0, totalSegments: task.script.dialogue.length, cachedSegments: 0 });
      enter('tts');
      fs.mkdirSync(workDir, { recursive: true });
      const result = await ttsSynthesizer(task.script.dialogue, workDir, task.voiceMapping || DEFAULT_VOICES, {
        provider: ttsProvider, cache, signal,
        onProgress({ index, completedSegments, totalSegments, cachedSegments, speaker }) {
          signal.throwIfAborted();
          const action = completedSegments > index ? '已完成' : '正在合成';
          Object.assign(task.progress, {
            completedSegments, totalSegments, cachedSegments, currentSpeaker: speaker,
            message: `${action}第 ${index + 1}/${totalSegments} 句（${speaker}）`,
          });
          save(task);
        },
      });

      enter('merge');
      const tempAudio = path.join(workDir, `.tmp-${randomUUID()}.mp3`);
      try {
        await audioMerger(result.dialogue.map(sentence => sentence.filePath), tempAudio);
        signal.throwIfAborted();
        fs.renameSync(tempAudio, path.join(workDir, 'full_podcast.mp3'));
      } finally {
        fs.rmSync(tempAudio, { force: true });
      }
      const meta = {
        id: task.id, podcastTitle: task.script.podcastTitle, summary: task.script.summary,
        sourceTruncated: task.input.sourceTruncated, createAt: now(), totalDuration: result.totalDuration,
        measurement: result.measurement, sentenceGap: result.sentenceGap,
        fullAudioUrl: `/podcasts/${task.id}/full_podcast.mp3`, sentences: publicSentences(task.id, result.dialogue),
      };
      atomicWrite(path.join(workDir, 'meta.json'), JSON.stringify(meta));
      task.status = 'completed';
      task.podcastId = task.id;
      enter('done');
    } catch (error) {
      // An immediate resume owns the new checkpoint while this cancelled run drains.
      if (active?.task !== task) return;
      if (signal.aborted || error.name === 'AbortError') {
        task.status = 'cancelled';
        task.error = null;
      } else {
        task.status = 'failed';
        task.error = {
          stage: task.stage, message: redactSecrets(error.path ? '本地文件读写失败' : error.message,
            [creds.apiKey, creds.baseURL, workDir, cacheDir, tasksDir]),
          retryable: true, failedSegmentIndex: error.segmentIndex ?? null,
        };
      }
      save(task);
    }
  }

  function start(task, creds) {
    save(task);
    const controller = new AbortController();
    // Resume may arrive before the cancelled provider has closed its stream.
    const ready = active?.finished || new Promise(resolve => setImmediate(resolve));
    const run = { task, controller };
    active = run;
    run.finished = ready.then(() => runPipeline(task, creds, controller.signal))
      .catch(() => console.error('任务状态写入失败，请检查数据目录'))
      .finally(() => { if (active === run) active = null; });
    return toDTO(task);
  }

  function createTask(payload = {}) {
    assertIdle();
    const creds = getCredentials(payload);
    if (containsApiKey(creds.apiKey, payload.title, payload.mode === 'url' ? payload.url : payload.content)) {
      throw new InputError('输入内容包含敏感凭据，已拦截并中止保存');
    }
    const source = getInput(payload);
    const mapping = validateVoiceMapping(payload.voiceMapping) || DEFAULT_VOICES;
    const voiceMapping = Object.fromEntries(Object.keys(DEFAULT_VOICES).map(speaker => [speaker, mapping[speaker] || DEFAULT_VOICES[speaker]]));
    if (!creds.apiKey) throw new InputError('缺少 API Key，请先配置后再生成');
    const task = {
      id: randomUUID(), status: 'queued', stage: 'extract', ...source, voiceMapping, script: null,
      progress: { ...stageProgress('extract'), message: '等待生成', completedSegments: 0, totalSegments: 0, cachedSegments: 0 },
      createdAt: now(), podcastId: null, error: null,
    };
    return start(task, creds);
  }

  function cancelTask(id) {
    const task = readTask(id);
    if (active?.task.id !== id || !['queued', 'running'].includes(task.status)) throw httpError(409, '任务已结束');
    active.controller.abort();
    active.task.status = 'cancelled';
    active.task.error = null;
    save(active.task);
    return toDTO(active.task);
  }

  function resumeTask(id, payload = {}) {
    const task = readTask(id);
    const drainingSameTask = active?.task.id === id && active.controller.signal.aborted;
    if (!drainingSameTask) assertIdle();
    if (!['failed', 'cancelled'].includes(task.status)) throw httpError(409, '当前任务状态无法续跑');
    const creds = getCredentials(payload);
    if (!task.script && !creds.apiKey) throw new InputError('尚未生成剧本，请先配置 API Key 后再继续');
    task.status = 'running';
    task.error = null;
    return start(task, creds);
  }

  return { createTask, getTask: id => toDTO(readTask(id)), cancelTask, resumeTask, listPodcasts, getPodcast };
}

module.exports = { createTaskManager };
