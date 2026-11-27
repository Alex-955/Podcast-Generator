(function () {
  'use strict';

  const SAMPLES_URL = './assets/data/samples.json';
  const SPEEDS = [1.0, 1.25, 1.5, 2.0, 0.8];
  const AMBIENT_LOOP_SECONDS = 24;
  const AMBIENT_SAMPLE_RATE = 32000;
  const AMBIENT_TARGET_GAIN = 0.125;

  const FALLBACK_SAMPLES = {
    version: '0.2.0',
    episodes: {
      deep: {
        id: 'deep',
        label: '深度主讲 · 7:3',
        title: '赢球不叫暂停：为什么维持现状有时候反而是好选择？',
        summary: '节选自真实生成播客《步子太大扯到裆：为什么90%的心脏病人出院后照旧熬夜》· 小晓 7:3 深度拆解 + 阿泽比喻接话',
        audioUrl: './assets/audio/sample-deep-v2.mp3',
        fallbackDuration: 46.944,
        cues: [
          {
            id: 1,
            speaker: 'aze',
            speakerName: '阿泽',
            emotion: '追问',
            startTime: 0,
            endTime: 6.772,
            text: '每天的选择，这个落点很实。那「选择」具体有哪几种？我猜不是「改」和「不改」这么二分吧。',
          },
          {
            id: 2,
            speaker: 'xiaoxiao',
            speakerName: '小晓',
            emotion: '拆解',
            startTime: 7.712,
            endTime: 19.392,
            text: '原文说选择实际上有三种：回避；直面但处理不好；直面但处理好。而且我们还要决定很多方面改还是不改。',
          },
          {
            id: 3,
            speaker: 'xiaoxiao',
            speakerName: '小晓',
            emotion: '深入',
            startTime: 20.012,
            endTime: 36.892,
            text: '这里有个很反常识的点——维持现状并不一定是差的选择。比如主讲人说，他现在经营几个公司，公司有很多问题，但如果这个公司还盈利、团队积极性还很好，那这些问题要不要现在改？不要。',
          },
          {
            id: 4,
            speaker: 'aze',
            speakerName: '阿泽',
            emotion: '顿悟',
            startTime: 38.192,
            endTime: 46.944,
            text: '这个比喻我熟。就像球队赢球的时候不叫暂停——比分领先，也有问题，但不能现在叫暂停。是这个意思吧？',
          },
        ],
      },
      casual: {
        id: 'casual',
        label: '轻松对谈 · 5:5',
        title: '从支付战争到搜搜往事：为什么入口心智是砸不出来的？',
        summary: '节选自真实生成播客《4.19亿对3733万，腾讯打算从微信里「偷袭」豆包》· 阿泽 × 小晓 5:5 轻快对谈',
        audioUrl: './assets/audio/sample-casual.mp3',
        fallbackDuration: 46.344,
        cues: [
          {
            id: 1,
            speaker: 'xiaoxiao',
            speakerName: '小晓',
            emotion: '联想',
            startTime: 0,
            endTime: 9.864,
            text: '这让我想到十年前那场支付战争。支付宝当年手握近八成份额，看着牢不可破，微信靠一个春节红包就撕开了口子。',
          },
          {
            id: 2,
            speaker: 'aze',
            speakerName: '阿泽',
            emotion: '补充',
            startTime: 10.224,
            endTime: 22.512,
            text: '不过腾讯在搜索上栽过跟头。PC 时代百度垄断入口，腾讯砸了 20 个亿做搜搜 SOSO，QQ 工具栏、QQ 空间能放的位置全铺上了。',
          },
          {
            id: 3,
            speaker: 'xiaoxiao',
            speakerName: '小晓',
            emotion: '接话',
            startTime: 22.872,
            endTime: 33.72,
            text: '结果用户聊完天要查资料，顺手打开的仍是百度。2013 年腾讯把搜搜注入搜狗，换 36.5% 的股份，基本等于公开认输。',
          },
          {
            id: 4,
            speaker: 'aze',
            speakerName: '阿泽',
            emotion: '点题',
            startTime: 34.08,
            endTime: 46.344,
            text: '因为搜索是个正向循环生意，用户每次输入、点击、改词，都在喂算法。用的人越多结果越准，光靠导流追不上，入口心智是砸不出来的。',
          },
        ],
      },
    },
  };

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatSpeedLabel(rate) {
    if (rate === 1 || rate === 2) return `${rate.toFixed(1)}x`;
    return `${rate}x`;
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * 兼容 0.36s 句间停顿：落入间隙时保持上一句高亮，不闪烁跳回
   */
  function findActiveCueIndex(cues, currentTime) {
    if (!Array.isArray(cues) || !cues.length) return -1;
    let candidate = -1;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (currentTime >= cue.startTime && currentTime < cue.endTime) {
        return i;
      }
      if (currentTime >= cue.startTime) {
        candidate = i;
      } else {
        break;
      }
    }
    return candidate;
  }

  /**
   * 合成 24s 无缝循环的微醺暖调和弦伴音（参考主应用 public/audioEngine.js）
   */
  async function renderAmbientBuffer() {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) return null;

    const length = AMBIENT_LOOP_SECONDS * AMBIENT_SAMPLE_RATE;
    const offline = new OfflineCtx(2, length, AMBIENT_SAMPLE_RATE);

    const lowpass = offline.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1550;
    lowpass.Q.value = 0.7;

    const vocalPocket = offline.createBiquadFilter();
    vocalPocket.type = 'peaking';
    vocalPocket.frequency.value = 1550;
    vocalPocket.Q.value = 0.9;
    vocalPocket.gain.value = -4.5;

    const masterGain = offline.createGain();
    masterGain.gain.value = 0.72;

    lowpass.connect(vocalPocket);
    vocalPocket.connect(masterGain);
    masterGain.connect(offline.destination);

    // 4 chords x 6s = 24s (Fmaj7 -> Em7 -> Dm7 -> Cmaj7)
    const chords = [
      [174.61, 220.0, 261.63, 329.63],
      [164.81, 196.0, 246.94, 293.66],
      [146.83, 174.61, 220.0, 261.63],
      [130.81, 164.81, 196.0, 246.94],
    ];

    const chordDur = 6.0;
    chords.forEach((freqs, barIdx) => {
      const start = barIdx * chordDur;
      const end = start + chordDur;

      freqs.forEach((freq, voiceIdx) => {
        const osc = offline.createOscillator();
        const pan = typeof offline.createStereoPanner === 'function' ? offline.createStereoPanner() : null;
        const gain = offline.createGain();

        osc.type = voiceIdx === 0 ? 'sine' : 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = (voiceIdx % 2 === 0 ? 1 : -1) * 3.0;
        if (pan) {
          pan.pan.value = (voiceIdx / Math.max(1, freqs.length - 1) - 0.5) * 0.55;
        }

        const peak = voiceIdx === 0 ? 0.105 : 0.055;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(peak, start + 1.15);
        gain.gain.setValueAtTime(peak * 0.88, end - 1.25);
        gain.gain.linearRampToValueAtTime(0.0001, end - 0.04);

        osc.connect(gain);
        if (pan) {
          gain.connect(pan);
          pan.connect(lowpass);
        } else {
          gain.connect(lowpass);
        }
        osc.start(start);
        osc.stop(end);
      });

      const arpOffsets = [0.35, 1.75, 3.15, 4.45];
      arpOffsets.forEach((offset, stepIdx) => {
        const noteStart = start + offset;
        const noteEnd = Math.min(end - 0.08, noteStart + 1.35);
        if (noteEnd <= noteStart + 0.1) return;

        const baseFreq = freqs[(stepIdx + barIdx) % freqs.length];
        const noteFreq = baseFreq * (stepIdx % 2 === 0 ? 2 : 1);

        const osc = offline.createOscillator();
        const pan = typeof offline.createStereoPanner === 'function' ? offline.createStereoPanner() : null;
        const gain = offline.createGain();

        osc.type = 'sine';
        osc.frequency.value = noteFreq;
        if (pan) {
          pan.pan.value = stepIdx % 2 === 0 ? -0.32 : 0.32;
        }

        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(0.036, noteStart + 0.045);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

        osc.connect(gain);
        if (pan) {
          gain.connect(pan);
          pan.connect(lowpass);
        } else {
          gain.connect(lowpass);
        }
        osc.start(noteStart);
        osc.stop(noteEnd + 0.02);
      });
    });

    return offline.startRendering();
  }

  function createAmbientSynthesizer() {
    let audioCtx = null;
    let ambientGain = null;
    let ambientSource = null;
    let ambientBuffer = null;
    let bufferPromise = null;
    let fadeTimer = null;
    let playToken = 0;

    function ensureContextSync() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;

      try {
        if (!audioCtx) {
          audioCtx = new Ctx();
          ambientGain = audioCtx.createGain();
          ambientGain.gain.value = 0.0001;
          ambientGain.connect(audioCtx.destination);
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      } catch {
        return null;
      }

      return audioCtx;
    }

    async function getBuffer() {
      if (ambientBuffer) return ambientBuffer;
      if (bufferPromise) return bufferPromise;

      bufferPromise = renderAmbientBuffer()
        .then((buf) => {
          if (buf) ambientBuffer = buf;
          return buf;
        })
        .catch(() => null)
        .finally(() => {
          bufferPromise = null;
        });
      return bufferPromise;
    }

    function stopImmediate() {
      if (fadeTimer) {
        window.clearTimeout(fadeTimer);
        fadeTimer = null;
      }
      if (ambientSource) {
        try {
          ambientSource.stop();
        } catch {
          // Ignore already stopped
        }
        try {
          ambientSource.disconnect();
        } catch {
          // Ignore
        }
        ambientSource = null;
      }
    }

    async function startFadeIn() {
      const token = ++playToken;
      const ctx = ensureContextSync();
      if (!ctx || !ambientGain) return;

      const buf = await getBuffer();
      if (!buf || token !== playToken) return;

      stopImmediate();
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        if (token !== playToken) return;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(ambientGain);

        const now = ctx.currentTime;
        ambientGain.gain.cancelScheduledValues(now);
        ambientGain.gain.setValueAtTime(0.0001, now);
        ambientGain.gain.linearRampToValueAtTime(AMBIENT_TARGET_GAIN, now + 0.65);
        src.start(now);
        ambientSource = src;
      } catch {
        stopImmediate();
      }
    }

    function fadeOut(durationSec = 0.32) {
      playToken += 1;
      if (!audioCtx || !ambientGain || !ambientSource) {
        stopImmediate();
        return;
      }

      if (fadeTimer) {
        window.clearTimeout(fadeTimer);
        fadeTimer = null;
      }

      const sourceToStop = ambientSource;
      ambientSource = null;

      try {
        const now = audioCtx.currentTime;
        ambientGain.gain.cancelScheduledValues(now);
        ambientGain.gain.setValueAtTime(Math.max(0.0001, ambientGain.gain.value), now);
        ambientGain.gain.linearRampToValueAtTime(0.0001, now + durationSec);
      } catch {
        // Ignore ramp error
      }

      fadeTimer = window.setTimeout(() => {
        fadeTimer = null;
        try {
          sourceToStop.stop();
          sourceToStop.disconnect();
        } catch {
          // Ignore
        }
      }, Math.round(durationSec * 1000) + 40);
    }

    return {
      unlockInGesture: ensureContextSync,
      startFadeIn,
      fadeOut,
      stopImmediate,
    };
  }

  let initialized = false;

  const dom = {};
  const state = {
    samples: FALLBACK_SAMPLES,
    currentEpisodeId: 'deep',
    mode: 'demo', // 'audio' | 'demo'
    isPlaying: false,
    isSeeking: false,
    currentTime: 0,
    duration: 48,
    speedIndex: 0,
    ambientEnabled: false,
    activeCueIndex: -1,
    cueElements: [],
    rafId: null,
    lastFrameTs: 0,
    loadToken: 0,
    hasUserInteracted: false,
    audioAvailabilityCache: new Map(),
  };

  let audioEl = null;
  const ambient = createAmbientSynthesizer();

  function collectDom() {
    dom.stage = document.getElementById('stage');
    dom.sourceBadge = document.getElementById('playerSourceBadge');
    dom.pillAze = document.getElementById('speakerPillAze');
    dom.pillXiaoxiao = document.getElementById('speakerPillXiaoxiao');
    dom.epTitle = document.getElementById('playerEpTitle');
    dom.epSummary = document.getElementById('playerEpSummary');
    dom.btnPlayPause = document.getElementById('btnPlayPause');
    dom.btnSkipBack = document.getElementById('btnSkipBack');
    dom.btnSkipForward = document.getElementById('btnSkipForward');
    dom.progressTrack = document.getElementById('playerProgressTrack');
    dom.progressFill = document.getElementById('playerProgressFill');
    dom.progressThumb = document.getElementById('playerProgressThumb');
    dom.timeCurrent = document.getElementById('playerTimeCurrent');
    dom.timeDuration = document.getElementById('playerTimeDuration');
    dom.btnSpeed = document.getElementById('btnSpeed');
    dom.btnAmbient = document.getElementById('btnAmbient');
    dom.transcriptCounter = document.getElementById('transcriptCounter');
    dom.transcriptList = document.getElementById('transcriptList');
    dom.episodeSeg = document.querySelector('[data-segmented="stage-episode"]');
  }

  function getCurrentEpisode() {
    return state.samples?.episodes?.[state.currentEpisodeId] || null;
  }

  function getCurrentSpeed() {
    return SPEEDS[state.speedIndex] || 1.0;
  }

  function getSkipSeconds(btn, fallback) {
    if (!btn) return fallback;
    const raw = Number(btn.dataset.skipSeconds || btn.dataset.skip);
    if (Number.isFinite(raw) && raw !== 0) return raw;
    const hint = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`;
    const match = hint.match(/(\d+)/);
    if (match) {
      const val = Number(match[1]);
      if (val > 0 && val <= 30) return fallback < 0 ? -val : val;
    }
    return fallback;
  }

  function updateSourceBadge(mode) {
    if (!dom.sourceBadge) return;
    if (mode === 'audio') {
      dom.sourceBadge.classList.remove('is-demo');
      dom.sourceBadge.textContent = '真实播客样片 · 纯人声输出';
    } else {
      dom.sourceBadge.classList.add('is-demo');
      dom.sourceBadge.textContent = '样片脚本预览 · 点击字幕即可试看同步节奏';
    }
  }

  function updatePlayStateUI() {
    const playing = state.isPlaying;
    if (dom.stage) {
      dom.stage.dataset.playing = playing ? 'true' : 'false';
      dom.stage.classList.toggle('is-playing', playing);
    }
    if (dom.btnPlayPause) {
      dom.btnPlayPause.classList.toggle('is-playing', playing);
      dom.btnPlayPause.setAttribute('aria-pressed', playing ? 'true' : 'false');
      dom.btnPlayPause.setAttribute('aria-label', playing ? '暂停样片' : '播放样片');
    }
    updateSpeakerUI();
  }

  function updateSpeakerUI() {
    const ep = getCurrentEpisode();
    const cues = ep?.cues || [];
    const activeCue = state.activeCueIndex >= 0 ? cues[state.activeCueIndex] : null;
    const speaker = activeCue && (state.isPlaying || state.currentTime > 0) ? activeCue.speaker : 'none';

    if (dom.stage) {
      dom.stage.dataset.speaker = speaker;
    }

    const azeActive = speaker === 'aze';
    const xiaoxiaoActive = speaker === 'xiaoxiao';

    if (dom.pillAze) {
      dom.pillAze.classList.toggle('is-active', azeActive);
      dom.pillAze.classList.toggle('is-speaking', azeActive && state.isPlaying);
    }
    if (dom.pillXiaoxiao) {
      dom.pillXiaoxiao.classList.toggle('is-active', xiaoxiaoActive);
      dom.pillXiaoxiao.classList.toggle('is-speaking', xiaoxiaoActive && state.isPlaying);
    }
  }

  function updateSpeedUI() {
    if (!dom.btnSpeed) return;
    const label = formatSpeedLabel(getCurrentSpeed());
    const textTarget = dom.btnSpeed.querySelector('[data-speed-label], .speed-label, .speed-value');
    if (textTarget) {
      textTarget.textContent = label;
    } else if (!dom.btnSpeed.querySelector('svg')) {
      dom.btnSpeed.textContent = label;
    }
    dom.btnSpeed.setAttribute('aria-label', `播放倍速 ${label}`);
  }

  function updateAmbientUI() {
    if (!dom.btnAmbient) return;
    dom.btnAmbient.classList.toggle('is-active', state.ambientEnabled);
    dom.btnAmbient.setAttribute('aria-pressed', state.ambientEnabled ? 'true' : 'false');
    const labelTarget = dom.btnAmbient.querySelector('[data-ambient-label], .ambient-label');
    if (labelTarget) {
      labelTarget.textContent = state.ambientEnabled ? '微醺环境音 · 开' : '微醺环境音 · 关';
    }
  }

  function updateProgressUI(time = state.currentTime) {
    const dur = Math.max(0.01, state.duration || 1);
    const clampedTime = Math.max(0, Math.min(dur, time));
    const pct = Math.max(0, Math.min(100, (clampedTime / dur) * 100));

    if (dom.progressFill) {
      dom.progressFill.style.width = `${pct.toFixed(3)}%`;
    }
    if (dom.progressThumb) {
      dom.progressThumb.style.left = `${pct.toFixed(3)}%`;
    }
    if (dom.progressTrack) {
      if (!dom.progressTrack.hasAttribute('role')) {
        dom.progressTrack.setAttribute('role', 'slider');
      }
      if (!dom.progressTrack.hasAttribute('tabindex')) {
        dom.progressTrack.setAttribute('tabindex', '0');
      }
      dom.progressTrack.setAttribute('aria-valuemin', '0');
      dom.progressTrack.setAttribute('aria-valuemax', '100');
      dom.progressTrack.setAttribute('aria-valuenow', String(Math.round(pct)));
      dom.progressTrack.setAttribute('aria-valuetext', `${formatTime(clampedTime)} / ${formatTime(state.duration)}`);
      dom.progressTrack.classList.toggle('is-dragging', state.isSeeking);
    }
    if (dom.timeCurrent) {
      dom.timeCurrent.textContent = formatTime(clampedTime);
    }
    if (dom.timeDuration) {
      dom.timeDuration.textContent = formatTime(state.duration);
    }
  }

  function updateTranscriptCounter() {
    if (!dom.transcriptCounter) return;
    const ep = getCurrentEpisode();
    const total = ep?.cues?.length || 0;
    if (!total) {
      dom.transcriptCounter.textContent = '0 / 0 句';
      return;
    }
    const current = state.activeCueIndex >= 0 ? state.activeCueIndex + 1 : 0;
    dom.transcriptCounter.textContent = current > 0 ? `${current} / ${total} 句` : `共 ${total} 句`;
  }

  /**
   * 仅在 #transcriptList 容器内部居中滚动，严禁调用 scrollIntoView() 造成整页跳动
   */
  function scrollCueIntoTranscriptCenter(cueEl) {
    if (!dom.transcriptList || !cueEl) return;
    const list = dom.transcriptList;
    if (list.scrollHeight <= list.clientHeight) return;

    const listRect = list.getBoundingClientRect();
    const cueRect = cueEl.getBoundingClientRect();
    const cueTopInsideList = cueRect.top - listRect.top + list.scrollTop;
    const targetTop = cueTopInsideList - (list.clientHeight - cueEl.offsetHeight) / 2;
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
    const clampedTop = Math.max(0, Math.min(maxScroll, targetTop));

    if (typeof list.scrollTo === 'function') {
      list.scrollTo({
        top: clampedTop,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    } else {
      list.scrollTop = clampedTop;
    }
  }

  function syncCueHighlight(time, { shouldScroll = true } = {}) {
    const ep = getCurrentEpisode();
    const cues = ep?.cues || [];
    if (!cues.length) {
      state.activeCueIndex = -1;
      updateTranscriptCounter();
      updateSpeakerUI();
      return;
    }

    const nextIdx = (state.isPlaying || time > 0) ? findActiveCueIndex(cues, time) : -1;
    if (nextIdx !== state.activeCueIndex) {
      if (state.activeCueIndex >= 0 && state.cueElements[state.activeCueIndex]) {
        state.cueElements[state.activeCueIndex].classList.remove('is-active');
        state.cueElements[state.activeCueIndex].setAttribute('aria-current', 'false');
      }
      state.activeCueIndex = nextIdx;
      const nextEl = nextIdx >= 0 ? state.cueElements[nextIdx] : null;
      if (nextEl) {
        nextEl.classList.add('is-active');
        nextEl.setAttribute('aria-current', 'true');
        if (shouldScroll) {
          scrollCueIntoTranscriptCenter(nextEl);
        }
      }
      updateTranscriptCounter();
    }
    updateSpeakerUI();
  }

  function renderTranscript(cues) {
    if (!dom.transcriptList) return;
    dom.transcriptList.textContent = '';
    state.cueElements = [];
    state.activeCueIndex = -1;

    if (!Array.isArray(cues) || !cues.length) {
      updateTranscriptCounter();
      return;
    }

    const frag = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const speakerKey = cue.speaker === 'xiaoxiao' ? 'xiaoxiao' : 'aze';
      const speakerName = cue.speakerName || (speakerKey === 'xiaoxiao' ? '小晓' : '阿泽');

      const item = document.createElement('div');
      item.className = `cue-item is-${speakerKey}`;
      item.dataset.cueIndex = String(index);
      item.dataset.speaker = speakerKey;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-current', 'false');
      item.setAttribute('aria-label', `${speakerName} ${formatTime(cue.startTime)}：${cue.text}`);

      const meta = document.createElement('div');
      meta.className = 'cue-meta';

      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'cue-speaker';
      speakerSpan.textContent = speakerName;
      meta.appendChild(speakerSpan);

      if (cue.emotion) {
        const emotionSpan = document.createElement('span');
        emotionSpan.className = 'cue-emotion';
        emotionSpan.textContent = `· ${cue.emotion}`;
        meta.appendChild(emotionSpan);
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'cue-time';
      timeSpan.textContent = formatTime(cue.startTime);
      meta.appendChild(timeSpan);

      const textEl = document.createElement('p');
      textEl.className = 'cue-text';
      textEl.textContent = cue.text;

      item.append(meta, textEl);

      const handleCueActivate = () => {
        ambient.unlockInGesture();
        const target = Math.max(0, Number(cue.startTime) || 0);
        seekTo(target, { scrollTranscript: true });
        play();
      };

      item.addEventListener('click', handleCueActivate);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCueActivate();
        }
      });

      frag.appendChild(item);
      state.cueElements.push(item);
    });

    dom.transcriptList.appendChild(frag);
    dom.transcriptList.scrollTop = 0;
    updateTranscriptCounter();
  }

  function stopDemoLoop() {
    if (state.rafId !== null) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.lastFrameTs = 0;
  }

  function startDemoLoop() {
    stopDemoLoop();
    state.lastFrameTs = performance.now();

    const step = (now) => {
      if (!state.isPlaying || state.mode !== 'demo') {
        state.rafId = null;
        return;
      }

      const elapsedSec = Math.min(0.12, Math.max(0, (now - state.lastFrameTs) / 1000));
      state.lastFrameTs = now;

      if (!state.isSeeking) {
        const nextTime = state.currentTime + elapsedSec * getCurrentSpeed();
        if (nextTime >= state.duration) {
          handlePlaybackEnded();
          return;
        }
        state.currentTime = nextTime;
        updateProgressUI(state.currentTime);
        syncCueHighlight(state.currentTime, { shouldScroll: true });
      }

      state.rafId = window.requestAnimationFrame(step);
    };

    state.rafId = window.requestAnimationFrame(step);
  }

  function startAudioRafLoop() {
    stopDemoLoop();
    const step = () => {
      if (!state.isPlaying || state.mode !== 'audio' || !audioEl) {
        state.rafId = null;
        return;
      }
      if (!state.isSeeking) {
        state.currentTime = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : state.currentTime;
        updateProgressUI(state.currentTime);
        syncCueHighlight(state.currentTime, { shouldScroll: true });
      }
      state.rafId = window.requestAnimationFrame(step);
    };
    state.rafId = window.requestAnimationFrame(step);
  }

  function handlePlaybackEnded() {
    stopDemoLoop();
    state.isPlaying = false;
    state.currentTime = state.duration;
    updateProgressUI(state.duration);
    syncCueHighlight(state.duration, { shouldScroll: false });
    ambient.fadeOut(0.45);
    updatePlayStateUI();
    if (dom.stage) {
      dom.stage.dataset.speaker = 'none';
    }
    if (dom.pillAze) dom.pillAze.classList.remove('is-active', 'is-speaking');
    if (dom.pillXiaoxiao) dom.pillXiaoxiao.classList.remove('is-active', 'is-speaking');
  }

  function fallbackToDemoMode({ preservePlayback = false } = {}) {
    const resumeTime = state.currentTime;
    const shouldPlay = preservePlayback && state.isPlaying;

    state.mode = 'demo';
    updateSourceBadge('demo');

    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
      } catch {
        // Ignore cleanup errors
      }
    }

    const ep = getCurrentEpisode();
    state.duration = Math.max(1, Number(ep?.fallbackDuration) || 45);
    state.currentTime = Math.max(0, Math.min(state.duration, resumeTime));
    updateProgressUI(state.currentTime);

    if (shouldPlay) {
      startDemoLoop();
    }
  }

  async function probeAudioAvailability(url) {
    if (!url) return false;
    if (state.audioAvailabilityCache.has(url)) {
      return state.audioAvailabilityCache.get(url);
    }
    if (window.location.protocol === 'file:') {
      state.audioAvailabilityCache.set(url, false);
      return false;
    }

    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const ok = res.ok && !contentType.includes('text/html');
      state.audioAvailabilityCache.set(url, ok);
      return ok;
    } catch {
      state.audioAvailabilityCache.set(url, false);
      return false;
    }
  }

  function ensureAudioElement() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.preload = 'metadata';

    audioEl.addEventListener('loadedmetadata', () => {
      if (state.mode !== 'audio') return;
      if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        state.duration = audioEl.duration;
        updateProgressUI(state.currentTime);
      }
    });

    audioEl.addEventListener('timeupdate', () => {
      if (state.mode !== 'audio' || state.isSeeking) return;
      state.currentTime = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
      updateProgressUI(state.currentTime);
      syncCueHighlight(state.currentTime, { shouldScroll: true });
    });

    audioEl.addEventListener('play', () => {
      if (state.mode !== 'audio') return;
      state.isPlaying = true;
      updatePlayStateUI();
      if (state.ambientEnabled) {
        ambient.startFadeIn();
      }
      startAudioRafLoop();
    });

    audioEl.addEventListener('pause', () => {
      if (state.mode !== 'audio') return;
      if (audioEl.ended) return;
      stopDemoLoop();
      state.isPlaying = false;
      ambient.fadeOut(0.28);
      updatePlayStateUI();
    });

    audioEl.addEventListener('ended', () => {
      if (state.mode !== 'audio') return;
      handlePlaybackEnded();
    });

    audioEl.addEventListener('error', () => {
      if (state.mode !== 'audio') return;
      const ep = getCurrentEpisode();
      if (ep?.audioUrl) {
        state.audioAvailabilityCache.set(ep.audioUrl, false);
      }
      fallbackToDemoMode({ preservePlayback: true });
    });

    return audioEl;
  }

  async function prepareEpisodeAudio(episode, token) {
    if (!episode?.audioUrl) {
      state.mode = 'demo';
      updateSourceBadge('demo');
      return;
    }

    const available = await probeAudioAvailability(episode.audioUrl);
    if (token !== state.loadToken) return;

    if (!available) {
      fallbackToDemoMode({ preservePlayback: state.isPlaying });
      return;
    }

    const el = ensureAudioElement();
    const resumeTime = state.currentTime;
    const shouldPlay = state.isPlaying;

    state.mode = 'audio';
    updateSourceBadge('audio');
    el.src = episode.audioUrl;
    el.playbackRate = getCurrentSpeed();
    if (resumeTime > 0) {
      try {
        el.currentTime = resumeTime;
      } catch {
        // Wait for metadata if needed
      }
    }
    el.load();

    if (shouldPlay) {
      stopDemoLoop();
      el.play().catch(() => {
        if (token === state.loadToken) {
          fallbackToDemoMode({ preservePlayback: true });
        }
      });
    }
  }

  function syncSegmentedButtons(episodeId) {
    if (!dom.episodeSeg) return;
    const buttons = Array.from(dom.episodeSeg.querySelectorAll('.segmented-btn[data-value]'));
    let activeBtn = null;
    buttons.forEach((btn) => {
      const matched = btn.dataset.value === episodeId;
      btn.classList.toggle('is-active', matched);
      if (btn.hasAttribute('aria-selected')) {
        btn.setAttribute('aria-selected', matched ? 'true' : 'false');
      }
      if (btn.hasAttribute('aria-pressed')) {
        btn.setAttribute('aria-pressed', matched ? 'true' : 'false');
      }
      if (matched) activeBtn = btn;
    });

    const indicator = dom.episodeSeg.querySelector('.segmented-indicator');
    if (indicator && activeBtn && activeBtn.offsetWidth > 0) {
      indicator.style.width = `${activeBtn.offsetWidth}px`;
      indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    }
  }

  function applyEpisode(episodeId, { force = false, autoplay = false, syncSegmented = true } = {}) {
    const episodes = state.samples?.episodes || {};
    const nextId = episodes[episodeId] ? episodeId : 'deep';
    if (!force && state.currentEpisodeId === nextId && state.cueElements.length > 0) {
      if (autoplay) playFromStart();
      return;
    }

    pause();
    state.loadToken += 1;
    const token = state.loadToken;

    state.currentEpisodeId = nextId;
    const ep = episodes[nextId];
    state.currentTime = 0;
    state.duration = Math.max(1, Number(ep?.fallbackDuration) || 45);
    state.activeCueIndex = -1;
    state.mode = 'demo';

    if (dom.epTitle) dom.epTitle.textContent = ep?.title || '拾声集样片';
    if (dom.epSummary) dom.epSummary.textContent = ep?.summary || '';

    updateSourceBadge('demo');
    updateProgressUI(0);
    renderTranscript(ep?.cues || []);
    updatePlayStateUI();
    if (syncSegmented) {
      syncSegmentedButtons(nextId);
    }

    prepareEpisodeAudio(ep, token);

    if (autoplay) {
      playFromStart();
    }
  }

  function seekTo(seconds, { scrollTranscript = false } = {}) {
    const dur = Math.max(0.01, state.duration || 1);
    const clamped = Math.max(0, Math.min(dur, Number(seconds) || 0));
    state.currentTime = clamped;

    if (state.mode === 'audio' && audioEl) {
      try {
        audioEl.currentTime = clamped;
      } catch {
        // Ignore if not yet seekable
      }
    }

    updateProgressUI(clamped);
    syncCueHighlight(clamped, { shouldScroll: scrollTranscript });
  }

  function play() {
    const ep = getCurrentEpisode();
    if (!ep) return;

    ambient.unlockInGesture();

    if (state.currentTime >= state.duration - 0.05) {
      seekTo(0, { scrollTranscript: true });
    }

    if (state.mode === 'audio' && audioEl && audioEl.src) {
      audioEl.playbackRate = getCurrentSpeed();
      state.isPlaying = true;
      updatePlayStateUI();
      if (state.ambientEnabled) {
        ambient.startFadeIn();
      }
      audioEl.play().catch(() => {
        fallbackToDemoMode({ preservePlayback: true });
      });
      return;
    }

    state.mode = 'demo';
    state.isPlaying = true;
    updatePlayStateUI();
    if (state.ambientEnabled) {
      ambient.startFadeIn();
    }
    syncCueHighlight(state.currentTime, { shouldScroll: true });
    startDemoLoop();
  }

  function pause() {
    stopDemoLoop();
    const wasPlaying = state.isPlaying;
    state.isPlaying = false;

    if (audioEl && !audioEl.paused) {
      try {
        audioEl.pause();
      } catch {
        // Ignore
      }
    }

    if (wasPlaying) {
      ambient.fadeOut(0.28);
    } else {
      ambient.stopImmediate();
    }
    updatePlayStateUI();
  }

  function togglePlayPause() {
    ambient.unlockInGesture();
    if (state.isPlaying) {
      pause();
    } else {
      play();
    }
  }

  function playFromStart(episodeId) {
    state.hasUserInteracted = true;
    ambient.unlockInGesture();
    if (episodeId && state.samples?.episodes?.[episodeId] && episodeId !== state.currentEpisodeId) {
      applyEpisode(episodeId, { force: true, autoplay: false });
    }
    seekTo(0, { scrollTranscript: true });
    play();
  }

  function selectEpisode(episodeId, options = {}) {
    state.hasUserInteracted = true;
    applyEpisode(episodeId, {
      force: Boolean(options.force),
      autoplay: Boolean(options.autoplay),
      syncSegmented: options.syncSegmented !== false,
    });
  }

  function cycleSpeed() {
    state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
    const rate = getCurrentSpeed();
    if (audioEl) {
      audioEl.playbackRate = rate;
    }
    updateSpeedUI();
  }

  function toggleAmbient() {
    state.ambientEnabled = !state.ambientEnabled;
    ambient.unlockInGesture();
    updateAmbientUI();

    if (state.ambientEnabled && state.isPlaying) {
      ambient.startFadeIn();
    } else {
      ambient.fadeOut(0.32);
    }
  }

  function bindProgressTrackEvents() {
    const track = dom.progressTrack;
    if (!track) return;

    const getRatioFromClientX = (clientX) => {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return 0;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    let activePointerId = null;

    track.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      activePointerId = e.pointerId;
      state.isSeeking = true;
      if (typeof track.setPointerCapture === 'function') {
        try {
          track.setPointerCapture(e.pointerId);
        } catch {
          // Ignore capture failures
        }
      }
      const ratio = getRatioFromClientX(e.clientX);
      const previewTime = ratio * state.duration;
      updateProgressUI(previewTime);
      syncCueHighlight(previewTime, { shouldScroll: false });
    });

    track.addEventListener('pointermove', (e) => {
      if (!state.isSeeking || (activePointerId !== null && e.pointerId !== activePointerId)) return;
      const ratio = getRatioFromClientX(e.clientX);
      const previewTime = ratio * state.duration;
      updateProgressUI(previewTime);
      syncCueHighlight(previewTime, { shouldScroll: false });
    });

    const commitSeek = (e) => {
      if (!state.isSeeking || (activePointerId !== null && e.pointerId !== activePointerId)) return;
      const ratio = getRatioFromClientX(e.clientX);
      state.isSeeking = false;
      activePointerId = null;
      seekTo(ratio * state.duration, { scrollTranscript: true });
    };

    track.addEventListener('pointerup', commitSeek);
    track.addEventListener('pointercancel', commitSeek);

    track.addEventListener('keydown', (e) => {
      const step = Math.max(1, Math.round(state.duration * 0.05));
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        seekTo(state.currentTime - 2, { scrollTranscript: true });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        seekTo(state.currentTime + 2, { scrollTranscript: true });
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        seekTo(state.currentTime - step, { scrollTranscript: true });
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        seekTo(state.currentTime + step, { scrollTranscript: true });
      } else if (e.key === 'Home') {
        e.preventDefault();
        seekTo(0, { scrollTranscript: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        seekTo(state.duration, { scrollTranscript: true });
      }
    });
  }

  function bindEvents() {
    if (dom.btnPlayPause) {
      dom.btnPlayPause.addEventListener('click', togglePlayPause);
    }

    if (dom.btnSkipBack) {
      dom.btnSkipBack.addEventListener('click', () => {
        const delta = getSkipSeconds(dom.btnSkipBack, -5);
        seekTo(state.currentTime + delta, { scrollTranscript: true });
      });
    }

    if (dom.btnSkipForward) {
      dom.btnSkipForward.addEventListener('click', () => {
        const delta = getSkipSeconds(dom.btnSkipForward, 5);
        seekTo(state.currentTime + delta, { scrollTranscript: true });
      });
    }

    if (dom.btnSpeed) {
      dom.btnSpeed.addEventListener('click', cycleSpeed);
    }

    if (dom.btnAmbient) {
      dom.btnAmbient.addEventListener('click', toggleAmbient);
    }

    bindProgressTrackEvents();

    const handleEpisodeEvent = (e) => {
      const nextId = e?.detail?.value || e?.detail?.episode || e?.detail?.id;
      if (nextId) {
        selectEpisode(nextId);
      }
    };
    document.addEventListener('inkcast:episode-change', handleEpisodeEvent);
    if (dom.episodeSeg) {
      dom.episodeSeg.addEventListener('inkcast:episode-change', handleEpisodeEvent);
      dom.episodeSeg.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.segmented-btn[data-value]');
        if (!btn) return;
        const nextId = btn.dataset.value;
        if (nextId) {
          selectEpisode(nextId, { syncSegmented: false });
        }
      });
    }
  }

  async function loadSamplesData() {
    if (window.location.protocol === 'file:') {
      return FALLBACK_SAMPLES;
    }
    try {
      const res = await fetch(SAMPLES_URL, { cache: 'no-cache' });
      if (!res.ok) return FALLBACK_SAMPLES;
      const data = await res.json();
      if (data && data.episodes && (data.episodes.deep || data.episodes.casual)) {
        return data;
      }
    } catch {
      // Fallback gracefully when samples.json cannot be fetched
    }
    return FALLBACK_SAMPLES;
  }

  async function init() {
    if (initialized) return;
    initialized = true;

    collectDom();
    if (!dom.stage) return;

    updateSpeedUI();
    updateAmbientUI();
    bindEvents();

    const initialActiveBtn = dom.episodeSeg?.querySelector('.segmented-btn.is-active[data-value]');
    const initialEpisodeId = initialActiveBtn?.dataset?.value || 'deep';
    applyEpisode(initialEpisodeId, { force: true, autoplay: false });

    const remoteSamples = await loadSamplesData();
    if (remoteSamples && remoteSamples !== FALLBACK_SAMPLES) {
      state.samples = remoteSamples;
      if (!state.hasUserInteracted && !state.isPlaying && state.currentTime === 0) {
        applyEpisode(state.currentEpisodeId, { force: true, autoplay: false });
      }
    }
  }

  window.InkCastPlayer = {
    init,
    playFromStart,
    pause,
    selectEpisode,
    unlockAudioInGesture: () => ambient.unlockInGesture(),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
    });
  } else {
    init();
  }
})();
