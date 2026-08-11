'use strict';

const { Plugin, MarkdownView, Menu, Notice, requestUrl, editorLivePreviewField, Platform, PluginSettingTab, Setting } = require('obsidian');
const { t } = require('./i18n.js');
const { cleanUrl, isMetaShortUrl, resolveShortUrl, primeShortUrl, canonicalFromHtml } = require('./cleanlink.js');

/* CodeMirror 6（Live Preview 用）。防禦性載入：失敗時編輯模式不渲染卡片，
   但 Reading Mode 與 Canvas 完全不受影響 */
let cm = null;
try {
  cm = {
    view: require('@codemirror/view'),
    state: require('@codemirror/state'),
  };
} catch (e) {
  console.warn('[LCP] CodeMirror modules unavailable, Live Preview cards disabled');
}

/* ============ 常數 ============ */

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
/* 第三段退路：部分站台只對「連結展開類 bot」提供 og 標籤，對其他 UA 一律回 403。
   實測 Etsy：Desktop 403、Googlebot 429、facebookexternalhit 403、Slackbot 200 且 og 齊全。
   （補齊 sec-ch-ua / Sec-Fetch-* 等完整瀏覽器 headers 結果相同，可見差異來自站方對
     連結預覽用途的白名單，而非 header 內容。）
   選 Slackbot 是因為它的用途就是「展開連結預覽」，與本外掛做的事情一致。 */
const PREVIEW_BOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
/* 語言偏好跟著使用者的環境走，不寫死開發者的地區設定
   （寫死會讓非中文使用者拿到中文的 og 內容，也是一種輕微指紋） */
const ACCEPT_LANG = ((typeof navigator !== 'undefined' && navigator.language) || 'en') + ',en;q=0.8';
const META_TTL = 7 * 24 * 60 * 60 * 1000;
/* 抓取失敗的指數退避（2026-08-05）。
   原本一律 15 分鐘：含死連結的筆記/Canvas 每次開啟都會重打網路（每個死連結最多兩輪
   UA 請求、最長 12 秒，還佔著並發名額），順帶把 390KB 的快取整檔重寫一次。
   改成連續失敗越多次、下次重試隔越久；一旦成功就歸零。 */
const FAIL_TTL = 15 * 60 * 1000;
function failTtl(n) {
  if (!n || n <= 1) return FAIL_TTL;            // 第 1 次失敗 → 15 分鐘
  if (n === 2) return 60 * 60 * 1000;           // 第 2 次 → 1 小時
  return 24 * 60 * 60 * 1000;                   // 第 3 次以後 → 1 天
}
// 這筆快取還能用多久（poor = 抓取失敗，走退避；正常結果走 META_TTL）
/* 標題其實是空的嗎？
   很多站台的 <title> 是「內容標題 - 站名」，抓取失敗（被擋、影片還在處理、
   臨時錯誤頁）時內容標題會是空的，只剩下分隔符與站名 —— YouTube 就會回
   「- YouTube」。這種標題看起來有值，實際上零資訊。
   不擋掉的話會被判定成「抓取成功」而快取七天，那張卡就整整七天不會再試。 */
function isEmptyTitle(title, hostname) {
  const t = String(title || '').trim();
  if (!t) return true;
  // 去掉頭尾的分隔符（- – — | · : ~ 與空白）後，若什麼都不剩就是空殼
  const stripped = t.replace(/^[\s\-–—|·:~]+/, '').replace(/[\s\-–—|·:~]+$/, '').trim();
  if (!stripped) return true;
  /* 「只剩站名」要再加一個條件：原本必須**帶著分隔符**。
     「- YouTube」是模板 <內容> - <站名> 在內容為空時留下的殘骸 → 是失敗；
     而「Gradientor」這種沒有分隔符的，很可能就是那個網站首頁的正式標題 →
     不能判成失敗，否則會害它反覆重抓。 */
  if (stripped === t) return false;
  const site = String(hostname || '').replace(/^www\./, '').split('.')[0];
  return !!site && stripped.toLowerCase() === site.toLowerCase();
}

function entryTtl(entry) {
  if (!entry || !entry.meta) return 0;
  const m = entry.meta;
  /* 舊快取裡混進的空殼結果（在 isEmptyTitle 上線前被存成「成功」的那些）
     → 回傳 0 讓它立刻過期重抓，使用者不必等七天或手動清快取。
     ⚠️ 這裡**不能**加上「沒有描述」的條件：站台的錯誤／通用頁往往帶著站台的
        預設描述（YouTube 回的是「在 YouTube 上盡情享受自己喜愛的影片…」），
        要求沒描述就永遠擋不到這種。標題是空殼又沒有圖，就已經沒有價值了。 */
  if (!m.image && !hasLocalImage(m) && isEmptyTitle(m.title, m.hostname)) return 0;
  return m.poor ? failTtl(entry.fail) : META_TTL;
}
const MAX_CACHE_ENTRIES = 500; // 快取項目上限，超過時淘汰最舊的
const MAX_IMAGE_BYTES = 300 * 1024;
const DOWNSCALE_WIDTH = 640;

/* ============ 圖片倉庫（v1.5：圖片不再塞 data.json） ============
   舊版把 base64 圖直接存進 data.json → 27MB，而且每次 save() 都要重寫整份，
   在 iCloud vault 上等於每看一個新連結就同步 27MB。
   現在改成：圖片寫成外掛資料夾裡的獨立檔案，data.json 只留檔名（meta.img）。 */

const IMG_SUBDIR = 'linkcard-images';

/** data URI → { bytes, ext }；解析失敗回 null */
function dataUriToBytes(dataUri) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri || '');
  if (!m) return null;
  const mime = m[1] || 'image/jpeg';
  const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  try {
    const bin = atob(m[3]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return { bytes: buf.buffer, ext };
  } catch (e) { return null; }
}

/** 網址 → 穩定檔名（同一個連結永遠對到同一個檔，換圖會直接覆蓋） */
function urlHash(url) {
  let h = 0;
  const s = String(url);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36) + '_' + s.length.toString(36);
}

/** mime → 副檔名（沿用舊的正規化規則，檔名才不會因為版本而變） */
function extOfMime(mime) {
  return ((mime || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
}

/** 把位元組寫成檔案，回傳檔名（失敗回空字串） */
async function writeImageBytes(pageUrl, bytes, ext) {
  const a = state.adapter;
  if (!a || !state.imgDir || !bytes) return '';
  const fname = urlHash(pageUrl) + '.' + (ext || 'jpg');
  try {
    if (!(await a.exists(state.imgDir))) await a.mkdir(state.imgDir);
    await a.writeBinary(state.imgDir + '/' + fname, bytes);
    return fname;
  } catch (e) { return ''; }
}

/** 把 data URI 寫成檔案（只剩「舊版 base64 快取遷移」在用） */
async function writeImageFile(pageUrl, dataUri) {
  const parsed = dataUriToBytes(dataUri);
  if (!parsed) return '';
  return writeImageBytes(pageUrl, parsed.bytes, parsed.ext);
}

/** 檔名 → 可直接餵給 <img>/CSS 的 app:// 網址 */
function imgResource(fname) {
  if (!fname || !state.adapter || !state.imgDir) return '';
  try { return state.adapter.getResourcePath(state.imgDir + '/' + fname); } catch (e) { return ''; }
}

/** 刪掉某筆快取對應的圖片檔（淘汰／清快取時用） */
async function removeImageFile(fname) {
  const a = state.adapter;
  if (!a || !fname || !state.imgDir) return;
  try { if (await a.exists(state.imgDir + '/' + fname)) await a.remove(state.imgDir + '/' + fname); } catch (e) {}
}

/** 這筆快取有沒有本地圖（新版檔案 or 舊版 base64 都算） */
function hasLocalImage(meta) {
  return !!(meta && (meta.img || meta.imageData));
}

/** 取得本地圖的可用來源（新版走檔案；舊版 base64 仍可直接用，之後會被遷移掉） */
function localImageSrc(meta) {
  if (!meta) return '';
  if (meta.img) return imgResource(meta.img);
  return meta.imageData || '';
}

const DEFAULT_SETTINGS = {
  threadsPasteInsert: true, // 貼上 Threads 連結時自動插入貼文文字
  youtubeCanvasEmbed: false, // Canvas 中 YouTube 連結：false=卡片預覽，true=保留原生嵌入
};

/* Apple 風格設定 */
const SHOW_DESCRIPTION = false;   // Apple 卡片不顯示描述；想要回來改 true 即可
const LARGE_MIN_WIDTH = 320;      // 圖片寬度達此值且非直向 → 大卡版型

const EXTLINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

const THREADS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>';

const GLOBE_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm-.354 14.933A7 7 0 0 1 1.02 8.73h2.49c.08 1.7.46 3.2 1.02 4.34a6.97 6.97 0 0 1-2.884 1.863zM1.02 7.27A7 7 0 0 1 7.646 1.07v2.07c-1.52.18-2.82 2.1-3.14 4.13H1.02zm6.626 7.663V12.5c1.18-.13 2.22-1.54 2.62-3.5H7.646zm0-3.933V7.27h2.62c-.4-1.96-1.44-3.37-2.62-3.5V5.5zm1.354-6.933A7 7 0 0 1 14.98 7.27h-2.49c-.08-1.7-.46-3.2-1.02-4.34a6.97 6.97 0 0 1 2.884-1.863zM8.354 1.07A7 7 0 0 1 14.98 8.73h-2.49c-.32-2.03-1.62-3.95-4.136-4.13V1.07zm-2.626 12.93v2.433a6.97 6.97 0 0 1-2.884-1.863c.56-1.14.94-2.64 1.02-4.34h2.49c-.4 1.96-1.44 3.37-2.62 3.5z"/></svg>';


/* SVG 常數 → DOM（不用 innerHTML：上架審查會標記） */
function setSvgEl(el, svg) {
  el.textContent = '';
  try {
    // ⚠️ text/html 模式：見 gallery.js setSvg 註解（XML 模式無命名空間 → 圖示不渲染）
    const node = new DOMParser().parseFromString(svg, 'text/html').body.firstElementChild;
    if (node && node.tagName && node.tagName.toLowerCase() === 'svg') {
      el.appendChild(document.importNode(node, true));
    }
  } catch (e) {}
}

/* ============ 共享狀態 ============ */

const state = {
  cache: {},
  save: () => {},
};

/* ============ 工具函式 ============ */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function isThreadsUrl(url) {
  const h = hostOf(url);
  return h === 'threads.net' || h === 'threads.com';
}

function isInstagramUrl(url) {
  const h = hostOf(url);
  return h === 'instagram.com' || h === 'instagr.am';
}

function isYouTubeUrl(url) {
  const h = hostOf(url);
  return h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com'
    || h === 'music.youtube.com';
}

// Meta 系平台共用同一套 oEmbed + 降級抓取邏輯
function isMetaUrl(url) {
  return isThreadsUrl(url) || isInstagramUrl(url);
}

/** 去除手機 App 分享連結附帶的追蹤參數（?igsh=、?xmt= 等）。
 *  Meta 的 oEmbed 對帶陌生參數的網址經常直接拒絕，
 *  這是「手機貼上失效、電腦貼上正常」的主因 */
function canonicalMetaUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function needsImageProxy(imageUrl) {
  return /cdninstagram|fbcdn|twimg|pbs\.twimg/i.test(imageUrl);
}

/** 快取 key 的唯一真理：只有 Meta 系網址才正規化（其餘保留 query，例如 YouTube 的 ?v=） */
function cacheKeyOf(url) {
  return isMetaUrl(url) ? canonicalMetaUrl(url) : url;
}

function faviconUrl(hostname) {
  return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(hostname) + '&sz=64';
}

function isSoloParagraph(p) {
  const children = Array.from(p.childNodes);
  if (children.length !== 1) return false;
  const child = children[0];
  if (child.nodeType !== 1 || child.tagName !== 'A') return false;
  const href = child.getAttribute('href') ?? '';
  const text = child.textContent?.trim() ?? '';
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch {}
  return (text === href || text === decoded) &&
    (href.startsWith('http://') || href.startsWith('https://'));
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  try {
    const doc = new DOMParser().parseFromString(str, 'text/html');
    return doc.documentElement.textContent || str;
  } catch (e) {
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }
}

function extractTextFromHtml(htmlStr) {
  if (!htmlStr) return '';
  const stripped = htmlStr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return decodeHtmlEntities(stripped);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ============ Metadata 解析 ============ */

/** 依編碼正確解碼 requestUrl 的回應。
 *  res.text 一律當 UTF-8，會讓 Shift_JIS / EUC-JP（日文老站）、Big5（中文老站）變亂碼。
 *  改讀 arrayBuffer，從 HTTP charset 或 HTML 內 <meta charset> 偵測真正編碼再解。 */
function decodeHtml(res) {
  const buf = res.arrayBuffer;
  if (!buf) return res.text || '';

  // 1. 先從 HTTP header 的 content-type 找 charset
  let charset = '';
  const ct = (res.headers?.['content-type'] || res.headers?.['Content-Type'] || '').toLowerCase();
  let m = ct.match(/charset=([^;]+)/);
  if (m) charset = m[1].trim();

  // 2. header 沒有就用 UTF-8 先粗解前 2KB，從 <meta> 找 charset 宣告
  if (!charset) {
    try {
      const head = new TextDecoder('utf-8').decode(buf.slice(0, 2048)).toLowerCase();
      m = head.match(/<meta[^>]+charset=["']?([\w-]+)/)
        || head.match(/charset\s*=\s*["']?([\w-]+)/);
      if (m) charset = m[1].trim();
    } catch (e) {}
  }

  // 3. 正規化常見別名
  charset = (charset || 'utf-8').replace(/^x-/, '');
  if (charset === 'shift-jis' || charset === 'shift_jis' || charset === 'sjis') charset = 'shift_jis';
  if (charset === 'euc-jp') charset = 'euc-jp';
  if (charset === 'big5' || charset === 'big5-hkscs') charset = 'big5';
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gbk';

  // 4. 用偵測到的編碼解碼；不支援就退回 UTF-8
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (e) {
    try { return new TextDecoder('utf-8').decode(buf); }
    catch (e2) { return res.text || ''; }
  }
}

/* 只取到 </head> 為止（找不到就退回前 256KB）。
   og/twitter/description 這些 meta 幾乎都在 <head>，但整份 HTML 動輒好幾 MB，
   在主執行緒 DOMParser 全文解析是貼上大頁面時 UI 卡住的主因。 */
const HTML_HEAD_CAP = 256 * 1024;
function headSlice(html) {
  const i = html.search(/<\/head>/i);
  if (i > 0) return html.slice(0, i + 7);
  return html.length > HTML_HEAD_CAP ? html.slice(0, HTML_HEAD_CAP) : html;
}

/* 先只解析 <head>；head 就湊齊標題與圖片時直接收工（絕大多數站台屬於此類）。
   缺東西才退回整份——「掃內容 <img>」那條退路本來就需要 body。 */
function parseMetadata(html, url) {
  /* 這頁已經抓回來了，順手把 canonical 記給「淨化連結」用：
     之後在卡片上右鍵展開短連結就是零額外網路請求。 */
  if (isMetaShortUrl(url)) {
    try { primeShortUrl(url, canonicalFromHtml(html)); } catch (e) {}
  }

  const head = headSlice(html);
  const meta = parseMetadataFrom(head, url);
  if (meta.title !== meta.hostname && meta.image) return meta;   // head 就夠了
  if (head.length === html.length) return meta;                  // 本來就是整份，沒有退路可走
  const full = parseMetadataFrom(html, url);
  return {
    title: meta.title !== meta.hostname ? meta.title : full.title,
    description: meta.description || full.description,
    image: meta.image || full.image,
    hostname: meta.hostname,
  };
}

function parseMetadataFrom(html, url) {
  const hostname = hostOf(url);
  let doc = null;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch {}

  const pick = (...selectors) => {
    if (!doc) return '';
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const v = el?.getAttribute('content');
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  let title = pick('meta[property="og:title"]', 'meta[name="twitter:title"]');
  if (!title && doc) {
    title = doc.querySelector('title')?.textContent?.trim() || '';
  }

  const description = pick(
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]'
  );

  let image = pick(
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]'
  );

  // 退路 1：<link rel="image_src">（舊式但仍有網站在用）
  if (!image && doc) {
    image = doc.querySelector('link[rel="image_src"]')?.getAttribute('href') || '';
  }

  // 退路 2：掃描內容圖片。許多網站用 lazy loading，<img src> 是佔位圖，
  // 真實網址藏在 data-src / data-lazy-src / srcset 等屬性裡
  if (!image && doc) {
    const imgs = Array.from(doc.querySelectorAll('img')).slice(0, 30);
    for (const im of imgs) {
      const candidates = [
        im.getAttribute('data-src'),
        im.getAttribute('data-lazy-src'),
        im.getAttribute('data-original'),
        (im.getAttribute('data-srcset') || im.getAttribute('srcset') || '').trim().split(/[\s,]+/)[0],
        im.getAttribute('src'),
      ];
      const cand = candidates.find((c) => c && !c.startsWith('data:'));
      if (!cand) continue;
      // 跳過佔位圖與追蹤像素
      if (/blank|spacer|placeholder|loading|pixel|1x1|\.svg(\?|$)/i.test(cand)) continue;
      image = cand;
      break;
    }
  }

  // 退路 3：apple-touch-icon（高解析網站 icon，Apple 沒圖時的行為）
  if (!image && doc) {
    image = doc.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href') || '';
  }

  if (image) {
    try { image = new URL(image, url).href; } catch { image = ''; }
  }

  return { title: title || hostname, description, image, hostname };
}

/* ============ 抓取：一般網站（UA 重試） ============ */

async function fetchGenericMeta(url) {
  const hostname = hostOf(url);
  let best = null;

  for (const ua of [DESKTOP_UA, BOT_UA, PREVIEW_BOT_UA]) {
    try {
      const res = await requestUrl({
        url,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': ACCEPT_LANG,
        },
        throw: false,
      });
      if (!res || res.status >= 400) continue;
      const htmlText = decodeHtml(res);
      if (!htmlText) continue;

      const meta = parseMetadata(htmlText, url);
      if (!best) {
        best = meta;
      } else {
        best = {
          title: best.title !== hostname ? best.title : meta.title,
          description: best.description || meta.description,
          image: best.image || meta.image,
          hostname,
        };
      }
      /* 只有「這一輪連標題都抓不到」才往下一段 UA。
         以前是「標題和圖片都要有」才收工 → 大量只有標題沒有 og:image 的站
         每次都被打兩輪請求（各自最長 12 秒，還各佔一個並發名額）。
         擋下請求的站台其挑戰頁 <title> 剛好就是 hostname，所以會自然掉到第三段。 */
      if (best.title !== hostname) break;
    } catch (e) {
      console.warn('[LCP] fetch failed:', e.message);
    }
  }

  return best || { title: hostname, description: '', image: '', hostname };
}

/* ============ 抓取：Threads 特化 ============ */

async function fetchMetaPlatform(url) {
  const ig = isInstagramUrl(url);
  // showDesc：貼文內文本身就是內容本體，不受全域 SHOW_DESCRIPTION 限制
  const base = {
    title: ig ? 'Instagram' : 'Threads',
    description: '', image: '', hostname: hostOf(url), showDesc: true,
  };

  try {
    // Threads 與 Instagram 的 oEmbed 都由 Meta 後端提供
    const oembedUrl = ig
      ? 'https://www.instagram.com/api/v1/oembed/?url=' + encodeURIComponent(url)
      : 'https://www.threads.net/oembed/?url=' + encodeURIComponent(url);
    const res = await requestUrl({ url: oembedUrl, headers: { 'Accept': 'application/json' }, throw: false });
    if (res && res.status === 200) {
      const data = JSON.parse(res.text);
      if (data.author_name) base.title = '@' + data.author_name;
      if (data.html) base.description = extractTextFromHtml(data.html);
      if (data.title) base.description = base.description || data.title;
      if (data.thumbnail_url) base.image = data.thumbnail_url;
    }
  } catch (e) {
    console.warn('[LCP] oEmbed failed:', e.message);
  }

  if (base.image) return base;

  for (const ua of [BOT_UA, DESKTOP_UA]) {
    try {
      const res = await requestUrl({
        url,
        headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml' },
        throw: false,
      });
      if (!res || res.status >= 400) continue;
      const html = decodeHtml(res);
      if (!html) continue;

      const meta = parseMetadata(html, url);
      if (meta.image) base.image = meta.image;
      if (!base.description && meta.description) base.description = meta.description;
      if ((!base.title || base.title === 'Threads' || base.title === 'Instagram') && meta.title !== base.hostname) base.title = meta.title;

      if (base.image) return base;

      const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try {
          const json = JSON.parse(ldMatch[1]);
          const img = json.image || json.thumbnailUrl;
          if (img) {
            base.image = typeof img === 'string' ? img : (img.url || '');
            if (base.image) return base;
          }
        } catch (e) {}
      }

      const cdnMatch = html.match(/https:\/\/[^"'\s\\]+(?:cdninstagram|fbcdn)[^"'\s\\]+\.jpg[^"'\s\\]*/);
      if (cdnMatch) {
        base.image = decodeHtmlEntities(cdnMatch[0]).replace(/\\u0026/g, '&');
        return base;
      }
    } catch (e) {
      console.warn('[LCP] Threads HTML fetch failed:', e.message);
    }
  }

  return base;
}

/* ============ 抓取入口（持久化快取） ============ */

/** 快取超過上限時，依時間戳淘汰最舊的項目（粗略 LRU）。
 *  base64 圖佔記憶體大宗，這道閘門避免長期使用後膨脹 */
/* 一次性遷移：把舊版塞在 data.json 裡的 base64 圖，全部寫成獨立檔案。
   跑完 data.json 會從 ~27MB 掉到幾百 KB。中途失敗也沒關係，下次啟動會繼續。 */
async function migrateBase64Cache() {
  const entries = Object.entries(state.cache).filter(([, v]) => v?.meta?.imageData);
  if (!entries.length) return 0;
  let done = 0;
  for (const [url, v] of entries) {
    const fname = await writeImageFile(url, v.meta.imageData);
    if (fname) v.meta.img = fname;
    delete v.meta.imageData;     // 寫檔失敗也刪掉：下次瀏覽到會重抓，總比讓 27MB 卡在那裡好
    done++;
    if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));   // 讓出 event loop
  }
  return done;
}

function pruneCache() {
  const keys = Object.keys(state.cache);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  keys
    .sort((a, b) => (state.cache[a].ts || 0) - (state.cache[b].ts || 0))
    .slice(0, keys.length - MAX_CACHE_ENTRIES)
    .forEach((k) => {
      const fname = state.cache[k]?.meta?.img;
      delete state.cache[k];
      if (fname) removeImageFile(fname);   // 連圖片檔一起刪，不然會變孤兒檔案
    });
}

/** 同步查詢快取是否命中且仍有效（不發任何請求）。
 *  命中回傳 meta，未命中或過期回傳 null。
 *  用於渲染時判斷可否跳過骨架、直接畫卡片。 */
function getCachedMeta(url) {
  const key = cacheKeyOf(url);
  const entry = state.cache[key];
  if (!entry || !entry.meta) return null;
  const ttl = entryTtl(entry);
  if (Date.now() - (entry.ts || 0) < ttl || hasLocalImage(entry.meta)) {
    return entry.meta;
  }
  return null;
}

/* ============ 抓取節流：去重 + 並發上限 + 逾時 ============

   ⚠️ 三個問題原本都沒處理：

   1. **同一 URL 會被重複抓取**：快取是在請求**完成後**才寫入，請求進行中沒有任何
      記錄。一份筆記貼三次同一連結 → 三個並行請求；Canvas 裡同一連結 5 個節點 → 5 個。

   2. **沒有並發上限**：attachToCanvas 的 processAll() 對所有節點同步跑一輪，
      開一張 60 個連結節點的 Canvas 就是 60 個 fetchMeta 同時發射；
      而 fetchGenericMeta 對抓不到 og:image 的站會跑兩輪 UA
      → 最多 120 個並行 HTTP 請求，每個回來還要在主執行緒 DOMParser 整份 HTML。

   3. **沒有逾時**：requestUrl 不吃 AbortController，慢站會讓 promise 一直掛著，
      連帶佔住並發名額。這裡用 Promise.race 讓「等待」有上限
      （底層請求無法真的中止，但我們不再等它）。 */

const inflight = new Map();      // url → 進行中的 meta promise
const imgInflight = new Map();   // url → 進行中的圖片下載 promise（同畫面同 URL 不重抓）
const MAX_CONCURRENT = 4;
const NET_TIMEOUT = 12000;
let running = 0;
const waiters = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function releaseSlot() {
  const next = waiters.shift();
  if (next) next();   // 名額直接轉交給下一位，running 不變
  else running--;
}

function withTimeout(p, ms) {
  let tm;
  const timer = new Promise((_, rej) => {
    tm = setTimeout(() => rej(new Error('network timeout')), ms || NET_TIMEOUT);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(tm));
}

async function fetchMeta(url) {
  // Meta 系網址先正規化，讓「手機帶 igsh」與「電腦乾淨網址」共用同一筆快取
  url = cacheKeyOf(url);
  const entry = state.cache[url];
  if (entry && entry.meta) {
    if (Date.now() - (entry.ts || 0) < entryTtl(entry) || hasLocalImage(entry.meta)) {
      return entry.meta;
    }
  }

  // 已經有人在抓同一個 URL → 共用那一次的結果，不重複發請求
  const dup = inflight.get(url);
  if (dup) return dup;

  const job = fetchMetaUncached(url, entry).finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

async function fetchMetaUncached(url, entry) {
  let meta;
  await acquireSlot();
  try {
    meta = isMetaUrl(url)
      ? await withTimeout(fetchMetaPlatform(url))
      : await withTimeout(fetchGenericMeta(url));
  } catch (e) {
    const hostname = hostOf(url);
    meta = { title: hostname, description: '', image: '', hostname };
  } finally {
    releaseSlot();
  }

  if (hasLocalImage(entry?.meta) && !hasLocalImage(meta)) {
    if (entry.meta.img) meta.img = entry.meta.img;
    else meta.imageData = entry.meta.imageData;
    meta.layout = entry.meta.layout;
  }

  // 品質判定：沒抓到圖也沒抓到實質標題／描述 → 視為失敗，走短 TTL
  const hostname = meta.hostname;
  /* 沒有圖是前提；在那之上，標題已經沒有資訊量就算失敗。
     ⚠️ 空殼標題這條**不要求**「沒有描述」：站台的錯誤／通用頁常常帶著站台預設
        描述（YouTube 回「在 YouTube 上盡情享受自己喜愛的影片…」），加了就擋不到。
        Threads／Instagram 那兩條維持原樣 —— 貼文卡片本來就可能只有內文沒有標題，
        那是合法結果，不能因為標題等於站名就當成失敗。 */
  const noImage = !meta.image && !hasLocalImage(meta);
  meta.poor = noImage && (
    meta.title === hostname
    || isEmptyTitle(meta.title, hostname)
    || (!meta.description && (meta.title === 'Threads' || meta.title === 'Instagram'))
  );

  /* 失敗次數：連續失敗才累加，成功一次就歸零（退避見 failTtl）。 */
  const prevFail = (entry && entry.fail) || 0;
  const fail = meta.poor ? prevFail + 1 : 0;
  const wasPoor = !!(entry && entry.meta && entry.meta.poor);
  state.cache[url] = { meta, ts: Date.now(), fail };
  pruneCache();
  /* 「本來就失敗、這次還是失敗」→ 內容沒有實質變化，不值得為了更新一個 ts
     就把 390KB 的快取整檔重寫。但退避級距往上跳的那一次要寫，
     否則重開 Obsidian 後退避會退回 15 分鐘。 */
  const tierChanged = failTtl(fail) !== failTtl(prevFail);
  if (!(meta.poor && wasPoor) || tierChanged) state.save();
  return meta;
}

/* ============ 圖片處理 ============ */

/* 縮圖：位元組進、位元組出，全程不經 base64。
   舊版是 bytes → base64 → dataURL → <img> → canvas → toDataURL → atob → bytes 四段轉換，
   每一段都在主執行緒配置一份完整副本（base64 還會膨脹 33%），手機開一堆連結卡就爆記憶體。
   不需要縮（本來就夠小）時回傳 null，呼叫端直接用原始位元組。 */
async function downscaleBytes(bytes, mime, maxWidth, quality) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    try {
      const scale = Math.min(1, maxWidth / bmp.width);
      if (scale >= 1) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
      if (!out) return null;
      return { bytes: await out.arrayBuffer(), mime: 'image/jpeg', ext: 'jpg' };
    } finally {
      bmp.close();   // ⚠️ 一定要 close，不然解出來的點陣圖會留在記憶體等 GC
    }
  } catch (e) { return null; }
}

/** 下載圖片 → { bytes, mime, ext }；失敗回 null */
async function fetchImageBytes(imageUrl, pageUrl) {
  try {
    let referer = '';
    try { referer = new URL(pageUrl).origin + '/'; } catch {}

    // 套既有的 12s race：requestUrl 不吃 AbortController，慢站會讓 promise 一直掛著
    const res = await withTimeout(requestUrl({
      url: imageUrl,
      headers: {
        'User-Agent': DESKTOP_UA,
        ...(referer ? { 'Referer': referer } : {}),
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      throw: false,
    }));
    if (!res || res.status !== 200 || !res.arrayBuffer) return null;

    const mime = (res.headers?.['content-type'] || res.headers?.['Content-Type'] || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return null;

    if (res.arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      const small = await downscaleBytes(res.arrayBuffer, mime, DOWNSCALE_WIDTH, 0.8);
      if (small) return small;
    }
    return { bytes: res.arrayBuffer, mime, ext: extOfMime(mime) };
  } catch (e) {
    console.warn('[LCP] image fetch failed:', e.message);
    return null;
  }
}

/** 把下載到的圖存成檔案，並把檔名寫進快取（不再把 base64 塞進 data.json）
 *  注意：key 要用「正規化後的網址」——fetchMeta 是用 canonicalMetaUrl 當 key 的，
 *  傳原始網址進來會查不到 entry（舊版就有這個潛在 bug）。 */
async function persistImageBytes(pageUrl, bytes, ext) {
  // 快取 key 的規則必須跟 fetchMeta 完全一致：只有 Meta 系網址才正規化。
  // （對一般網址亂套 canonicalMetaUrl 會砍掉 ?v= 之類的 query → 查不到 entry）
  const key = cacheKeyOf(pageUrl);
  const entry = state.cache[key] || state.cache[pageUrl];
  const fname = await writeImageBytes(key, bytes, ext);
  if (!fname) return '';
  if (entry?.meta) {
    entry.meta.img = fname;
    delete entry.meta.imageData;   // 舊版殘留的 base64 一併清掉
    state.save();
  }
  return fname;
}

/** data URI 版（只剩舊版 base64 快取遷移在用） */
async function persistImage(pageUrl, dataUri) {
  const parsed = dataUriToBytes(dataUri);
  if (!parsed) return '';
  return persistImageBytes(pageUrl, parsed.bytes, parsed.ext);
}

/** 載入圖片並回傳實際尺寸；失敗回 null（兼作直連可用性探測） */
function loadImageDims(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Apple 式主色提取：縮到 24×24 取樣，量化分箱統計，
 *  忽略近白／近黑，並用飽和度加權讓主題色贏過大片灰底。
 *  回傳 [r, g, b] 或 null（圖片載入失敗、CORS 污染等）。 */
function extractDominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const S = 24;
        const canvas = document.createElement('canvas');
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, S, S);
        const data = ctx.getImageData(0, 0, S, S).data; // 跨域未授權時這行會丟錯

        const bins = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 125) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const light = (max + min) / 2;
          if (light > 242 || light < 14) continue; // 近白近黑不具代表性
          const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
          const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0 };
          bin.r += r; bin.g += g; bin.b += b; bin.n++;
          bin.sat += (max - min);
          bins.set(key, bin);
        }
        if (!bins.size) { resolve(null); return; }

        let best = null, bestScore = -1;
        bins.forEach((bin) => {
          const score = bin.n * (1 + (bin.sat / bin.n) / 128);
          if (score > bestScore) { bestScore = score; best = bin; }
        });
        resolve([
          Math.round(best.r / best.n),
          Math.round(best.g / best.n),
          Math.round(best.b / best.n),
        ]);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 依相對亮度判斷主色是深是淺，決定文字用白或黑 */
function isDarkTint(tint) {
  const [r, g, b] = tint;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 150;
}

/** 取得可顯示的圖片來源：本地快取 → 防盜連 CDN 直接下載 → 直連探測 → 失敗下載補救
 *  尺寸量測結果存進快取（meta.dims），Canvas 重掛載卡片時不必重新解碼圖片 */
async function resolveImage(pageUrl, meta) {
  /* 圖片下載的失敗負快取（2026-08-12）。
     meta.image 指向過期的 IG/FB CDN 簽章網址時（快取裡的 IG 貼文正是此類），
     下載會 403；以前完全不記錄，於是 7 天 meta TTL 內每次開檔都把整批重發一輪。
     欄位名 imgFail 刻意避開既有的 img / imageData / dims / tint / poor
     （meta 會整份序列化進 linkcard-cache.json）。 */
  if (meta.imgFail && Date.now() - meta.imgFail < failTtl(1) && !hasLocalImage(meta)) {
    return { src: '', dims: null };
  }
  // 已有本地圖（新版＝檔案；舊版＝base64，順手遷移成檔案）
  if (hasLocalImage(meta)) {
    if (meta.imageData && !meta.img) {
      const fname = await persistImage(pageUrl, meta.imageData);
      if (fname) { meta.img = fname; delete meta.imageData; }
    }
    const src = localImageSrc(meta);
    if (!meta.dims) {
      meta.dims = await loadImageDims(src);
      state.save();
    }
    return { src, dims: meta.dims };
  }
  if (!meta.image) return { src: '', dims: null };

  /* 下載回來 → 存成檔案 → 用檔案的 app:// 網址顯示。
     ⚠️ 兩個保護沿用既有機制、不另起爐灶：
       • acquireSlot/releaseSlot：跟 meta 抓取共用同一組 4 併發名額。
         以前 meta 被限流、但 meta 陸續回來之後的圖片下載可以同時發射數十個。
       • imgInflight：同一張圖同時被多張卡片要時共用一次下載（比照 meta 的 inflight）。 */
  const download = () => {
    const key = cacheKeyOf(pageUrl);
    const dup = imgInflight.get(key);
    if (dup) return dup;
    const job = (async () => {
      await acquireSlot();
      let got;
      try {
        got = await fetchImageBytes(meta.image, pageUrl);
      } finally {
        releaseSlot();
      }
      if (!got) {
        // 記下失敗時間，短期內不再重發（成功時會 delete）
        meta.imgFail = Date.now();
        state.save();
        return null;
      }
      delete meta.imgFail;
      const fname = await persistImageBytes(pageUrl, got.bytes, got.ext);
      if (fname) meta.img = fname;
      /* 寫檔失敗（罕見）→ 這一次仍用 data URI 顯示，不寫進快取。
         只有這條退路才會走到 base64，正常路徑全程都是位元組。 */
      const src = fname
        ? imgResource(fname)
        : 'data:' + got.mime + ';base64,' + arrayBufferToBase64(got.bytes);
      meta.dims = await loadImageDims(src);
      state.save();
      return { src, dims: meta.dims };
    })().finally(() => imgInflight.delete(key));
    imgInflight.set(key, job);
    return job;
  };

  if (needsImageProxy(meta.image) || isMetaUrl(pageUrl)) {
    return (await download()) || { src: '', dims: null };
  }

  if (meta.dims) return { src: meta.image, dims: meta.dims };

  const dims = await loadImageDims(meta.image);
  if (dims) {
    meta.dims = dims;
    state.save();
    return { src: meta.image, dims };
  }

  return (await download()) || { src: '', dims: null };
}

/** 開啟按鈕：Live Preview 與行動端 Canvas 共用。
 *  桌面 hover 浮現；行動端常駐顯示並加大觸控目標（CSS 以 .is-mobile 切換） */
function buildOpenButton(url) {
  const btn = document.createElement('div');
  btn.className = 'lcp-open-btn';
  btn.setAttribute('aria-label', 'Open link');
  setSvgEl(btn, EXTLINK_SVG);
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, '_blank');
  };
  btn.addEventListener('mousedown', open);
  btn.addEventListener('touchend', open);
  return btn;
}

/* ============ 卡片渲染（Apple 三版型） ============ */

function createSkeleton(url) {
  const wrap = document.createElement('div');
  wrap.className = 'lcp-card lcp-card--compact lcp-skeleton';

  const body = document.createElement('div');
  body.className = 'lcp-body';

  const l1 = document.createElement('div');
  l1.className = 'lcp-skeleton-line lcp-skeleton-line--title';

  const host = document.createElement('div');
  host.className = 'lcp-domain';
  host.textContent = hostOf(url);

  body.append(l1, host);

  const thumb = document.createElement('div');
  thumb.className = 'lcp-thumb lcp-thumb--skeleton';

  wrap.append(body, thumb);
  return wrap;
}

/** 網域列：favicon ＋ 裸網域（favicon 載不到時退回地球 icon） */
function buildDomainRow(hostname) {
  const row = document.createElement('div');
  row.className = 'lcp-domain';

  const fav = document.createElement('img');
  fav.className = 'lcp-favicon';
  fav.src = faviconUrl(hostname);
  fav.onerror = () => {
    const span = document.createElement('span');
    span.className = 'lcp-favicon lcp-favicon--fallback';
    setSvgEl(span, GLOBE_SVG);
    fav.replaceWith(span);
  };
  row.appendChild(fav);

  row.appendChild(document.createTextNode(hostname));
  return row;
}

function buildTitle(meta) {
  const el = document.createElement('div');
  el.className = 'lcp-title';
  el.textContent = meta.title || meta.hostname;
  return el;
}

function buildDesc(meta) {
  if ((!SHOW_DESCRIPTION && !meta.showDesc) || !meta.description) return null;
  const el = document.createElement('div');
  el.className = 'lcp-desc';
  el.textContent = meta.description;
  return el;
}

/* ============ 卡片右鍵：淨化連結 ============ */

/** 在卡片上掛「淨化連結」右鍵選單。
 *  這條網址沒有追蹤參數就不掛 —— 右鍵維持 Obsidian 原本的行為，不多事。 */
function attachCleanMenu(wrap, url, opts) {
  const plugin = state.plugin;
  if (!plugin || plugin.state.enableCleanLink === false) return;

  const cleaned = cleanUrl(url, { state: plugin.state });
  const isShort = isMetaShortUrl(url) && plugin.state.cleanLinkExpandShort !== false;
  if (cleaned === url && !isShort) return;   // 沒事可做就別掛，右鍵維持原本行為

  wrap.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    const menu = new Menu();

    if (isShort) {
      // 短連結：追蹤碼在路徑裡，要換成正式網址才算真的乾淨。
      // 卡片渲染時已經抓過這頁，canonical 通常已在快取中 → 即時完成。
      menu.addItem((i) => i.setTitle(t('Restore original URL')).setIcon('unfold-horizontal')
        .onClick(async () => {
          const full = await resolveShortUrl(url, { state: plugin.state });
          if (full === url) { new Notice(t('Could not resolve this share link')); return; }
          applyCleanToSource(url, full, opts);
        }));
    }

    if (cleaned !== url) {
      menu.addItem((i) => i.setTitle(t('Clean this link')).setIcon('eraser')
        .onClick(() => applyCleanToSource(url, cleaned, opts)));
    }

    menu.addItem((i) => i.setTitle(t('Copy cleaned link')).setIcon('copy')
      .onClick(async () => {
        try {
          const best = isShort ? await resolveShortUrl(url, { state: plugin.state }) : cleaned;
          await navigator.clipboard.writeText(best);
          new Notice(t('Copied cleaned link'));
        } catch (e) { new Notice(t('Clean failed: {{msg}}', { msg: e.message })); }
      }));

    menu.showAtMouseEvent(evt);
  });
}

/** 把淨化後的網址寫回來源。
 *  Live Preview 走 CodeMirror（卡片即時重繪、只算一步 undo）；
 *  閱讀模式沒有 editor，只能改寫檔案本身。 */
async function applyCleanToSource(url, cleaned, opts) {
  const plugin = state.plugin;
  if (!plugin) return;

  // ① Live Preview：直接改 CM 文件
  if (opts.lpView && opts.lpContainer) {
    try {
      const view = opts.lpView;
      const pos = view.posAtDOM(opts.lpContainer);
      const line = view.state.doc.lineAt(pos);
      const next = line.text.split(url).join(cleaned);
      if (next !== line.text) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
        new Notice(t('Cleaned {{n}} link(s)', { n: 1 }));
        return;
      }
    } catch (e) { /* 落到檔案改寫 */ }
  }

  // ② 閱讀模式 / 其他：改寫來源檔案
  const app = plugin.app;
  const path = opts.sourcePath || app.workspace.getActiveFile()?.path;
  const file = path ? app.vault.getAbstractFileByPath(path) : null;
  if (!file) { new Notice(t('Could not locate the source note')); return; }

  try {
    const rewrite = (data) => data.split(url).join(cleaned);
    if (app.vault.process) await app.vault.process(file, rewrite);
    else await app.vault.modify(file, rewrite(await app.vault.read(file)));
    new Notice(t('Cleaned {{n}} link(s)', { n: 1 }));
  } catch (e) {
    new Notice(t('Clean failed: {{msg}}', { msg: e.message }));
  }
}

async function renderCard(wrap, url, meta, opts = {}) {
  /* 快速路徑（同步、不閃骨架）只在「能安全直接顯示」時啟用：
     A. 已有本地 base64 圖 + 尺寸 → 直接用，最安全
     B. 確定無圖的純文字卡 → 無需載圖
     C. 直連圖但「不需防盜連代理」+ 已有尺寸 → 網址可直接顯示
     其餘情況（需代理但還沒下載成 base64、缺尺寸等）一律走 resolveImage，
     避免把被 CDN 擋的網址當 src 而破圖／空卡。 */
  let src, dims, tint;
  const hasLocalImg = hasLocalImage(meta) && !!meta.dims;
  const noImg = !meta.image && !hasLocalImage(meta);
  const safeDirectImg = !!meta.image && !!meta.dims &&
    !needsImageProxy(meta.image) && !isMetaUrl(url);

  if (hasLocalImg) {
    src = localImageSrc(meta); dims = meta.dims; tint = meta.tint || null;
  } else if (noImg) {
    src = ''; dims = null; tint = null;
  } else if (safeDirectImg) {
    src = meta.image; dims = meta.dims; tint = meta.tint || null;
  } else {
    // 慢但可靠：處理防盜連代理、補尺寸、補主色
    ({ src, dims } = await resolveImage(url, meta));
    tint = null;
    if (src) {
      tint = meta.tint;
      if (tint === undefined) {
        tint = await extractDominantColor(src);
        meta.tint = tint || null;
        state.save();
      }
    }
  }

  /* icon 類圖片：尺寸偏小（apple-touch-icon、favicon、小縮圖） */
  const iconLike = !!(dims && Math.max(dims.w, dims.h) <= 256);
  /* 直向圖：大卡 hero 改裁 1:1 方形，避免 1.91:1 砍掉太多、也避免卡片過長 */
  const portrait = !!(dims && dims.h > dims.w * 1.1);

  /* 版型決策（Apple 邏輯）：
     大圖（寬 >= 320）→ 大卡（直向圖裁方形）
     小圖 → 緊湊卡（縮圖在右）
     無圖 → 純文字卡
     Canvas ＋ icon 類圖 → icon 卡（主色鋪滿、icon 置中） */
  /* Threads 貼文：og:image 只有作者頭像（2026-07-17 兩種 UA 實測皆同），沒有「貼文截圖」
     可抓 → 學 iMessage：用 title + description（貼文全文，含換行）自己排出文字卡。 */
  const isThreadPost = /(^|\.)threads\.(net|com)$/.test(meta.hostname || '') && !!(meta.description || '').trim();
  let layout;
  if (isThreadPost) {
    layout = 'thread';        // Canvas 內也用 Threads 版型（否則 hero 會是大頭貼）
  } else if (opts.canvas) {
    layout = src ? (iconLike ? 'canvas-icon' : 'canvas') : 'canvas-text';
  } else if (!src) {
    layout = 'text';
  } else if (dims && dims.w >= LARGE_MIN_WIDTH && !iconLike) {
    layout = 'large';
  } else {
    layout = 'compact';
  }

  wrap.textContent = '';
  wrap.setAttribute('role', 'link');
  wrap.setAttribute('tabindex', '0');

  const body = document.createElement('div');
  body.className = 'lcp-body';

  if (layout === 'thread') {
    /* Threads 貼文卡（仿官方 embed / iMessage 預覽）：
       作者列（頭像＋帳號＋右上 Threads 標誌）→ 貼文全文 → 底部灰帶（標題＋網域） */
    wrap.className = 'lcp-card lcp-card--thread';
    /* og:image 三種可能（2026-07-17 以 51 筆快取實測歸納）：
       路徑含 -19/ ＝ 作者頭像 → 放作者列
       路徑含 -15/ ＝ 貼文照片 → 放內文下方完整顯示
       static.cdninstagram rsrc.php ＝ Threads logo 佔位圖 → 不顯示 */
    const rawImg = meta.image || '';
    const imgKind = /rsrc\.php|static\.cdninstagram/.test(rawImg) ? 'none'
      : /\/t\d+[\d.-]*-19\//.test(rawImg) ? 'avatar'
      : (src ? 'photo' : 'none');
    const head = document.createElement('div');
    head.className = 'lcp-thread-head';
    if (src && imgKind === 'avatar') {
      const av = document.createElement('img');
      av.className = 'lcp-thread-avatar';
      av.src = src;
      av.onerror = () => av.remove();
      head.appendChild(av);
    }
    const nm = document.createElement('div');
    nm.className = 'lcp-thread-name';
    // 「Threads 上的 Nanako Tsai（@nyanako0129）」→ 抽出帳號 nyanako0129；抽不到退回整串
    const hm = /[（(]\s*@([\w.]+)\s*[）)]/.exec(meta.title || '');
    nm.textContent = hm ? hm[1] : (meta.title || meta.hostname);
    head.appendChild(nm);
    const lg = document.createElement('span');
    lg.className = 'lcp-thread-logo';
    setSvgEl(lg, THREADS_SVG);
    head.appendChild(lg);
    const txt = document.createElement('div');
    txt.className = 'lcp-thread-text';
    txt.textContent = meta.description;  // 貼文全文；CSS pre-wrap 保留換行 + line-clamp 限行數
    body.appendChild(buildTitle(meta));
    body.appendChild(buildDomainRow(meta.hostname));
    if (src && imgKind === 'photo') {
      // lcp-has-photo 取代原本的 :has(.lcp-thread-photo)（2026-07-31）：
      // 這個條件 JS 這裡就已經知道了，不必再叫瀏覽器回頭查一次子樹。
      wrap.classList.add('lcp-has-photo');
      const ph = document.createElement('div');
      ph.className = 'lcp-thread-photo';
      ph.style.backgroundImage = 'url("' + src + '")';
      if (dims && dims.w && dims.h) ph.style.aspectRatio = dims.w + ' / ' + dims.h;
      wrap.append(head, txt, ph, body);
    } else {
      wrap.append(head, txt, body);
    }

  } else if (layout === 'large') {
    wrap.className = 'lcp-card lcp-card--large';
    const hero = document.createElement('div');
    hero.className = 'lcp-hero' + (portrait ? ' lcp-hero--portrait' : '');
    hero.style.backgroundImage = 'url("' + src + '")';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(hero, body);

  } else if (layout === 'compact') {
    wrap.className = 'lcp-card lcp-card--compact';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    const thumb = document.createElement('div');
    thumb.className = 'lcp-thumb' + (iconLike ? ' lcp-thumb--icon' : '');
    thumb.style.backgroundImage = 'url("' + src + '")';
    wrap.append(body, thumb);

  } else if (layout === 'canvas-icon') {
    wrap.className = 'lcp-card lcp-card--canvas lcp-card--canvas-icon';
    const stage = document.createElement('div');
    stage.className = 'lcp-icon-stage';
    const iconImg = document.createElement('img');
    iconImg.className = 'lcp-icon-img';
    iconImg.src = src;
    stage.appendChild(iconImg);
    body.appendChild(buildTitle(meta));
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(stage, body);
    if (tint) {
      wrap.classList.add('lcp-card--solid');
      wrap.classList.add(isDarkTint(tint) ? 'lcp-on-dark' : 'lcp-on-light');
    }

  } else if (layout === 'text') {
    wrap.className = 'lcp-card lcp-card--text';
    body.appendChild(buildTitle(meta));
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(body);

  } else if (layout === 'canvas') {
    wrap.className = 'lcp-card lcp-card--canvas';
    const hero = document.createElement('div');
    hero.className = 'lcp-hero';
    hero.style.backgroundImage = 'url("' + src + '")';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta);
    if (d) body.appendChild(d);
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(hero, body);

  } else { // canvas-text
    wrap.className = 'lcp-card lcp-card--canvas lcp-card--canvas-text';
    body.appendChild(buildTitle(meta));
    const d = buildDesc(meta) || (meta.description ? (() => {
      const el = document.createElement('div');
      el.className = 'lcp-desc';
      el.textContent = meta.description;
      return el;
    })() : null);
    if (d) body.appendChild(d); // 無圖的 canvas 卡片空間大，描述放回來填充
    body.appendChild(buildDomainRow(meta.hostname));
    wrap.append(body);
  }

  /* 染色套用：icon 卡（solid）鋪滿主色，其餘卡片 12% 淡染 */
  if (tint) {
    wrap.style.setProperty('--lcp-tint', tint.join(', '));
    if (!wrap.classList.contains('lcp-card--solid')) {
      wrap.classList.add('lcp-card--tinted');
    }
  }

  // 右鍵：淨化連結（Canvas 例外——節點網址存在 .canvas 的 JSON 裡，改寫方式不同）
  if (!opts.canvas) attachCleanMenu(wrap, url, opts);

  const handler = () => window.open(url, '_blank');
  if (opts.canvas) {
    wrap.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
    // 行動端：觸控雙點不可靠，補一顆常駐開啟按鈕
    if (Platform.isMobile) {
      wrap.appendChild(buildOpenButton(url));
    }
  } else if (!opts.editor) {
    // Live Preview（editor）的互動由 widget 容器統一管理：單擊選取、⌘+單擊開啟
    wrap.addEventListener('click', handler);
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
  }
}

/* ============ Live Preview（編輯模式）擴充 ============ */

/* 拖曳選取期間的穩定機制：
   選取進行中只移除被蓋到的卡片、不把離開選取的行變回卡片，
   避免卡片高度差造成版面跳動、選取亂飄；放開後才重新結算。

   ⚠️ iOS 點擊被吃掉（2026-08-11，從獨立版 Link Card Preview v1.8.0 移植）：
   舊版是「按下就算拖曳、放開一律重新結算」，所以每次點擊、甚至每次捲動都會
   觸發一輪全量重算。桌機沒事是因為 CM6 在 mousedown 就把游標定好了，重算發生在
   mouseup、順序在後面；但 iOS 的合成 mousedown / click 是 touchend **之後**才送出的，
   等於把一次 view update 插進「手指放開 → 點擊送達」的空窗 → 那一下被吃掉，
   使用者得點兩三次才有反應（WikiLink、Base 卡片同理，它們也靠合成 click 觸發）。
   改成三道閘門，任何一道不成立就不 dispatch：
     1. 位移超過門檻才算拖曳 —— 單純點一下根本不進入拖曳狀態
     2. 真的因為拖曳而移除過卡片才需要補回 —— 純捲動不會動到選取，也就不必重算
     3. dispatch 一律延到下一個 task —— 永不落在 touchend → click 的空窗中間 */
const DRAG_THRESHOLD = 4;   // px；手指按住本來就會微晃，低於此距離視為單純點擊
let lcpPointerDown = false;
let lcpDragging = false;
let lcpStripped = false;    // 本次手勢真的移除過卡片 → 放開後才需要重新結算
let lcpStartX = 0;
let lcpStartY = 0;
let RefreshAnno = null;

function buildLivePreviewExtension() {
  if (!cm) return null;
  const { EditorView, Decoration, WidgetType } = cm.view;
  const { StateField } = cm.state;

  const URL_LINE = /^(https?:\/\/\S+)$/;

  class CardWidget extends WidgetType {
    constructor(url) {
      super();
      this.url = url;
    }
    eq(other) {
      return other.url === this.url;
    }
    toDOM(view) {
      const container = document.createElement('div');
      container.className = 'lcp-lp-container';

      const inner = document.createElement('div');
      inner.className = 'lcp-lp-inner';
      container.appendChild(inner);

      const skeleton = createSkeleton(this.url);
      inner.appendChild(skeleton);
      fetchMeta(this.url).then((meta) =>
        // lpView / lpContainer：右鍵「淨化連結」用來定位這張卡在文件中的哪一行
        renderCard(skeleton, this.url, meta, { editor: true, lpView: view, lpContainer: container })
      );

      // 編輯按鈕（鉛筆）：還原並反白裸網址供編輯
      // 桌面 hover 浮現；行動端常駐（觸控沒有 hover 也沒有 ⌘）
      const selectLine = () => {
        try {
          const pos = view.posAtDOM(container);
          const line = view.state.doc.lineAt(pos);
          view.dispatch({ selection: { anchor: line.from, head: line.to } });
          view.focus();
        } catch (err) {}
      };
      const editBtn = document.createElement('div');
      editBtn.className = 'lcp-open-btn';
      editBtn.setAttribute('aria-label', 'Edit URL');
      setSvgEl(editBtn, PENCIL_SVG);
      const onEdit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectLine();
      };
      editBtn.addEventListener('mousedown', onEdit);
      editBtn.addEventListener('touchend', onEdit);
      inner.appendChild(editBtn);

      // 單擊＝開啟連結（卡片的主動作）
      // ⌘/Ctrl＋單擊＝選取編輯（次要動作的鍵盤捷徑）
      // ⚠️ 掛在 inner 不是 container：container 是區塊 widget、佔滿整行寬，
      //    但卡片只有 420px → 掛 container 會讓卡片右側的空白也能點（2026-08-11 修）。
      //    inner 的 max-width 就是卡片寬度，點擊範圍因此等於看得見的卡片。
      inner.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.lcp-open-btn')) return;
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          selectLine();
          return;
        }
        window.open(this.url, '_blank');
      });

      return container;
    }
    ignoreEvent() {
      return true; // 事件交給容器自己的 handler
    }
  }

  /* ⚠️ 效能關鍵（2026-08-05）：以前 docChanged **和** 選取變動都會整份重算，
     3000 行的筆記按住方向鍵移動游標＝每次按鍵都對整份文件逐行跑一次 regex。

     拆成兩層：
       • scanLines()：逐行找出「整行就是一個網址」的候選行 —— 只有文件真的變動才跑
       • decosFrom()：從候選行算出這一刻要顯示哪些卡片 —— 只跟游標/選取有關，
                      成本是 O(候選行數)（通常個位數），與文件長度無關 */
  function scanLines(state) {
    // 純 Source Mode 不渲染，維持原始文字
    if (editorLivePreviewField) {
      const lp = state.field(editorLivePreviewField, false);
      if (lp === false) return [];
    }
    const out = [];
    const doc = state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = line.text.trim().match(URL_LINE);
      if (m) out.push({ from: line.from, to: line.to, url: m[1] });
    }
    return out;
  }

  function decosFrom(lines, state) {
    const widgets = [];
    for (const ln of lines) {
      // 游標或選取範圍碰到這一行 → 還原裸網址供編輯
      let onLine = false;
      for (const r of state.selection.ranges) {
        if (r.from <= ln.to && r.to >= ln.from) { onLine = true; break; }
      }
      if (onLine) continue;
      widgets.push(
        Decoration.replace({
          widget: new CardWidget(ln.url),
          block: true,
        }).range(ln.from, ln.to)
      );
    }
    return Decoration.set(widgets);
  }

  // 欄位值 = { lines: 候選行（文件變動才重掃）, decos: 目前要顯示的卡片 }
  function buildValue(state) {
    const lines = scanLines(state);
    return { lines, decos: decosFrom(lines, state) };
  }

  /* docChanged 的增量重掃（2026-08-12）。
     選取／游標路徑早就優化成 O(候選行) 了，但文件變動仍走全份 scanLines：
     3000 行的筆記每按一個鍵就是 3000 次 trim+regex（widget 的 eq 保護只擋住 DOM 重建，
     CPU 照燒）。
     做法：只有「被這次編輯碰到的行」重跑 URL_LINE，其餘舊候選行用 changes.mapPos
     平移座標就好——那些行的文字沒變，判定結果自然也不會變。 */
  function rescanIncremental(value, tr) {
    const state = tr.state;
    // 純 Source Mode 不渲染（與 scanLines 同一個前置條件）
    if (editorLivePreviewField) {
      const lp = state.field(editorLivePreviewField, false);
      if (lp === false) return [];
    }
    const doc = state.doc;
    const ranges = [];
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      ranges.push([doc.lineAt(fromB).number, doc.lineAt(toB).number]);
    });

    const out = [];
    const seen = new Set();   // 已處理的行號：避免同一行被排進兩次（重疊的 block 裝飾會讓 CM6 報錯）

    // 1. 受影響的行：重跑 regex
    for (const [a, b] of ranges) {
      for (let i = a; i <= b; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        const line = doc.line(i);
        const m = line.text.trim().match(URL_LINE);
        if (m) out.push({ from: line.from, to: line.to, url: m[1] });
      }
    }
    // 2. 其餘舊候選行：只換算新座標
    for (const ln of value.lines) {
      const line = doc.lineAt(tr.changes.mapPos(ln.from, 1));
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      out.push({ from: line.from, to: line.to, url: ln.url });
    }

    out.sort((x, y) => x.from - y.from);
    return out;
  }

  /* 移除與目前選取重疊的卡片（不新增任何卡片） */
  function stripSelected(decos, state) {
    return decos.update({
      filter: (from, to) => {
        for (const r of state.selection.ranges) {
          if (r.from <= to && r.to >= from) return false;
        }
        return true;
      },
    });
  }

  RefreshAnno = cm.state.Annotation.define();

  // 區塊型 widget 必須由 StateField 提供（CM6 限制，ViewPlugin 不行）
  const field = StateField.define({
    create: buildValue,
    update(value, tr) {
      // 外部要求刷新（設定變更等）→ 全量重建
      if (tr.annotation(RefreshAnno)) return buildValue(tr.state);
      // 文件變動 → 只重掃被改到的那幾行，其餘平移座標
      if (tr.docChanged) {
        const lines = rescanIncremental(value, tr);
        return { lines, decos: decosFrom(lines, tr.state) };
      }
      if (tr.selection) {
        /* 指標還按著、而且已經拉出非空選取 → 視同拖曳中。
           補的是「滑鼠按下後迅速拖出編輯器」的漏網：那之後 CM 自己接管選取更新，
           editor 收不到 mousemove，門檻永遠達不到，版面就會在拖曳中跳動 */
        if (lcpPointerDown && !lcpDragging && !tr.state.selection.main.empty) lcpDragging = true;
        // 拖曳中：只還原被選到的，不變回卡片 → 版面穩定
        if (lcpDragging) {
          lcpStripped = true;   // 有移除過 → 放開時才需要重新結算
          return { lines: value.lines, decos: stripSelected(value.decos, tr.state) };
        }
        // 一般游標移動：候選行沒變，只重算「這一刻哪些行要讓位給游標」
        return { lines: value.lines, decos: decosFrom(value.lines, tr.state) };
      }
      return value;   // 文件與選取都沒動 → 原封不動（tr.changes 必為空）
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });

  /* 在編輯器內按下滑鼠／觸控只記起點，**位移超過門檻**才進入「拖曳中」
     （放開由 plugin 的全域監聽處理）。單純點一下永遠不會進入拖曳狀態，
     放開時也就不會 dispatch —— 這是 iOS 點擊被吃掉的主因 */
  const beginPointer = (x, y) => {
    lcpPointerDown = true;
    lcpDragging = false;
    lcpStripped = false;
    lcpStartX = x;
    lcpStartY = y;
  };
  const movePointer = (x, y) => {
    if (!lcpPointerDown || lcpDragging) return;   // 已經是拖曳就不用再比，滑鼠移動時這裡會很頻繁
    if (Math.abs(x - lcpStartX) > DRAG_THRESHOLD || Math.abs(y - lcpStartY) > DRAG_THRESHOLD) {
      lcpDragging = true;
    }
  };

  const dragWatch = EditorView.domEventHandlers({
    mousedown: (e) => { beginPointer(e.clientX, e.clientY); return false; },
    mousemove: (e) => { movePointer(e.clientX, e.clientY); return false; },
    touchstart: (e) => {
      const p = e.touches && e.touches[0];
      if (p) beginPointer(p.clientX, p.clientY);
      return false;
    },
    touchmove: (e) => {
      const p = e.touches && e.touches[0];
      if (p) movePointer(p.clientX, p.clientY);
      return false;
    },
  });

  return [field, dragWatch];
}

/* ============ Plugin 主體 ============ */

class LinkCardModule {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.manifest = plugin.manifest;
  }

  /* 快取檔獨立於 Gallery 的 data.json —— 卡片快取有幾百 KB，
     而 Gallery 的 saveState() 是高頻寫入（釘選/上色/拖滑桿），兩者混在一起會很傷 iCloud。 */
  cachePath() { return this.manifest.dir + '/linkcard-cache.json'; }

  async loadCache() {
    try {
      const a = this.app.vault.adapter;
      const p = this.cachePath();
      if (await a.exists(p)) return JSON.parse(await a.read(p)) || {};
    } catch (e) {}
    return {};
  }

  async saveCache() {
    try {
      this._dirty = false;
      await this.app.vault.adapter.write(this.cachePath(), JSON.stringify({ cache: state.cache }));
    } catch (e) {}
  }

  // 還有沒寫出去的變更就立刻寫一次（卸載時用，避免掉資料）
  async flushCache() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._dirty) await this.saveCache();
  }

  async start() {
    const data = await this.loadCache();
    state.cache = data?.cache || {};
    // 設定改放在宿主外掛的 state 裡（設定頁統一在 Gallery Navigator 底下）
    this.plugin.state.linkcard = Object.assign({}, DEFAULT_SETTINGS, this.plugin.state.linkcard);
    this.settings = this.plugin.state.linkcard;

    // 卡片右鍵「淨化連結」要用到宿主外掛（讀 state、寫檔案）
    state.plugin = this.plugin;

    // 圖片倉庫：<vault>/.obsidian/plugins/gallery-navigator/linkcard-images/
    state.adapter = this.app.vault.adapter;
    state.imgDir = this.manifest.dir + '/' + IMG_SUBDIR;

    /* 快取檔約 390KB，而且**整檔重寫**。單張卡片的完整生命週期（抓 meta → 圖片尺寸
       → 下載圖 → 取主色）就會排 3~4 次寫入，開一則多連結的筆記等於連續重寫幾百 KB
       ——在 iCloud 同步範圍內這個代價會被放大。
       → dirty flag + 間隔拉長到 10 秒；真正沒寫完的部分由 onunload 的 flushCache() 補上。 */
    this._dirty = false;
    this._saveTimer = null;
    state.save = () => {
      this._dirty = true;
      if (this._saveTimer) return;          // 已經排程了就不重排（不是「順延」，避免一直被推遲）
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        if (this._dirty) this.saveCache().catch(() => {});
      }, 10000);
    };
    // 卸載時把還沒寫出去的變更補寫（外掛重載/關閉 Obsidian 都會走到）
    this.plugin.register(() => { this.flushCache().catch(() => {}); });
    /* 關閉 Obsidian 走 'quit'：這裡可以把非同步工作加進 tasks，Obsidian 會等它完成，
       比只靠 unregister 的 fire-and-forget 可靠。API 不存在時安靜略過。 */
    try {
      this.plugin.registerEvent(this.app.workspace.on('quit', (tasks) => {
        if (tasks && typeof tasks.add === 'function') tasks.add(() => this.flushCache());
        else this.flushCache().catch(() => {});
      }));
    } catch (e) {}

    // 一次性遷移：舊版 data.json 裡的 base64 圖 → 獨立檔案（背景跑，不擋啟動）
    setTimeout(async () => {
      try {
        const n = await migrateBase64Cache();
        if (n) {
          await this.saveCache();
          new Notice(t('Link cards: moved {{n}} images from data.json to images/', { n }), 6000);
        }
      } catch (e) { console.warn('[LCP] migrate failed:', e.message); }
    }, 1500);


    this.plugin.addCommand({
      id: 'lcp-clear-cache',
      name: 'Clear link card cache',
      callback: async () => {
        // 連圖片檔一起清掉，不然 images/ 會留一堆孤兒
        const files = Object.values(state.cache).map((v) => v?.meta?.img).filter(Boolean);
        state.cache = {};
        await this.saveCache();
        for (const f of files) await removeImageFile(f);
        new Notice('Link Card Preview: cache cleared.');
      },
    });

    // 預覽模式：渲染卡片
    this.plugin.registerMarkdownPostProcessor((el, ctx) => {
      const paragraphs = el.querySelectorAll('p');
      paragraphs.forEach((p) => {
        if (!isSoloParagraph(p)) return;
        const url = p.querySelector('a').getAttribute('href');
        const skeleton = createSkeleton(url);
        p.replaceWith(skeleton);
        // sourcePath：右鍵「淨化連結」要靠它知道該改哪個檔案
        fetchMeta(url).then((meta) => renderCard(skeleton, url, meta, { sourcePath: ctx?.sourcePath }));
      });
    });

    // 編輯模式（Live Preview）：渲染卡片，單擊開啟、鉛筆按鈕選取編輯
    const lpExtension = buildLivePreviewExtension();
    if (lpExtension) {
      this.plugin.registerEditorExtension(lpExtension);

      // 放開滑鼠／手指才結束「拖曳中」狀態並重新結算卡片
      // （掛在 document 上：拖到編輯器外放開也要能收尾）
      const endDrag = () => {
        if (!lcpPointerDown) return;
        // 兩道閘門都成立才重算：真的拖曳過（位移夠大）、而且真的因此移除過卡片。
        // 單純點擊與純捲動都會走到這裡，但兩者都不該 dispatch（見上方 iOS 說明）
        const needsRefresh = lcpDragging && lcpStripped;
        lcpPointerDown = false;
        lcpDragging = false;
        lcpStripped = false;
        if (!needsRefresh || !RefreshAnno) return;
        // 延到下一個 task：保證這輪 CM 更新永遠不會插進 touchend → 合成 click 的空窗
        window.setTimeout(() => {
          this.app.workspace.iterateAllLeaves((leaf) => {
            const v = leaf.view;
            if (v instanceof MarkdownView && v.editor?.cm) {
              try {
                v.editor.cm.dispatch({ annotations: RefreshAnno.of(true) });
              } catch (e) {}
            }
          });
        }, 0);
      };
      this.plugin.registerDomEvent(document, 'mouseup', endDrag);
      this.plugin.registerDomEvent(document, 'touchend', endDrag);
      // iOS 手勢被系統接管時（捲動接手、通知橫幅、邊緣滑動）只發 touchcancel、不發 touchend。
      // 少了這行，lcpDragging 會卡在 true，之後每次選取變動都只移除卡片、不重建
      this.plugin.registerDomEvent(document, 'touchcancel', endDrag);
    }

    // Canvas：把 link node 的內嵌網頁換成 lcp 卡片
    this.setupCanvasPatch();

    // 編輯模式：貼上 Threads 連結時自動插入描述
    this.plugin.registerDomEvent(document, 'paste', async (evt) => {
      if (!this.settings.threadsPasteInsert) return;
      const text = evt.clipboardData?.getData('text/plain')?.trim();
      if (!text || !isMetaUrl(text)) return;

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) return;
      /* handler 掛在 document，所以「背景開著筆記」時，在設定頁輸入框／改名對話框／
         搜尋列貼上 Meta 連結也會打到這裡，把貼文內文插進背後那份筆記的游標處。
         貼上的目標必須真的在這個 MarkdownView 裡面才處理。
         注意：不可改用 evt.defaultPrevented 擋——cleanlink 的淨化貼上會 preventDefault，
         但本功能仍應照常運作（兩者是刻意疊加的設計）。 */
      if (!activeView.containerEl.contains(evt.target)) return;

      const editor = activeView.editor;
      setTimeout(async () => {
        try {
          /* 短連結先等展開，再對「正式網址」抓 meta。
             直接拿 /share/ 網址去抓的話，同一則貼文會被 cleanlink（淨化貼上）與這裡
             各抓一次，而且快取 key 落在短連結上，等於白佔一筆——之後用正式網址開時
             還得再存一筆。resolveShortUrl 有記憶體快取，cleanlink 剛展開過就直接命中。 */
          const url = isMetaShortUrl(text)
            ? await resolveShortUrl(text, this.plugin.cleanlink?.opt)
            : text;
          const meta = await fetchMeta(url);
          if (!meta.description) return;
          const cursor = editor.getCursor();
          const insertPos = { line: cursor.line, ch: editor.getLine(cursor.line).length };
          editor.replaceRange('\n' + meta.description, insertPos);
        } catch (e) {
          console.warn('[LCP] paste insert failed:', e.message);
        }
      }, 100);
    });
  }

  setupCanvasPatch() {
    // view → cleanup 函式，用來回收已關閉 Canvas 的 observer
    this._canvasObservers = new Map();
    /* 已處理過的節點：contentEl → 我們掛上去的那張卡片。
       Canvas 平移縮放會持續觸發 mutation，每次全量掃描時，已經有卡片的節點
       以前仍要跑 querySelectorAll('iframe, webview')（掃整棵子樹）＋ querySelector('.lcp-card')。
       改成只比對一個元素參照，完全不碰 DOM 查詢。
       節點內容被 Obsidian 回收重建時，這張卡就不再是 contentEl 的子節點 → 自動走回完整路徑。 */
    this._canvasCards = new WeakMap();

    const syncCanvasObservers = () => {
      // 1. 對目前開著的 Canvas 掛上 observer（已掛的會被 __lcpAttached 擋掉）
      this.app.workspace.getLeavesOfType('canvas').forEach((leaf) => {
        if (leaf.view) this.attachToCanvas(leaf.view);
      });
      // 2. 只回收「DOM 已脫離文件」的 observer。
      //    用 document.contains 判斷，而非「是否在分頁清單」——
      //    切換分頁時背景 Canvas 的 DOM 仍在文件中，不該回收、不該重掛載，
      //    這樣切分頁不會重新渲染卡片（修正 1.2.1 的重載感）。
      for (const [view, cleanup] of this._canvasObservers) {
        const root = view.canvas?.canvasEl || view.containerEl;
        if (!root || !root.isConnected) cleanup();
      }
    };

    this.plugin.registerEvent(this.app.workspace.on('layout-change', syncCanvasObservers));
    this.plugin.registerEvent(this.app.workspace.on('active-leaf-change', syncCanvasObservers));

    /* 卸載時一次清光所有還活著的 Canvas observer。
       以前是每次 attachToCanvas 都 plugin.register(cleanup)：cleanup 本身冪等、功能沒問題，
       但 register 清單會隨著開關 Canvas 的次數一路變長，每個閉包還持有 view 參照。
       改成在這裡註冊一顆，遍歷 _canvasObservers 即可（cleanup 會自行從 Map 移除）。 */
    this.plugin.register(() => {
      for (const cleanup of Array.from(this._canvasObservers.values())) {
        try { cleanup(); } catch (e) {}
      }
    });

    syncCanvasObservers();
  }

  attachToCanvas(view) {
    if (!view || !view.canvas || view.__lcpAttached) return;
    view.__lcpAttached = true;

    const root = view.canvas.canvasEl || view.containerEl;
    if (!root) return;

    const processAll = () => {
      try {
        view.canvas.nodes?.forEach((node) => this.processCanvasNode(node));
      } catch (e) {}
    };

    /* 單一 observer ＋ debounce：
       Canvas 平移縮放時會大量增刪節點內容（視野外節點虛擬化），
       不 debounce 的話每次變動都觸發全量掃描，卡片一多就拖垮效能。

       ⚠️ 這裡要的是 **trailing-only**（停下來才跑），不是 leading-block。
          舊寫法 `if (pending) return` 的效果是「每 120ms 一定跑一次」——
          而拖曳期間 mutation 是持續發生的，等於整個拖曳過程每秒跑 8 次全節點掃描，
          每個節點還要做 4 次 querySelector。這正是最該避開的模式。
          改成每次變動都把計時器往後推，手停了才掃一次。

       maxWait 1 秒：萬一有東西讓 mutation 永不停歇（例如 Canvas 裡有動畫節點），
          也不能無限延後，否則新卡片永遠不會渲染。 */
    let pending = null, firstAt = 0;
    const scheduleProcess = () => {
      const now = Date.now();
      if (!pending) firstAt = now;
      else if (now - firstAt > 1000) return;   // 已連續變動 1 秒 → 不再延後，讓既有計時器如期觸發
      clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        processAll();
      }, 120);
    };

    const obs = new MutationObserver(scheduleProcess);
    obs.observe(root, { childList: true, subtree: true });

    const cleanup = () => {
      obs.disconnect();
      if (pending) { clearTimeout(pending); pending = null; }
      view.__lcpAttached = false;
      this._canvasObservers.delete(view);
    };
    /* 集中追蹤所有作用中的 Canvas observer：供 layout-change 時回收殭屍項，
       卸載時也由 setupCanvasPatch 註冊的那一顆統一清掉（不在這裡逐次 plugin.register）。 */
    this._canvasObservers.set(view, cleanup);
    processAll();
  }

  /* 冪等修復：每次掃描時清除 webview、補回缺失的卡片。
     已有卡片的節點是 no-op，成本只有一次 querySelector */
  // 切換 YouTube 設定後，提示使用者重開 Canvas。
  // 不做即時 DOM 切換——重開時讀新設定走對路徑，100% 可靠、無半套狀態。
  notifyCanvasYouTubeChange() {
    const hasOpenCanvasWithYouTube = this.app.workspace
      .getLeavesOfType('canvas')
      .some((leaf) => {
        const view = leaf.view;
        if (!view || !view.canvas) return false;
        let found = false;
        view.canvas.nodes?.forEach((node) => {
          try {
            const data = node.getData?.();
            if (data && data.type === 'link' && isYouTubeUrl(data.url)) found = true;
          } catch (e) {}
        });
        return found;
      });
    if (hasOpenCanvasWithYouTube) {
      new Notice('YouTube display setting changed. Reopen the canvas to apply it.');
    }
  }

  processCanvasNode(node) {
    try {
      const data = node.getData?.();
      if (!data || data.type !== 'link' || !data.url) return;

      const contentEl = node.contentEl
        || node.nodeEl?.querySelector('.canvas-node-content');
      if (!contentEl) return;

      // 快速路徑：這個節點的卡片還在原位 → 什麼都不用做（見 _canvasCards 說明）
      const done = this._canvasCards.get(contentEl);
      if (done && done.parentElement === contentEl) return;

      // YouTube 且使用者選擇保留嵌入：不卡片化，維持原生 iframe 播放器
      if (isYouTubeUrl(data.url) && this.settings.youtubeCanvasEmbed) {
        const nodeEl = node.nodeEl || contentEl.closest('.canvas-node');
        if (nodeEl && nodeEl.classList) nodeEl.classList.remove('lcp-has-card');
        return;
      }

      const frames = contentEl.querySelectorAll('iframe, webview');
      frames.forEach((f) => {
        try { f.src = 'about:blank'; } catch (e) {}
        f.remove();
      });

      if (!contentEl.querySelector('.lcp-card')) {
        const url = data.url;
        // 標記節點：CSS 據此隱藏裸網址標籤（取代 has 偽類選擇器，效能較好）
        const nodeEl = node.nodeEl || contentEl.closest('.canvas-node');
        if (nodeEl && nodeEl.classList) nodeEl.classList.add('lcp-has-card');
        contentEl.textContent = '';

        // 一律先放骨架佔位（確保任何情況下節點都有可見內容，不會空白）
        const sk = createSkeleton(url);
        sk.classList.add('lcp-card--canvas');
        contentEl.appendChild(sk);
        // renderCard 是就地改寫 sk（骨架直接變成卡片）→ 記這個參照就能認出「已處理」
        this._canvasCards.set(contentEl, sk);

        const cached = getCachedMeta(url);
        const metaPromise = cached ? Promise.resolve(cached) : fetchMeta(url);
        metaPromise
          .then((meta) => renderCard(sk, url, meta, { canvas: true }))
          .catch((e) => {
            // renderCard 失敗也不留空白：退回最基本的網域卡
            try {
              const fallback = {
                title: hostOf(url), description: '', image: '', hostname: hostOf(url),
              };
              renderCard(sk, url, fallback, { canvas: true });
            } catch (e2) {}
            console.warn('[LCP] canvas render failed:', e && e.message);
          });
      }
    } catch (e) {}
  }

}



/* 設定區塊：由 main.js 的統一設定頁呼叫 */
function renderLinkCardSettings(containerEl, plugin) {
  /* 總開關為關時 LinkCardModule.start() 不會跑，state.linkcard 也就沒被初始化。
     以前寫成 `|| {}`，子開關會被寫進一個沒人接住的暫時物件 → saveState 存不到，重載即遺失。
     這裡直接把預設值就地掛回 state，之後的 onChange 才寫得進真正的設定。 */
  const lc = plugin.state.linkcard || (plugin.state.linkcard = Object.assign({}, DEFAULT_SETTINGS));
  new Setting(containerEl)
    .setName(t('Insert post text when pasting Threads / Instagram links'))
    .setDesc(t('When off, only the bare link is kept'))
    .addToggle((tg) => tg.setValue(lc.threadsPasteInsert !== false)   // ⚠️ 參數勿叫 t，會遮蔽 i18n 的 t()
      .onChange((v) => { lc.threadsPasteInsert = v; plugin.saveState(); }));

  new Setting(containerEl)
    .setName(t('Keep native YouTube embeds on Canvas'))
    .setDesc(t('On = playable iframe; off = link card. Reopen the Canvas after switching'))
    .addToggle((tg) => tg.setValue(!!lc.youtubeCanvasEmbed)
      .onChange((v) => {
        lc.youtubeCanvasEmbed = v;
        plugin.saveState();
        if (plugin.linkcard) plugin.linkcard.notifyCanvasYouTubeChange();
        new Notice(t('Takes effect after reopening the Canvas'));
      }));
}

/* downscaleBytes 也給 gallery.js 的 og-cache 用（同一套縮圖邏輯只維護一份）。
   它是純函式，不碰本模組的 state，可以安全外借。 */
module.exports = { LinkCardModule, renderLinkCardSettings, downscaleBytes };
