(function (global) {
  'use strict';

  function initTopbarScroll() {
    const topbar = document.querySelector('.topbar, .site-header, header');
    if (!topbar) return;

    let ticking = false;
    function syncScrollState() {
      ticking = false;
      topbar.classList.toggle('is-scrolled', global.scrollY > 10);
    }

    syncScrollState();
    global.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        global.requestAnimationFrame(syncScrollState);
      },
      { passive: true }
    );
  }

  function initScrollReveal() {
    const targets = Array.from(document.querySelectorAll('.reveal'));
    if (targets.length === 0) return;

    const reduceMotion = Boolean(
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
    );

    if (reduceMotion || typeof global.IntersectionObserver !== 'function') {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new global.IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        });
      },
      {
        threshold: 0.08,
        rootMargin: '0px 0px -24px 0px',
      }
    );

    targets.forEach((el) => observer.observe(el));
  }

  function bootstrap() {
    // 1. 绑定 site-config.js 中的文案、链接与环境提示
    if (global.MiaotingConfig && typeof global.MiaotingConfig.init === 'function') {
      global.MiaotingConfig.init();
    }
    if (global.MiaotingInteractions && typeof global.MiaotingInteractions.bindConfig === 'function') {
      global.MiaotingInteractions.bindConfig();
    }

    // 2. 初始化全站微交互、OS 三处联动、模拟器与弹窗
    if (global.MiaotingInteractions && typeof global.MiaotingInteractions.init === 'function') {
      global.MiaotingInteractions.init();
    }

    // 3. 初始化暖纸放音台引擎
    if (global.MiaotingPlayer && typeof global.MiaotingPlayer.init === 'function') {
      global.MiaotingPlayer.init();
    }

    // 4. 顶栏吸顶投影与滚动入场
    initTopbarScroll();
    initScrollReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})(window);
