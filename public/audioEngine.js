(function () {
  'use strict';

  const STORAGE_KEY = 'ai_podcast_bgm_mode';
  const BGM_MODES = ['warm', 'airy', 'off'];
  const BGM_LABELS = {
    warm: '配乐·暖调',
    airy: '配乐·清透',
    off: '配乐·关',
  };

  const BGM_LOOP_SECONDS = 24;
  const BGM_SAMPLE_RATE = 32000;
  const INTRO_DURATION_MS = 2300;
  const OUTRO_DURATION_MS = 2600;
  const BGM_INTRO_GAIN = 0.34;
  const BGM_DUCK_GAIN = 0.105;
  const BGM_OUTRO_GAIN = 0.24;

  function readBgmMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return BGM_MODES.includes(saved) ? saved : 'warm';
    } catch {
      return 'warm';
    }
  }

  function saveBgmMode(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors in private browsing mode
    }
  }

  function findSentenceIndex(sentences, currentTime, lastIndex = -1) {
    if (!Array.isArray(sentences) || !sentences.length) return -1;
    const len = sentences.length;
    if (lastIndex >= 0 && lastIndex < len) {
      const cur = sentences[lastIndex];
      const next = lastIndex + 1 < len ? sentences[lastIndex + 1] : null;
      if (currentTime >= cur.startTime && (!next || currentTime < next.startTime)) {
        return lastIndex;
      }
      if (next && currentTime >= next.startTime) {
        const afterNext = lastIndex + 2 < len ? sentences[lastIndex + 2] : null;
        if (!afterNext || currentTime < afterNext.startTime) {
          return lastIndex + 1;
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

  /**
   * Build a seamless 24-second stereo ambient music buffer offline.
   * Each chord & chime decays cleanly inside the 24s bar so looping has zero clicks.
   */
  async function renderBgmBuffer(style) {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) return null;

    const length = BGM_LOOP_SECONDS * BGM_SAMPLE_RATE;
    const offline = new OfflineCtx(2, length, BGM_SAMPLE_RATE);

    const masterFilter = offline.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = style === 'airy' ? 2500 : 1850;
    masterFilter.Q.value = 0.7;

    // Gentle mid-band pocket around ~1.5kHz so voices stay crisp and foregrounded
    const vocalPocket = offline.createBiquadFilter();
    vocalPocket.type = 'peaking';
    vocalPocket.frequency.value = 1550;
    vocalPocket.Q.value = 0.9;
    vocalPocket.gain.value = -4.5;

    const masterGain = offline.createGain();
    masterGain.gain.value = 0.72;

    masterFilter.connect(vocalPocket);
    vocalPocket.connect(masterGain);
    masterGain.connect(offline.destination);

    // 4 chords x 6s = 24s loop
    const chords = style === 'airy'
      ? [
          [261.63, 329.63, 392.00, 493.88, 587.33], // Cmaj9
          [220.00, 261.63, 329.63, 392.00, 493.88], // Am9
          [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9
          [196.00, 246.94, 293.66, 329.63, 440.00], // G6
        ]
      : [
          [174.61, 220.00, 261.63, 329.63], // Fmaj7
          [164.81, 196.00, 246.94, 293.66], // Em7
          [146.83, 174.61, 220.00, 261.63], // Dm7
          [130.81, 164.81, 196.00, 246.94], // Cmaj7
        ];

    const chordDur = 6.0;
    chords.forEach((freqs, barIdx) => {
      const start = barIdx * chordDur;
      const end = start + chordDur;

      // Soft warm pad chord (triangle + sine overtone), enclosed inside [start, end]
      freqs.forEach((freq, voiceIdx) => {
        const osc = offline.createOscillator();
        const pan = offline.createStereoPanner();
        const gain = offline.createGain();

        osc.type = voiceIdx === 0 ? 'sine' : 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = (voiceIdx % 2 === 0 ? 1 : -1) * (style === 'airy' ? 4.5 : 3.0);
        pan.pan.value = ((voiceIdx / Math.max(1, freqs.length - 1)) - 0.5) * 0.55;

        const peak = voiceIdx === 0 ? 0.105 : 0.058;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(peak, start + 1.1);
        gain.gain.setValueAtTime(peak * 0.88, end - 1.25);
        gain.gain.linearRampToValueAtTime(0.0001, end - 0.04);

        osc.connect(gain);
        gain.connect(pan);
        pan.connect(masterFilter);
        osc.start(start);
        osc.stop(end);
      });

      // Gentle electric-piano / felt-pluck arpeggio notes inside the bar
      const arpOffsets = style === 'airy' ? [0.25, 1.5, 2.75, 4.0] : [0.35, 1.75, 3.15, 4.45];
      arpOffsets.forEach((offset, stepIdx) => {
        const noteStart = start + offset;
        const noteEnd = Math.min(end - 0.08, noteStart + 1.35);
        if (noteEnd <= noteStart + 0.1) return;

        const baseFreq = freqs[(stepIdx + barIdx) % freqs.length];
        const noteFreq = style === 'airy' ? baseFreq * 2 : baseFreq * (stepIdx % 2 === 0 ? 2 : 1);

        const osc = offline.createOscillator();
        const pan = offline.createStereoPanner();
        const gain = offline.createGain();

        osc.type = 'sine';
        osc.frequency.value = noteFreq;
        pan.pan.value = stepIdx % 2 === 0 ? -0.32 : 0.32;

        const notePeak = style === 'airy' ? 0.046 : 0.04;
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(notePeak, noteStart + 0.045);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

        osc.connect(gain);
        gain.connect(pan);
        pan.connect(masterFilter);
        osc.start(noteStart);
        osc.stop(noteEnd + 0.02);
      });
    });

    return offline.startRendering();
  }

  /**
   * Compute per-sentence gain multipliers so quiet segments (e.g. -40dB drops)
   * match the podcast's median active speaking loudness without clipping peaks.
   */
  function computeSentenceGains(audioBuffer, sentences) {
    if (!audioBuffer || !Array.isArray(sentences) || !sentences.length) return null;
    const sampleRate = audioBuffer.sampleRate;
    const channelCount = audioBuffer.numberOfChannels;
    const channels = [];
    for (let c = 0; c < channelCount; c += 1) {
      channels.push(audioBuffer.getChannelData(c));
    }
    const totalSamples = audioBuffer.length;
    const blockSamples = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms blocks

    const metrics = sentences.map((sentence) => {
      const startSample = Math.max(0, Math.floor((Number(sentence.startTime) || 0) * sampleRate));
      const endSample = Math.min(totalSamples, Math.ceil((Number(sentence.endTime) || 0) * sampleRate));
      if (endSample <= startSample + blockSamples) {
        return { activeDb: null, peakDb: null };
      }

      let peak = 0;
      const blockRmsValues = [];
      for (let pos = startSample; pos < endSample; pos += blockSamples) {
        const limit = Math.min(endSample, pos + blockSamples);
        let sumSq = 0;
        let count = 0;
        for (let i = pos; i < limit; i += 1) {
          let sample = 0;
          for (let c = 0; c < channelCount; c += 1) {
            sample += channels[c][i];
          }
          sample /= channelCount;
          const abs = Math.abs(sample);
          if (abs > peak) peak = abs;
          sumSq += sample * sample;
          count += 1;
        }
        const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
        if (rms > 0.0025) {
          blockRmsValues.push(rms);
        }
      }

      const activeDb = blockRmsValues.length
        ? (() => {
            const meanSq = blockRmsValues.reduce((acc, v) => acc + v * v, 0) / blockRmsValues.length;
            return 20 * Math.log10(Math.max(1e-5, Math.sqrt(meanSq)));
          })()
        : null;
      const peakDb = peak > 0 ? 20 * Math.log10(peak) : null;
      return { activeDb, peakDb };
    });

    const validDbs = metrics
      .map((m) => m.activeDb)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!validDbs.length) return null;

    const mid = Math.floor(validDbs.length / 2);
    const medianDb = validDbs.length % 2 === 1
      ? validDbs[mid]
      : (validDbs[mid - 1] + validDbs[mid]) / 2;

    return metrics.map(({ activeDb, peakDb }) => {
      if (!Number.isFinite(activeDb)) return 1.0;
      let deltaDb = medianDb - activeDb;
      deltaDb = Math.max(-4.5, Math.min(14.5, deltaDb));
      if (Number.isFinite(peakDb) && peakDb + deltaDb > -2.0) {
        deltaDb = Math.max(-4.5, -2.0 - peakDb);
      }
      return Math.pow(10, deltaDb / 20);
    });
  }

  function createAudioEngine(audioEl, options = {}) {
    const onPhaseChange = typeof options.onPhaseChange === 'function' ? options.onPhaseChange : () => {};

    let bgmMode = readBgmMode();
    let audioCtx = null;
    let mediaSource = null;
    let sentenceGain = null;
    let vocalCompressor = null;
    let vocalMakeup = null;
    let bgmGain = null;
    let bgmSource = null;

    const bgmBuffers = new Map();
    const bgmPromises = new Map();
    const gainCache = new Map();

    let currentPodcast = null;
    let currentSentenceGains = null;
    let currentSentenceIdx = -1;
    let phase = 'idle'; // 'idle' | 'intro' | 'playing' | 'outro'
    let introTimer = null;
    let introStartTimer = null;
    let outroTimer = null;
    let fadeOutTimer = null;
    let fadingOutSource = null;
    let analyzeAbortController = null;
    let analyzingPodcastKey = null;
    let playToken = 0;

    function getPodcastCacheKey(podcast) {
      if (!podcast?.id) return '';
      const version = podcast.audioVersion || podcast.updatedAt || '';
      return version ? `${podcast.id}:${version}` : podcast.id;
    }

    function setPhase(nextPhase) {
      if (phase === nextPhase) return;
      phase = nextPhase;
      onPhaseChange({
        phase,
        isActive: phase === 'intro' || phase === 'playing' || phase === 'outro',
        bgmMode,
      });
    }

    function stopFadingOutSource() {
      if (fadeOutTimer) {
        window.clearTimeout(fadeOutTimer);
        fadeOutTimer = null;
      }
      if (fadingOutSource) {
        const src = fadingOutSource;
        fadingOutSource = null;
        try {
          src.stop();
        } catch {
          // Already stopped
        }
        try {
          src.disconnect();
        } catch {
          // Ignore
        }
      }
    }

    function clearTimers() {
      if (introTimer) {
        window.clearTimeout(introTimer);
        introTimer = null;
      }
      if (introStartTimer) {
        window.clearTimeout(introStartTimer);
        introStartTimer = null;
      }
      if (outroTimer) {
        window.clearTimeout(outroTimer);
        outroTimer = null;
      }
      stopFadingOutSource();
    }

    function cancelPendingAnalysis() {
      if (analyzeAbortController) {
        analyzeAbortController.abort();
        analyzeAbortController = null;
      }
      analyzingPodcastKey = null;
    }

    async function ensureContext() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !audioEl) return null;

      if (!audioCtx) {
        audioCtx = new Ctx();
        sentenceGain = audioCtx.createGain();
        sentenceGain.gain.value = 1.0;

        const highpass = audioCtx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 75;

        vocalCompressor = audioCtx.createDynamicsCompressor();
        vocalCompressor.threshold.value = -20;
        vocalCompressor.knee.value = 18;
        vocalCompressor.ratio.value = 3.5;
        vocalCompressor.attack.value = 0.008;
        vocalCompressor.release.value = 0.16;

        vocalMakeup = audioCtx.createGain();
        vocalMakeup.gain.value = 1.08;

        bgmGain = audioCtx.createGain();
        bgmGain.gain.value = 0.0001;

        try {
          mediaSource = audioCtx.createMediaElementSource(audioEl);
          mediaSource.connect(highpass);
          highpass.connect(sentenceGain);
          sentenceGain.connect(vocalCompressor);
          vocalCompressor.connect(vocalMakeup);
          vocalMakeup.connect(audioCtx.destination);
        } catch {
          // If MediaElementSource cannot attach, native <audio> continues playing directly
          mediaSource = null;
        }
        bgmGain.connect(audioCtx.destination);
      }

      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {
          // Ignore resume failures outside user gestures
        }
      }

      return audioCtx;
    }

    async function getBgmBuffer(style) {
      if (style === 'off') return null;
      if (bgmBuffers.has(style)) return bgmBuffers.get(style);
      if (bgmPromises.has(style)) return bgmPromises.get(style);

      const promise = renderBgmBuffer(style)
        .then((buf) => {
          if (buf) bgmBuffers.set(style, buf);
          return buf;
        })
        .catch(() => null)
        .finally(() => {
          bgmPromises.delete(style);
        });
      bgmPromises.set(style, promise);
      return promise;
    }

    function stopBgmImmediate() {
      stopFadingOutSource();
      if (bgmSource) {
        try {
          bgmSource.stop();
        } catch {
          // Already stopped
        }
        try {
          bgmSource.disconnect();
        } catch {
          // Ignore
        }
        bgmSource = null;
      }
    }

    function fadeOutBgm(durationSec = 0.25) {
      stopFadingOutSource();
      if (!audioCtx || !bgmGain || !bgmSource) {
        stopBgmImmediate();
        return;
      }
      const now = audioCtx.currentTime;
      const sourceToStop = bgmSource;
      bgmSource = null;
      fadingOutSource = sourceToStop;
      try {
        bgmGain.gain.cancelScheduledValues(now);
        bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), now);
        bgmGain.gain.linearRampToValueAtTime(0.0001, now + durationSec);
      } catch {
        // Ignore ramp failure
      }
      fadeOutTimer = window.setTimeout(() => {
        fadeOutTimer = null;
        if (fadingOutSource === sourceToStop) fadingOutSource = null;
        try {
          sourceToStop.stop();
          sourceToStop.disconnect();
        } catch {
          // Ignore
        }
      }, Math.round(durationSec * 1000) + 40);
    }

    async function startBgmAtGain(style, targetGain, rampSec, token) {
      if (style === 'off') {
        stopBgmImmediate();
        return false;
      }
      const ctx = await ensureContext();
      if (!ctx || token !== playToken) return false;
      const buf = await getBgmBuffer(style);
      if (!buf || token !== playToken) return false;

      stopBgmImmediate();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(bgmGain);

      const now = ctx.currentTime;
      bgmGain.gain.cancelScheduledValues(now);
      bgmGain.gain.setValueAtTime(0.0001, now);
      bgmGain.gain.linearRampToValueAtTime(targetGain, now + rampSec);
      src.start(now);
      bgmSource = src;
      return true;
    }

    async function analyzePodcast(podcast) {
      const cacheKey = getPodcastCacheKey(podcast);
      if (!cacheKey || !podcast?.fullAudioUrl || !Array.isArray(podcast?.sentences)) return;
      if (gainCache.has(cacheKey)) {
        if (getPodcastCacheKey(currentPodcast) === cacheKey) {
          currentSentenceGains = gainCache.get(cacheKey);
        }
        return;
      }
      if (analyzingPodcastKey === cacheKey) return;

      cancelPendingAnalysis();
      const controller = new AbortController();
      analyzeAbortController = controller;
      analyzingPodcastKey = cacheKey;

      const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const decoder = audioCtx || (OfflineCtx ? new OfflineCtx(1, 1, 24000) : null);
      if (!decoder) {
        if (analyzeAbortController === controller) {
          analyzeAbortController = null;
          analyzingPodcastKey = null;
        }
        return;
      }

      try {
        const res = await fetch(podcast.fullAudioUrl, { signal: controller.signal });
        if (!res.ok || controller.signal.aborted || getPodcastCacheKey(currentPodcast) !== cacheKey) return;
        const arrayBuffer = await res.arrayBuffer();
        if (controller.signal.aborted || getPodcastCacheKey(currentPodcast) !== cacheKey) return;
        const decoded = await decoder.decodeAudioData(arrayBuffer);
        if (controller.signal.aborted || getPodcastCacheKey(currentPodcast) !== cacheKey) return;
        const gains = computeSentenceGains(decoded, podcast.sentences);
        if (!gains) return;

        if (gainCache.size >= 10) {
          const oldestKey = gainCache.keys().next().value;
          gainCache.delete(oldestKey);
        }
        gainCache.set(cacheKey, gains);
        if (getPodcastCacheKey(currentPodcast) === cacheKey) {
          currentSentenceGains = gains;
          currentSentenceIdx = -1;
          syncTime(audioEl?.currentTime || 0);
        }
      } catch {
        // Non-fatal: fallback to flat 1.0 vocal gain
      } finally {
        if (analyzeAbortController === controller) {
          analyzeAbortController = null;
          analyzingPodcastKey = null;
        }
      }
    }

    function loadPodcast(podcast) {
      playToken += 1;
      clearTimers();
      cancelPendingAnalysis();
      stopBgmImmediate();
      setPhase('idle');

      currentPodcast = podcast || null;
      currentSentenceIdx = -1;
      const cacheKey = getPodcastCacheKey(podcast);
      currentSentenceGains = cacheKey ? (gainCache.get(cacheKey) || null) : null;

      if (audioCtx && sentenceGain) {
        sentenceGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
      }
    }

    function syncTime(currentTime) {
      if (!audioCtx || !sentenceGain || !currentPodcast?.sentences?.length) return;
      const idx = findSentenceIndex(currentPodcast.sentences, currentTime, currentSentenceIdx);
      if (idx === -1) return;
      if (idx === currentSentenceIdx && currentSentenceGains) return;
      currentSentenceIdx = idx;

      const targetGain = currentSentenceGains && Number.isFinite(currentSentenceGains[idx])
        ? currentSentenceGains[idx]
        : 1.0;
      sentenceGain.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.055);
    }

    async function requestPlay({ skipIntro = false } = {}) {
      if (!audioEl?.src) return;
      const token = ++playToken;
      clearTimers();
      await ensureContext();
      if (token !== playToken) return;

      if (currentPodcast && !currentSentenceGains) {
        analyzePodcast(currentPodcast);
      }

      const shouldIntro = !skipIntro && bgmMode !== 'off' && (audioEl.currentTime || 0) < 0.25 && !audioEl.ended;
      if (shouldIntro) {
        setPhase('intro');
        const started = await startBgmAtGain(bgmMode, BGM_INTRO_GAIN, 0.45, token);
        if (token !== playToken) return;

        if (!started) {
          setPhase('playing');
          await audioEl.play();
          return;
        }

        // Start ducking slightly before voices enter at 2.3s
        introTimer = window.setTimeout(() => {
          if (token !== playToken || !audioCtx || !bgmGain) return;
          const now = audioCtx.currentTime;
          bgmGain.gain.cancelScheduledValues(now);
          bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), now);
          bgmGain.gain.linearRampToValueAtTime(BGM_DUCK_GAIN, now + 0.85);
        }, Math.max(0, INTRO_DURATION_MS - 350));

        introStartTimer = window.setTimeout(() => {
          if (token !== playToken) return;
          syncTime(audioEl.currentTime || 0);
          audioEl.play().catch(() => {
            if (token === playToken) {
              stopBgmImmediate();
              setPhase('idle');
            }
          });
        }, INTRO_DURATION_MS);
        return;
      }

      if (bgmMode !== 'off') {
        if (!bgmSource) {
          startBgmAtGain(bgmMode, BGM_DUCK_GAIN, 0.4, token);
        } else if (audioCtx && bgmGain) {
          const now = audioCtx.currentTime;
          bgmGain.gain.cancelScheduledValues(now);
          bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), now);
          bgmGain.gain.linearRampToValueAtTime(BGM_DUCK_GAIN, now + 0.35);
        }
      }

      setPhase('playing');
      syncTime(audioEl.currentTime || 0);
      await audioEl.play();
    }

    function requestPause() {
      playToken += 1;
      clearTimers();
      if (audioEl && !audioEl.paused) {
        audioEl.pause();
      }
      fadeOutBgm(0.25);
      setPhase('idle');
    }

    async function seekAndPlay(targetSeconds) {
      if (!audioEl?.src) return;
      const target = Math.max(0, Number(targetSeconds) || 0);
      audioEl.currentTime = target;
      syncTime(target);
      await requestPlay({ skipIntro: true });
    }

    function handleAudioPlay() {
      clearTimers();
      setPhase('playing');
      if (currentPodcast && !currentSentenceGains) {
        analyzePodcast(currentPodcast);
      }
      syncTime(audioEl?.currentTime || 0);
      if (bgmMode !== 'off' && !bgmSource) {
        const token = playToken;
        startBgmAtGain(bgmMode, BGM_DUCK_GAIN, 0.4, token);
      }
    }

    function handleAudioPause() {
      if (phase === 'intro' || phase === 'outro') return;
      if (audioEl?.ended) return;
      playToken += 1;
      clearTimers();
      fadeOutBgm(0.25);
      setPhase('idle');
    }

    function handleAudioEnded() {
      clearTimers();
      if (bgmMode === 'off' || !bgmSource || !audioCtx || !bgmGain) {
        stopBgmImmediate();
        setPhase('idle');
        return;
      }

      const token = ++playToken;
      setPhase('outro');
      const now = audioCtx.currentTime;
      const outSec = OUTRO_DURATION_MS / 1000;
      bgmGain.gain.cancelScheduledValues(now);
      bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), now);
      bgmGain.gain.linearRampToValueAtTime(BGM_OUTRO_GAIN, now + 0.55);
      bgmGain.gain.setValueAtTime(BGM_OUTRO_GAIN, now + 1.0);
      bgmGain.gain.linearRampToValueAtTime(0.0001, now + outSec);

      outroTimer = window.setTimeout(() => {
        if (token !== playToken) return;
        stopBgmImmediate();
        setPhase('idle');
      }, OUTRO_DURATION_MS + 60);
    }

    async function setBgmMode(nextMode) {
      if (!BGM_MODES.includes(nextMode)) return bgmMode;
      bgmMode = nextMode;
      saveBgmMode(bgmMode);

      if (bgmMode === 'off') {
        if (phase === 'intro' || phase === 'outro') {
          clearTimers();
          stopBgmImmediate();
          if (phase === 'intro' && audioEl?.src) {
            setPhase('playing');
            audioEl.play().catch(() => setPhase('idle'));
          } else {
            setPhase('idle');
          }
        } else {
          fadeOutBgm(0.28);
        }
        onPhaseChange({ phase, isActive: phase !== 'idle', bgmMode });
        return bgmMode;
      }

      if (phase === 'playing' || phase === 'intro' || phase === 'outro') {
        const target = phase === 'intro' ? BGM_INTRO_GAIN : phase === 'outro' ? BGM_OUTRO_GAIN : BGM_DUCK_GAIN;
        await startBgmAtGain(bgmMode, target, 0.35, playToken);
      }
      onPhaseChange({ phase, isActive: phase !== 'idle', bgmMode });
      return bgmMode;
    }

    function cycleBgmMode() {
      const idx = BGM_MODES.indexOf(bgmMode);
      const next = BGM_MODES[(idx + 1) % BGM_MODES.length];
      return setBgmMode(next);
    }

    function getBgmMode() {
      return bgmMode;
    }

    function getBgmLabel(mode = bgmMode) {
      return BGM_LABELS[mode] || BGM_LABELS.warm;
    }

    function getPhase() {
      return phase;
    }

    function suspend() {
      playToken += 1;
      clearTimers();
      cancelPendingAnalysis();
      stopBgmImmediate();
      if (audioEl && !audioEl.paused) {
        audioEl.pause();
      }
      setPhase('idle');
      if (audioCtx && audioCtx.state === 'running') {
        try {
          audioCtx.suspend().catch(() => {});
        } catch {
          // Ignore suspend failures on pagehide
        }
      }
    }

    function dispose() {
      playToken += 1;
      clearTimers();
      cancelPendingAnalysis();
      stopBgmImmediate();
      bgmBuffers.clear();
      bgmPromises.clear();
      gainCache.clear();
      currentPodcast = null;
      currentSentenceGains = null;
      currentSentenceIdx = -1;
      phase = 'idle';
      if (audioCtx) {
        const ctxToClose = audioCtx;
        audioCtx = null;
        mediaSource = null;
        sentenceGain = null;
        vocalCompressor = null;
        vocalMakeup = null;
        bgmGain = null;
        try {
          ctxToClose.close().catch(() => {});
        } catch {
          // Ignore close errors on unload
        }
      }
    }

    return {
      BGM_MODES,
      getBgmMode,
      getBgmLabel,
      setBgmMode,
      cycleBgmMode,
      getPhase,
      loadPodcast,
      syncTime,
      requestPlay,
      requestPause,
      seekAndPlay,
      handleAudioPlay,
      handleAudioPause,
      handleAudioEnded,
      suspend,
      dispose,
    };
  }

  window.PodcastAudioEngine = {
    createAudioEngine,
    computeSentenceGains,
    BGM_MODES,
    BGM_LABELS,
  };
})();
