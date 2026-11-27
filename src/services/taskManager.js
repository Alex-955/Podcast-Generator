const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite } = require('./atomicWrite');
const { extractArticle, assertValidUrl, assertSafeFetchTarget } = require('./extractor');
const { generatePodcastScript, normalizePodcastStyle, PODCAST_STYLES } = require('./scriptEngine');
const { synthesizeDialogueScript, DEFAULT_VOICES, sentenceFileName, TTS_CHECKPOINT_FILENAME } = require('./ttsService');
const { getCredentials, llmSecrets, validateLlmSettings } = require('./llmCredentials');
const { redactProviderDetail } = require('./providerHttp');
const { getTtsCredentials, resolveVoiceMapping } = require('./ttsCredentials');
const { getTtsProvider, DEFAULT_PROVIDER_ID, resolveSpeechRate } = require('./ttsProvider');
const { SPEECH_SPEEDS, normalizeSpeechSpeed } = require('./speechNormalize');
const { createTtsCache, speechAccountHash } = require('./ttsCache');
const { concatenateAudioFiles } = require('./audioMerger');
const { InputError, validateEditedDialogue, validateScriptRequest, redactSecrets, ttsSecrets } = require('./validation');

const { isSafeVersion, assertPodcastVersion, publishEditedPodcast, reconcilePendingPublications } = require('./podcastPublication');

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SOURCE_TYPES = new Set(['url', 'text', 'image']);
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

function realPathIfExists(file) {
  try { return fs.realpathSync.native(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function sameFileSystemResource(a, b) {
  const left = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const right = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  if (!left || !right) return false;
  if (left.ino !== 0n && left.dev === right.dev && left.ino === right.ino) return true;
  const realLeft = realPathIfExists(a);
  return Boolean(realLeft && realLeft === realPathIfExists(b));
}

function readPodcastMetadata(dir, resolveTaskStatus) {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  reconcilePendingPublications(dir, resolveTaskStatus);
  const audio = fs.lstatSync(path.join(dir, 'full_podcast.mp3'), { throwIfNoEntry: false });
  const metaFile = path.join(dir, 'meta.json');
  if (!audio?.isFile() || !audio.size || !fs.lstatSync(metaFile, { throwIfNoEntry: false })?.isFile()) return;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta && typeof meta === 'object' && !Array.isArray(meta) &&
        (meta.sentences === undefined || (Array.isArray(meta.sentences) &&
          meta.sentences.every(item => item && typeof item === 'object' && !Array.isArray(item))))) return meta;
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
  }
}

function assertNotRawUrl(content) {
  if (typeof content === 'string' && /^https?:\/\/\S+$/i.test(content.trim())) {
    throw new InputError('正文内容不能是一个链接，请先解析文章或直接粘贴文章正文');
  }
}

function inferSourceType(mode) {
  return mode === 'url' ? 'url' : 'text';
}

function resolveSourceType({ mode, sourceType }) {
  if (sourceType === undefined) return inferSourceType(mode);
  if (typeof sourceType === 'string') {
    const type = sourceType.trim();
    if (SOURCE_TYPES.has(type)) return type;
  }
  throw new InputError('来源类型仅支持 url、text 或 image');
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
  if (task.targetPodcastId !== undefined &&
      (typeof task.targetPodcastId !== 'string' || !SAFE_ID.test(task.targetPodcastId) || !task.script)) return false;
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

function containsSecrets(secrets, ...fields) {
  function contains(value) {
    if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
    if (value && typeof value === 'object') return Object.values(value).some(contains);
    return false;
  }
  return fields.some(contains);
}

function clearAudio(dir) {
  if (!fs.existsSync(dir)) return;
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('任务音频目录无效');
  for (const entry of readDirectory(dir)) {
    if (!entry.isDirectory() && (/^sentence_.*\.mp3$/.test(entry.name) || entry.name === 'full_podcast.mp3' ||
        entry.name === TTS_CHECKPOINT_FILENAME)) {
      fs.unlinkSync(path.join(dir, entry.name));
    }
  }
}

function redactScriptField(value, sensitive) {
  return typeof value === 'string' ? redactProviderDetail(value, sensitive) : undefined;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function publicDate(value, sensitive) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    redactScriptField(value, sensitive) === value ? value : null;
}

function publicIdentifier(value, pattern, sensitive) {
  if (typeof value === 'string' && pattern.test(value) && redactScriptField(value, sensitive) === value) return value;
}

function metadataSecrets(record, baseSecrets) {
  const options = { includeDefaultBase: false };
  return [...new Set([
    ...baseSecrets, ...llmSecrets(record, {}, options), ...llmSecrets(record?.llm || {}, {}, options),
    ...ttsSecrets(record), ...ttsSecrets(record?.tts || {}),
  ].filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
}

function sanitizeScript({ podcastTitle, summary, dialogue }, sensitive) {
  return {
    podcastTitle: redactScriptField(podcastTitle, sensitive),
    summary: redactScriptField(summary, sensitive),
    dialogue: dialogue.map(({ speaker, text, emotion, rate, pitch }) => {
      const safeText = redactScriptField(text, sensitive);
      if (!safeText?.trim()) throw new Error('模型返回内容包含敏感路径或凭据，已拦截并中止保存');
      return { speaker, text: safeText, emotion: redactScriptField(emotion, sensitive), rate, pitch };
    }),
  };
}

function sanitizeTaskScript(task, sensitive) {
  if (!task.script) return false;
  const original = task.script.dialogue;
  const sanitized = sanitizeScript(task.script, sensitive);
  const changed = sanitized.dialogue.some(({ text, emotion }, index) =>
    text !== original[index].text || emotion !== original[index].emotion);
  task.script = sanitized;
  return changed;
}

// Only expose public dialogue fields, including when reading older metadata.
function publicSentences(id, sentences, sensitive, query = '') {
  return sentences.map(({ index, speaker, text, emotion, startTime, endTime, duration, fileName }) => {
    const basename = typeof fileName === 'string' && path.basename(fileName);
    return {
      index: finiteNumber(index), speaker: redactScriptField(speaker, sensitive), text: redactScriptField(text, sensitive),
      emotion: redactScriptField(emotion, sensitive), startTime: finiteNumber(startTime),
      endTime: finiteNumber(endTime), duration: finiteNumber(duration),
      ...(basename && redactScriptField(basename, sensitive) === basename && {
        fileName: basename, audioUrl: `/podcasts/${id}/${encodeURIComponent(basename)}${query}`,
      }),
    };
  });
}

function publicTtsSummary(meta, sensitive) {
  const ttsProvider = publicIdentifier(meta.ttsProvider, SAFE_ID, sensitive);
  const ttsModel = publicIdentifier(meta.ttsModel, /^[a-zA-Z0-9_.:-]{1,120}$/, sensitive);
  const speechSpeed = SPEECH_SPEEDS.includes(meta.speechSpeed) ? meta.speechSpeed : 'standard';
  const voiceMapping = Object.fromEntries(Object.keys(DEFAULT_VOICES)
    .map(role => [role, publicIdentifier(meta.voiceMapping?.[role], /^[a-zA-Z0-9_() .:-]{1,120}$/, sensitive)])
    .filter(([, voice]) => voice?.trim()));
  return {
    ...(ttsProvider && { ttsProvider }), ...(ttsModel && { ttsModel }), speechSpeed,
    ...(Object.keys(voiceMapping).length && { voiceMapping }),
  };
}

function createTaskManager({
  tasksDir, podcastsDir, cacheDir, extractor = extractArticle, scriptGenerator = generatePodcastScript,
  llmRequest, lookup, ttsSynthesizer = synthesizeDialogueScript, audioMerger = concatenateAudioFiles,
  adminToken, ttsProvider, getTtsProviderById = getTtsProvider,
}) {
  const cache = createTtsCache(cacheDir);
  const storedSecrets = [...llmSecrets({}, {}, { includeDefaultBase: false }), adminToken, podcastsDir, cacheDir, tasksDir];
  let active = null;
  let closing;

  function resolveSpeech(payload, creds, task) {
    const tts = payload.tts ?? {};
    if (typeof tts !== 'object' || Array.isArray(tts)) throw new InputError('语音配置格式无效');
    const previousSpeed = task && normalizeSpeechSpeed(task.speechSpeed, 'standard');
    const speechSpeed = normalizeSpeechSpeed(tts.speechSpeed, previousSpeed ?? 'relaxed');
    const previousId = task && (task.ttsProvider || DEFAULT_PROVIDER_ID);
    const id = tts.provider ?? previousId ?? (process.env.TTS_PROVIDER?.trim() || ttsProvider?.id || DEFAULT_PROVIDER_ID);
    let provider;
    try { provider = id === ttsProvider?.id ? ttsProvider : getTtsProviderById(id); }
    catch { throw new InputError('未注册的 TTS Provider'); }
    if (!provider) throw new InputError('未注册的 TTS Provider');
    const sameProvider = id === previousId;
    const adapterOptions = getTtsCredentials(provider, tts, sameProvider && task.ttsModel);
    const defaults = provider.defaultVoices || DEFAULT_VOICES;
    const previousMapping = sameProvider ? task.voiceMapping : undefined;
    let inherited = previousMapping;
    if (inherited && provider.defaultVoicesForModel && adapterOptions.model !== task.ttsModel) {
      const oldDefaults = provider.defaultVoicesForModel(task.ttsModel);
      inherited = Object.fromEntries(Object.entries(inherited).filter(([role, voice]) => voice !== oldDefaults[role]));
    }
    const voiceMapping = resolveVoiceMapping(provider, adapterOptions.model, tts.voiceMapping ?? payload.voiceMapping ?? inherited);
    const scopeHash = provider.getScopeHash?.(Object.values(voiceMapping), adapterOptions);
    const accountHash = (provider.requiresAuth || provider.getScopeHash) ? speechAccountHash(adapterOptions) : undefined;
    const settings = { ttsProvider: provider.id, ttsModel: adapterOptions.model, voiceMapping, speechSpeed };
    const llmSensitive = llmSecrets(payload, creds, { includeDefaultBase: false });
    const secrets = [...llmSensitive, adminToken,
      ...ttsSecrets(tts), adapterOptions.apiKey, adapterOptions.accessKey, adapterOptions.appId, adapterOptions.endpoint]
      .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
    if (containsSecrets(secrets, settings, payload.title, payload.content, payload.url, task?.sourceContent, task?.input, task?.script, task?.targetPodcastId, task?.baseVersion)) {
      throw new InputError('输入内容包含敏感凭据，已拦截并中止保存');
    }
    const changed = task && (!sameProvider || previousSpeed !== speechSpeed ||
      task.ttsAccountHash !== accountHash || task.ttsScopeHash !== scopeHash || (task.ttsModel || provider.model) !== settings.ttsModel ||
      Object.keys(voiceMapping).some(name => (previousMapping?.[name] || defaults[name]) !== voiceMapping[name]));
    return { provider, adapterOptions, secrets, settings, changed, scopeHash, accountHash, rate: resolveSpeechRate(provider.id, speechSpeed) };
  }

  function save(task, publishedPodcast) {
    task.updatedAt = now();
    const sensitive = metadataSecrets(task, storedSecrets);
    const dto = toDTO(task, sensitive, publishedPodcast);
    const { mode, url } = task.input;
    const input = { ...dto.input, mode };
    // Restarting the extractor requires the original article URL, including any article signature.
    if (mode === 'url' && typeof url === 'string' && /^https?:\/\//i.test(url) && !containsSecrets(sensitive, url)) input.url = url;
    const record = { ...dto, input, ...(task.targetPodcastId && { mode: 'resynthesize', baseVersion: task.baseVersion }),
      ttsScopeHash: task.ttsScopeHash, ttsAccountHash: task.ttsAccountHash, sourceContent: task.sourceContent,
      script: task.script, ...(task.clearPending && { clearPending: true }) };
    atomicWrite(path.join(tasksDir, task.id + '.json'), JSON.stringify(record));
  }

  function storedTask(id, optional = false) {
    checkId(id);
    const file = path.join(tasksDir, id + '.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      if (optional) return;
      throw httpError(404, '任务不存在');
    }
    const raw = fs.readFileSync(file, 'utf8');
    try {
      const task = JSON.parse(raw);
      if (validTaskRecord(task, id)) return task;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!optional) throw new Error('任务记录无效');
  }

  function resolvePublicationTask(taskId, podcastId) {
    const task = storedTask(taskId, true);
    if (task?.targetPodcastId === podcastId) return task;
  }

  function readTask(id, { startup = false } = {}) {
    const task = storedTask(id);
    const legacyStyle = task.script ? 'dialogue' : 'deep_dive';
    task.podcastStyle = normalizePodcastStyle(task.podcastStyle === undefined ? legacyStyle : task.podcastStyle);
    if (!task.targetPodcastId && !SOURCE_TYPES.has(task.sourceType)) task.sourceType = inferSourceType(task.input.mode);
    if (['queued', 'running'].includes(task.status) && active?.task.id !== id) {
      task.status = 'failed';
      task.error = {
        stage: task.stage, retryable: true, failedSegmentIndex: null,
        message: startup ? '服务已重启，上次生成被中断，可点击「从断点继续生成」恢复'
          : '上次生成已中断，可点击「从断点继续生成」恢复',
      };
      try {
        // Keep the invalidation flag with the sanitized checkpoint across restarts.
        if (sanitizeTaskScript(task, metadataSecrets(task, storedSecrets))) task.clearPending = true;
        save(task);
      } catch {
        // The checkpoint stays readable on a read-only volume. A later read or resume retries the write.
      }
    }
    return task;
  }

  for (const entry of readDirectory(podcastsDir)) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try {
      reconcilePodcast(entry.name);
    } catch {
      console.warn('启动恢复时跳过了一期无法恢复的播客');
    }
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

  function reconcilePodcast(id) {
    checkId(id);
    reconcilePendingPublications(path.join(podcastsDir, id), resolvePublicationTask);
  }

  function getPodcast(id) {
    checkId(id);
    const dir = path.join(podcastsDir, id);
    const missing = () => httpError(404, '播客不存在或尚未生成完成');
    try {
      const meta = readPodcastMetadata(dir, resolvePublicationTask);
      if (!meta) throw missing();
      return podcastDTO(id, meta);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError || error instanceof TypeError) throw missing();
      throw error;
    }
  }

  function podcastDTO(id, meta) {
    const metaSensitive = metadataSecrets(meta, storedSecrets);
    const { podcastTitle, summary = '' } = meta;
    const audioVersion = isSafeVersion(meta.audioVersion) && redactScriptField(meta.audioVersion, metaSensitive) === meta.audioVersion
      ? meta.audioVersion : undefined;
    const query = audioVersion ? '?v=' + audioVersion : '';
    const podcastStyle = PODCAST_STYLES.includes(meta.podcastStyle) ? meta.podcastStyle : 'dialogue';
    const sourceType = SOURCE_TYPES.has(meta.sourceType) ? meta.sourceType : null;
    return {
      id, podcastTitle: redactScriptField(podcastTitle, metaSensitive), summary: redactScriptField(summary, metaSensitive),
      podcastStyle, sourceType, sourceTruncated: Boolean(meta.sourceTruncated),
      createAt: publicDate(meta.createAt, metaSensitive), totalDuration: finiteNumber(meta.totalDuration),
      sentenceGap: finiteNumber(meta.sentenceGap), measurement: publicIdentifier(meta.measurement, /^[a-zA-Z0-9_-]{1,60}$/, metaSensitive),
      ...publicTtsSummary(meta, metaSensitive),
      ...(audioVersion && { audioVersion, updatedAt: publicDate(meta.updatedAt, metaSensitive) }),
      fullAudioUrl: `/podcasts/${id}/full_podcast.mp3${query}`, sentences: publicSentences(id, meta.sentences || [], metaSensitive, query),
    };
  }

  function listPodcasts() {
    const items = [];
    for (const entry of readDirectory(podcastsDir)) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try {
        const { id, podcastTitle, summary, podcastStyle, sourceType, createAt, totalDuration, sentences, fullAudioUrl,
          ttsProvider, ttsModel, voiceMapping, speechSpeed } = getPodcast(entry.name);
        items.push({ id, podcastTitle, summary, podcastStyle, sourceType, createAt, totalDuration, sentenceCount: sentences.length, fullAudioUrl,
          ...(ttsProvider && { ttsProvider }), ...(ttsModel && { ttsModel }), ...(voiceMapping && { voiceMapping }), speechSpeed });
      } catch (error) {
        if (error.statusCode === 404 || (error.statusCode === 503 && error.code === 'PODCAST_RECOVERY_FAILED')) continue;
        throw error;
      }
    }
    return { items: items.sort((a, b) => (Date.parse(b.createAt) || 0) - (Date.parse(a.createAt) || 0)) };
  }

  function deletePodcast(id) {
    checkId(id);
    const dir = path.join(podcastsDir, id);
    const taskFile = path.join(tasksDir, id + '.json');
    if (active) {
      const { id: activeId, podcastId, targetPodcastId } = active.task;
      if (activeId === id || podcastId === id || targetPodcastId === id ||
          (targetPodcastId && sameFileSystemResource(dir, path.join(podcastsDir, targetPodcastId))) ||
          sameFileSystemResource(dir, path.join(podcastsDir, activeId)) ||
          sameFileSystemResource(taskFile, path.join(tasksDir, activeId + '.json')) ||
          (typeof podcastId === 'string' && SAFE_ID.test(podcastId) &&
            sameFileSystemResource(dir, path.join(podcastsDir, podcastId)))) {
        throw httpError(409, '当前播客正在生成中，请先取消后再删除');
      }
    }
    const realDir = fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() && realPathIfExists(dir);
    const directory = realDir && ![tasksDir, cacheDir].some(storage => {
      const location = realPathIfExists(storage);
      return location && (location === realDir || location.startsWith(realDir + path.sep) || realDir.startsWith(location + path.sep));
    });
    const hasValidPodcast = directory && Boolean(readPodcastMetadata(dir, resolvePublicationTask));
    let hasValidTask = false;
    if (fs.lstatSync(taskFile, { throwIfNoEntry: false })?.isFile()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        hasValidTask = typeof parsed?.id === 'string' && SAFE_ID.test(parsed.id) && validTaskRecord(parsed, parsed.id) &&
          sameFileSystemResource(path.join(tasksDir, parsed.id + '.json'), taskFile);
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      }
    }
    if (!hasValidPodcast && !hasValidTask) throw httpError(404, '播客不存在');
    if (directory) fs.rmSync(dir, { recursive: true });
    if (hasValidTask) fs.unlinkSync(taskFile);
    return { id, deleted: true };
  }

  function toDTO(task, sensitive = metadataSecrets(task, storedSecrets), publishedPodcast) {
    const { id, status, stage, input, progress, script, error } = task;
    const podcastId = publicIdentifier(task.podcastId, SAFE_ID, sensitive) ?? null;
    return {
      ...(task.targetPodcastId && { targetPodcastId: publicIdentifier(task.targetPodcastId, SAFE_ID, sensitive) }),
      id, status, stage, podcastStyle: task.podcastStyle, sourceType: task.sourceType,
      ...publicTtsSummary(task, sensitive),
      input: {
        mode: redactScriptField(input.mode, sensitive), url: redactScriptField(input.url, sensitive),
        title: redactScriptField(input.title, sensitive), contentLength: finiteNumber(input.contentLength),
        sourceTruncated: Boolean(input.sourceTruncated),
      },
      progress: {
        stageIndex: finiteNumber(progress.stageIndex), totalStages: finiteNumber(progress.totalStages),
        completedSegments: finiteNumber(progress.completedSegments), totalSegments: finiteNumber(progress.totalSegments),
        cachedSegments: finiteNumber(progress.cachedSegments), stageLabel: redactScriptField(progress.stageLabel, sensitive),
        message: redactScriptField(progress.message, sensitive), currentSpeaker: redactScriptField(progress.currentSpeaker, sensitive) ?? null,
        stageStartedAt: publicDate(progress.stageStartedAt, sensitive),
      },
      hasScript: Boolean(script),
      podcastTitle: redactScriptField(script?.podcastTitle, sensitive) || '',
      summary: redactScriptField(script?.summary, sensitive) || '', podcastId,
      podcast: status === 'completed' && podcastId ? (publishedPodcast ?? getPodcast(podcastId)) : null,
      error: error && typeof error === 'object' && !Array.isArray(error) ? {
        stage: typeof error.stage === 'string' && Object.hasOwn(STAGES, error.stage) ? error.stage : undefined,
        message: redactScriptField(error.message, sensitive), retryable: Boolean(error.retryable),
        failedSegmentIndex: Number.isInteger(error.failedSegmentIndex) ? error.failedSegmentIndex : null,
      } : null,
      createdAt: publicDate(task.createdAt, sensitive), updatedAt: publicDate(task.updatedAt, sensitive),
    };
  }

  function assertIdle() {
    if (active) throw httpError(409, '当前已有任务正在生成，请等待完成或先取消当前任务', 'TASK_ALREADY_RUNNING');
  }

  function assertAcceptingTasks() {
    if (closing) throw httpError(503, '服务正在关闭，暂不接收新任务', 'SERVER_SHUTTING_DOWN');
  }

  function workingDirectory(task) {
    return path.join(podcastsDir, task.targetPodcastId ? '.resynth-' + task.id : task.id);
  }

  function targetMetadata(id) {
    checkId(id);
    const meta = readPodcastMetadata(path.join(podcastsDir, id), resolvePublicationTask);
    if (!meta) throw httpError(404, '播客不存在或尚未生成完成');
    return meta;
  }

  function archiveLookup(id, meta, speech) {
    const settings = speech.settings;
    if (meta.ttsProvider !== settings.ttsProvider || meta.ttsModel !== settings.ttsModel ||
        meta.speechSpeed !== settings.speechSpeed ||
        Object.keys(settings.voiceMapping).some(role => meta.voiceMapping?.[role] !== settings.voiceMapping[role])) return;
    const keys = meta.cacheKeys;
    let original;
    const needsAccount = speech.provider.requiresAuth || speech.provider.getScopeHash;
    if (keys === undefined || needsAccount) {
      // A later edit may have been published by a different account than the initial task.
      try { original = storedTask(meta.audioVersion == null ? id : meta.publicationTaskId); } catch { /* Imported archive. */ }
      if (needsAccount && (!speech.accountHash || original?.ttsAccountHash !== speech.accountHash ||
          original.status !== 'completed' || original.podcastId !== id ||
          (original.podcast?.audioVersion ?? null) !== (meta.audioVersion ?? null))) return;
      if (keys === undefined && (speech.provider.getScopeHash || speech.provider.toneVersion) &&
          (!speech.scopeHash || original?.ttsScopeHash !== speech.scopeHash)) return;
    }
    const identity = line => JSON.stringify([line.speaker, line.text, line.emotion || '']);
    const byLine = new Map();
    for (const [index, sentence] of (meta.sentences || []).entries()) {
      if (sentence.fileName !== sentenceFileName(index)) continue;
      const oldLine = original?.script?.dialogue?.[index];
      if (oldLine && (identity(oldLine) !== identity(sentence) || oldLine.rate || oldLine.pitch)) continue;
      byLine.set(identity(sentence), { index, file: path.join(podcastsDir, id, sentence.fileName) });
    }
    return (line, key) => {
      const match = byLine.get(identity(line));
      if (match && (keys === undefined || keys?.[match.index] === key)) return match.file;
    };
  }

  async function runPipeline(task, creds, speech, signal) {
    const workDir = workingDirectory(task);
    const podcastId = task.targetPodcastId || task.id;
    const scriptSecrets = [...speech.secrets, creds.baseURL, workDir, cacheDir, tasksDir];
    function enter(stage, publishedPodcast) {
      signal.throwIfAborted();
      task.stage = stage;
      Object.assign(task.progress, stageProgress(stage));
      save(task, publishedPodcast);
    }
    try {
      signal.throwIfAborted();
      if (task.clearPending) {
        clearAudio(workDir);
        delete task.clearPending;
      }
      const previous = task.targetPodcastId && targetMetadata(podcastId);
      task.status = 'running';
      if (!task.sourceContent && !task.script) {
        enter('extract');
        const article = await extractor({ url: task.input.url }, { signal });
        signal.throwIfAborted();
        if (containsSecrets(speech.secrets, article.title, article.content)) {
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
          title: task.input.title, content: task.sourceContent, podcastStyle: task.podcastStyle, ...creds, signal, llmRequest, lookup,
        });
        signal.throwIfAborted();
        if (containsSecrets(speech.secrets, script)) throw new Error('模型返回内容包含敏感凭据，已拦截并中止保存');
        task.script = sanitizeScript(script, scriptSecrets);
      }

      Object.assign(task.progress, { completedSegments: 0, totalSegments: task.script.dialogue.length, cachedSegments: 0 });
      enter('tts');
      fs.mkdirSync(workDir, { recursive: true });
      if (!fs.lstatSync(workDir).isDirectory()) throw new Error('任务音频目录无效');
      const result = await ttsSynthesizer(task.script.dialogue, workDir, task.voiceMapping, {
        archivedSegment: previous && archiveLookup(podcastId, previous, speech),
        provider: speech.provider, ttsModel: task.ttsModel, adapterOptions: speech.adapterOptions, rate: speech.rate, cache, signal,
        onProgress({ index, completedSegments, totalSegments, cachedSegments, speaker, retrying, attempt, maxAttempts, delayMs, rateLimited }) {
          signal.throwIfAborted();
          const action = completedSegments > index ? '已完成' : '正在合成';
          const segment = `第 ${index + 1}/${totalSegments} 句`;
          let message = `${action}${segment}（${speaker}）`;
          if (retrying) {
            const retry = `第 ${attempt}/${maxAttempts} 次`;
            message = rateLimited
              ? `${segment}触发频率限制，约 ${Math.max(1, Math.round(delayMs / 1000))} 秒后自动重试（${retry}）…`
              : `${segment}合成波动，正在${retry}重试…`;
          }
          Object.assign(task.progress, {
            completedSegments, totalSegments, cachedSegments, currentSpeaker: speaker,
            message,
          });
          save(task);
        },
      });

      enter('merge');
      const tempAudio = path.join(workDir, `.tmp-${randomUUID()}.mp3`);
      try {
        await audioMerger(result.dialogue.map(sentence => sentence.filePath), tempAudio);
        signal.throwIfAborted();
        const audioStat = fs.lstatSync(tempAudio);
        if (!audioStat.isFile() || !audioStat.size) throw new Error('拼接音频文件无效');
        fs.renameSync(tempAudio, path.join(workDir, 'full_podcast.mp3'));
      } finally {
        fs.rmSync(tempAudio, { force: true });
      }
      const meta = {
        ...speech.settings, id: podcastId, podcastTitle: task.script.podcastTitle, summary: task.script.summary,
        podcastStyle: task.podcastStyle, sourceType: task.sourceType, sourceTruncated: task.input.sourceTruncated,
        createAt: previous ? publicDate(previous.createAt, metadataSecrets(previous, scriptSecrets)) : now(),
        ...(previous && { updatedAt: now(), publicationTaskId: task.id, audioVersion: randomUUID().replaceAll('-', '') }),
        cacheKeys: result.cacheKeys,
        totalDuration: result.totalDuration,
        measurement: result.measurement, sentenceGap: result.sentenceGap,
        fullAudioUrl: `/podcasts/${podcastId}/full_podcast.mp3`, sentences: publicSentences(podcastId, result.dialogue, scriptSecrets),
      };
      const finish = () => {
        task.status = 'completed';
        task.podcastId = podcastId;
        enter('done', podcastDTO(podcastId, meta));
      };
      if (previous) {
        publishEditedPodcast(path.join(podcastsDir, podcastId), workDir, task.baseVersion, meta, task.id, finish, resolvePublicationTask);
        try { fs.rmSync(workDir, { recursive: true }); }
        catch { console.warn('无法清理微调剧本暂存目录'); }
      } else {
        atomicWrite(path.join(workDir, 'meta.json'), JSON.stringify(meta));
        fs.rmSync(path.join(workDir, TTS_CHECKPOINT_FILENAME), { force: true });
        finish();
      }
    } catch (error) {
      // An immediate resume owns the new checkpoint while this cancelled run drains.
      if (active?.task !== task || active.interruptedForShutdown) return;
      if (task.targetPodcastId && task.stage === 'done') {
        task.stage = 'merge';
        task.podcastId = null;
        Object.assign(task.progress, stageProgress('merge'));
      }
      if (signal.aborted || error.name === 'AbortError') {
        task.status = 'cancelled';
        task.error = null;
      } else {
        task.status = 'failed';
        task.error = {
          stage: task.stage, message: redactProviderDetail(error.path ? '本地文件读写失败' : error.message, scriptSecrets),
          retryable: error.retryable !== false, failedSegmentIndex: error.segmentIndex ?? null,
        };
      }
      save(task);
    }
  }

  function start(task, creds, speech) {
    save(task);
    const controller = new AbortController();
    // Resume may arrive before the cancelled provider has closed its stream.
    const ready = active?.finished || new Promise(resolve => setImmediate(resolve));
    const run = { task, controller };
    active = run;
    run.finished = ready.then(() => runPipeline(task, creds, speech, controller.signal))
      .catch(() => console.error('任务状态写入失败，请检查数据目录'))
      .finally(() => { if (active === run) active = null; });
    return toDTO(task);
  }

  function createTask(payload = {}) {
    assertAcceptingTasks();
    const podcastStyle = normalizePodcastStyle(payload.podcastStyle);
    const sourceType = resolveSourceType(payload);
    assertIdle();
    const creds = getCredentials(payload);
    if (!creds.apiKey) throw new InputError('缺少 API Key，请先配置后再生成');
    validateLlmSettings(payload, creds);
    const speech = resolveSpeech(payload, creds);
    const source = getInput(payload);
    const task = {
      id: randomUUID(), status: 'queued', stage: 'extract', podcastStyle, sourceType, ...source, ...speech.settings,
      ttsAccountHash: speech.accountHash, ttsScopeHash: speech.scopeHash, script: null,
      progress: { ...stageProgress('extract'), message: '等待生成', completedSegments: 0, totalSegments: 0, cachedSegments: 0 },
      createdAt: now(), podcastId: null, error: null,
    };
    return start(task, creds, speech);
  }

  function resynthesizePodcast(podcastId, payload = {}) {
    assertAcceptingTasks();
    assertIdle();
    const previous = targetMetadata(podcastId);
    const source = podcastDTO(podcastId, previous);
    if (payload.baseVersion === undefined) {
      throw new InputError('缺少播客版本号，请刷新最新剧本后再微调');
    }
    if (payload.baseVersion !== null && !isSafeVersion(payload.baseVersion)) throw new InputError('无效的播客版本号');
    assertPodcastVersion(source.audioVersion, payload.baseVersion);
    const dialogue = validateEditedDialogue(payload.dialogue);
    const creds = {};
    const speech = resolveSpeech(payload, creds, previous);
    const sensitive = metadataSecrets(previous, [...storedSecrets, ...speech.secrets]);
    if (!publicIdentifier(podcastId, SAFE_ID, sensitive) || containsSecrets(sensitive, dialogue, speech.settings, source.audioVersion) ||
        dialogue.some(({ text, emotion }) => [text, emotion].some(value => value && redactSecrets(value) !== value))) {
      throw new InputError('输入内容包含敏感凭据，已拦截并中止保存');
    }
    const script = sanitizeScript({ ...source, dialogue }, sensitive);
    const task = {
      id: randomUUID(), status: 'queued', stage: 'tts', targetPodcastId: podcastId, baseVersion: source.audioVersion ?? null,
      script, podcastStyle: source.podcastStyle, sourceType: source.sourceType, ...speech.settings,
      ttsAccountHash: speech.accountHash, ttsScopeHash: speech.scopeHash,
      input: { mode: 'text', title: script.podcastTitle, contentLength: dialogue.reduce((sum, line) => sum + line.text.length, 0),
        sourceTruncated: source.sourceTruncated },
      progress: { ...stageProgress('tts'), message: '准备重合成微调剧本', totalSegments: dialogue.length, completedSegments: 0, cachedSegments: 0 },
      createdAt: now(), podcastId: null, error: null,
    };
    return start(task, creds, speech);
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
    assertAcceptingTasks();
    const requestedStyle = payload.podcastStyle === undefined ? undefined : normalizePodcastStyle(payload.podcastStyle);
    const task = readTask(id);
    const drainingSameTask = active?.task.id === id && active.controller.signal.aborted;
    if (!drainingSameTask) assertIdle();
    if (!['failed', 'cancelled'].includes(task.status)) throw httpError(409, '当前任务状态无法续跑');
    const podcastStyle = requestedStyle ?? task.podcastStyle;
    const styleChanged = podcastStyle !== task.podcastStyle;
    if (task.targetPodcastId) {
      const previous = getPodcast(task.targetPodcastId);
      assertPodcastVersion(previous.audioVersion, task.baseVersion);
      if (styleChanged) throw new InputError('微调剧本时不能切换节目风格');
    }
    const needsScript = !task.script || styleChanged;
    if (styleChanged && !validTaskRecord({ ...task, script: null }, id)) {
      throw new InputError('任务缺少可重新生成的原文，无法切换节目风格');
    }
    const creds = task.targetPodcastId ? {} : getCredentials(payload);
    if (needsScript && !creds.apiKey) throw new InputError('尚未生成剧本，请先配置 API Key 后再继续');
    const hasLlmSettings = [payload.apiKey, payload.baseURL, payload.model, payload.visionModel].some(value => value != null);
    if (needsScript || (!task.targetPodcastId && hasLlmSettings)) {
      validateLlmSettings(payload, creds);
    }
    const speech = resolveSpeech(payload, creds, task);
    const workDir = workingDirectory(task);
    if (styleChanged) task.script = null;
    const scriptChanged = !styleChanged && sanitizeTaskScript(task,
      metadataSecrets(task, [...speech.secrets, creds.baseURL, workDir, cacheDir, tasksDir]));
    if (styleChanged || scriptChanged || speech.changed || task.clearPending) {
      clearAudio(workDir);
      // A cancelled adapter may still publish its last write before it drains.
      // Persist the second cleanup across a process restart as well.
      task.clearPending = Boolean(drainingSameTask);
    }
    Object.assign(task, speech.settings, { ttsAccountHash: speech.accountHash, ttsScopeHash: speech.scopeHash, podcastStyle });
    task.status = 'running';
    task.error = null;
    return start(task, creds, speech);
  }

  function shutdown({ timeoutMs = 5000 } = {}) {
    if (closing) return closing;
    const run = active;
    if (!run) return (closing = Promise.resolve());
    const { task, controller, finished } = run;
    const wait = new AbortController();
    closing = Promise.race([finished, delay(timeoutMs, undefined, { ref: false, signal: wait.signal })])
      .finally(() => wait.abort());
    if (task.status === 'queued' || task.status === 'running') {
      run.interruptedForShutdown = true;
      task.status = 'failed';
      task.error = {
        stage: task.stage, retryable: true, failedSegmentIndex: null,
        message: '服务已关闭，上次生成被中断，可点击「从断点继续生成」恢复',
      };
      try {
        save(task);
      } catch {
        console.error('关闭时未能保存任务状态，请检查数据目录');
      } finally {
        controller.abort();
      }
    }
    return closing;
  }

  return {
    createTask, resynthesizePodcast, isPodcastEdit: id => Boolean(readTask(id).targetPodcastId),
    getTask: id => toDTO(readTask(id)), cancelTask, resumeTask, listPodcasts, getPodcast, reconcilePodcast, deletePodcast, shutdown,
  };
}

module.exports = { createTaskManager };
