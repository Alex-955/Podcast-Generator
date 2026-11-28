/* 预览专用：静态打开时桩掉 /api，并把右栏空状态替换为插画欢迎面板 */
(function () {
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url) || '';
    if (u.indexOf('/api/') !== -1 && location.port !== '3000' && !window.__PREVIEW_REAL_API__) {
      var body = { success: true, data: { items: [], totalPodcastCount: 0, unassignedCount: 0 } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };

  var variant = document.documentElement.getAttribute('data-variant') || 'a';

  var LINE_ART = '' +
    '<svg class="wl-art wl-art-line" viewBox="0 0 360 240" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<g class="wl-doc" stroke="#1A1916" stroke-width="2">' +
        '<path class="wl-draw" d="M44 96h38l18 18v70a8 8 0 0 1-8 8H44a8 8 0 0 1-8-8v-80a8 8 0 0 1 8-8z"/>' +
        '<path class="wl-draw" d="M82 96v18h18"/>' +
        '<path class="wl-draw" d="M48 134h36M48 150h44M48 166h28" opacity=".5"/>' +
      '</g>' +
      '<path d="M108 152C130 152 134 128 158 122" stroke="#B03E24" stroke-width="2" stroke-dasharray="2 7"/>' +
      '<path d="M150 114l10 7-11 6" stroke="#B03E24" stroke-width="2"/>' +
      '<g class="wl-float wl-float-1">' +
        '<path class="wl-draw" d="M172 28h84a22 22 0 0 1 22 22v32a22 22 0 0 1-22 22h-52l-24 18v-18h-8a22 22 0 0 1-22-22V50a22 22 0 0 1 22-22z" fill="#FDFCF9" stroke="#1C5A73" stroke-width="2.2"/>' +
        '<g stroke="#1C5A73" stroke-width="3">' +
          '<path d="M178 66v0M190 58v16M202 52v28M214 60v12M226 54v24M238 62v8M250 66v0"/>' +
        '</g>' +
      '</g>' +
      '<g class="wl-float wl-float-2">' +
        '<path class="wl-draw" d="M212 112h96a22 22 0 0 1 22 22v34a22 22 0 0 1-22 22h-8v18l-24-18h-64a22 22 0 0 1-22-22v-34a22 22 0 0 1 22-22z" fill="#FDFCF9" stroke="#B03E24" stroke-width="2.2"/>' +
        '<g stroke="#B03E24" stroke-width="2.4">' +
          '<path d="M214 136h78" opacity=".9"/><path d="M214 152h54" opacity=".6"/><path d="M214 168h68" opacity=".4"/>' +
        '</g>' +
      '</g>' +
      '<g stroke-width="2"><path d="M304 44v14M297 51h14" stroke="#B03E24"/><path d="M118 52v10M113 57h10" stroke="#1C5A73"/></g>' +
    '</svg>';

  var bars = [14, 26, 18, 40, 52, 30, 20, 44, 56, 34, 22, 46, 38, 26, 50, 32, 18];
  var barsSvg = bars.map(function (h, i) {
    var x = 82 + i * 12;
    var c = i < 8 ? '#1C5A73' : '#B03E24';
    return '<rect class="wl-bar" style="--d:' + (i * 90 % 700) + 'ms;--s:' + (0.35 + (h / 56) * 0.65).toFixed(2) + '" x="' + x + '" y="' + (212 - h / 2) + '" width="6" height="' + h + '" rx="3" fill="' + c + '"/>';
  }).join('');

  var GEOMETRIC = '' +
    '<svg class="wl-art wl-art-geo" viewBox="0 0 360 240" aria-hidden="true">' +
      '<circle cx="180" cy="112" r="104" fill="#ECE7DC"/>' +
      '<circle cx="292" cy="40" r="9" fill="#B03E24" opacity=".85"/>' +
      '<circle cx="62" cy="168" r="6" fill="#1C5A73" opacity=".85"/>' +
      '<rect x="98" y="36" width="164" height="132" rx="16" fill="#FDFCF9" stroke="rgba(26,25,22,.1)" transform="rotate(-7 180 102)"/>' +
      '<g fill="#E3DDD0" transform="rotate(-7 180 102)"><rect x="118" y="56" width="82" height="7" rx="3.5"/><rect x="118" y="72" width="120" height="7" rx="3.5"/><rect x="118" y="88" width="96" height="7" rx="3.5"/></g>' +
      '<g class="wl-float wl-float-1"><circle cx="138" cy="122" r="46" fill="#1C5A73"/><text x="138" y="137" text-anchor="middle" font-size="40" font-weight="700" fill="#fff" font-family="Songti SC, Noto Serif SC, Noto Serif CJK SC, serif">泽</text></g>' +
      '<g class="wl-float wl-float-2"><circle cx="224" cy="122" r="46" fill="#B03E24" stroke="#FDFCF9" stroke-width="4"/><text x="224" y="137" text-anchor="middle" font-size="40" font-weight="700" fill="#fff" font-family="Songti SC, Noto Serif SC, Noto Serif CJK SC, serif">晓</text></g>' +
      barsSvg +
    '</svg>';

  var samples = [
    ['ai', 'AI 智能体工作流', '技术长文'],
    ['deepseek', 'DeepSeek 技术剖析', '深度拆解'],
    ['work', '数字游民的自律', '生活方式']
  ];

  function welcomeHtml() {
    return (variant === 'b' ? GEOMETRIC : LINE_ART) +
      '<h2 class="wl-title">粘贴一篇文章，生成你的第一期</h2>' +
      '<p class="wl-sub">几分钟，在本机变成<b class="wl-host">阿泽</b> × <b class="wl-guest">小晓</b>的双人对话播客</p>' +
      '<ol class="wl-steps"><li><i>1</i>粘贴链接或正文</li><li><i>2</i>选择对话风格</li><li><i>3</i>生成并收听</li></ol>' +
      '<div class="wl-samples-head">或者先试试内置示例</div>' +
      '<div class="wl-samples">' + samples.map(function (s) {
        return '<button type="button" class="wl-sample" data-sample="' + s[0] + '"><span class="wl-sample-tag">' + s[2] + '</span><span class="wl-sample-name">' + s[1] + '</span><span class="wl-sample-go" aria-hidden="true">→</span></button>';
      }).join('') + '</div>';
  }

  function enhance(empty) {
    if (empty.classList.contains('is-welcome')) return;
    var text = empty.textContent || '';
    if (text.indexOf('该集暂无') !== -1) return;
    empty.classList.add('is-welcome');
    empty.innerHTML = welcomeHtml();
    empty.querySelectorAll('.wl-draw').forEach(function (p) { p.setAttribute('pathLength', '1'); });
    empty.querySelectorAll('.wl-sample').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pill = document.querySelector('.sample-pill[data-sample="' + btn.getAttribute('data-sample') + '"]');
        if (pill) pill.click();
      });
    });
  }

  function boot() {
    var list = document.getElementById('subtitlesList');
    if (!list) return;
    var run = function () { var e = list.querySelector('.subtitles-empty'); if (e) enhance(e); };
    new MutationObserver(run).observe(list, { childList: true });
    run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
