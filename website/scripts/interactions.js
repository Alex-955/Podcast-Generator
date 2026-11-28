(function (global) {
  'use strict';

  const FALLBACK_CONFIG = {
    filename: 'InkCast-v1.0.1-mac-arm64.dmg',
    directUrl: 'https://github.com/Alex-955/Podcast-Generator/releases/download/v1.0.1/InkCast-v1.0.1-mac-arm64.dmg',
    githubReleasesUrl: 'https://github.com/Alex-955/Podcast-Generator/releases/tag/v1.0.1',
    githubRepoUrl: 'https://github.com/Alex-955/Podcast-Generator',
    sha256: 'shasum -a 256 InkCast-v1.0.1-mac-*.dmg',
    requireNodeNotice: false,
  };

  const PREVIEW_ASSETS = {
    desktop: {
      src: './assets/images/studio-desktop.png',
      alt: '拾声集（InkCast）双栏桌面工作台实景截图',
      caption: '双栏桌面工作台 · 导入文稿、确认预览与同步放音同屏完成',
    },
    modal: {
      src: './assets/images/settings-modal.png',
      alt: '拾声集（InkCast）模型与语音配置弹窗实景截图',
      caption: '模型与语音配置 · 自带 Key 直连主流大模型与双主播语音',
    },
  };

  const state = {
    initialized: false,
    os: 'mac',
    simState: 'idle',
    simTimers: [],
    simRunToken: 0,
    simInitialStatus: '',
    simCacheUsesUnit: false,
    toastTimer: null,
    shaHighlightTimer: null,
    downloadRestoreFocusEl: null,
    lightboxRestoreFocusEl: null,
  };

  function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function toggleVisibility(el, visible) {
    if (!el) return;
    if (visible) {
      el.classList.remove('hidden');
      el.removeAttribute('hidden');
    } else {
      el.classList.add('hidden');
      el.setAttribute('hidden', '');
    }
  }

  function resolveConfigValue(cfg, key) {
    if (!cfg || !key) return undefined;
    if (Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur = cfg;
      for (let i = 0; i < parts.length; i += 1) {
        if (cur && typeof cur === 'object' && parts[i] in cur) {
          cur = cur[parts[i]];
        } else {
          cur = undefined;
          break;
        }
      }
      if (cur !== undefined) return cur;
    }
    if (cfg.links && key in cfg.links) return cfg.links[key];
    if (cfg.texts && key in cfg.texts) return cfg.texts[key];
    if (cfg.meta && key in cfg.meta) return cfg.meta[key];
    return undefined;
  }

  function getOsConfig(os) {
    const cfg = global.SITE_CONFIG || {};
    const osBucket =
      (cfg.downloads && cfg.downloads[os]) ||
      (cfg.platforms && cfg.platforms[os]) ||
      (cfg.os && cfg.os[os]) ||
      cfg[os] ||
      {};

    const filename = osBucket.filename || cfg.filename || FALLBACK_CONFIG.filename;
    const directUrl = osBucket.directUrl || cfg.directUrl || FALLBACK_CONFIG.directUrl;
    const githubAssetUrl =
      osBucket.githubAssetUrl ||
      cfg.githubAssetUrl ||
      osBucket.githubReleasesUrl ||
      cfg.githubReleasesUrl ||
      (cfg.links && cfg.links.githubReleases) ||
      cfg.githubReleases ||
      FALLBACK_CONFIG.githubReleasesUrl;
    const sha256 = osBucket.shaCommand || osBucket.sha256 || cfg.sha256 || FALLBACK_CONFIG.sha256;

    return {
      filename,
      directUrl,
      githubAssetUrl,
      sha256,
      directLabel: osBucket.directLabel || (os === 'win' ? '下载 Windows 64 位安装版 (.exe)' : '下载 Apple Silicon (.dmg)'),
      secondaryLabel: osBucket.secondaryLabel || (os === 'win' ? '前往 GitHub Releases v1.0.1' : '下载 Intel 芯片 (.dmg)'),
      heroLabel: osBucket.heroButtonLabel || osBucket.heroLabel || (os === 'win' ? '下载 Windows 安装版（v1.0.1）' : '下载 macOS 桌面版（v1.0.1）'),
      switchLabel: osBucket.switchButtonLabel || osBucket.switchLabel || (os === 'win' ? '切到 macOS 版' : '切到 Windows 版'),
    };
  }

  function bindConfig() {
    const cfg = global.SITE_CONFIG || {};

    document.querySelectorAll('[data-config-text]').forEach((el) => {
      const key = el.getAttribute('data-config-text');
      const val = resolveConfigValue(cfg, key);
      if (typeof val === 'string' || typeof val === 'number') {
        el.textContent = String(val);
      }
    });

    document.querySelectorAll('[data-config-link]').forEach((el) => {
      const key = el.getAttribute('data-config-link');
      const val = resolveConfigValue(cfg, key);
      if (typeof val === 'string' && val.trim()) {
        el.setAttribute('href', val.trim());
      }
    });

    const showNodeNotice = cfg.requireNodeNotice !== false;
    document.querySelectorAll('[data-require-node], #modalNodeNotice').forEach((el) => {
      toggleVisibility(el, showNodeNotice);
    });
  }

  /* ------------------------------------------------------------------
   * 通用弹簧分段控制器 ([data-segmented])
   * ------------------------------------------------------------------ */
  function positionSegmentedIndicator(container, immediate) {
    if (!container) return;
    const indicator = container.querySelector('.segmented-indicator');
    const activeBtn =
      container.querySelector('.segmented-btn.is-active') ||
      container.querySelector('.segmented-btn');
    if (!indicator || !activeBtn) return;
    if (activeBtn.offsetWidth === 0) return;

    const noAnim = Boolean(immediate) || prefersReducedMotion();
    if (noAnim) {
      indicator.style.transition = 'none';
    }
    indicator.style.width = `${activeBtn.offsetWidth}px`;
    indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    if (noAnim) {
      void indicator.offsetWidth;
      indicator.style.transition = '';
    }
  }

  function repositionAllSegmented(immediate) {
    document.querySelectorAll('[data-segmented]').forEach((container) => {
      positionSegmentedIndicator(container, immediate);
    });
  }

  function setSegmentedActive(containerOrName, value, options) {
    const opts = options || {};
    const container =
      typeof containerOrName === 'string'
        ? document.querySelector(`[data-segmented="${containerOrName}"]`)
        : containerOrName;
    if (!container) return null;

    const buttons = Array.from(container.querySelectorAll('.segmented-btn'));
    const targetBtn = buttons.find((btn) => btn.getAttribute('data-value') === value);
    if (!targetBtn) return null;

    buttons.forEach((btn) => {
      const isMatch = btn === targetBtn;
      btn.classList.toggle('is-active', isMatch);
      if (btn.getAttribute('role') === 'tab' || btn.hasAttribute('aria-selected')) {
        btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      }
      if (btn.hasAttribute('aria-pressed')) {
        btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
      }
    });

    positionSegmentedIndicator(container, Boolean(opts.immediate));
    return targetBtn;
  }

  function initSegmentedControls() {
    document.querySelectorAll('[data-segmented]').forEach((container) => {
      positionSegmentedIndicator(container, true);

      container.addEventListener('click', (e) => {
        const btn = e.target.closest('.segmented-btn');
        if (!btn || !container.contains(btn)) return;

        const segName = container.getAttribute('data-segmented') || '';
        const value = btn.getAttribute('data-value') || '';
        setSegmentedActive(container, value, { immediate: false });

        container.dispatchEvent(
          new CustomEvent('inkcast:segmented-change', {
            bubbles: true,
            detail: { name: segName, value },
          })
        );

        if (segName === 'stage-episode') {
          container.dispatchEvent(
            new CustomEvent('inkcast:episode-change', {
              bubbles: true,
              detail: { episode: value, value },
            })
          );
        } else if (segName === 'preview-view') {
          updatePreviewScreenshot(value);
        } else if (segName === 'onboarding-os' || segName === 'modal-os') {
          setOs(value);
        }
      });
    });

    let resizeRaf = 0;
    global.addEventListener(
      'resize',
      () => {
        if (resizeRaf) global.cancelAnimationFrame(resizeRaf);
        resizeRaf = global.requestAnimationFrame(() => {
          resizeRaf = 0;
          repositionAllSegmented(true);
        });
      },
      { passive: true }
    );

    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(() => {
        repositionAllSegmented(true);
      });
    }

    global.requestAnimationFrame(() => {
      repositionAllSegmented(true);
    });
  }

  /* ------------------------------------------------------------------
   * 全局三处 OS 联动 (mac | win)
   * ------------------------------------------------------------------ */
  function detectInitialOs() {
    const platformHint = String(
      (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.platform ||
        navigator.userAgent ||
        ''
    ).toLowerCase();
    return /win/.test(platformHint) ? 'win' : 'mac';
  }

  function setOs(nextOs, options) {
    const opts = options || {};
    const os = nextOs === 'win' ? 'win' : 'mac';
    state.os = os;

    const osCfg = getOsConfig(os);
    const immediate = Boolean(opts.immediate);

    // 1. Hero 主下载按钮与切换按钮
    const heroDownloadBtn = document.getElementById('heroDownloadBtn');
    if (heroDownloadBtn) heroDownloadBtn.setAttribute('data-os', os);

    const heroDownloadLabel = document.getElementById('heroDownloadLabel');
    if (heroDownloadLabel) heroDownloadLabel.textContent = osCfg.heroLabel;

    const heroSwitchOsBtn = document.getElementById('heroSwitchOsBtn');
    if (heroSwitchOsBtn) {
      heroSwitchOsBtn.textContent = osCfg.switchLabel;
      heroSwitchOsBtn.setAttribute('data-target-os', os === 'win' ? 'mac' : 'win');
    }

    // 2. 上手指南分段控件与 Step 2 面板
    setSegmentedActive('onboarding-os', os, { immediate });
    document.querySelectorAll('[data-os-panel]').forEach((panel) => {
      const match = panel.getAttribute('data-os-panel') === os;
      toggleVisibility(panel, match);
      panel.classList.toggle('is-active', match);
    });

    // 3. 下载弹窗分段控件、启动提示与下载元数据
    setSegmentedActive('modal-os', os, { immediate });
    document.querySelectorAll('[data-modal-os-hint]').forEach((hint) => {
      const match = hint.getAttribute('data-modal-os-hint') === os;
      toggleVisibility(hint, match);
      hint.classList.toggle('is-active', match);
    });

    const directBtn = document.getElementById('modalDirectDownloadBtn');
    if (directBtn) {
      if (directBtn.tagName === 'A') {
        directBtn.setAttribute('href', osCfg.directUrl);
        directBtn.setAttribute('download', osCfg.filename);
      } else {
        directBtn.dataset.href = osCfg.directUrl;
      }
      if (osCfg.directLabel) directBtn.textContent = osCfg.directLabel;
    }

    const githubBtn = document.getElementById('modalGithubDownloadBtn');
    if (githubBtn && githubBtn.tagName === 'A') {
      githubBtn.setAttribute('href', osCfg.githubAssetUrl);
      if (osCfg.secondaryLabel) githubBtn.textContent = osCfg.secondaryLabel;
    }

    const filenameEl = document.getElementById('modalFilename');
    if (filenameEl) filenameEl.textContent = osCfg.filename;

    const shaCodeEl = document.getElementById('modalShaCode');
    if (shaCodeEl) shaCodeEl.textContent = osCfg.sha256;

    const cfg = global.SITE_CONFIG || {};
    const showNodeNotice = cfg.requireNodeNotice !== false;
    document.querySelectorAll('[data-require-node], #modalNodeNotice').forEach((el) => {
      toggleVisibility(el, showNodeNotice);
    });
  }

  function initOsSync() {
    const initialOs = detectInitialOs();
    setOs(initialOs, { immediate: true });

    const heroSwitchOsBtn = document.getElementById('heroSwitchOsBtn');
    if (heroSwitchOsBtn) {
      heroSwitchOsBtn.addEventListener('click', () => {
        setOs(state.os === 'mac' ? 'win' : 'mac');
      });
    }

    const directBtn = document.getElementById('modalDirectDownloadBtn');
    if (directBtn && directBtn.tagName !== 'A') {
      directBtn.addEventListener('click', () => {
        const href = directBtn.dataset.href || getOsConfig(state.os).directUrl;
        if (href) global.location.assign(href);
      });
    }
  }

  /* ------------------------------------------------------------------
   * 断点续跑 5 胶囊模拟器
   * ------------------------------------------------------------------ */
  function clearSimTimers() {
    state.simRunToken += 1;
    while (state.simTimers.length > 0) {
      const timerId = state.simTimers.pop();
      global.clearTimeout(timerId);
    }
  }

  function scheduleSim(fn, delayMs) {
    const token = state.simRunToken;
    const id = global.setTimeout(() => {
      if (token !== state.simRunToken) return;
      fn();
    }, delayMs);
    state.simTimers.push(id);
  }

  function initResumeSimulator() {
    const pillsWrap = document.getElementById('simPills');
    const statusEl = document.getElementById('simStatusText');
    const cacheBadgeEl = document.getElementById('simCacheBadge');
    const cacheCountEl = document.getElementById('simCacheCount');
    const btnRun = document.getElementById('btnSimRun');
    const btnReset = document.getElementById('btnSimReset');
    if (!pillsWrap || !btnRun) return;

    const pills = Array.from(pillsWrap.querySelectorAll('.sim-pill')).sort((a, b) => {
      const ia = Number(a.getAttribute('data-sim-index') || 0);
      const ib = Number(b.getAttribute('data-sim-index') || 0);
      return ia - ib;
    });

    state.simInitialStatus =
      (statusEl && statusEl.textContent && statusEl.textContent.trim()) ||
      '点击模拟生成，体验第 3 句突发断网与本地缓存断点续跑';
    state.simCacheUsesUnit = Boolean(cacheCountEl && /句/.test(cacheCountEl.textContent || ''));

    function setCacheCount(count, bounce) {
      if (cacheCountEl) {
        cacheCountEl.textContent = state.simCacheUsesUnit ? `${count} 句` : String(count);
      }
      if (cacheBadgeEl) {
        cacheBadgeEl.classList.toggle('is-active', count > 0);
        cacheBadgeEl.classList.remove('is-bump');
        if (bounce && !prefersReducedMotion()) {
          void cacheBadgeEl.offsetWidth;
          cacheBadgeEl.classList.add('is-bump');
        }
      }
    }

    function setPillState(index, mode, stateLabel) {
      const pill = pills[index];
      if (!pill) return;
      pill.classList.remove(
        'is-running',
        'is-active',
        'is-done',
        'is-error',
        'is-cached',
        'is-shake',
        'is-complete-pop'
      );
      pill.setAttribute('data-state', mode);

      if (mode === 'running') {
        pill.classList.add('is-running', 'is-active');
      } else if (mode === 'done') {
        pill.classList.add('is-done');
      } else if (mode === 'error') {
        pill.classList.add('is-error');
        if (!prefersReducedMotion()) {
          void pill.offsetWidth;
          pill.classList.add('is-shake');
        }
      } else if (mode === 'cached') {
        pill.classList.add('is-cached');
      }

      const stateNode = pill.querySelector('.sim-pill-state');
      if (stateNode) stateNode.textContent = stateLabel;
    }

    function setButtonIdle(label) {
      btnRun.disabled = false;
      btnRun.removeAttribute('aria-disabled');
      btnRun.textContent = label;
    }

    function setButtonBusy(label) {
      btnRun.disabled = true;
      btnRun.setAttribute('aria-disabled', 'true');
      btnRun.textContent = label;
    }

    function resetSim() {
      clearSimTimers();
      state.simState = 'idle';
      pills.forEach((_, idx) => setPillState(idx, 'waiting', '等待'));
      setCacheCount(0, false);
      if (statusEl) statusEl.textContent = state.simInitialStatus;
      setButtonIdle('⚡ 模拟生成（第 3 句突发断网）');
      toggleVisibility(btnReset, false);
    }

    function runPhaseOne() {
      clearSimTimers();
      state.simState = 'running-1';
      pills.forEach((_, idx) => setPillState(idx, 'waiting', '等待'));
      setCacheCount(0, false);
      toggleVisibility(btnReset, false);
      setButtonBusy('正在合成第 01 句…');

      setPillState(0, 'running', '合成中…');
      if (statusEl) statusEl.textContent = '正在合成第 01 句语音并写入本地缓存…';

      scheduleSim(() => {
        setPillState(0, 'done', '✓ 已缓存');
        setPillState(1, 'running', '合成中…');
        if (statusEl) statusEl.textContent = '第 01 句已缓存，正在合成第 02 句…';
      }, 320);

      scheduleSim(() => {
        setPillState(1, 'done', '✓ 已缓存');
        setPillState(2, 'running', '合成中…');
        if (statusEl) statusEl.textContent = '前 2 句已缓存，正在合成第 03 句…';
      }, 640);

      scheduleSim(() => {
        setPillState(2, 'error', '✕ 网络中断');
        if (statusEl) statusEl.textContent = '第 3 句突发断网 · 前 2 句已安全缓存到本地';
        state.simState = 'paused-error';
        setButtonIdle('↻ 从第 3 句断点继续');
        toggleVisibility(btnReset, true);
      }, 980);
    }

    function runPhaseTwo() {
      clearSimTimers();
      state.simState = 'running-2';
      setButtonBusy('正在断点续跑…');

      // 01 与 02 零延迟弹出藏青色「⚡ 命中缓存」
      setPillState(0, 'cached', '⚡ 命中缓存');
      setPillState(1, 'cached', '⚡ 命中缓存');
      setCacheCount(2, true);
      setPillState(2, 'running', '续传中…');
      if (statusEl) statusEl.textContent = '前 2 句零重复请求命中缓存，正从第 3 句继续合成…';

      scheduleSim(() => {
        setPillState(2, 'done', '✓ 已完成');
        setPillState(3, 'running', '合成中…');
        if (statusEl) statusEl.textContent = '第 03 句续传完成，正在合成第 04 句…';
      }, 360);

      scheduleSim(() => {
        setPillState(3, 'done', '✓ 已完成');
        setPillState(4, 'running', '合成中…');
        if (statusEl) statusEl.textContent = '第 04 句已完成，正在合成第 05 句…';
      }, 720);

      scheduleSim(() => {
        setPillState(4, 'done', '✓ 已完成');
        if (!prefersReducedMotion()) {
          pills.forEach((pill, idx) => {
            scheduleSim(() => {
              pill.classList.add('is-complete-pop');
            }, idx * 45);
          });
        }
        if (statusEl) statusEl.textContent = '5 句全部合成完成 · 前 2 句直接复用本地缓存';
        state.simState = 'done';
        setButtonIdle('↻ 再演练一次');
      }, 1080);
    }

    resetSim();

    btnRun.addEventListener('click', () => {
      if (state.simState === 'running-1' || state.simState === 'running-2') return;
      if (state.simState === 'paused-error') {
        runPhaseTwo();
      } else {
        runPhaseOne();
      }
    });

    if (btnReset) {
      btnReset.addEventListener('click', resetSim);
    }
  }

  /* ------------------------------------------------------------------
   * 口语读法翻牌 (#spokenFlipCard)
   * ------------------------------------------------------------------ */
  function initSpokenFlipCard() {
    const card = document.getElementById('spokenFlipCard');
    if (!card) return;

    function toggleFlip() {
      const next = !card.classList.contains('is-flipped');
      card.classList.toggle('is-flipped', next);
      card.setAttribute('aria-pressed', next ? 'true' : 'false');
    }

    card.addEventListener('click', toggleFlip);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggleFlip();
      }
    });
  }

  /* ------------------------------------------------------------------
   * 实景截图切换与轻量放大弹窗
   * ------------------------------------------------------------------ */
  function updatePreviewScreenshot(viewKey) {
    const img = document.getElementById('previewScreenshotImg');
    const fallback = document.getElementById('previewFallback');
    if (!img) return;

    const asset = PREVIEW_ASSETS[viewKey] || PREVIEW_ASSETS.desktop;
    toggleVisibility(fallback, false);
    toggleVisibility(img, true);
    img.alt = asset.alt;
    img.dataset.caption = asset.caption;
    if (img.getAttribute('src') !== asset.src) {
      img.setAttribute('src', asset.src);
    }
  }

  function openLightboxModal(triggerEl) {
    const modal = document.getElementById('lightboxModal');
    const previewImg = document.getElementById('previewScreenshotImg');
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxCaption = document.getElementById('lightboxCaption');
    const closeBtn = document.getElementById('lightboxClose');
    if (!modal || !previewImg || !lightboxImg) return;

    if (previewImg.classList.contains('hidden') || (previewImg.complete && previewImg.naturalWidth === 0)) {
      showToast('截图文件暂未加载，请先检查资源路径');
      return;
    }

    state.lightboxRestoreFocusEl = triggerEl || document.activeElement;
    lightboxImg.src = previewImg.currentSrc || previewImg.getAttribute('src') || '';
    lightboxImg.alt = previewImg.alt || '拾声集（InkCast）界面实景放大预览';
    if (lightboxCaption) {
      lightboxCaption.textContent = previewImg.dataset.caption || previewImg.alt || '';
    }

    toggleVisibility(modal, true);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    if (closeBtn) {
      global.requestAnimationFrame(() => closeBtn.focus({ preventScroll: true }));
    }
  }

  function closeLightboxModal() {
    const modal = document.getElementById('lightboxModal');
    if (!modal || !modal.classList.contains('is-open')) return;

    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    toggleVisibility(modal, false);
    syncBodyModalLock();

    const target = state.lightboxRestoreFocusEl;
    state.lightboxRestoreFocusEl = null;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function initPreviewAndLightbox() {
    const img = document.getElementById('previewScreenshotImg');
    const fallback = document.getElementById('previewFallback');
    const frameBtn = document.getElementById('previewFrameBtn');
    const lightboxModal = document.getElementById('lightboxModal');
    const lightboxClose = document.getElementById('lightboxClose');

    if (img) {
      img.addEventListener('error', () => {
        toggleVisibility(img, false);
        toggleVisibility(fallback, true);
      });
      img.addEventListener('load', () => {
        toggleVisibility(fallback, false);
        toggleVisibility(img, true);
      });
      if (img.complete && img.naturalWidth === 0) {
        toggleVisibility(img, false);
        toggleVisibility(fallback, true);
      }
      if (!img.dataset.caption) {
        img.dataset.caption = PREVIEW_ASSETS.desktop.caption;
      }
    }

    if (frameBtn) {
      frameBtn.addEventListener('click', () => openLightboxModal(frameBtn));
    }

    if (lightboxClose) {
      lightboxClose.addEventListener('click', closeLightboxModal);
    }

    if (lightboxModal) {
      lightboxModal.addEventListener('click', (e) => {
        if (
          e.target === lightboxModal ||
          e.target.hasAttribute('data-lightbox-backdrop') ||
          e.target.closest('[data-lightbox-close]')
        ) {
          closeLightboxModal();
        }
      });
    }
  }

  /* ------------------------------------------------------------------
   * BYOK 芯片推荐墙 (.byok-chip)
   * ------------------------------------------------------------------ */
  function initByokChips() {
    const chips = Array.from(document.querySelectorAll('.byok-chip'));
    const tipTextEl = document.getElementById('byokTipText');
    if (chips.length === 0) return;

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const group = chip.getAttribute('data-chip-group') || '';
        chips.forEach((other) => {
          const sameGroup = !group || other.getAttribute('data-chip-group') === group;
          if (!sameGroup) return;
          const active = other === chip;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-pressed', active ? 'true' : 'false');
        });

        const tip = chip.getAttribute('data-chip-tip');
        if (tipTextEl && tip) {
          tipTextEl.textContent = tip;
        }
      });
    });

    if (tipTextEl && !tipTextEl.textContent.trim()) {
      const initialActive = chips.find((c) => c.classList.contains('is-active')) || chips[0];
      const tip = initialActive && initialActive.getAttribute('data-chip-tip');
      if (tip) tipTextEl.textContent = tip;
    }
  }

  /* ------------------------------------------------------------------
   * 安全放行手风琴 (#safetyAccordionBtn, #safetyAccordionPanel)
   * ------------------------------------------------------------------ */
  function initSafetyAccordion() {
    const btn = document.getElementById('safetyAccordionBtn');
    const panel = document.getElementById('safetyAccordionPanel');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      const next = !isExpanded;
      btn.setAttribute('aria-expanded', next ? 'true' : 'false');
      btn.classList.toggle('is-open', next);
      panel.classList.toggle('is-open', next);
    });
  }

  /* ------------------------------------------------------------------
   * 下载弹窗 (#downloadModal)
   * ------------------------------------------------------------------ */
  function syncBodyModalLock() {
    const downloadOpen = document.getElementById('downloadModal')?.classList.contains('is-open');
    const lightboxOpen = document.getElementById('lightboxModal')?.classList.contains('is-open');
    document.body.classList.toggle('modal-open', Boolean(downloadOpen || lightboxOpen));
  }

  function openDownloadModal(options) {
    const opts = options || {};
    const modal = document.getElementById('downloadModal');
    const closeBtn = document.getElementById('downloadModalClose');
    const modalOsSeg = document.querySelector('[data-segmented="modal-os"]');
    const shaBox = document.getElementById('modalShaBox');
    if (!modal) return;

    if (opts.os === 'mac' || opts.os === 'win') {
      setOs(opts.os, { immediate: true });
    } else {
      setOs(state.os, { immediate: true });
    }

    state.downloadRestoreFocusEl = opts.trigger || document.activeElement;
    toggleVisibility(modal, true);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    syncBodyModalLock();

    if (modalOsSeg) {
      positionSegmentedIndicator(modalOsSeg, true);
      global.requestAnimationFrame(() => positionSegmentedIndicator(modalOsSeg, true));
    }

    if (opts.highlightSha && shaBox) {
      if (state.shaHighlightTimer) {
        global.clearTimeout(state.shaHighlightTimer);
        state.shaHighlightTimer = null;
      }
      shaBox.classList.remove('is-highlight');
      void shaBox.offsetWidth;
      shaBox.classList.add('is-highlight');
      state.shaHighlightTimer = global.setTimeout(() => {
        shaBox.classList.remove('is-highlight');
        state.shaHighlightTimer = null;
      }, 1400);
    }

    if (closeBtn) {
      global.requestAnimationFrame(() => closeBtn.focus({ preventScroll: true }));
    }
  }

  function closeDownloadModal() {
    const modal = document.getElementById('downloadModal');
    if (!modal || !modal.classList.contains('is-open')) return;

    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    toggleVisibility(modal, false);
    syncBodyModalLock();

    const target = state.downloadRestoreFocusEl;
    state.downloadRestoreFocusEl = null;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function initDownloadModal() {
    const modal = document.getElementById('downloadModal');
    const backdrop = document.getElementById('downloadModalBackdrop');
    const closeBtn = document.getElementById('downloadModalClose');

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-open-download]');
      if (!trigger) return;
      if (trigger.tagName === 'A') e.preventDefault();

      const osAttr = trigger.getAttribute('data-os');
      const highlightSha = trigger.getAttribute('data-highlight-sha') === 'true';
      openDownloadModal({
        trigger,
        os: osAttr === 'mac' || osAttr === 'win' ? osAttr : undefined,
        highlightSha,
      });
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', closeDownloadModal);
    }

    if (backdrop) {
      backdrop.addEventListener('click', closeDownloadModal);
    }

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDownloadModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const lightbox = document.getElementById('lightboxModal');
      if (lightbox && lightbox.classList.contains('is-open')) {
        closeLightboxModal();
        return;
      }
      if (modal && modal.classList.contains('is-open')) {
        closeDownloadModal();
      }
    });
  }

  /* ------------------------------------------------------------------
   * 双兜底剪贴板复制 + 全局弹簧 Toast (#siteToast)
   * ------------------------------------------------------------------ */
  function showToast(message) {
    const toast = document.getElementById('siteToast');
    if (!toast || !message) return;

    if (state.toastTimer) {
      global.clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }

    toast.textContent = message;
    toggleVisibility(toast, true);
    toast.classList.remove('is-visible');
    void toast.offsetWidth;
    toast.classList.add('is-visible');

    state.toastTimer = global.setTimeout(() => {
      toast.classList.remove('is-visible');
      state.toastTimer = null;
    }, 2600);
  }

  function fallbackCopyWithTextarea(text) {
    const prevFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);

    let copied = false;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = Boolean(document.execCommand && document.execCommand('copy'));
    } catch {
      copied = false;
    } finally {
      textarea.remove();
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try {
          prevFocus.focus({ preventScroll: true });
        } catch {
          // 忽略焦点恢复异常
        }
      }
    }
    return copied;
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // 非 HTTPS 或微信内置浏览器受限时降级至 execCommand
      }
    }
    return fallbackCopyWithTextarea(value);
  }

  function initClipboardActions() {
    const copySiteBtn = document.getElementById('copySiteUrlBtn');
    if (copySiteBtn) {
      copySiteBtn.addEventListener('click', async () => {
        const ok = await copyText(global.location.href);
        showToast(ok ? '官网链接已复制，可在电脑打开或分享' : '复制失败，请手动复制浏览器地址栏链接');
      });
    }

    const copyShaBtn = document.getElementById('btnCopySha');
    if (copyShaBtn) {
      copyShaBtn.addEventListener('click', async () => {
        const shaCodeEl = document.getElementById('modalShaCode');
        const shaText =
          (shaCodeEl && shaCodeEl.textContent && shaCodeEl.textContent.trim()) ||
          getOsConfig(state.os).sha256;
        const ok = await copyText(shaText);
        showToast(ok ? '校验命令已复制到剪贴板' : '复制失败，请手动选中命令复制');
      });
    }

    document.querySelectorAll('[data-copy-text], [data-copy-xattr]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text =
          btn.getAttribute('data-copy-text') ||
          (btn.hasAttribute('data-copy-xattr') ? 'xattr -cr "/Applications/拾声集.app"' : '');
        if (!text) return;
        const ok = await copyText(text);
        const successMsg =
          btn.getAttribute('data-copy-toast') ||
          (btn.hasAttribute('data-copy-xattr')
            ? '已复制终端放行命令；确认安装包来自官方 Release 并核对同版本 SHA256SUMS.txt 无误后再粘贴回车'
            : '已复制到剪贴板');
        showToast(ok ? successMsg : '复制失败，请手动选中内容复制');
      });
    });
  }

  /* ------------------------------------------------------------------
   * Hero 「先听 45 秒样片」(#heroListenBtn)
   * ------------------------------------------------------------------ */
  function initHeroListenCta() {
    const btn = document.getElementById('heroListenBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (global.InkCastPlayer && typeof global.InkCastPlayer.unlockAudioInGesture === 'function') {
        global.InkCastPlayer.unlockAudioInGesture();
      }
      const stage = document.getElementById('stage');
      if (stage && typeof stage.scrollIntoView === 'function') {
        stage.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start',
        });
      }
      global.setTimeout(() => {
        if (global.InkCastPlayer && typeof global.InkCastPlayer.playFromStart === 'function') {
          global.InkCastPlayer.playFromStart();
        }
      }, 360);
    });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    initSegmentedControls();
    initOsSync();
    initResumeSimulator();
    initSpokenFlipCard();
    initPreviewAndLightbox();
    initByokChips();
    initSafetyAccordion();
    initDownloadModal();
    initClipboardActions();
    initHeroListenCta();
  }

  global.InkCastInteractions = {
    init,
    bindConfig,
    setOs,
    getOs: () => state.os,
    showToast,
    copyText,
    repositionSegmented: repositionAllSegmented,
    openDownloadModal,
    closeDownloadModal,
  };
})(window);
