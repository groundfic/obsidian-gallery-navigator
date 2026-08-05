'use strict';

/* ===== Clean Links（淨化連結） =====
 *
 * 在編輯器右鍵選單加入「淨化連結」：把網址裡的追蹤參數（utm_*、xmt、slof、
 * fbclid、igsh、gclid…）拿掉，其餘 query 原封不動保留。
 *
 * 策略：黑名單制
 *   • EXACT   —— 已知的追蹤參數名（全站適用）
 *   • PREFIX  —— 以某前綴開頭者全刪（utm_、pd_rd_、_hs…）
 *   • HOST_EXTRA —— 名稱太通用、只在特定網域才算追蹤碼的（x.com 的 s/t、
 *                   YouTube 的 si…）。這樣才不會誤刪 YouTube 的 ?v=、?t=。
 *   • 使用者可在設定頁自訂「額外要刪」與「永不刪」的參數名。
 *
 * 字串處理刻意「不經過 new URL()」——直接切 `?` 與 `#`，保留原始編碼，
 * 避免 URL 正規化把使用者原本的網址改得面目全非（大小寫、%2F、尾斜線…）。
 *
 * 狀態：state.enableCleanLink / state.cleanLinkExtra / state.cleanLinkKeep
 */

const { Notice, Setting, requestUrl } = require('obsidian');
const { t } = require('./i18n.js');

/* ── 黑名單：全站適用的追蹤參數 ── */
const EXACT = new Set([
  // Meta：Threads / Instagram / Facebook
  'xmt', 'slof', 'igsh', 'igshid', 'fbclid', 'mibextid', 'rdid', 'ig_rid',
  'share_url', 'shid', 'fb_action_ids', 'fb_action_types', 'fb_source',
  // Google / DoubleClick / Ads
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source', 'gad', 'srsltid',
  'ved', 'usg', 'sca_esv', 'sourceid',
  // 其他廣告平台
  'msclkid', 'twclid', 'ttclid', 'li_fat_id', 'epik', 'yclid', 'rb_clickid',
  'irclickid', 'cjevent', 'awc',
  // EDM / CRM
  'mc_cid', 'mc_eid', 'ml_subscriber', 'ml_subscriber_hash', 'vgo_ee',
  'hsCtaTracking', 'elqTrackId', 'elqTrack', 'sc_campaign', 'sc_channel',
  'sc_content', 'sc_medium', 'sc_outcome', 'sc_geo', 'sc_country',
  // 分析 / 站內來源標記
  '_ga', '_gl', '_openstat', 'icid', 'trk', 'trkCampaign', 'cmpid', 'cid_source',
  'ito', 'ncid', 'oicd', 'spReportId', 'wtmc', 'wt_mc', 'ref_source', 'ref_src',
  'ref_url', 'referrer', 'campaign_id', 'campaignid', 'adgroupid', 'adid',
  'share_id', 'share_source', 'share_medium', 'share_plat', 'share_tag',
  'from_source', 'from_spmid', 'is_from_webapp', 'sender_device', 'sender_web_id',
  'u_code', 'preview_pb', 'spm_id_from', 'vd_source', 'bbid',
  // Amazon
  'pd_rd_w', 'pd_rd_r', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r', 'linkCode',
  'creativeASIN', 'ascsubtag', 'psc',
]);

/* ── 黑名單：前綴比對（大小寫不敏感） ── */
const PREFIX = [
  'utm_',      // Google Analytics 家族
  'pk_', 'mtm_', 'piwik_', 'matomo_',
  'stm_', 'vero_', 'oly_', 'hsa_', '_hs',
  'pd_rd_', 'pf_rd_',
  'at_', 'wickedid',
];

/* ── 只在特定網域才算追蹤碼的通用參數名 ──
   （s / t / si / ref 在別的站可能是必要參數，不能全站砍） */
const HOST_EXTRA = [
  { test: /(^|\.)(x\.com|twitter\.com|t\.co)$/i,          names: ['s', 't', 'cxt'] },
  { test: /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i, names: ['si', 'pp', 'feature', 'ab_channel'] },
  { test: /(^|\.)(spotify\.com|spoti\.fi)$/i,             names: ['si', 'nd', 'context'] },
  { test: /(^|\.)(amazon\.[a-z.]+|amzn\.to)$/i,           names: ['ref', 'ref_', 'tag', 'th', 'creative'] },
  { test: /(^|\.)(tiktok\.com)$/i,                        names: ['_r', '_t', 'refer', 'checksum'] },
  { test: /(^|\.)(bilibili\.com|b23\.tv)$/i,              names: ['spm_id_from', 'from', 'seid', 'buvid'] },
  { test: /(^|\.)(medium\.com)$/i,                        names: ['source', 'sk'] },
  { test: /(^|\.)(reddit\.com|redd\.it)$/i,               names: ['share_id', 'utm_name', 'rdt'] },
  { test: /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/i,         names: ['nic_v', 'nic_v1', 'sender'] },
  { test: /(^|\.)(shopee\.[a-z.]+|xiaohongshu\.com|xhslink\.com)$/i, names: ['xptdk', 'app_platform', 'apptime', 'share_from'] },
];

/* 這些網址整個跳過不動：
   • 本機 / 內網
   • CDN 圖床 —— 那些 query 是簽章（_nc_oh、oe、Expires、Signature…），刪一個圖就掛掉 */
const SKIP_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$|(^|\.)(fbcdn\.net|cdninstagram\.com|akamaized\.net|cloudfront\.net|licdn\.com|twimg\.com|pinimg\.com|ggpht\.com|googleusercontent\.com|blob\.core\.windows\.net|amazonaws\.com)$/i;

/* 抓網址：不含空白與明顯的 markdown 邊界字元；尾端標點另外修掉 */
const URL_RE = /https?:\/\/[^\s<>"'`\\|]+/gi;

/* ────────────────────────── 純函式區（好測試、無 Obsidian 依賴） ────────────────────────── */

function hostOf(raw) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(raw);
  if (!m) return '';
  return m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
}

function splitList(s) {
  return String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}

/* 判斷單一參數名是否為追蹤碼 */
function isTracking(name, opt) {
  const n = String(name || '');
  const low = n.toLowerCase();
  if (!low) return false;
  if (opt.keep.has(low)) return false;            // 使用者指定永不刪
  if (opt.extra.has(low)) return true;            // 使用者指定額外刪
  if (EXACT.has(n) || EXACT.has(low)) return true;
  if (PREFIX.some((p) => low.startsWith(p))) return true;
  if (opt.hostNames.has(low)) return true;
  return false;
}

/* 淨化單一網址。沒東西可刪就原樣回傳（===  相同代表無變動）。 */
function cleanUrl(raw, opt) {
  const o = normalizeOpt(opt);
  const qIdx = raw.indexOf('?');
  if (qIdx < 0) return raw;                       // 沒有 query，什麼都不用做

  const host = hostOf(raw);
  if (!host || SKIP_HOST.test(host)) return raw;

  const hostNames = new Set();
  for (const r of HOST_EXTRA) if (r.test.test(host)) r.names.forEach((x) => hostNames.add(x.toLowerCase()));
  const optH = Object.assign({}, o, { hostNames });

  const hashIdx = raw.indexOf('#', qIdx);
  const base = raw.slice(0, qIdx);
  const query = raw.slice(qIdx + 1, hashIdx < 0 ? undefined : hashIdx);
  const hash = hashIdx < 0 ? '' : raw.slice(hashIdx);

  const parts = query.split('&').filter((p) => p !== '');
  const kept = parts.filter((p) => !isTracking(p.split('=')[0], optH));
  if (kept.length === parts.length) return raw;

  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}

/* 把網址尾端誤抓進來的標點切掉，回傳 [網址, 尾巴] */
function splitTrailing(u) {
  let tail = '';
  for (;;) {
    const last = u.charAt(u.length - 1);
    if (!last) break;
    if ('.,;:!?、。，；：！？'.indexOf(last) >= 0) { tail = last + tail; u = u.slice(0, -1); continue; }
    // 只有在括號不成對時才把 ) 當成尾巴（保住維基百科那種網址內含括號的情況）
    if (last === ')' && (u.split('(').length - 1) < (u.split(')').length - 1)) { tail = last + tail; u = u.slice(0, -1); continue; }
    if (']}>」』】〉》'.indexOf(last) >= 0) { tail = last + tail; u = u.slice(0, -1); continue; }
    break;
  }
  return [u, tail];
}

/* 淨化一段文字裡的所有網址 → { text, count } */
function cleanText(text, opt) {
  const o = normalizeOpt(opt);
  let count = 0;
  const out = String(text).replace(URL_RE, (m) => {
    const [url, tail] = splitTrailing(m);
    const cleaned = cleanUrl(url, o);
    if (cleaned !== url) count++;
    return cleaned + tail;
  });
  return { text: out, count };
}

/* ────────────────────────── 短連結展開（唯一需要連網的部分） ────────────────────────── */

/* Threads / IG 的分享短連結：
 *     https://www.threads.com/share/XXXXXXXX/
 *   → https://www.threads.com/@example/post/XXXXXXX
 *
 * 追蹤碼藏在「路徑」而不是 query，砍參數對它完全無效，只能連網問。
 * 而且它不走 HTTP 轉址（直接回 200），正式網址藏在 HTML 的
 * <link rel="canonical"> / og:url / al:android:url 裡，所以得抓 HTML 回來解析。 */

const META_SHORT_RE = /^https?:\/\/(?:www\.)?(?:threads\.(?:com|net)|instagram\.com|instagr\.am)\/share\/[^\s?#]+/i;
/* 展開結果必須長得像一則真正的貼文，避免被錯誤頁 / 登入頁的 canonical 騙走 */
const META_POST_RE = /^https?:\/\/(?:www\.)?(?:threads\.(?:com|net)|instagram\.com|instagr\.am)\/(@[^/]+\/post\/|p\/|reel\/|tv\/)[^\s?#]+/i;

const SHORT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/* 短連結 → 正式網址。記憶體快取，重開 Obsidian 就清空（不值得寫進磁碟）。 */
const shortCache = new Map();

function isMetaShortUrl(u) { return META_SHORT_RE.test(u); }

/** 找出一段文字裡所有的 Meta 短連結（去重） */
function findShortUrls(text) {
  const out = [];
  const seen = new Set();
  String(text).replace(URL_RE, (m) => {
    const [url] = splitTrailing(m);
    if (isMetaShortUrl(url) && !seen.has(url)) { seen.add(url); out.push(url); }
    return m;
  });
  return out;
}

/** 別處（連結卡片）已經抓過同一頁的話，把結果餵進來，省掉重複請求 */
function primeShortUrl(short, canonical) {
  if (!short || !canonical || short === canonical) return;
  if (!isMetaShortUrl(short) || !META_POST_RE.test(canonical)) return;
  shortCache.set(short, canonical);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#0*64;/g, '@')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCharCode(+d); } catch (e) { return _; } })
    .replace(/&amp;/g, '&');
}

/** 從 HTML 抽出正式網址。屬性順序不固定，所以正反兩種寫法都試。 */
function canonicalFromHtml(html) {
  const pats = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i,
    /<meta[^>]+property=["']al:android:url["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const re of pats) {
    const m = re.exec(html);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}

/** 展開單一短連結。失敗（離線、被擋、解析不出）一律原樣回傳，不吵不報錯。 */
async function resolveShortUrl(raw, opt) {
  if (!isMetaShortUrl(raw)) return raw;
  if (shortCache.has(raw)) return shortCache.get(raw);

  try {
    const res = await requestUrl({
      url: raw,
      headers: { 'User-Agent': SHORT_UA, 'Accept': 'text/html,application/xhtml+xml' },
      throw: false,
    });
    if (!res || res.status >= 400) return raw;

    let out = canonicalFromHtml(res.text || '');
    if (!out || !META_POST_RE.test(out)) return raw;

    out = cleanUrl(out, opt);   // 展開後的正式網址本身也可能帶參數
    shortCache.set(raw, out);
    return out;
  } catch (e) {
    return raw;
  }
}

function normalizeOpt(opt) {
  if (opt && opt._normalized) return opt;
  const st = (opt && opt.state) || {};
  return {
    _normalized: true,
    extra: new Set(splitList(st.cleanLinkExtra).map((x) => x.toLowerCase())),
    keep: new Set(splitList(st.cleanLinkKeep).map((x) => x.toLowerCase())),
    hostNames: new Set(),
  };
}

/* ────────────────────────── Obsidian 模組 ────────────────────────── */

class CleanLinkModule {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  get opt() { return normalizeOpt({ state: this.plugin.state }); }

  start() {
    const p = this.plugin;

    p.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      if (p.state.enableCleanLink === false) return;
      this.buildMenu(menu, editor);
    }));

    p.registerEvent(this.app.workspace.on('editor-paste', (evt, editor) => this.onPaste(evt, editor)));

    p.addCommand({
      id: 'clean-tracking-links',
      name: t('Clean tracking links in this note'),
      editorCallback: (editor) => this.cleanWholeNote(editor),
    });

    p.addCommand({
      id: 'expand-short-links',
      name: t('Restore share links in this note'),
      editorCallback: (editor) => {
        const all = findShortUrls(editor.getValue());
        if (!all.length) { new Notice(t('No share links found')); return; }
        this.expandInEditor(editor, all);
      },
    });
  }

  /* 貼上時攔截：只在「確定不會弄壞別的貼上行為」時才出手。
     刻意放過的情況：
       • 已被別的外掛處理掉（defaultPrevented）
       • 剪貼簿有檔案／圖片
       • 剪貼簿同時有 text/html 且貼的不是單純一條網址
         → 那是從網頁複製的排版內容，要留給 Obsidian 的 HTML→Markdown 轉換 */
  onPaste(evt, editor) {
    const st = this.plugin.state;
    if (st.enableCleanLink === false || st.cleanLinkOnPaste === false) return;
    if (evt.defaultPrevented) return;
    const cd = evt.clipboardData;
    if (!cd) return;
    if (cd.files && cd.files.length) return;

    const text = cd.getData('text/plain');
    if (!text || text.indexOf('http') < 0) return;

    const types = Array.from(cd.types || []);
    const isBareUrl = /^\s*https?:\/\/\S+\s*$/.test(text);
    if (types.indexOf('text/html') >= 0 && !isBareUrl) return;

    const r = cleanText(text, this.opt);
    const shorts = this.expandEnabled() ? findShortUrls(r.text) : [];
    if (!r.count && !shorts.length) return;

    evt.preventDefault();
    editor.replaceSelection(r.text);
    if (r.count) new Notice(t('Cleaned {{n}} link(s) on paste', { n: r.count }));

    // 短連結要連網才知道正式網址：先把文字貼進去（不讓使用者等），
    // 解析完再原地換掉。失敗就維持短連結，不會少東西。
    if (shorts.length) this.expandInEditor(editor, shorts);
  }

  expandEnabled() {
    const st = this.plugin.state;
    return st.enableCleanLink !== false && st.cleanLinkExpandShort !== false;
  }

  /** 把編輯器裡出現的這些短連結全部換成正式網址（逐行掃描 + 一次 transaction） */
  async expandInEditor(editor, shorts) {
    const opt = this.opt;
    const pairs = [];
    for (const s of shorts) {
      const full = await resolveShortUrl(s, opt);
      if (full && full !== s) pairs.push([s, full]);
    }
    if (!pairs.length) return;

    const changes = [];
    let n = 0;
    for (let ln = 0; ln < editor.lineCount(); ln++) {
      const src = editor.getLine(ln);
      if (src.indexOf('/share/') < 0) continue;
      let next = src;
      for (const [s, full] of pairs) {
        if (next.indexOf(s) < 0) continue;
        n += next.split(s).length - 1;
        next = next.split(s).join(full);
      }
      if (next !== src) changes.push({ from: { line: ln, ch: 0 }, to: { line: ln, ch: src.length }, text: next });
    }
    if (!changes.length) return;

    if (editor.transaction) editor.transaction({ changes });
    else changes.reverse().forEach((c) => editor.replaceRange(c.text, c.from, c.to));
    new Notice(t('Restored {{n}} share link(s)', { n }));
  }

  /* 依當下情境決定要放哪些選單項目：沒東西可淨化就完全不出現，不吵。 */
  buildMenu(menu, editor) {
    const opt = this.opt;
    const sel = editor.getSelection();
    let added = false;

    /* 全文只讀一次、只掃一次。
       以前 cleanText(editor.getValue()) 與 findShortUrls(editor.getValue()) 各跑一輪，
       而 buildMenu 是右鍵選單的同步路徑——幾千行的筆記按右鍵會明顯卡一下。
       兩者都用惰性求值：只有真的需要那個選單項時才算。 */
    let _all = null;
    const allText = () => (_all === null ? (_all = editor.getValue()) : _all);
    let _whole = null;
    const wholeClean = () => (_whole === null ? (_whole = cleanText(allText(), opt)) : _whole);
    let _shorts = null;
    const allShorts = () => (_shorts === null ? (_shorts = findShortUrls(allText())) : _shorts);

    if (sel) {
      const r = cleanText(sel, opt);
      if (r.count) {
        added = true;
        menu.addItem((i) => i.setTitle(t('Clean links in selection ({{n}})', { n: r.count }))
          .setIcon('eraser')
          .onClick(() => {
            editor.replaceSelection(r.text);
            new Notice(t('Cleaned {{n}} link(s)', { n: r.count }));
          }));
      }
    } else {
      const hit = this.linkAtCursor(editor);
      if (hit) {
        added = true;
        menu.addItem((i) => i.setTitle(t('Clean this link')).setIcon('eraser')
          .onClick(() => {
            editor.replaceRange(hit.cleaned, { line: hit.line, ch: hit.from }, { line: hit.line, ch: hit.to });
            new Notice(t('Cleaned {{n}} link(s)', { n: 1 }));
          }));
      }
    }

    // 整篇：只在「還有別的地方可淨化」時才出現，避免跟上面那項重複
    const whole = wholeClean();
    if (whole.count && (!added || whole.count > 1)) {
      menu.addItem((i) => i.setTitle(t('Clean all links in this note ({{n}})', { n: whole.count }))
        .setIcon('eraser')
        .onClick(() => this.cleanWholeNote(editor)));
    }

    /* ── 短連結 ──
       Threads/IG 的 /share/ 連結把追蹤碼放在路徑裡，砍 query 完全無效，
       只能連網問出正式網址，所以獨立成一項並標明「需連線」。 */
    if (this.expandEnabled()) {
      const scope = sel || editor.getLine(editor.getCursor().line) || '';
      const here = findShortUrls(scope);
      if (here.length) {
        menu.addItem((i) => i.setTitle(t('Restore original URL (needs network)')).setIcon('unfold-horizontal')
          .onClick(() => this.expandInEditor(editor, here)));
      }
      const all = allShorts();
      if (all.length > here.length) {
        menu.addItem((i) => i.setTitle(t('Restore all share links in this note ({{n}})', { n: all.length }))
          .setIcon('unfold-horizontal')
          .onClick(() => this.expandInEditor(editor, all)));
      }
    }
  }

  /* 游標所在的網址（且真的有東西可刪才回傳） */
  linkAtCursor(editor) {
    const cur = editor.getCursor();
    const line = editor.getLine(cur.line) || '';
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(line)) !== null) {
      const [url, tail] = splitTrailing(m[0]);
      const from = m.index;
      const to = from + url.length;
      if (cur.ch < from || cur.ch > to + tail.length) continue;
      const cleaned = cleanUrl(url, this.opt);
      if (cleaned === url) return null;
      return { line: cur.line, from, to, cleaned };
    }
    return null;
  }

  /* 逐行改寫，用 transaction 一次送出 → 只算一步 undo，且不動游標與捲動位置 */
  cleanWholeNote(editor) {
    const opt = this.opt;
    const changes = [];
    let count = 0;
    const total = editor.lineCount();
    for (let ln = 0; ln < total; ln++) {
      const src = editor.getLine(ln);
      if (src.indexOf('http') < 0) continue;
      const r = cleanText(src, opt);
      if (!r.count) continue;
      count += r.count;
      changes.push({ from: { line: ln, ch: 0 }, to: { line: ln, ch: src.length }, text: r.text });
    }
    if (!changes.length) { new Notice(t('No tracking parameters found')); return; }
    if (editor.transaction) editor.transaction({ changes });
    else changes.reverse().forEach((c) => editor.replaceRange(c.text, c.from, c.to));
    new Notice(t('Cleaned {{n}} link(s)', { n: count }));
  }
}

/* ────────────────────────── 設定頁（掛在 gallery.js 的設定分頁底下） ────────────────────────── */

function renderCleanLinkSettings(containerEl, plugin) {
  const st = plugin.state;
  const save = () => plugin.saveState();

  new Setting(containerEl)
    .setName(t('Clean links on paste'))
    .setDesc(t('Strips tracking parameters the moment you paste, so they never enter the note. Pasting rich content copied from a web page is left alone.'))
    .addToggle((tg) => tg.setValue(st.cleanLinkOnPaste !== false)
      .onChange((v) => { st.cleanLinkOnPaste = v; save(); }));

  new Setting(containerEl)
    .setName(t('Restore Threads / Instagram share links'))
    .setDesc(t('Share links like threads.com/share/XXXX hide the tracking code in the path, so it can only be removed by asking the site for the real post URL. This is the only part of clean links that uses the network.'))
    .addToggle((tg) => tg.setValue(st.cleanLinkExpandShort !== false)
      .onChange((v) => { st.cleanLinkExpandShort = v; save(); }));

  new Setting(containerEl)
    .setName(t('Extra parameters to remove'))
    .setDesc(t('Comma separated. Added to the built-in blacklist, e.g. my_ref, src_id'))
    .addText((tx) => {
      tx.setPlaceholder('my_ref, src_id').setValue(st.cleanLinkExtra || '')
        .onChange((v) => { st.cleanLinkExtra = v; save(); });
      tx.inputEl.style.width = '240px';
    });

  new Setting(containerEl)
    .setName(t('Parameters to always keep'))
    .setDesc(t('Comma separated. Never removed, even if blacklisted. Wins over everything else.'))
    .addText((tx) => {
      tx.setPlaceholder('ref, source').setValue(st.cleanLinkKeep || '')
        .onChange((v) => { st.cleanLinkKeep = v; save(); });
      tx.inputEl.style.width = '240px';
    });
}

module.exports = {
  CleanLinkModule,
  renderCleanLinkSettings,
  // 匯出純函式方便測試 / 其他模組重用
  cleanUrl,
  cleanText,
  isMetaShortUrl,
  findShortUrls,
  resolveShortUrl,
  primeShortUrl,
  canonicalFromHtml,
};
