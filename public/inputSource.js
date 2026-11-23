/**
 * B0-1：输入来源单一事实来源（纯逻辑模块，浏览器与 node:test 共用）。
 *
 * 解决的三个真实缺陷：
 * 1. 解析 A 成功后把输入改成 B，再点生成，误用 A 的过期正文；
 * 2. 慢解析请求在快请求之后返回，旧响应覆盖新结果；
 * 3. 生成期间可重复点击，产生多个合成任务互相覆盖。
 *
 * 输入模式（mode）决定生成时使用哪个输入，显式不混用：
 * - 'url'：链接输入框是唯一事实来源（含「解析文章」「生成剧本」「一键生成」）；
 * - 'text'：正文输入框是唯一事实来源。用户手动编辑正文会切到该模式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InputSource = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createState(overrides) {
    return Object.assign(
      {
        mode: 'url', // 'url' | 'text'
        busy: false,
        opSeq: 0,
        opTarget: '', // 当前进行中操作的目标 URL
        parsedUrl: '', // 当前已解析正文对应的 URL（配对一致性依据）
        parsedTitle: '',
        parsedContent: '',
        scriptTitle: '', // 已生成剧本的标题（供「重新配音」使用，不读 DOM）
        activeSentenceIndex: -1,
      },
      overrides || {}
    );
  }

  function setMode(state, mode) {
    if (mode !== 'url' && mode !== 'text') {
      throw new Error(`未知输入模式: ${mode}`);
    }
    state.mode = mode;
    return mode;
  }

  /**
   * 开始一次操作（解析/生成）。已有操作进行中时返回 null（防重复点击）。
   * @param {object} state
   * @param {string} [target] 本次操作的目标 URL（用于过期检测）
   * @returns {number|null} 操作序列号
   */
  function beginOperation(state, target) {
    if (state.busy) return null;
    state.busy = true;
    state.opSeq += 1;
    state.opTarget = typeof target === 'string' ? target.trim() : '';
    return state.opSeq;
  }

  /** 结束操作。seq 与当前不符时不动（防止误释放新操作的 busy 锁） */
  function finishOperation(state, seq) {
    if (seq == null || seq === state.opSeq) {
      state.busy = false;
      state.opTarget = '';
    }
  }

  /**
   * 应用解析结果。以下情况丢弃结果、不覆盖用户当前输入：
   * 1. seq 过期（期间开始过新操作——慢请求晚到）；
   * 2. 解析目标 URL 与当前输入框 URL 不一致（用户已改输入）；
   * 3. 已切到文本模式。
   * @returns {'applied'|'stale-seq'|'stale-url'|'wrong-mode'}
   */
  function applyParseResult(state, { seq, url, currentUrl, title, content }) {
    if (seq !== state.opSeq) return 'stale-seq';
    if (state.mode !== 'url') return 'wrong-mode';
    const fetchedUrl = typeof url === 'string' ? url.trim() : '';
    const inputUrl = typeof currentUrl === 'string' ? currentUrl.trim() : '';
    if (fetchedUrl !== inputUrl) return 'stale-url';

    state.parsedUrl = fetchedUrl;
    state.parsedTitle = typeof title === 'string' ? title : '';
    state.parsedContent = typeof content === 'string' ? content : '';
    return 'applied';
  }

  /**
   * 生成输入选择：按当前模式选择唯一事实来源，显式不混用。
   * - URL 模式：用「当前输入框」的 URL（不是 parsedUrl——过期解析结果不参与）；
   * - 文本模式：用当前正文与标题。
   * @returns {{kind:'url', url:string} | {kind:'text', title:string, content:string}}
   */
  function selectGenerationInput(state, { urlInput, textTitle, textContent } = {}) {
    if (state.mode === 'text') {
      return {
        kind: 'text',
        title: typeof textTitle === 'string' ? textTitle.trim() : '',
        content: typeof textContent === 'string' ? textContent.trim() : '',
      };
    }
    return {
      kind: 'url',
      url: typeof urlInput === 'string' ? urlInput.trim() : '',
    };
  }

  /** 加载新播客数据时重置逐句高亮，避免保留上一集的高亮状态 */
  function resetPlaybackHighlight(state) {
    state.activeSentenceIndex = -1;
  }

  return {
    createState,
    setMode,
    beginOperation,
    finishOperation,
    applyParseResult,
    selectGenerationInput,
    resetPlaybackHighlight,
  };
});
