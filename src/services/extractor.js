const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');

// 移动端微信内置浏览器 UA：微信公众号正文命中率最高
const WECHAT_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.38';
// 桌面浏览器 UA：作为通用网页与微信反爬时的重试策略
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_CONTENT_LENGTH = 200; // 低于此长度视为"没抓到正文"，触发重试/报错
const MAX_CONTENT_LENGTH = 12000; // 截取上限，防止超长爆 token

// 微信错误页特征 → 用户可理解的提示（命中即立刻报错，不再重试）
const WECHAT_ERROR_MARKERS = [
  ['该内容已被发布者删除', '文章已被发布者删除，无法获取正文'],
  ['此内容因违规无法查看', '文章因违规无法查看，无法获取正文'],
  ['此内容发送过后无法被查看', '文章已失效，无法获取正文'],
  ['环境异常', '微信返回了反爬验证页（环境异常），请稍后重试；也可以直接把文章正文粘贴到"直接贴文字"生成播客'],
  ['操作频繁', '微信提示操作频繁，请稍后重试；也可以直接把文章正文粘贴到"直接贴文字"生成播客'],
  ['参数错误', '微信文章链接参数不完整或已失效，请重新复制文章链接'],
  ['链接已过期', '微信文章链接已过期，请重新复制文章链接'],
];

/**
 * 校验并清洗用户输入的 URL
 * 典型误用：把文章正文粘贴进了链接输入框 → 给出明确指引而不是 Invalid URL
 */
function assertValidUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    throw inputError('请输入文章链接');
  }
  if (!/^https?:\/\//i.test(url)) {
    if (url.length > 200 || /\n/.test(url)) {
      throw inputError('这看起来是文章正文而不是链接，请切换到「直接贴文字」输入框粘贴正文');
    }
    throw inputError('链接格式不正确，请粘贴以 http:// 或 https:// 开头的完整文章链接');
  }
  return url;
}

/** 输入错误（HTTP 400）*/
function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** 上游错误（HTTP 502：抓取/解析/LLM/TTS）*/
function upstreamError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  return error;
}

function abortError() {
  return new DOMException('文章抓取已取消', 'AbortError');
}

/** B-F3：展开 IPv6 字面量为 8 个 16 位组（含尾部内嵌 IPv4 / IPv4-mapped 形态）；非法返回 null */
function expandIpv6(rawHost) {
  let h = rawHost.split('%')[0].toLowerCase(); // 去除 zone id
  if (!h.includes(':')) return null;

  // 尾部内嵌 IPv4（如 ::ffff:127.0.0.1）→ 两个十六进制组（WHATWG 序列化后一般已是十六进制）
  const dotted = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    h = h.replace(dotted[1], ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16));
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s) =>
    s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** IPv4-mapped（::ffff:x）与旧式 IPv4-compatible（::x）→ 点分 IPv4；其他返回 null */
function mappedIpv4(groups) {
  if (!groups) return null;
  const [a, b, c, d, e, f, g, h] = groups;
  if (a || b || c || d || e !== 0) return null;
  if (f !== 0xffff && f !== 0) return null;
  return `${(g >> 8) & 0xff}.${g & 0xff}.${(h >> 8) & 0xff}.${h & 0xff}`;
}

/** IPv4 点分字面量是否属于本机/内网/链路本地/组播等拒绝范围；规范外写法一律拒绝 */
function isBlockedIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    parts[0] >= 224 // 组播/保留段
  );
}

/**
 * B0-6/B-F3 SSRF 基线：默认拒绝抓取本机/内网/链路本地目标；
 * 合法本地来源可用 ALLOW_PRIVATE_FETCH=1 显式放开（见 security-notes.md）。
 * B-F3 已覆盖：IPv6 规范化（含 IPv4-mapped 点分/十六进制形态）、defaultFetcher 逐跳校验重定向。
 * 仍未覆盖：DNS 解析后的地址复检（rebinding 防护）——不宣称完整 SSRF 防护。
 */
function assertSafeFetchTarget(rawUrl) {
  if (process.env.ALLOW_PRIVATE_FETCH === '1') return;
  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    throw inputError('链接格式不正确，请粘贴以 http:// 或 https:// 开头的完整文章链接');
  }

  let blocked;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    blocked = isBlockedIpv4(hostname);
  } else if (hostname.includes(':')) {
    const groups = expandIpv6(hostname);
    if (!groups) {
      blocked = true; // 解析不了的 IPv6 字面量按危险处理
    } else {
      const mapped = mappedIpv4(groups);
      blocked = mapped
        ? isBlockedIpv4(mapped)
        : groups.every((g) => g === 0) ||
          (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) ||
          (groups[0] & 0xfe00) === 0xfc00 || // fc00::/7 ULA
          (groups[0] & 0xffc0) === 0xfe80;   // fe80::/10 链路本地
    }
  } else {
    blocked =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal');
  }

  if (blocked) {
    throw inputError(
      '不允许抓取本机/内网地址。如确需抓取本地来源，请以 ALLOW_PRIVATE_FETCH=1 启动服务'
    );
  }
}

/** 命中微信错误页时抛出带指引的错误 */
function assertNotWechatErrorPage(url, html) {
  if (!url.includes('mp.weixin.qq.com')) return;
  for (const [marker, message] of WECHAT_ERROR_MARKERS) {
    if (html.includes(marker)) {
      throw new Error(message);
    }
  }
}

/**
 * 提取保留段落结构的文本：
 * 块级元素（段落/标题/列表/表格行）后换行，段内空白折叠，连续空行压成一个空行。
 * 保留结构能帮 LLM 识别文章的章节脉络与重点层级，直接提升剧本质量。
 */
function extractStructuredText(rootEl) {
  rootEl.find('br').replaceWith('\n');
  rootEl
    .find('p, div, section, h1, h2, h3, h4, h5, h6, li, blockquote, tr')
    .append('\n');
  return rootEl
    .text()
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 默认抓取器：axios + 超时/响应大小上限（B0-6）+ 手动逐跳重定向（B-F3）。
 * 每一跳（含重定向 Location 解析出的目标）都重新过 assertSafeFetchTarget，
 * 不信任远端返回的 Location；最多跟随 5 次重定向。
 * request 参数仅供离线测试注入假传输，生产路径使用 axios。
 */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** 单跳抓取超时（毫秒）；请求实现自带 AbortSignal，避免 axios timeout 的定时器泄漏（见 B-F4） */
const FETCH_TIMEOUT_MS = 20000;
async function defaultFetcher(url, headers, { request, timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  const send = request || ((u, cfg) => axios.get(u, cfg));
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (signal?.aborted) throw abortError();
    assertSafeFetchTarget(current); // 逐跳校验（B-F3）
    // B-F4：不使用 axios 的 timeout 选项（连接阶段失败时其内部定时器不会清理，会挟持事件循环）；
    // 每跳自管定时器，finally 清理定时器和外部取消监听。
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const hopTimer = setTimeout(() => {
      controller.abort(upstreamError(`抓取失败：请求超时（单跳最多 ${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    let response;
    try {
      response = await send(current, {
        ...(process.env.ALLOW_INSECURE_TLS === '1' && {
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }),
        headers,
        signal: controller.signal,
        maxRedirects: 0, // 禁用 axios 自动重定向，由本循环逐跳校验
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      });
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(hopTimer);
      signal?.removeEventListener('abort', onAbort);
    }
    controller.signal.throwIfAborted();
    const status = response.status;
    if (status >= 300 && status < 400) {
      if (hop === MAX_REDIRECTS) {
        throw upstreamError('抓取失败：重定向次数过多');
      }
      const location = response.headers && response.headers.location;
      if (!location) {
        throw upstreamError('抓取失败：重定向响应缺少 Location');
      }
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw upstreamError('抓取失败：重定向次数过多');
}

/** 用指定 UA 抓取并解析页面，返回 { title, content }（content 可能为空字符串） */
async function fetchAndParse(url, userAgent, fetcher, { signal }) {
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  const response = await fetcher(url, headers, { signal });
  if (signal?.aborted) throw abortError();

  const html = typeof response.data === 'string' ? response.data : String(response.data);
  assertNotWechatErrorPage(url, html);

  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, nav, footer, header, .advertisement, .comment-section').remove();

  // 标题提取：微信专用选择器 → og:title → h1 → title 标签
  let title = '';
  if (url.includes('mp.weixin.qq.com')) {
    title =
      $('#activity-name').text().trim() ||
      $('h1.rich_media_title').text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('meta[name="description"]').attr('content')?.trim() ||
      '';
  }
  if (!title) {
    title =
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      '';
  }

  // 正文提取：微信专用容器 → 通用正文容器 → 段落聚合（均保留段落结构）
  let content = '';
  if (url.includes('mp.weixin.qq.com')) {
    const contentEl = $('#js_content');
    if (contentEl.length) {
      content = extractStructuredText(contentEl);
    }
  }

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    const candidates = [
      'article',
      '#js_content',
      '.article-content',
      '.post-content',
      '.entry-content',
      '#article-content',
      'main',
      '.content',
    ];
    for (const sel of candidates) {
      const el = $(sel);
      if (el.length && el.text().trim().length > MIN_CONTENT_LENGTH) {
        content = extractStructuredText(el);
        break;
      }
    }
  }

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    const paragraphs = [];
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) {
        paragraphs.push(text);
      }
    });
    content = paragraphs.join('\n\n').trim();
  }

  return {
    title: title.replace(/[\r\n\t]+/g, ' ').trim(),
    content,
  };
}

/**
 * 从 URL 抓取网页并提取核心正文与标题
 * 支持微信公众号、知乎专栏、微博文章、36氪、掘金及通用网页
 *
 * 错误契约：失败一律 throw Error（携带用户可理解的中文提示），
 * 不再返回 success:false 的静默对象
 */
async function extractArticleFromUrl(rawUrl, options = {}) {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const url = assertValidUrl(rawUrl);
  assertSafeFetchTarget(url);
  const fetcher = options.fetcher || defaultFetcher;

  // 每次尝试产出 { title, content } 配对候选
  const candidates = [];
  let lastError = null;

  // 策略一：微信移动端 UA；抓不到足够正文时再用桌面 UA 重试一次
  for (const userAgent of [WECHAT_MOBILE_UA, DESKTOP_UA]) {
    try {
      const { title, content } = await fetchAndParse(url, userAgent, fetcher, { signal });
      if (signal?.aborted) throw abortError();
      candidates.push({ title, content });
      if (content && content.length >= MIN_CONTENT_LENGTH) break;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error.name === 'AbortError') throw error;
      // 微信明确报错（被删除/反爬/链接失效）无需重试策略，直接抛出
      if (error.message && WECHAT_ERROR_MARKERS.some(([, msg]) => msg === error.message)) {
        error.statusCode = 502;
        throw error;
      }
      lastError = error;
    }
  }

  // B0-2 选优：取第一个满足正文有效性条件的候选，标题与正文来自同一次抓取（同源一致）
  const chosen = candidates.find((c) => c.content && c.content.length >= MIN_CONTENT_LENGTH);
  if (!chosen) {
    const hint = lastError ? `（${lastError.message}）` : '';
    throw upstreamError(
      `未能提取到文章正文，可能需要登录/验证或链接已失效${hint}。也可以直接把文章正文粘贴到「直接贴文字」生成播客`
    );
  }

  const truncated = chosen.content.length > MAX_CONTENT_LENGTH;
  const finalContent = chosen.content.slice(0, MAX_CONTENT_LENGTH);

  return {
    success: true,
    title: chosen.title || '未命名文章',
    content: finalContent,
    length: finalContent.length,
    truncated,
  };
}

/**
 * 统一入口：有 url 走抓取；只有 rawText 直接透传
 */
async function extractArticle({ url, rawText } = {}, options = {}) {
  if (!url && rawText && rawText.trim()) {
    if (options.signal?.aborted) throw abortError();
    // 与抓取一致的确定性截断语义，truncated 标记贯通到界面
    const fullText = rawText.trim();
    const truncated = fullText.length > MAX_CONTENT_LENGTH;
    const content = fullText.slice(0, MAX_CONTENT_LENGTH);
    return {
      success: true,
      title: '',
      content,
      length: content.length,
      truncated,
    };
  }
  return extractArticleFromUrl(url, options);
}

module.exports = {
  extractArticle,
  extractArticleFromUrl,
  assertValidUrl,
  assertSafeFetchTarget,
  defaultFetcher,
  MAX_CONTENT_LENGTH,
};
