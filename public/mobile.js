(function () {
  'use strict';

  const SPEEDS = [0.8, 1.0, 1.25, 1.5, 1.75, 2.0];
  const STYLE_LABELS = {
    deep_dive: '深度主讲',
    dialogue: '轻松对谈',
    debate: '正反交锋',
  };

  const state = {
    view: 'library',
    collections: [],
    totalPodcastCount: 0,
    unassignedCount: 0,
    selectedFilter: 'all',
    podcasts: [],
    currentDetail: null,
    currentDetailId: null,
    detailSeq: 0,
    speedIndex: 1,
    isSeeking: false,
    activeSentenceIndex: -1,
    sentenceEls: [],
    userScrollingUntil: 0,
    disconnected: false,
  };

  const dom = {
    tabLibrary: document.getElementById('mTabLibrary'),
    tabPlayer: document.getElementById('mTabPlayer'),
    viewLibrary: document.getElementById('mViewLibrary'),
    viewPlayer: document.getElementById('mViewPlayer'),
    collectionBar: document.getElementById('mCollectionBar'),
    libraryHeading: document.getElementById('mLibraryHeading'),
    libraryCount: document.getElementById('mLibraryCount'),
    episodeList: document.getElementById('mEpisodeList'),
    btnBackLibrary: document.getElementById('mBtnBackLibrary'),
    btnSaveMp3: document.getElementById('mBtnSaveMp3'),
    detailBadges: document.getElementById('mDetailBadges'),
    detailTitle: document.getElementById('mDetailTitle'),
    detailSummary: document.getElementById('mDetailSummary'),
    detailMeta: document.getElementById('mDetailMeta'),
    highlightsCard: document.getElementById('mHighlightsCard'),
    highlightsHeading: document.getElementById('mHighlightsHeading'),
    highlightsList: document.getElementById('mHighlightsList'),
    transcriptList: document.getElementById('mTranscriptList'),
    playerDock: document.getElementById('mPlayerDock'),
    dockEpisodeBtn: document.getElementById('mDockEpisodeBtn'),
    dockTitle: document.getElementById('mDockTitle'),
    dockSpeakerName: document.getElementById('mDockSpeakerName'),
    dockExpandHint: document.getElementById('mDockExpandHint'),
    currentTime: document.getElementById('mCurrentTime'),
    totalTime: document.getElementById('mTotalTime'),
    seekSlider: document.getElementById('mSeekSlider'),
    btnSpeed: document.getElementById('mBtnSpeed'),
    btnBack15: document.getElementById('mBtnBack15'),
    btnPlayPause: document.getElementById('mBtnPlayPause'),
    btnFwd15: document.getElementById('mBtnFwd15'),
    btnNext: document.getElementById('mBtnNext'),
    authOverlay: document.getElementById('mAuthOverlay'),
    overlayTitle: document.getElementById('mOverlayTitle'),
    overlayMsg: document.getElementById('mOverlayMsg'),
    btnRetryConnect: document.getElementById('mBtnRetryConnect'),
    toastStack: document.getElementById('mToastStack'),
    audio: document.getElementById('mAudio'),
  };

  function showToast(msg) {
    if (!dom.toastStack || !msg) return;
    const pill = document.createElement('div');
    pill.className = 'm-toast';
    pill.textContent = msg;
    dom.toastStack.appendChild(pill);
    window.setTimeout(() => {
      pill.remove();
    }, 2400);
  }

  function formatTime(sec) {
    const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function isHostSpeaker(speaker) {
    return !speaker || speaker.includes('阿泽') || speaker.toLowerCase().includes('host');
  }

  function showDisconnected(title, msg) {
    state.disconnected = true;
    dom.audio.pause();
    updateDockPlayState();
    if (dom.overlayTitle && title) dom.overlayTitle.textContent = title;
    if (dom.overlayMsg && msg) dom.overlayMsg.textContent = msg;
    if (dom.authOverlay) dom.authOverlay.classList.remove('hidden');
  }

  function hideDisconnected() {
    state.disconnected = false;
    if (dom.authOverlay) dom.authOverlay.classList.add('hidden');
  }

  async function companionFetch(url) {
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    } catch {
      const err = new Error('网络已断开，无法连接电脑端随身听');
      err.isNetwork = true;
      throw err;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401 || body?.code === 'LAN_AUTH_REQUIRED') {
      showDisconnected(
        '随身听连接已失效',
        '电脑端已关闭随身听或刷新了配对二维码。请在电脑端「拾声集 → 手机随身听」重新扫码连接。'
      );
      const err = new Error(body?.error || '连接已失效');
      err.status = 401;
      throw err;
    }
    if (!res.ok || body?.success === false) {
      const err = new Error(body?.error || `请求失败（HTTP ${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return body.data;
  }

  function switchView(nextView) {
    state.view = nextView === 'player' ? 'player' : 'library';
    const isPlayer = state.view === 'player';
    dom.viewLibrary.classList.toggle('hidden', isPlayer);
    dom.viewPlayer.classList.toggle('hidden', !isPlayer);
    dom.tabLibrary.classList.toggle('is-active', !isPlayer);
    dom.tabPlayer.classList.toggle('is-active', isPlayer);
    dom.tabLibrary.setAttribute('aria-selected', String(!isPlayer));
    dom.tabPlayer.setAttribute('aria-selected', String(isPlayer));
    if (dom.dockExpandHint) {
      dom.dockExpandHint.textContent = isPlayer ? '节目单 ›' : '台词 ›';
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function findCollection(collectionId) {
    if (!collectionId) return null;
    return state.collections.find((c) => c.id === collectionId) || null;
  }

  function getFilteredEpisodes() {
    if (state.selectedFilter === 'all') return state.podcasts;
    if (state.selectedFilter === 'unassigned') {
      return state.podcasts.filter((ep) => !ep.collectionId);
    }
    return state.podcasts.filter((ep) => ep.collectionId === state.selectedFilter);
  }

  function renderCollectionBar() {
    if (!dom.collectionBar) return;
    dom.collectionBar.replaceChildren();

    const makePill = ({ id, label, count, color }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'm-filter-pill' + (state.selectedFilter === id ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(state.selectedFilter === id));
      btn.dataset.filterId = id;
      if (color) btn.dataset.collectionColor = color;

      if (color) {
        const dot = document.createElement('span');
        dot.className = 'm-col-dot';
        dot.setAttribute('aria-hidden', 'true');
        btn.appendChild(dot);
      }

      const nameSpan = document.createElement('span');
      nameSpan.textContent = label;
      btn.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'm-filter-count';
      countSpan.textContent = String(count);
      btn.appendChild(countSpan);

      return btn;
    };

    dom.collectionBar.appendChild(
      makePill({ id: 'all', label: '全部', count: state.totalPodcastCount })
    );

    state.collections.forEach((col) => {
      dom.collectionBar.appendChild(
        makePill({
          id: col.id,
          label: col.name,
          count: col.podcastCount ?? 0,
          color: col.color || 'ink',
        })
      );
    });

    if (state.unassignedCount > 0) {
      dom.collectionBar.appendChild(
        makePill({ id: 'unassigned', label: '未归类', count: state.unassignedCount })
      );
    }
  }

  function renderEpisodeList() {
    if (!dom.episodeList) return;
    const list = getFilteredEpisodes();

    if (dom.libraryHeading) {
      if (state.selectedFilter === 'all') dom.libraryHeading.textContent = '全部播客';
      else if (state.selectedFilter === 'unassigned') dom.libraryHeading.textContent = '未归类播客';
      else dom.libraryHeading.textContent = findCollection(state.selectedFilter)?.name || '合集播客';
    }
    if (dom.libraryCount) {
      dom.libraryCount.textContent = `${list.length} 期`;
    }

    dom.episodeList.replaceChildren();

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'm-empty-card';
      empty.textContent = state.podcasts.length === 0
        ? '电脑端还没有已完成的播客，先在拾声集桌面端生成一期再来收听吧。'
        : '当前筛选下暂时没有播客单集。';
      dom.episodeList.appendChild(empty);
      return;
    }

    const isPlaying = !dom.audio.paused && !dom.audio.ended;

    list.forEach((ep) => {
      const isCurrent = ep.id === state.currentDetailId;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'm-episode-card'
        + (isCurrent ? ' is-current' : '')
        + (isCurrent && isPlaying ? ' is-playing' : '');
      card.setAttribute('role', 'listitem');
      card.dataset.podcastId = ep.id;

      const top = document.createElement('div');
      top.className = 'm-ep-top';

      const tags = document.createElement('div');
      tags.className = 'm-ep-tags';

      const col = findCollection(ep.collectionId);
      if (col) {
        const colPill = document.createElement('span');
        colPill.className = 'm-pill is-collection';
        colPill.dataset.collectionColor = col.color || 'ink';
        const dot = document.createElement('span');
        dot.className = 'm-col-dot';
        dot.setAttribute('aria-hidden', 'true');
        const txt = document.createElement('span');
        txt.textContent = col.name;
        colPill.append(dot, txt);
        tags.appendChild(colPill);
      }

      if (ep.podcastStyle && STYLE_LABELS[ep.podcastStyle]) {
        const stylePill = document.createElement('span');
        stylePill.className = 'm-pill';
        stylePill.textContent = STYLE_LABELS[ep.podcastStyle];
        tags.appendChild(stylePill);
      }

      if (ep.highlightCount > 0) {
        const hlPill = document.createElement('span');
        hlPill.className = 'm-pill is-highlight';
        hlPill.textContent = `✦ ${ep.highlightCount} 金句`;
        tags.appendChild(hlPill);
      }

      const dur = document.createElement('span');
      dur.className = 'm-ep-duration';
      dur.textContent = formatTime(ep.totalDuration || 0);
      top.append(tags, dur);

      const body = document.createElement('div');
      body.className = 'm-ep-body';

      const copy = document.createElement('div');
      copy.className = 'm-ep-copy';

      const title = document.createElement('h2');
      title.className = 'm-ep-title';
      title.textContent = ep.podcastTitle || '未命名播客';
      copy.appendChild(title);

      if (ep.summary) {
        const sum = document.createElement('p');
        sum.className = 'm-ep-summary';
        sum.textContent = ep.summary;
        copy.appendChild(sum);
      }

      const iconWrap = document.createElement('span');
      iconWrap.className = 'm-ep-status-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      if (isCurrent) {
        const eq = document.createElement('span');
        eq.className = 'm-eq-bars';
        eq.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
        iconWrap.appendChild(eq);
      } else {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '15');
        svg.setAttribute('height', '15');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M7.5 5.25a.75.75 0 0 1 1.14-.64l10.5 6.75a.75.75 0 0 1 0 1.28l-10.5 6.75a.75.75 0 0 1-1.14-.64V5.25z');
        svg.appendChild(p);
        iconWrap.appendChild(svg);
      }

      body.append(copy, iconWrap);
      card.append(top, body);
      dom.episodeList.appendChild(card);
    });

    updateNextButtonState();
  }

  function updateNextButtonState() {
    if (!dom.btnNext) return;
    const list = getFilteredEpisodes();
    const idx = list.findIndex((ep) => ep.id === state.currentDetailId);
    dom.btnNext.disabled = list.length <= 1 && idx === -1 ? true : (list.length === 0 || (idx >= 0 && idx >= list.length - 1));
  }

  function setControlsEnabled(enabled) {
    dom.seekSlider.disabled = !enabled;
    dom.btnSpeed.disabled = !enabled;
    dom.btnBack15.disabled = !enabled;
    dom.btnPlayPause.disabled = !enabled;
    dom.btnFwd15.disabled = !enabled;
    updateNextButtonState();
  }

  function renderEpisodeDetail(podcast) {
    if (!podcast) return;
    const col = findCollection(podcast.collectionId);

    if (dom.detailBadges) {
      dom.detailBadges.replaceChildren();
      if (col) {
        const c = document.createElement('span');
        c.className = 'm-pill is-collection';
        c.dataset.collectionColor = col.color || 'ink';
        const d = document.createElement('span');
        d.className = 'm-col-dot';
        const t = document.createElement('span');
        t.textContent = col.name;
        c.append(d, t);
        dom.detailBadges.appendChild(c);
      }
      if (podcast.podcastStyle && STYLE_LABELS[podcast.podcastStyle]) {
        const s = document.createElement('span');
        s.className = 'm-pill';
        s.textContent = STYLE_LABELS[podcast.podcastStyle];
        dom.detailBadges.appendChild(s);
      }
    }

    if (dom.detailTitle) dom.detailTitle.textContent = podcast.podcastTitle || '未命名播客';
    if (dom.detailSummary) {
      dom.detailSummary.textContent = podcast.summary || '';
      dom.detailSummary.classList.toggle('hidden', !podcast.summary);
    }

    const sentences = Array.isArray(podcast.sentences) ? podcast.sentences : [];
    if (dom.detailMeta) {
      dom.detailMeta.textContent = `${sentences.length} 句对话 · ${formatTime(podcast.totalDuration || 0)}`;
    }

    if (dom.btnSaveMp3) {
      const downloadUrl = `/podcasts/${encodeURIComponent(podcast.id)}/full_podcast.mp3?download=1`;
      dom.btnSaveMp3.href = downloadUrl;
      dom.btnSaveMp3.classList.remove('is-disabled');
      dom.btnSaveMp3.setAttribute('aria-disabled', 'false');
    }

    // 金句卡片
    const highlights = Array.isArray(podcast.highlights)
      ? podcast.highlights.filter((h) => (h?.text && h.text.trim()) || (h?.quote && h.quote.trim()))
      : [];
    if (dom.highlightsCard && dom.highlightsList) {
      dom.highlightsList.replaceChildren();
      dom.highlightsCard.classList.toggle('hidden', highlights.length === 0);
      if (dom.highlightsHeading) {
        dom.highlightsHeading.textContent = `本期金句（${highlights.length}）`;
      }
      highlights.forEach((hl) => {
        const li = document.createElement('li');
        li.className = 'm-highlight-item' + (Number.isFinite(hl.startTime) ? ' is-clickable' : '');
        const textDiv = document.createElement('div');
        textDiv.textContent = (hl.text || hl.quote || '').trim();
        li.appendChild(textDiv);

        if (hl.speaker || Number.isFinite(hl.startTime)) {
          const meta = document.createElement('div');
          meta.className = 'm-highlight-meta';
          const sp = document.createElement('span');
          sp.textContent = hl.speaker || '';
          const tm = document.createElement('span');
          tm.textContent = Number.isFinite(hl.startTime) ? formatTime(hl.startTime) : '';
          meta.append(sp, tm);
          li.appendChild(meta);
        }

        if (Number.isFinite(hl.startTime)) {
          li.addEventListener('click', () => seekAndPlay(hl.startTime));
        }
        dom.highlightsList.appendChild(li);
      });
    }

    // 同步台词流
    renderTranscript(sentences);
  }

  function renderTranscript(sentences) {
    state.sentenceEls = [];
    state.activeSentenceIndex = -1;
    dom.transcriptList.replaceChildren();

    if (!sentences.length) {
      const empty = document.createElement('div');
      empty.className = 'm-empty-card';
      empty.textContent = '该期播客暂无同步台词数据。';
      dom.transcriptList.appendChild(empty);
      return;
    }

    sentences.forEach((s, idx) => {
      const isHost = isHostSpeaker(s.speaker);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `m-sentence ${isHost ? 'is-host' : 'is-guest'}`;
      btn.dataset.index = String(idx);

      const meta = document.createElement('div');
      meta.className = 'm-sentence-meta';

      const speaker = document.createElement('span');
      speaker.className = 'm-sentence-speaker';
      speaker.textContent = s.speaker || (isHost ? '阿泽' : '小晓');
      meta.appendChild(speaker);

      if (s.emotion) {
        const emo = document.createElement('span');
        emo.className = 'm-sentence-emotion';
        emo.textContent = s.emotion;
        meta.appendChild(emo);
      }

      const time = document.createElement('span');
      time.className = 'm-sentence-time';
      time.textContent = formatTime(s.startTime || 0);
      meta.appendChild(time);

      const text = document.createElement('p');
      text.className = 'm-sentence-text';
      text.textContent = s.text || '';

      btn.append(meta, text);
      btn.addEventListener('click', () => {
        if (Number.isFinite(s.startTime)) {
          seekAndPlay(s.startTime);
        }
      });

      dom.transcriptList.appendChild(btn);
      state.sentenceEls.push(btn);
    });
  }

  function findActiveSentenceIndex(sentences, currentTime) {
    if (!sentences?.length) return -1;
    if (currentTime < (sentences[0].startTime || 0)) return -1;
    let lo = 0;
    let hi = sentences.length - 1;
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

  function syncTranscriptHighlight() {
    const sentences = state.currentDetail?.sentences;
    if (!sentences?.length) return;
    const cur = dom.audio.currentTime || 0;
    const idx = findActiveSentenceIndex(sentences, cur);

    if (idx !== state.activeSentenceIndex) {
      if (state.activeSentenceIndex >= 0 && state.sentenceEls[state.activeSentenceIndex]) {
        state.sentenceEls[state.activeSentenceIndex].classList.remove('is-active');
      }
      state.activeSentenceIndex = idx;
      if (idx >= 0 && state.sentenceEls[idx]) {
        const el = state.sentenceEls[idx];
        el.classList.add('is-active');
        if (idx > 0 && state.view === 'player' && Date.now() > state.userScrollingUntil) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    const activeSentence = idx >= 0 ? sentences[idx] : null;
    if (activeSentence) {
      const isHost = isHostSpeaker(activeSentence.speaker);
      dom.playerDock.dataset.speaker = isHost ? 'host' : 'guest';
      dom.dockSpeakerName.textContent = activeSentence.speaker || (isHost ? '阿泽' : '小晓');
    } else {
      dom.playerDock.dataset.speaker = 'none';
      dom.dockSpeakerName.textContent = dom.audio.paused ? '就绪' : '收听中';
    }
  }

  function updateProgressUI() {
    const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
      ? dom.audio.duration
      : (state.currentDetail?.totalDuration || 0);
    const cur = dom.audio.currentTime || 0;
    dom.currentTime.textContent = formatTime(cur);
    dom.totalTime.textContent = formatTime(duration);
    if (!state.isSeeking) {
      const pct = duration > 0 ? Math.min(100, Math.max(0, (cur / duration) * 100)) : 0;
      dom.seekSlider.value = String(pct);
      dom.seekSlider.style.setProperty('--seek-pct', `${pct.toFixed(2)}%`);
    }
    updateMediaPositionState();
  }

  function updateDockPlayState() {
    const playing = !dom.audio.paused && !dom.audio.ended;
    dom.playerDock.dataset.playing = String(playing);
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      } catch {
        // Ignore unsupported mediaSession state
      }
    }
    renderEpisodeList();
  }

  function updateMediaMetadata(podcast) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !podcast) return;
    const colName = findCollection(podcast.collectionId)?.name || '拾声集随身听';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: podcast.podcastTitle || '拾声集播客',
        artist: '拾声集 · 阿泽 & 小晓',
        album: colName,
        artwork: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch {
      // Ignore MediaMetadata errors on older browsers
    }
  }

  function updateMediaPositionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0 ? dom.audio.duration : 0;
    if (!duration) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: dom.audio.playbackRate || 1.0,
        position: Math.min(duration, Math.max(0, dom.audio.currentTime || 0)),
      });
    } catch {
      // Ignore unsupported setPositionState arguments
    }
  }

  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const bindAction = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Ignore unsupported actions
      }
    };
    bindAction('play', () => {
      if (state.currentDetailId) dom.audio.play().catch(() => {});
    });
    bindAction('pause', () => dom.audio.pause());
    bindAction('seekbackward', (details) => {
      seekRelative(-(details?.seekOffset || 15));
    });
    bindAction('seekforward', (details) => {
      seekRelative(details?.seekOffset || 15);
    });
    bindAction('previoustrack', () => playRelativeEpisode(-1));
    bindAction('nexttrack', () => playRelativeEpisode(1));
    bindAction('seekto', (details) => {
      if (Number.isFinite(details?.seekTime)) {
        dom.audio.currentTime = Math.max(0, details.seekTime);
        updateProgressUI();
        syncTranscriptHighlight();
      }
    });
  }

  function seekAndPlay(targetSec) {
    if (!state.currentDetailId) return;
    const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
      ? dom.audio.duration
      : (state.currentDetail?.totalDuration || 0);
    const clamped = Math.max(0, duration > 0 ? Math.min(duration, targetSec) : targetSec);
    dom.audio.currentTime = clamped;
    updateProgressUI();
    syncTranscriptHighlight();
    dom.audio.play().catch(() => {});
  }

  function seekRelative(deltaSec) {
    if (!state.currentDetailId) return;
    const next = (dom.audio.currentTime || 0) + deltaSec;
    const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
      ? dom.audio.duration
      : (state.currentDetail?.totalDuration || 0);
    dom.audio.currentTime = Math.max(0, duration > 0 ? Math.min(duration, next) : next);
    updateProgressUI();
    syncTranscriptHighlight();
  }

  function cycleSpeed() {
    state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
    const rate = SPEEDS[state.speedIndex];
    dom.audio.playbackRate = rate;
    dom.btnSpeed.textContent = `${rate.toFixed(rate % 1 === 0 ? 1 : 2).replace(/\.00$/, '.0')}x`;
    updateMediaPositionState();
  }

  async function selectEpisode(id, { autoplay = true, openDetail = true } = {}) {
    if (!id) return;
    const seq = ++state.detailSeq;

    try {
      const detail = await companionFetch(`/api/companion/podcasts/${encodeURIComponent(id)}`);
      if (seq !== state.detailSeq) return;
      state.currentDetail = detail;
      state.currentDetailId = detail.id;
      setControlsEnabled(true);
      dom.dockTitle.textContent = detail.podcastTitle || '未命名播客';
      renderEpisodeList();
      renderEpisodeDetail(detail);
      if (openDetail) switchView('player');
      updateMediaMetadata(detail);

      const audioSrc = detail.fullAudioUrl || `/podcasts/${encodeURIComponent(detail.id)}/full_podcast.mp3`;
      if (dom.audio.getAttribute('src') !== audioSrc) {
        dom.audio.src = audioSrc;
        dom.audio.playbackRate = SPEEDS[state.speedIndex];
      }
      updateProgressUI();
      syncTranscriptHighlight();

      if (autoplay) {
        dom.audio.play().catch(() => {
          showToast('请轻触底部播放按钮开始收听');
        });
      }
    } catch (err) {
      if (seq === state.detailSeq && err.status !== 401) {
        showToast(err.message || '加载播客详情失败');
      }
    }
  }

  function playRelativeEpisode(offset) {
    const list = getFilteredEpisodes();
    if (!list.length) return false;
    const idx = list.findIndex((ep) => ep.id === state.currentDetailId);
    const targetIdx = idx === -1 ? 0 : idx + offset;
    if (targetIdx < 0 || targetIdx >= list.length) return false;
    selectEpisode(list[targetIdx].id, { autoplay: true, openDetail: state.view === 'player' });
    return true;
  }

  async function loadLibrary({ autoSelectFirst = false } = {}) {
    const [colData, podData] = await Promise.all([
      companionFetch('/api/companion/collections'),
      companionFetch('/api/companion/podcasts'),
    ]);

    hideDisconnected();
    state.collections = Array.isArray(colData?.items) ? colData.items : [];
    state.totalPodcastCount = Number.isFinite(colData?.totalPodcastCount) ? colData.totalPodcastCount : (podData?.items?.length || 0);
    state.unassignedCount = Number.isFinite(colData?.unassignedCount) ? colData.unassignedCount : 0;
    state.podcasts = Array.isArray(podData?.items) ? podData.items : [];

    if (state.selectedFilter !== 'all' && state.selectedFilter !== 'unassigned' && !findCollection(state.selectedFilter)) {
      state.selectedFilter = 'all';
    }

    renderCollectionBar();
    renderEpisodeList();

    if (autoSelectFirst && !state.currentDetailId && state.podcasts.length > 0) {
      await selectEpisode(state.podcasts[0].id, { autoplay: false, openDetail: false });
    }
  }

  function bindEvents() {
    dom.tabLibrary.addEventListener('click', () => switchView('library'));
    dom.tabPlayer.addEventListener('click', () => switchView('player'));
    dom.btnBackLibrary.addEventListener('click', () => switchView('library'));

    dom.dockEpisodeBtn.addEventListener('click', () => {
      switchView(state.view === 'player' ? 'library' : 'player');
    });

    dom.collectionBar.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-filter-id]');
      if (!pill || !dom.collectionBar.contains(pill)) return;
      const next = pill.dataset.filterId || 'all';
      if (next === state.selectedFilter) return;
      state.selectedFilter = next;
      renderCollectionBar();
      renderEpisodeList();
    });

    dom.episodeList.addEventListener('click', (e) => {
      const card = e.target.closest('[data-podcast-id]');
      if (!card || !dom.episodeList.contains(card)) return;
      selectEpisode(card.dataset.podcastId, { autoplay: true, openDetail: true });
    });

    dom.btnPlayPause.addEventListener('click', () => {
      if (!state.currentDetailId) {
        const list = getFilteredEpisodes();
        if (list.length > 0) selectEpisode(list[0].id, { autoplay: true, openDetail: false });
        return;
      }
      if (dom.audio.paused || dom.audio.ended) {
        dom.audio.play().catch(() => {});
      } else {
        dom.audio.pause();
      }
    });

    dom.btnBack15.addEventListener('click', () => seekRelative(-15));
    dom.btnFwd15.addEventListener('click', () => seekRelative(15));
    dom.btnSpeed.addEventListener('click', cycleSpeed);
    dom.btnNext.addEventListener('click', () => {
      if (!playRelativeEpisode(1)) {
        showToast('已是当前列表最后一集');
      }
    });

    dom.seekSlider.addEventListener('input', () => {
      state.isSeeking = true;
      const pct = Number(dom.seekSlider.value) || 0;
      dom.seekSlider.style.setProperty('--seek-pct', `${pct}%`);
      const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
        ? dom.audio.duration
        : (state.currentDetail?.totalDuration || 0);
      dom.currentTime.textContent = formatTime((pct / 100) * duration);
    });

    const commitSeek = () => {
      if (!state.isSeeking) return;
      state.isSeeking = false;
      const pct = Number(dom.seekSlider.value) || 0;
      const duration = Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
        ? dom.audio.duration
        : (state.currentDetail?.totalDuration || 0);
      if (duration > 0) {
        dom.audio.currentTime = (pct / 100) * duration;
        syncTranscriptHighlight();
      }
    };
    dom.seekSlider.addEventListener('change', commitSeek);

    dom.audio.addEventListener('timeupdate', () => {
      updateProgressUI();
      syncTranscriptHighlight();
    });
    dom.audio.addEventListener('loadedmetadata', () => {
      updateProgressUI();
    });
    dom.audio.addEventListener('play', updateDockPlayState);
    dom.audio.addEventListener('pause', updateDockPlayState);
    dom.audio.addEventListener('ended', () => {
      updateDockPlayState();
      if (!playRelativeEpisode(1)) {
        showToast('当前列表已全部播完');
      }
    });
    dom.audio.addEventListener('error', async () => {
      if (!state.currentDetailId || state.disconnected) return;
      try {
        await companionFetch('/api/companion/collections');
        showToast('音频加载中断，请重试');
      } catch {
        // companionFetch handles 401/network disconnection UI
      }
    });

    const pauseAutoScroll = () => {
      state.userScrollingUntil = Date.now() + 5000;
    };
    window.addEventListener('touchmove', pauseAutoScroll, { passive: true });
    window.addEventListener('wheel', pauseAutoScroll, { passive: true });

    dom.btnRetryConnect.addEventListener('click', async () => {
      dom.btnRetryConnect.disabled = true;
      try {
        await loadLibrary({ autoSelectFirst: !state.currentDetailId });
        showToast('已恢复随身听连接');
      } catch (err) {
        if (err.isNetwork) {
          showDisconnected('无法连接到电脑端', '请确认电脑与手机在同一 Wi-Fi 下，且电脑端拾声集已开启随身听。');
        }
      } finally {
        dom.btnRetryConnect.disabled = false;
      }
    });
  }

  async function bootstrap() {
    setupMediaSessionHandlers();
    bindEvents();
    try {
      await loadLibrary({ autoSelectFirst: true });
    } catch (err) {
      if (err.isNetwork) {
        showDisconnected('无法连接到电脑端', '请确认电脑与手机在同一 Wi-Fi 下，且电脑端拾声集已开启随身听。');
      }
    }
  }

  window.addEventListener('DOMContentLoaded', bootstrap);
})();
