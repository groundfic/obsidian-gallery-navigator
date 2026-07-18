'use strict';

/*
 * Gallery Navigator
 * 以封面卡片視覺化瀏覽整個 vault。集合總覽(資料夾) → 進資料夾 → 筆記卡片牆。
 * 核心封面/標籤邏輯移植自 vault 內的 BASE/Code/Collections code.md (js-engine)。
 */

const { Plugin, ItemView, TFolder, TFile, Menu, FuzzySuggestModal, SuggestModal, Notice, setIcon, Modal, requestUrl, PluginSettingTab, Setting } = require('obsidian');
const { t, setLang, isZh } = require('./i18n.js');

const GN_BUILD = '2026-07-17 i18n';   // 手機診斷用：確認 iCloud 同步到的是哪一版

const PIN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PIN_ENDPOINT = 'https://api.pinterest.com/v3/visual_search/extension/image/';

// 容錯 JSON 解析：Pinterest 回應的字串欄位偶爾含原始控制字元，嚴格 JSON.parse 會炸
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) {}
  try { return JSON.parse(String(text).replace(/[\u0000-\u001F]/g, ' ')); } catch (e) {}
  return null;
}

/* ===== Pinterest 動圖（gif）處理 =====
   實測（2026-07）：visual_search 的回應「只有靜態 jpg」，整包裡沒有任何 .gif / .mp4 網址，
   連 is_video 旗標都不可靠（真的是 gif 的 pin，is_video 竟是 false）。
   但 Pinterest 的原檔就放在 i.pinimg.com/originals/<a>/<b>/<c>/<hash>.gif —— 用縮圖 hash 推得出來。
   → 縮圖網址換算成 originals 的 .gif，HEAD 一下：200 + image/gif ＝ 這個 pin 真的是動圖，直接播原檔。 */

// 由縮圖網址推原檔 gif 網址：.../474x/11/50/80/<hash>.jpg → .../originals/11/50/80/<hash>.gif
function pinGifGuess(url) {
  if (!url || !/i\.pinimg\.com/i.test(url)) return null;
  const g = String(url).split('?')[0]
    .replace(/\/(originals|\d+x)\//, '/originals/')
    .replace(/\.(jpe?g|png|webp)$/i, '.gif');
  return /\/originals\/.+\.gif$/i.test(g) ? g : null;
}

// HEAD 探測（結果快取；同時併發上限 5，免一頁 80 張同時打爆）
const _pinGifCache = new Map();
let _pinGifRunning = 0;
const _pinGifQueue = [];
function _pinGifPump() {
  while (_pinGifRunning < 5 && _pinGifQueue.length) {
    const job = _pinGifQueue.shift();
    _pinGifRunning++;
    job().finally(() => { _pinGifRunning--; _pinGifPump(); });
  }
}
function probePinGif(thumbUrl) {
  const guess = pinGifGuess(thumbUrl);
  if (!guess) return Promise.resolve(null);
  if (_pinGifCache.has(guess)) return _pinGifCache.get(guess);
  const p = new Promise((resolve) => {
    _pinGifQueue.push(async () => {
      try {
        const r = await requestUrl({ url: guess, method: 'HEAD', throw: false });
        const h = (r && r.headers) || {};
        const ct = h['content-type'] || h['Content-Type'] || '';
        resolve(r && r.status === 200 && /image\/gif/i.test(String(ct)) ? guess : null);
      } catch (e) { resolve(null); }
    });
    _pinGifPump();
  });
  _pinGifCache.set(guess, p);
  return p;
}

// 這個 pin 是不是動態內容（旗標不可靠，只當「拿不到 gif 就別顯示」的判斷依據）
function pinIsAnimated(p) {
  if (!p) return false;
  if (p.is_video || p.videos || p.video_status || p.story_pin_data) return true;
  if (p.embed && /video|gif/i.test(String(p.embed.type || ''))) return true;
  return /video|story/i.test(String(p.type || ''));
}

// 穩健複製：優先 clipboard API，失敗退回 textarea+execCommand（手機 webview 常需要），並給提示
// okMsg：自訂成功提示（例如批次複製時顯示筆數，避免把整串多行內容塞進 Notice）
async function copyToClipboard(text, okMsg) {
  const shown = okMsg || (text.length > 40 ? text.slice(0, 40) + '…' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      new Notice(t('Copied: {{text}}', { text: shown }));
      return true;
    }
  } catch (e) { /* 落到 fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    new Notice(ok ? t('Copied: {{text}}', { text: shown }) : t('Copy failed'));
    return ok;
  } catch (e) {
    new Notice(t('Copy failed'));
    return false;
  }
}

// 手動組 multipart/form-data（requestUrl 不支援 FormData，得自己拼 bytes）
function buildMultipart(fields, fileField, fileName, fileBytes, mime) {
  const boundary = '----GNBoundary' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const enc = new TextEncoder();
  const chunks = [];
  for (const k of Object.keys(fields)) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  chunks.push(new Uint8Array(fileBytes));
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c instanceof Uint8Array ? c : new Uint8Array(c), off); off += c.byteLength; }
  return { boundary, body: out.buffer };
}

/* ===== 瀑布流版面引擎（shortest-column，同 Pinterest） ===== */

class MasonryLayout {
  constructor(container, opts) {
    opts = opts || {};
    this.container = container;
    this.gap = opts.gap || 10;
    this.minCol = opts.minCol || 150;
    this.fixedCols = opts.fixedCols || 0;   // >0 = 強制固定欄數（手機用）
    this.items = [];
    this._lastW = 0;
    this._raf = 0;
    container.style.position = 'relative';
    this.ro = new ResizeObserver(() => {
      if (this.container.clientWidth !== this._lastW) this.scheduleLayout();
    });
    this.ro.observe(container);
    // 任何圖片（含之後才插入的縮圖/連結圖/PDF 圖）載入完成 → 重排。
    // load 事件不會冒泡，但捕獲階段抓得到，一條就涵蓋所有後續插入的圖。
    container.addEventListener('load', () => this.scheduleLayout(), true);
  }
  add(el) {
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    this.items.push(el);
    // 圖片載入後高度會變 → 重排（rAF 合併多次）
    (el.querySelectorAll ? el.querySelectorAll('img') : []).forEach(
      (im) => im.addEventListener('load', () => this.scheduleLayout()));
    this.scheduleLayout();
  }
  clear() {
    this.items = [];
    this.container.empty();
    this.container.style.height = '0px';
    this._lastW = 0;
  }
  // 事後才發現不該顯示的項目（例如拿不到 gif 的動態 pin）→ 移除並重排
  remove(el) {
    const i = this.items.indexOf(el);
    if (i >= 0) this.items.splice(i, 1);
    el.remove();
    this.scheduleLayout();
  }
  setMinCol(w) { this.minCol = w; this.scheduleLayout(); }
  scheduleLayout() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.layout(); });
  }
  layout() {
    const W = this.container.clientWidth;
    if (!W || !this.items.length) { if (!this.items.length) this.container.style.height = '0px'; return; }
    this._lastW = W;
    const cols = this.fixedCols || Math.max(1, Math.floor((W + this.gap) / (this.minCol + this.gap)));
    const colW = (W - this.gap * (cols - 1)) / cols;
    for (const el of this.items) el.style.width = colW + 'px';          // 先統一設寬（一次 reflow）
    const heights = this.items.map((el) => el.offsetHeight);            // 再一次量測
    const colH = new Array(cols).fill(0);
    this.items.forEach((el, i) => {
      let c = 0;
      for (let k = 1; k < cols; k++) if (colH[k] < colH[c]) c = k;      // 找最矮的欄
      el.style.left = (c * (colW + this.gap)) + 'px';
      el.style.top = colH[c] + 'px';
      colH[c] += heights[i] + this.gap;
    });
    this.container.style.height = Math.max.apply(null, colH) + 'px';
  }
  destroy() {
    if (this.ro) this.ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

/* ===== Pinterest 以圖搜圖：結果視窗 ===== */

class PinterestModal extends Modal {
  constructor(app, srcUrl, title, srcFolder) {
    super(app);
    this.srcUrl = srcUrl;      // 圖片 resource path（app://…）
    this.title = title || '';
    this.srcFolder = srcFolder || '';   // 下載時在此資料夾建立 md
    this.isMobile = document.body.classList.contains('is-mobile');
  }

  // 開外部連結：桌機走 electron，手機退回 window.open
  openExternal(url) {
    if (!url) return;
    window.open(url, '_blank');   // Obsidian 攔截外部網址 → 系統瀏覽器（桌機手機皆可，免 electron）
  }
  pinUrl(p) {
    return p.id ? 'https://www.pinterest.com/pin/' + p.id + '/' : (p.link || p.tracked_link || '');
  }
  onOpen() {
    this.modalEl.addClass('gn-pin-modal');
    const { contentEl } = this;
    contentEl.createEl('h3', { cls: 'gn-pin-title', text: t('Pinterest visual search') });

    const bodyEl = contentEl.createDiv('gn-pin-body');

    // 左：原始查詢圖
    const left = bodyEl.createDiv('gn-pin-orig');
    const oimg = left.createEl('img', { cls: 'gn-pin-orig-img' });
    oimg.src = this.srcUrl;
    if (this.title) left.createDiv('gn-pin-orig-name').setText(this.title);

    // 中：可拖曳分隔桿
    const splitter = bodyEl.createDiv('gn-pin-splitter');

    // 右：搜尋結果（本身是捲動容器）
    const right = bodyEl.createDiv('gn-pin-right');
    this.rightEl = right;
    this.status = right.createDiv('gn-pin-status');
    this.chips = right.createDiv('gn-pin-chips');
    this.grid = right.createDiv('gn-pin-grid');
    this.moreWrap = right.createDiv('gn-pin-more');
    // 手機：強制 2 欄；桌機：依寬度自動
    this.masonry = new MasonryLayout(this.grid, { gap: 10, minCol: 150, fixedCols: this.isMobile ? 2 : 0 });

    // 手機：把原始查詢圖併進結果捲動區最上方 → 往下捲時會跟著捲走，不再卡在畫面上方
    if (this.isMobile) right.insertBefore(left, right.firstChild);

    // 拖曳分隔桿調整左欄寬度
    const onMove = (e) => {
      const rect = bodyEl.getBoundingClientRect();
      let w = e.clientX - rect.left;
      w = Math.max(140, Math.min(rect.width - 220, w));
      left.style.flex = '0 0 ' + w + 'px';
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    this.bookmark = '';
    this.pinBuf = null;
    this.search();
  }

  // 讀一次圖 bytes 並快取（分頁時重複用）
  // Pinterest 這支端點對上傳的圖很挑：檔案太大、或 gif/webp/avif/heic 等格式常直接回 400。
  // → 先用 canvas 重新編碼成「長邊 ≤ 1600 的標準 JPEG」再上傳；轉檔失敗才退回原始位元組。
  async ensureBuf() {
    if (this.pinBuf) return;
    const blob = await fetch(this.srcUrl).then((r) => r.blob());
    if (!blob || !blob.size) throw new Error(t('Could not read this image'));
    this.rawBuf = await blob.arrayBuffer();
    this.rawMime = blob.type || 'image/png';
    const jpeg = await this.toJpeg(blob);
    if (jpeg) { this.pinBuf = jpeg; this.pinMime = 'image/jpeg'; }
    else { this.pinBuf = this.rawBuf; this.pinMime = this.rawMime; }
  }

  // blob → 長邊 ≤ 1600 的 JPEG ArrayBuffer（失敗回 null）
  toJpeg(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        try {
          const MAX = 1600;
          const w0 = im.naturalWidth, h0 = im.naturalHeight;
          if (!w0 || !h0) { URL.revokeObjectURL(url); return resolve(null); }
          const s = Math.min(1, MAX / Math.max(w0, h0));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w0 * s));
          cv.height = Math.max(1, Math.round(h0 * s));
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';                       // gif/png 透明底 → 白底（JPEG 無透明）
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(im, 0, 0, cv.width, cv.height);   // gif 只會畫第一幀，正是我們要的
          cv.toBlob((b) => {
            URL.revokeObjectURL(url);
            if (!b) return resolve(null);
            b.arrayBuffer().then(resolve).catch(() => resolve(null));
          }, 'image/jpeg', 0.92);
        } catch (e) { URL.revokeObjectURL(url); resolve(null); }
      };
      im.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      im.src = url;
    });
  }

  // 打一頁（bookmark 空＝第一頁）；raw=true 時改用原始位元組（JPEG 版被退件時的退路）
  async fetchPage(bookmark, raw) {
    await this.ensureBuf();
    const buf = raw ? this.rawBuf : this.pinBuf;
    const mime = raw ? this.rawMime : this.pinMime;
    const { boundary, body } = buildMultipart(
      { x: '0', y: '0', w: '1', h: '1', page_size: '80' },
      'image', 'image.jpg', buf, mime);
    const url = PIN_ENDPOINT + (bookmark ? '?bookmark=' + encodeURIComponent(bookmark) : '');
    return requestUrl({
      url,
      method: 'PUT',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'User-Agent': PIN_UA },
      body,
      throw: false,
    });
  }

  // 把 Pinterest 的錯誤訊息挖出來（400 通常會附原因）
  errMsg(res) {
    const j = parseJsonLoose(res && res.text) || {};
    const m = j.message || j.error_message || (j.error && (j.error.message || j.error));
    if (m) return String(m).slice(0, 120);
    const t = (res && res.text ? String(res.text) : '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 120) : '';
  }

  async search() {
    this.status.setText(t('Searching…'));
    this.chips.empty();
    this.masonry.clear();
    this.moreWrap.empty();
    this.bookmark = '';
    this.useRaw = false;
    try {
      let res = await this.fetchPage('');
      // JPEG 版被退件（多半是 400）→ 用原始位元組再試一次
      if (res.status !== 200 && this.rawBuf && this.pinMime !== this.rawMime) {
        const res2 = await this.fetchPage('', true);
        if (res2.status === 200) { res = res2; this.useRaw = true; }
      }
      if (res.status !== 200) {
        const why = this.errMsg(res);
        this.status.setText(t('Pinterest responded with status {{status}} (private API — image too large / unsupported format / rate limited)', { status: res.status }) + (why ? ' · ' + why : ''));
        return;
      }
      const j = parseJsonLoose(res.text) || {};
      const pins = j.data || [];
      if (!pins.length) { this.status.setText(t('No similar images found')); return; }
      this.bookmark = j.bookmark || '';
      this.renderChips(j.annotations || []);
      this.statusBase = t('Similar results · broader as you scroll · hover to preview/download');
      this.status.setText(this.statusBase);
      this.renderPins(pins, false);
      this.setupInfiniteScroll();
    } catch (e) {
      this.status.setText(t('Search failed: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  // 無限捲動：底部放一個哨兵，快進視野就自動抓下一頁
  setupInfiniteScroll() {
    this.moreWrap.empty();
    this.loadingEl = this.moreWrap.createDiv('gn-pin-loading');
    this.sentinel = this.moreWrap.createDiv('gn-pin-sentinel');
    if (this.io) this.io.disconnect();
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.autoLoad();
    }, { root: this.rightEl, rootMargin: '400px 0px' });
    this.io.observe(this.sentinel);
  }

  async autoLoad() {
    if (this.loading || !this.bookmark) return;
    this.loading = true;
    this.loadingEl.setText(t('Loading…'));
    try {
      const res = await this.fetchPage(this.bookmark, this.useRaw);   // 沿用第一頁成功的那種上傳格式
      const j = parseJsonLoose(res.text) || {};
      this.bookmark = j.bookmark || '';
      this.renderPins(j.data || [], true);
    } catch (e) {
      // 失敗就下次捲動再試
    }
    this.loading = false;
    if (!this.bookmark) {
      this.loadingEl.setText(t('— no more results —'));
      if (this.io) this.io.disconnect();
      return;
    }
    this.loadingEl.setText('');
    // 若哨兵仍在可視範圍（結果還沒填滿），繼續補
    requestAnimationFrame(() => {
      if (!this.bookmark || this.loading || !this.sentinel || !this.rightEl) return;
      const r = this.sentinel.getBoundingClientRect();
      const cr = this.rightEl.getBoundingClientRect();
      if (r.top < cr.bottom + 400) this.autoLoad();
    });
  }

  // 主題關鍵字 chip → 開 Pinterest 關鍵字搜尋（比視覺相似更廣）
  renderChips(annotations) {
    this.chips.empty();
    for (const a of annotations || []) {
      const term = typeof a === 'string' ? a : (a && (a.name || a.term || a.query));
      if (!term) continue;
      const chip = this.chips.createEl('button', { cls: 'gn-pin-chip', text: '# ' + term });
      chip.setAttr('title', t('Search "{{term}}" on Pinterest (broader)', { term }));
      chip.onclick = () => this.openExternal(
        'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(term));
    }
  }

  renderPins(pins, append) {
    if (!append) { this.masonry.clear(); this.skipped = 0; }
    for (const p of pins || []) {
      const thumb = p.image_medium_url || p.image_large_url || p.image_square_url;
      if (!thumb) continue;
      const big = p.image_large_url || thumb;
      const cell = this.grid.createDiv('gn-pin-cell');
      const im = cell.createEl('img');
      // 用已知尺寸先占好高度（免等圖載入就能正確排版）
      const dim = p.image_medium_size_pixels || p.image_large_size_pixels;
      if (dim && dim.width && dim.height) im.style.aspectRatio = dim.width + ' / ' + dim.height;
      im.src = thumb;
      im.loading = 'lazy';
      if (p.title) im.setAttr('title', p.title);

      // 背景探測原檔 gif：是動圖 → 換成會動的原檔 + GIF 角標；
      // 是動態 pin 卻拿不到 gif（只有影片）→ 依設定不顯示，直接把格子移除。
      probePinGif(big).then((gif) => {
        if (!cell.isConnected) return;
        if (gif) {
          p._gifUrl = gif;                       // 下載時抓原始 gif
          im.removeAttribute('loading');
          im.src = gif;
          cell.createDiv('gn-pin-gif-badge').setText('GIF');
          return;
        }
        if (pinIsAnimated(p)) {
          this.skipped = (this.skipped || 0) + 1;
          this.masonry.remove(cell);
          if (this.status && this.statusBase) {
            this.status.setText(this.statusBase + ' · ' + t('skipped {{n}} animated pins without a gif', { n: this.skipped }));
          }
        }
      });
      // 桌機：點格子＝開 Pinterest；手機：點格子＝顯示/收起按鈕
      cell.onclick = () => {
        if (this.isMobile) { cell.classList.toggle('gn-pin-cell-active'); return; }
        this.openExternal(this.pinUrl(p));
      };

      // 動作按鈕：在 Pinterest / 下載（桌機 hover、手機點格顯示）
      const actions = cell.createDiv('gn-pin-actions');
      const openBtn = actions.createEl('button', { cls: 'gn-pin-act' });
      setIcon(openBtn, 'external-link');
      openBtn.setAttr('title', t('Open on Pinterest'));
      openBtn.onclick = (e) => { e.stopPropagation(); this.openExternal(this.pinUrl(p)); };
      const dl = actions.createEl('button', { cls: 'gn-pin-act' });
      setIcon(dl, 'download');
      dl.setAttr('title', t('Download and create note'));
      dl.onclick = (e) => { e.stopPropagation(); this.downloadPin(p); };

      this.masonry.add(cell);
    }
  }

  // 預覽：燈箱放大
  openPreview(url) {
    const ov = this.modalEl.createDiv('gn-pin-lightbox');
    const im = ov.createEl('img');
    im.src = url;
    ov.onclick = () => ov.remove();
  }

  // 下載大圖到 img/，並在來源資料夾建立一則嵌入該圖的 md
  async downloadPin(pin) {
    // gif pin → 抓原始 .gif（探測到的原檔），不要存成靜態縮圖
    const url = pin._gifUrl || pin.image_large_url || pin.image_medium_url || pin.image_square_url;
    if (!url) { new Notice(t('No downloadable image URL')); return; }
    try {
      new Notice(t('Downloading…'));
      const res = await requestUrl({ url, method: 'GET' });
      const extM = url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i);
      const ext = extM ? extM[1].toLowerCase() : 'jpg';
      if (!this.app.vault.getAbstractFileByPath('img')) {
        try { await this.app.vault.createFolder('img'); } catch (e) {}
      }
      // 1) 存圖到 img/
      const base = 'pinterest_' + (pin.id || Date.now());
      let imgPath = 'img/' + base + '.' + ext;
      let n = 1;
      while (this.app.vault.getAbstractFileByPath(imgPath)) { imgPath = 'img/' + base + '_' + n + '.' + ext; n++; }
      await this.app.vault.createBinary(imgPath, res.arrayBuffer);

      // 2) 在來源資料夾建立 md（內嵌該圖）
      const pinUrl = this.pinUrl(pin);
      const dir = this.srcFolder && this.app.vault.getAbstractFileByPath(this.srcFolder) ? this.srcFolder + '/' : '';
      let title = String(pin.title || pin.grid_title || base)
        .replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || base;
      let mdPath = dir + title + '.md';
      let m = 1;
      while (this.app.vault.getAbstractFileByPath(mdPath)) { mdPath = dir + title + ' ' + m + '.md'; m++; }
      const fm = ['---', 'cover: ' + imgPath, pinUrl ? 'source: ' + pinUrl : '', '---']
        .filter(Boolean).join('\n');
      const body = '![[' + imgPath + ']]' + (pinUrl ? '\n' + pinUrl : '') + '\n';
      await this.app.vault.create(mdPath, fm + '\n' + body);
      new Notice(t('Created note: {{path}}', { path: mdPath }));
    } catch (e) {
      new Notice(t('Download failed: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  onClose() {
    if (this.io) { this.io.disconnect(); this.io = null; }
    if (this.masonry) { this.masonry.destroy(); this.masonry = null; }
    this.contentEl.empty();
  }
}

/* ===== 常數 / 資料邏輯 ===== */

const VIEW_TYPE = 'gallery-navigator';
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const INVISIBLE = /[​‌‍⁠﻿￼]/g;

/* ===== 資料邏輯(移植自 Collections code.md) ===== */

function tagsOf(cache) {
  const set = new Set();
  const fm = cache && cache.frontmatter;
  if (fm && fm.tags) {
    (Array.isArray(fm.tags) ? fm.tags : [fm.tags])
      .forEach((x) => set.add('#' + String(x).replace(/^#/, '')));
  }
  ((cache && cache.tags) || []).forEach((o) => set.add(o.tag));
  return [...set];
}

// 從筆記取「代表連結」：優先 frontmatter.source，否則內文第一個 http(s) 網址
function firstExternalUrl(frontmatter, content) {
  const fromFm = frontmatter && frontmatter.source;
  if (fromFm && /^https?:\/\//i.test(String(fromFm).trim())) return String(fromFm).trim();
  const m = String(content || '').match(/https?:\/\/[^\s)\]"'<>]+/i);
  return m ? m[0] : null;
}

// 從網頁 HTML 解析預覽圖：og:image → twitter:image → 第一張 <img>。回傳絕對網址或 null
function ogImageFrom(html, pageUrl) {
  if (!html) return null;
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  let src =
    pick(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i) ||
    pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i) ||
    pick(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (!src) return null;
  src = src.replace(/&amp;/g, '&').trim();
  try { return new URL(src, pageUrl).href; } catch (e) { return src; }
}

// 由字串產生短雜湊（給連結預覽快取檔命名，穩定且無特殊字元）
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 解析封面：frontmatter.cover → 後備:內文第一張嵌入圖。支援 ![[...]]、外部網址、去隱形字元。
function coverSrc(app, cache, path) {
  let raw = cache && cache.frontmatter ? cache.frontmatter.cover : null;
  if (raw == null) {
    const emb = ((cache && cache.embeds) || [])
      .find((e) => IMG_EXT.test(String(e.link).split('|')[0].split('#')[0]));
    raw = emb ? emb.link : null;
    if (raw == null) return null;
  }
  let s = String(raw).replace(INVISIBLE, '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  const m = s.match(/!?\[\[([^\]]+)\]\]/);
  if (m) s = m[1];
  s = s.split('|')[0].split('#')[0].trim();
  if (!s) return null;
  const f = app.metadataCache.getFirstLinkpathDest(s, path);
  return f ? app.vault.getResourcePath(f) : null;
}

function itemFromFile(app, f) {
  const isImg = IMG_EXT.test(f.path);
  return {
    file: f,
    name: f.basename,
    ext: (f.extension || '').toLowerCase(),
    isImg,
    ctime: f.stat.ctime,
    mtime: f.stat.mtime,
    // 圖片檔本身即封面（免讀 cache）；md 才讀 frontmatter/內文封面；其他檔型無封面
    src: isImg ? app.vault.getResourcePath(f) : coverSrc(app, app.metadataCache.getFileCache(f), f.path),
  };
}

// 非圖片、無封面的檔型 → 對應的 lucide 圖示
// 自訂資料夾圖示：闔起＝實心填滿（明顯關閉）、展開＝線框開啟（明顯打開），差異大、不依賴 lucide
const FOLDER_CLOSED_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

// SVG 常數 → DOM（不用 innerHTML：上架審查會標記，且 DOMParser 同樣快）
function setSvg(el, svg) {
  el.textContent = '';
  try {
    // ⚠️ 一定要用 text/html 模式：SVG 常數沒寫 xmlns，XML 模式解析出來的 <svg>
    //   是「無命名空間元素」，掛上去不會渲染（2026-07-18 圖示消失事故）。
    //   HTML 解析器會把 <svg> 當外來內容、自動給正確命名空間——跟 innerHTML 行為一致。
    const node = new DOMParser().parseFromString(svg, 'text/html').body.firstElementChild;
    if (node && node.tagName && node.tagName.toLowerCase() === 'svg') {
      el.appendChild(document.importNode(node, true));
    }
  } catch (e) {}
}

function setFolderIcon(el, open) {
  setSvg(el, open ? FOLDER_OPEN_SVG : FOLDER_CLOSED_SVG);
}

function iconForExt(ext) {
  if (ext === 'canvas') return 'layout-dashboard';
  if (ext === 'pdf') return 'file-text';
  if (ext === 'base') return 'database';
  if (/^(mp4|mov|webm|mkv|avi|m4v)$/.test(ext)) return 'file-video';
  if (/^(mp3|wav|m4a|flac|ogg|aac)$/.test(ext)) return 'file-audio';
  if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return 'file-archive';
  return 'file';
}

// 排序選項：value → { label, fn }
const SORTS = {
  new: { label: 'Newest first', fn: (a, b) => b.ctime - a.ctime },
  old: { label: 'Oldest first', fn: (a, b) => a.ctime - b.ctime },
  mod: { label: 'Recently modified', fn: (a, b) => b.mtime - a.mtime },
  az: { label: 'Name A→Z', fn: (a, b) => a.name.localeCompare(b.name, 'zh-Hant') },
  za: { label: 'Name Z→A', fn: (a, b) => b.name.localeCompare(a.name, 'zh-Hant') },
};
function sortItems(items, key) {
  const s = SORTS[key] || SORTS.new;
  return items.slice().sort(s.fn);
}

// 製作日期小字：YYYY-MM-DD
function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 資料夾卡片配色（扁平色塊風格）。emoji 當選單裡的顏色提示
const PALETTE = [
  { key: 'red', label: 'Coral', bg: '#ef5130', fg: '#1a1a1a' },
  { key: 'orange', label: 'Orange', bg: '#f2913d', fg: '#1a1a1a' },
  { key: 'yellow', label: 'Yellow', bg: '#e9cf5a', fg: '#1a1a1a' },
  { key: 'green', label: 'Green', bg: '#7fbf94', fg: '#12321f' },
  { key: 'teal', label: 'Teal', bg: '#63c0c9', fg: '#0f343a' },
  { key: 'blue', label: 'Blue', bg: '#3a5fc4', fg: '#f5f5f5' },
  { key: 'pink', label: 'Pink', bg: '#e0518f', fg: '#1a1a1a' },
  { key: 'sand', label: 'Sand', bg: '#e6d9b0', fg: '#2a2a2a' },
  { key: 'grey', label: 'Grey', bg: '#b8b3a8', fg: '#1a1a1a' },
  { key: 'black', label: 'Black', bg: '#1c1c1c', fg: '#f0f0f0' },
];
const PALETTE_BY_KEY = Object.fromEntries(PALETTE.map((p) => [p.key, p]));

// 卡片底色票（先 8 色，之後可自行改 bg/fg 色號；fg = 對比字色）
const CARD_PALETTE = [
  { key: 'c-red',    label: 'Red', bg: '#fbe0da', fg: '#5a1c0f' },
  { key: 'c-orange', label: 'Orange', bg: '#fbe6cd', fg: '#5a3410' },
  { key: 'c-yellow', label: 'Yellow', bg: '#f8f1cc', fg: '#4f4610' },
  { key: 'c-green',  label: 'Green', bg: '#dbeede', fg: '#153a22' },
  { key: 'c-teal',   label: 'Teal', bg: '#d2ecef', fg: '#0d3a40' },
  { key: 'c-blue',   label: 'Blue', bg: '#dbe3f6', fg: '#152a5a' },
  { key: 'c-pink',   label: 'Pink', bg: '#f8dbe9', fg: '#5a1636' },
  { key: 'c-grey',   label: 'Grey', bg: '#e5e3de', fg: '#2a2a2a' },
];
const CARD_PALETTE_BY_KEY = Object.fromEntries(CARD_PALETTE.map((p) => [p.key, p]));
// 自動配色用的彩色子集（排除米/灰/黑，讓預設更繽紛）
const AUTO_KEYS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'pink'];
function paletteFor(item, colors) {
  const chosen = colors && colors[item.folder.path];
  if (chosen && PALETTE_BY_KEY[chosen]) return PALETTE_BY_KEY[chosen];
  let h = 0;                                       // 用名稱雜湊出穩定的預設色
  for (let i = 0; i < item.name.length; i++) h = (h * 31 + item.name.charCodeAt(i)) >>> 0;
  return PALETTE_BY_KEY[AUTO_KEYS[h % AUTO_KEYS.length]];
}

// 從原始 md 抽出乾淨的預覽文字（去 frontmatter / 圖片 / 連結語法），最多 maxLines 行
function extractPreview(raw, maxLines) {
  let text = raw;
  if (text.startsWith('---')) {                       // 去 YAML frontmatter
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const nl = text.indexOf('\n', end + 1);
      text = nl !== -1 ? text.slice(nl + 1) : '';
    }
  }
  const out = [];
  let inCode = false;
  for (const line of text.split('\n')) {
    if (out.length >= maxLines) break;
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) { out.push(t); continue; }
    if (/^!\[\[.*\]\]$/.test(t)) continue;            // 內嵌圖片
    if (/^!\[.*\]\(.*\)$/.test(t)) continue;          // 外部圖片
    if (/^https?:\/\/\S+$/.test(t)) continue;          // 純網址行
    const s = t
      .replace(/^#{1,6}\s+/, '')                       // 標題符號
      .replace(/^>\s?/, '')                            // 引用
      .replace(/^[-*+]\s+/, '• ')                      // 清單
      .replace(/^\d+\.\s+/, '')                        // 數字清單
      .replace(/!\[\[[^\]]+\]\]/g, '')                 // 行內嵌圖
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')   // wiki 別名
      .replace(/\[\[([^\]]+)\]\]/g, '$1')              // wiki 連結
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')         // md 連結
      .replace(/[*_`~]/g, '')                          // 強調符號
      .trim();
    if (s) out.push(s);
  }
  return out.join('\n');
}


function subFolders(folder) {
  return folder.children
    .filter((c) => c instanceof TFolder)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function notesIn(app, folder) {
  return folder.children
    .filter((c) => c instanceof TFile)
    .map((f) => itemFromFile(app, f));
}

// 遞迴收集資料夾底下所有子孫檔案（攤平模式用）；跳過隱藏的子資料夾
function notesInDeep(app, folder, hiddenSet) {
  const out = [];
  const hidden = hiddenSet || new Set();
  const walk = (fo) => {
    for (const ch of fo.children) {
      if (ch instanceof TFolder) { if (!hidden.has(ch.path)) walk(ch); }
      else if (ch instanceof TFile) out.push(itemFromFile(app, ch));
    }
  };
  walk(folder);
  return out;
}

// 只算資料夾底下的檔案總數（樹狀清單用；不排序、不讀 metadata，比 folderStats 輕很多）
function folderFileCount(folder) {
  let n = 0;
  const walk = (fo) => {
    for (const ch of fo.children) {
      if (ch instanceof TFolder) walk(ch);
      else n++;
    }
  };
  walk(folder);
  return n;
}


// 依使用者自訂順序排列資料夾；未排過的(新資料夾)按名稱排在最後
function orderFolders(items, savedOrder) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hant');
  if (!Array.isArray(savedOrder) || !savedOrder.length) return items.slice().sort(byName);
  const idx = new Map(savedOrder.map((p, i) => [p, i]));
  return items.slice().sort((a, b) => {
    const ia = idx.has(a.folder.path) ? idx.get(a.folder.path) : Infinity;
    const ib = idx.has(b.folder.path) ? idx.get(b.folder.path) : Infinity;
    return ia !== ib ? ia - ib : byName(a, b);
  });
}

/* ===== 資料夾選擇器（移動目的地） ===== */

class FolderSuggest extends FuzzySuggestModal {
  constructor(app, onChoose, excludePath) {
    super(app);
    this.onChoose = onChoose;
    this.excludePath = excludePath;          // 移動資料夾時，排除自己與子孫，避免移進自己
    this.setPlaceholder(t('Move to which folder…'));
  }
  getItems() {
    const root = this.app.vault.getRoot();
    const folders = [root];
    const walk = (f) => {
      for (const c of f.children) if (c instanceof TFolder) { folders.push(c); walk(c); }
    };
    walk(root);
    if (!this.excludePath) return folders;
    return folders.filter((f) => f.path !== this.excludePath && !f.path.startsWith(this.excludePath + '/'));
  }
  getItemText(f) { return f.path === '/' ? '/ (' + t('vault root') + ')' : f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

/* ===== 確認刪除對話框 ===== */

class ConfirmModal extends Modal {
  // extra（可選）：{ label, items: string[], checked } → 顯示勾選框＋檔案清單，
  // onConfirm 會收到勾選狀態（既有呼叫端不接參數，不受影響）
  constructor(app, message, onConfirm, extra) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.extra = extra || null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });
    let chk = null;
    if (this.extra && this.extra.items && this.extra.items.length) {
      const box = contentEl.createDiv('gn-confirm-extra');
      const lab = box.createEl('label', { cls: 'gn-confirm-extra-label' });
      chk = lab.createEl('input', { type: 'checkbox' });
      chk.checked = this.extra.checked !== false;
      lab.createSpan({ text: ' ' + this.extra.label });
      const list = box.createDiv('gn-confirm-extra-list');
      for (const p of this.extra.items) list.createDiv({ cls: 'gn-confirm-extra-item', text: p });
    }
    const btns = contentEl.createDiv('gn-modal-btns');
    const cancel = btns.createEl('button', { text: t('Cancel') });
    cancel.onclick = () => this.close();
    const ok = btns.createEl('button', { text: t('Delete') });
    ok.addClass('mod-warning');
    ok.onclick = () => { const withExtra = !!(chk && chk.checked); this.close(); this.onConfirm(withExtra); };
  }
  onClose() { this.contentEl.empty(); }
}

/* ===== 文字輸入對話框 ===== */

class InputModal extends Modal {
  constructor(app, title, initial, onSubmit, okLabel) {
    super(app);
    this.titleText = title;
    this.initial = initial || '';
    this.onSubmit = onSubmit;
    this.okLabel = okLabel || t('Create');
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.titleText });
    const input = contentEl.createEl('input', { type: 'text', cls: 'gn-input' });
    input.value = this.initial;
    const btns = contentEl.createDiv('gn-modal-btns');
    const cancel = btns.createEl('button', { text: t('Cancel') });
    cancel.onclick = () => this.close();
    const ok = btns.createEl('button', { text: this.okLabel });
    ok.addClass('mod-cta');
    const submit = () => { const v = input.value.trim(); if (v) { this.close(); this.onSubmit(v); } };
    ok.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

/* ===== 檔案選擇器（選待辦筆記） ===== */

class FileSuggest extends FuzzySuggestModal {
  constructor(app, onChoose, placeholder) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder || t('Pick a to-do note…'));
  }
  getItems() { return this.app.vault.getMarkdownFiles(); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

// 從 md 原文解析待辦：回傳 [{ line, done, text, depth }]，支援 - [ ] / - [x]（含 * +）
// depth 用堆疊依縮排推算，相容 2/4 空格或 tab
function parseTasks(raw) {
  const rows = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      const indent = m[1].replace(/\t/g, '    ').length;
      rows.push({ line: i, indent, done: m[2].toLowerCase() === 'x', text: m[3].trim() });
    }
  }
  const stack = [];
  for (const r of rows) {
    while (stack.length && stack[stack.length - 1] >= r.indent) stack.pop();
    r.depth = stack.length;
    stack.push(r.indent);
  }
  return rows;
}

/* ===== View ===== */

class GalleryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.path = plugin.state.lastPath || '';
    this.showHidden = false;
    this.drag = null;         // { kind: 'note'|'folder', path }
    this.selected = new Set();   // 多選：檔案路徑
    this.selAnchor = null;       // 範圍選的錨點
    this._tagDirty = true;       // 標籤索引快取失效旗標
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Gallery Navigator'; }
  getIcon() { return 'egg'; }   // 🥚（2026-07-18 使用者欽點）

  async onOpen() {
    this.render();
    // 開啟任一筆記時，若同步開著 → 定位到它的資料夾（從日曆開的會設跳過旗標）
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (this.plugin._skipNextSync) { this.plugin._skipNextSync = false; return; }
      if (!this.plugin.state.syncActive) return;
      if (this.isCanvasEmbed(file)) return;   // 在 Canvas 裡點圖片/內嵌節點 → 不要跳去 img/
      this.syncToFile(file);
    }));
    // 標籤索引快取失效：metadata 變動或檔案增刪改名時標記，下次用到才重建
    const markTagDirty = () => { this._tagDirty = true; };
    this.registerEvent(this.app.metadataCache.on('changed', markTagDirty));
    this.registerEvent(this.app.vault.on('create', markTagDirty));
    this.registerEvent(this.app.vault.on('delete', markTagDirty));
    this.registerEvent(this.app.vault.on('rename', markTagDirty));
    // 滑鼠在本視圖上時追蹤（給 Cmd+A 全選判斷用）
    this._hover = false;
    this.registerDomEvent(this.contentEl, 'mouseenter', () => { this._hover = true; });
    this.registerDomEvent(this.contentEl, 'mouseleave', () => { this._hover = false; });
    // Cmd/Ctrl+A 全選右側卡片；Esc 清除選取
    this.registerDomEvent(document, 'keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/^(input|textarea)$/i.test(tag)) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        if (this._hover && !this.graphFocus && this._cardOrder && this._cardOrder.length) {
          e.preventDefault();
          this.selectAll();
        }
      } else if (e.key === 'Escape' && this.selected && this.selected.size) {
        this.clearSel();
      }
    });
  }

  async onClose() {
    // 清理 observer，避免關閉分頁後殘留
    for (const m of (this._masonries || [])) { try { m.destroy(); } catch (e) {} }
    this._masonries = [];
    if (this._ogObserver) { this._ogObserver.disconnect(); this._ogObserver = null; }
    if (this._wallIO) { this._wallIO.disconnect(); this._wallIO = null; }
    if (this._paneRO) { this._paneRO.disconnect(); this._paneRO = null; }
    if (this._syncRaf) { cancelAnimationFrame(this._syncRaf); this._syncRaf = 0; }
    if (this._todoPop) { this._todoPop.remove(); this._todoPop = null; }
    this.closeMorePopover();   // 掛在 body 上的浮動面板要一起收掉
  }

  // 重排目前這面牆的所有分區。延遲載入（內文預覽 / og:image / PDF 縮圖）會改變卡片高度，
  // 連結牆有兩個 grid，只重排其中一個會漏掉另一區 → 破版。
  // 重排所有瀑布流。（手機兩欄改用 transform 平移後，重排不會影響「顯示哪一欄」，這裡不必再顧捲動）
  relayoutWalls() {
    for (const m of (this._masonries || [])) m.scheduleLayout();
  }

  // 把左側樹定位到某檔案：展開祖先、選取資料夾、捲到位、標記 active 卡片
  // 這次 file-open 是不是「Canvas 裡的內嵌節點」造成的？
  // Canvas 的圖片/筆記節點各自是內嵌 leaf，點下去 Obsidian 會替那個檔案送 file-open，
  // 同步定位就會跳到 img/。真正在看的還是那張 Canvas → 這種事件一律略過。
  isCanvasEmbed(file) {
    const ws = this.app.workspace;
    const leaf = ws.activeLeaf;
    const view = leaf && leaf.view;
    const type = view && typeof view.getViewType === 'function' ? view.getViewType() : '';
    // 目前這個分頁本身就是 Canvas，而開的檔又不是這張 Canvas → 是節點內嵌造成的
    if (type === 'canvas') {
      const cf = view.file;
      if (!file || !cf || file.path !== cf.path) return true;
      return false;
    }
    // 保險：active leaf 已被切成內嵌 leaf 時，用 DOM 判斷它是否住在 canvas 節點裡
    const el = leaf && leaf.containerEl;
    if (el && typeof el.closest === 'function' && el.closest('.canvas-node')) return true;
    return false;
  }

  syncToFile(file) {
    if (this.drag) return;                        // 拖曳進行中 → 不重繪，避免中斷拖曳
    if (this.plugin.state.leftMode === 'tag') return;   // 標籤模式不做資料夾定位
    if (!(file instanceof TFile)) return;
    const curFolder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    if (curFolder === this.path && this.activePath === file.path && !this.graphFocus) return;  // 無變化不重繪
    // 同資料夾內換檔（且不在關聯圖）→ 只更新 active 卡片，不整頁重畫（避免 PDF 縮圖等重載）
    if (curFolder === this.path && !this.graphFocus) { this.setActiveCard(file.path); return; }
    this.graphFocus = null;                       // 開筆記時離開關聯圖
    const parent = file.parent;
    const folderPath = parent && parent.path !== '/' ? parent.path : '';
    const expanded = new Set(this.plugin.state.expandedFolders || []);
    let acc = '';
    for (const seg of (folderPath ? folderPath.split('/') : [])) {
      acc = acc ? acc + '/' + seg : seg;
      expanded.add(acc);
    }
    this.plugin.state.expandedFolders = [...expanded];
    this.activePath = file.path;
    this.path = folderPath;
    this.plugin.state.lastPath = folderPath;
    this.plugin.saveState();
    // 延後整頁重畫到下一個 frame：讓筆記先開起來，不被畫廊重畫卡在同一條執行緒
    if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
    this._syncRaf = requestAnimationFrame(() => {
      this._syncRaf = 0;
      this.render();
      const sel = this.contentEl.querySelector('.gn-tsel');
      // 排在「還原捲動位置」之後一幀執行，否則捲動位置會被還原值覆蓋回去
      if (sel) requestAnimationFrame(() => {
        sel.scrollIntoView({ block: 'nearest' });
        this.saveTreeScroll();   // 同步定位造成的捲動也要記下來
      });
    });
  }

  // 一則筆記可能同時出現在連結牆的兩區（互相引用），所以一個 path 對到「多張」卡片
  cardElsFor(path) {
    const v = this._cardEls && this._cardEls.get(path);
    return v || [];
  }

  // 只更新「目前開啟」的卡片外框，不重畫整牆
  setActiveCard(path) {
    const prev = this.activePath;
    this.activePath = path;
    if (!this._cardEls) return;
    if (prev && prev !== path) { for (const e of this.cardElsFor(prev)) e.removeClass('gn-card-active'); }
    this.cardElsFor(path).forEach((el, i) => {
      el.addClass('gn-card-active');
      if (i === 0) el.scrollIntoView({ block: 'nearest' });
    });
  }

  folderAt(path) {
    if (!path) return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : this.app.vault.getRoot();
  }

  // 切到某個資料夾（根目錄列、最愛捷徑、麵包屑、右鍵「跳到資料夾」都走這裡）
  navigate(path) {
    this.path = path;
    this.plugin.state.lastPath = path;
    this._tagFilter = new Set();   // 換資料夾 → 清掉上一夾的標籤篩選
    this.plugin.saveState();
    this.render();
    this.gotoCardsMobile();        // 手機：選完資料夾就滑到右邊的卡片欄
  }

  openNote(file, newTab) {
    this.app.workspace.openLinkText(file.path, '', !!newTab);
  }

  // 這則筆記「連結出去」的 md 筆記（已建立的）
  outgoingMdFiles(file) {
    const res = this.app.metadataCache.resolvedLinks[file.path] || {};
    const out = [];
    for (const p of Object.keys(res)) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile && f.extension === 'md') out.push(f);
    }
    return out;
  }

  // 「連結進來」的 md 筆記（backlinks：誰引用了這則）
  incomingMdFiles(file) {
    const all = this.app.metadataCache.resolvedLinks;
    const out = [];
    for (const src of Object.keys(all)) {
      if (src !== file.path && all[src][file.path]) {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (f instanceof TFile && f.extension === 'md') out.push(f);
      }
    }
    return out;
  }

  // 在右欄開啟自製關聯圖（canvas / 心智圖風）
  showLinks(file) {
    this.graphFocus = file.path;
    this.render();
    this.gotoCardsMobile();   // 手機：關聯圖畫在右欄，維持停在右欄
  }

  // 在資料夾內新建檔案（自動避開同名），建立後開啟。ext: md / canvas / base
  async newFile(folder, ext, content) {
    const dir = !folder || folder.path === '/' ? '' : folder.path + '/';
    let path = dir + t('Untitled') + '.' + ext;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) { path = dir + t('Untitled') + ' ' + n + '.' + ext; n++; }
    try {
      const file = await this.app.vault.create(path, content || '');
      this.render();
      this.openNote(file, false);
    } catch (e) {
      new Notice(t('Failed to create: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  // 桌機右鍵 + 手機長按 → 同一個選單。build() 需回傳未 show 的 Menu
  wireContextMenu(el, build) {
    const open = (x, y) => { const m = build(); if (m) m.showAtPosition({ x, y }); };
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e.clientX, e.clientY); });
    // 手機長按（自製計時器；移動超過門檻或放開即取消）
    let timer = null, sx = 0, sy = 0;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
      timer = setTimeout(() => {
        timer = null;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (er) {} }
        open(sx, sy);
        // 攔掉這次長按後緊接的 click，避免同時觸發開啟/導覽
        const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); el.removeEventListener('click', kill, true); };
        el.addEventListener('click', kill, true);
        setTimeout(() => el.removeEventListener('click', kill, true), 700);
      }, 500);
    }, { passive: true });
    const cancel = (e) => {
      if (!timer) return;
      if (e && e.touches && e.touches[0]) {
        const t = e.touches[0];
        if (Math.abs(t.clientX - sx) < 10 && Math.abs(t.clientY - sy) < 10) return;   // 幾乎沒移動 → 不取消
      }
      clearTimeout(timer); timer = null;
    };
    el.addEventListener('touchmove', cancel, { passive: true });
    el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
    el.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  }

  // 新建檔案選單（資料夾 / md / Canvas / Base）
  // 目前資料夾（含攤平時的子孫）裡出現過的標籤 → [{ tag, n }]，依筆數多到少排序
  // 只取「筆記自己寫的標籤」（不展開祖先層級），膠囊才不會爆量
  folderTags() {
    if (this.plugin.state.leftMode === 'tag') return [];   // 標籤模式本身就在看標籤，不重複
    const folder = this.folderAt(this.path);
    if (!folder) return [];
    const flatten = !!this.plugin.state.flattenFolders;
    const items = flatten
      ? notesInDeep(this.app, folder, new Set(this.plugin.state.hiddenFolders || []))
      : notesIn(this.app, folder);
    const count = new Map();
    for (const it of items) {
      if (it.ext !== 'md') continue;
      for (const t of tagsOf(this.app.metadataCache.getFileCache(it.file))) {
        const clean = String(t).replace(/^#/, '');
        count.set(clean, (count.get(clean) || 0) + 1);
      }
    }
    return [...count.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  }

  // 這則筆記有沒有命中目前的標籤篩選（多選＝OR：任一個中就算）
  matchTagFilter(file) {
    if (!this._tagFilter || !this._tagFilter.size) return true;
    const tags = tagsOf(this.app.metadataCache.getFileCache(file))
      .map((t) => String(t).replace(/^#/, ''));
    for (const want of this._tagFilter) {
      // 命中本身或其子標籤（選 #design 也會撈到 #design/font）
      if (tags.some((t) => t === want || t.startsWith(want + '/'))) return true;
    }
    return false;
  }

  // 工具列的「⋯ 更多」面板：排序 / 卡片大小（真滑桿）/ 攤平 / 重新整理
  // 用自訂浮動面板而不是 Obsidian 的 Menu —— Menu 只吃「選項列」，塞不進滑桿，
  // 而且會被迫再開一層子選單。這裡全部攤平成單層。
  openMorePopover(anchor) {
    if (this._morePop) { this._morePop.remove(); this._morePop = null; return; }   // 再點一次＝收起
    const state = this.plugin.state;
    const pop = document.body.createDiv('gn-more-pop');
    this._morePop = pop;

    // 定位：貼著按鈕、靠右對齊；按鈕在下半部就往上彈
    const rect = anchor.getBoundingClientRect();
    pop.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    if (rect.top > window.innerHeight * 0.5) pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    else pop.style.top = (rect.bottom + 6) + 'px';

    /* ── 排序（清單列，打勾標示目前值） ── */
    pop.createDiv('gn-more-label').setText(t('Sort'));
    const cur = state.sort || 'new';
    Object.keys(SORTS).forEach((key) => {
      const row = pop.createDiv('gn-more-row');
      row.toggleClass('gn-more-row-on', key === cur);
      row.createSpan('gn-more-text').setText(t(SORTS[key].label));
      const mark = row.createSpan('gn-more-check');
      if (key === cur) setIcon(mark, 'check');
      row.onclick = () => {
        state.sort = key;
        this.plugin.saveState();
        this.closeMorePopover();
        this.render();
      };
    });

    /* ── 本夾標籤：膠囊，點了就篩選這個資料夾的卡片（可複選；再點取消） ── */
    const tags = this.folderTags();
    if (tags.length) {
      const tagLabel = pop.createDiv('gn-more-label');
      tagLabel.setText(t('Tags in this folder'));
      if (this._tagFilter && this._tagFilter.size) {
        const clear = tagLabel.createSpan('gn-more-clear');
        clear.setText(t('Clear'));
        clear.onclick = (e) => {
          e.stopPropagation();
          this._tagFilter = new Set();
          this.closeMorePopover();
          this.rerenderMain();
        };
      }
      const tagRow = pop.createDiv('gn-more-tags');   // 標籤多時會自己出現捲軸（限高）
      for (const t of tags) {
        const chip = tagRow.createDiv('gn-more-chip');
        chip.toggleClass('gn-more-chip-on', !!(this._tagFilter && this._tagFilter.has(t.tag)));
        chip.setText('#' + t.tag + ' ' + t.n);
        chip.onclick = () => {
          if (!this._tagFilter) this._tagFilter = new Set();
          if (this._tagFilter.has(t.tag)) this._tagFilter.delete(t.tag);
          else this._tagFilter.add(t.tag);
          chip.toggleClass('gn-more-chip-on', this._tagFilter.has(t.tag));
          this.rerenderMain();     // 只重畫右側卡片牆，面板留著繼續點
        };
      }
    }

    /* ── 卡片大小：真的滑桿，拖曳即時生效（手機不顯示：手機是固定欄數，在設定頁調） ── */
    if (!document.body.classList.contains('is-mobile')) {
      pop.createDiv('gn-more-label').setText(t('Card size'));
      const zoom = pop.createEl('input', { type: 'range' });
      zoom.addClass('gn-zoom');
      zoom.min = '120'; zoom.max = '300'; zoom.step = '10';
      zoom.value = String(state.cardWidth || 120);
      zoom.oninput = () => {
        const v = Number(zoom.value);
        state.cardWidth = v;
        for (const m of (this._masonries || [])) m.setMinCol(v);   // 各區瀑布流即時重排
        this.plugin.saveState();
      };
    }

    pop.createDiv('gn-more-sep');

    /* ── 攤平（開關列） ── */
    const flatRow = pop.createDiv('gn-more-row');
    flatRow.toggleClass('gn-more-row-on', !!state.flattenFolders);
    const flatIcon = flatRow.createSpan('gn-more-icon');
    setIcon(flatIcon, 'layers');
    flatRow.createSpan('gn-more-text').setText(t('Flatten: include all subfolders'));
    const flatMark = flatRow.createSpan('gn-more-check');
    if (state.flattenFolders) setIcon(flatMark, 'check');
    flatRow.onclick = () => {
      state.flattenFolders = !state.flattenFolders;
      this.plugin.saveState();
      this.closeMorePopover();
      this.render();
    };

    /* ── 重新整理 ── */
    const refreshRow = pop.createDiv('gn-more-row');
    const rIcon = refreshRow.createSpan('gn-more-icon');
    setIcon(rIcon, 'refresh-cw');
    refreshRow.createSpan('gn-more-text').setText(t('Refresh'));
    refreshRow.onclick = () => { this.closeMorePopover(); this.render(); };

    // 點面板外／按 Esc → 關閉（拖滑桿時不會誤關，因為滑桿在面板內）
    const closer = (e) => {
      if (!this._morePop) return;
      if (this._morePop.contains(e.target) || anchor.contains(e.target)) return;
      this.closeMorePopover();
    };
    const esc = (e) => { if (e.key === 'Escape') this.closeMorePopover(); };
    this._moreCloser = closer; this._moreEsc = esc;
    setTimeout(() => {
      document.addEventListener('mousedown', closer);
      document.addEventListener('keydown', esc);
    }, 0);
  }

  closeMorePopover() {
    if (this._moreCloser) { document.removeEventListener('mousedown', this._moreCloser); this._moreCloser = null; }
    if (this._moreEsc) { document.removeEventListener('keydown', this._moreEsc); this._moreEsc = null; }
    if (this._morePop) { this._morePop.remove(); this._morePop = null; }
  }

  newFileMenu(folder, evt) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(t('Folder')).setIcon('folder-plus').onClick(() => this.newFolder(folder)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t('Note')).setIcon('file-text').onClick(() => this.newFile(folder, 'md', '')));
    menu.addItem((i) => i.setTitle(t('Canvas')).setIcon('layout-dashboard').onClick(() => this.newFile(folder, 'canvas', '{}')));
    menu.addItem((i) => i.setTitle(t('Base')).setIcon('database').onClick(() => this.newFile(folder, 'base', 'views:\n  - type: table\n    name: Table\n')));
    if (evt instanceof MouseEvent) menu.showAtMouseEvent(evt);
    else menu.showAtPosition({ x: 0, y: 0 });
  }

  // 新增資料夾（先問名稱）
  newFolder(parentFolder) {
    new InputModal(this.app, t('New folder'), '', async (name) => {
      const dir = !parentFolder || parentFolder.path === '/' ? '' : parentFolder.path + '/';
      const path = dir + name;
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice(t('A folder with that name already exists')); return; }
      try {
        await this.app.vault.createFolder(path);
        // 展開父層並選取新資料夾
        const expanded = new Set(this.plugin.state.expandedFolders || []);
        let acc = '';
        for (const seg of path.split('/').slice(0, -1)) { acc = acc ? acc + '/' + seg : seg; expanded.add(acc); }
        this.plugin.state.expandedFolders = [...expanded];
        this.path = path;
        this.plugin.state.lastPath = path;
        this.plugin.saveState();
        this.render();
      } catch (e) {
        new Notice(t('Failed to create folder: {{msg}}', { msg: e && e.message ? e.message : e }));
      }
    }).open();
  }

  // 實際執行改名（會自動更新所有 [[wiki-link]]，並沿用選取/展開狀態）
  async _commitFolderRename(folder, name) {
    name = (name || '').trim();
    if (!name || name === folder.name) { this.render(); return; }
    if (/[\\/:*?"<>|]/.test(name)) { new Notice(t('Name contains forbidden characters') + ' \\ / : * ? " < > |'); this.render(); return; }
    const parent = folder.parent && folder.parent.path !== '/' ? folder.parent.path + '/' : '';
    const newPath = parent + name;
    if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice(t('A folder with that name already exists')); this.render(); return; }
    const oldPath = folder.path;
    try {
      await this.app.fileManager.renameFile(folder, newPath);
      // 沿用選取 / 展開狀態：把舊路徑前綴換成新路徑
      const remap = (p) => (p === oldPath || p.startsWith(oldPath + '/')) ? newPath + p.slice(oldPath.length) : p;
      this.plugin.state.expandedFolders = (this.plugin.state.expandedFolders || []).map(remap);
      if (this.path === oldPath || this.path.startsWith(oldPath + '/')) this.path = remap(this.path);
      this.plugin.state.lastPath = this.path;
      this.plugin.saveState();
      this.render();
    } catch (e) {
      new Notice(t('Rename failed: {{msg}}', { msg: e && e.message ? e.message : e }));
      this.render();
    }
  }

  // macOS 風格：把資料夾名稱原地換成輸入框，Enter 確認、Esc 取消、失焦確認
  inlineRenameFolder(folder, nameEl) {
    if (!(folder instanceof TFolder) || folder.path === '/') { new Notice(t('Cannot rename this folder')); return; }
    if (!nameEl || nameEl._editing) return;
    nameEl._editing = true;
    const orig = folder.name;
    const input = nameEl.doc.createElement('input');
    input.type = 'text';
    input.value = orig;
    input.addClass('gn-tname-input');
    nameEl.empty();
    nameEl.appendChild(input);
    // 輸入框上的互動不要觸發整列選取/展開
    ['click', 'dblclick', 'mousedown', 'pointerdown'].forEach((ev) =>
      input.addEventListener(ev, (e) => e.stopPropagation()));
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      const val = input.value;
      if (commit && val.trim() && val.trim() !== orig) {
        this._commitFolderRename(folder, val);   // render() 會整棵樹重畫
      } else {
        nameEl._editing = false;
        nameEl.setText(orig);                    // 取消：復原名稱
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  /* 手機兩欄 = 方案⑤「並排雙欄一起平移」（2026-07-15）：
     左欄 86% + 右欄 100% 並排在 overflow:hidden 的 split 裡，
     切換＝兩欄同步 translateX（CSS 依 .gn-split[data-pane] + --gn-shift 決定）。
     transform 免疫卡片重排（不像捲動會被吸回去）；平移的是固定大小的捲動容器，
     瀏覽器只光柵化可視區附近，加上 renderInChunks 初始只有 40 張卡 → 不會 lag。
     this._pane（'tree' | 'cards'）＝目前吸附在哪一欄。 */

  // 切換手機顯示的欄（就是改 .gn-split 的 data-pane，CSS 負責平移兩欄）
  setPane(pane) {
    this._pane = pane;
    const split = this._split;
    if (!split) return;
    split.dataset.pane = pane;
    // 保險：右欄若曾在寬度不對時排版（例如旋轉螢幕），顯示時重排一次
    if (pane === 'cards') requestAnimationFrame(() => this.relayoutWalls());
  }

  // 手機：點資料夾/標籤 → 滑到右邊卡片欄（帶過場動畫）
  gotoCardsMobile() {
    if (!document.body.classList.contains('is-mobile')) return;
    const split = this._split;
    // render() 剛重建 DOM 就改 data-pane 會「直接出現」在右欄（瀏覽器還沒畫過左欄位置）。
    // 先強制 reflow 把目前（左欄）位置定成過場起點，再切換 → 才有滑過去的動畫。
    if (split && split.dataset.pane !== 'cards') void split.offsetWidth;
    this.setPane('cards');
  }

  // 診斷用（行車記錄器版）：執行後「武裝 10 秒」，這期間去點一個會失敗的資料夾，
  // 它會記錄 setPane / gotoCardsMobile / render 的呼叫時間軸 + 每 200ms 取樣兩欄實際位置，
  // 10 秒後把整條時間軸用 Notice 顯示出來（手機沒 console，全靠這個）。
  diagnoseMobileScroll() {
    if (this._diagArmed) { new Notice('已在記錄中…'); return; }
    this._diagArmed = true;
    const log = [];
    const t0 = Date.now();
    const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

    // 靜態環境檢查（styles.css 舊版一眼看出）
    const tree0 = this._split && this._split.querySelector('.gn-tree');
    if (tree0) {
      const ct = getComputedStyle(tree0);
      if (!/transform/.test(ct.transitionProperty)) log.push('⚠️ 左欄無 transform transition ＝ styles.css 是舊版');
      log.push('0.0s 起點 _pane=' + this._pane + ' shift=' + (this._split.style.getPropertyValue('--gn-shift') || '(未設)'));
    }

    // 包住三個關鍵方法，記錄呼叫與拋錯
    const V = this;
    const wrap = (name) => {
      const orig = V[name];
      V[name] = function (...a) {
        log.push(stamp() + ' ' + name + '(' + a.map(String).join(',') + ')');
        try { return orig.apply(V, a); }
        catch (e) { log.push(stamp() + ' ❌ ' + name + ' 拋錯: ' + (e && e.message ? e.message : e)); throw e; }
      };
      return () => { V[name] = orig; };
    };
    const restores = ['setPane', 'gotoCardsMobile', 'renderInner'].map(wrap);

    // 每 200ms 取樣：pane / 右欄相對位置 / split 有沒有被水平捲動（值變了才記）
    let last = '';
    const iv = setInterval(() => {
      const split = V._split, main = V._main;
      if (!split || !main || !split.isConnected) return;
      const sr = split.getBoundingClientRect(), mr = main.getBoundingClientRect();
      const cur = 'pane=' + (split.dataset.pane || '-') + ' mainΔ=' + Math.round(mr.left - sr.left) + ' sL=' + Math.round(split.scrollLeft);
      if (cur !== last) { log.push(stamp() + ' ' + cur); last = cur; }
    }, 200);

    new Notice('🩺 開始記錄 10 秒——現在去點一個「不會跳」的資料夾', 5000);
    setTimeout(() => {
      clearInterval(iv);
      restores.forEach((r) => r());
      this._diagArmed = false;
      // mainΔ≈左欄寬(~86%畫面) ＝ 停在左欄；mainΔ≈0 ＝ 已滑到卡片欄；sL>0 ＝ split 被水平捲動（不該發生）
      new Notice('版本: ' + GN_BUILD + '\n' + (log.join('\n') || '（10 秒內沒有任何事件）'), 60000);
    }, 10000);
  }

  // 桌機才有「在 Finder 顯示」（行動裝置的 adapter 沒有 getFullPath）
  canReveal() {
    const a = this.app.vault.adapter;
    return !!(a && typeof a.getFullPath === 'function');
  }

  revealInSystem(file) {
    try {
      const full = this.app.vault.adapter.getFullPath(file.path);
      // app.showInFolder：Obsidian 內建（核心「在系統檔案總管顯示」用的同一支），免 require electron
      if (typeof this.app.showInFolder === 'function') this.app.showInFolder(file.path);
      else throw new Error('showInFolder unavailable');
    } catch (e) {
      new Notice(t('Cannot reveal in system explorer: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  // 刪除（移到垃圾桶，依 Obsidian 設定），先跳確認框
  // 這則筆記引用的附件（非 md：圖片/PDF/影音…），且**沒有被其他筆記引用**（孤兒）。
  // 刪筆記時這些附件會變成沒人用的檔案 → 給使用者選擇一併移到垃圾桶。
  orphanAttachmentsOf(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return [];
    const mc = this.app.metadataCache;
    const cache = mc.getFileCache(file);
    if (!cache) return [];
    const raws = [...(cache.embeds || []), ...(cache.links || [])];
    const res = mc.resolvedLinks || {};
    const seen = new Set();
    const out = [];
    for (const r of raws) {
      const lp = String(r.link || '').split('#')[0].split('|')[0].trim();
      if (!lp) continue;
      const f = mc.getFirstLinkpathDest(lp, file.path);
      if (!(f instanceof TFile) || f.extension === 'md' || seen.has(f.path)) continue;
      seen.add(f.path);
      let used = false;
      for (const src of Object.keys(res)) {
        if (src !== file.path && res[src] && res[src][f.path]) { used = true; break; }
      }
      if (!used) out.push(f);
    }
    return out;
  }

  confirmDelete(item) {
    const isFolder = item instanceof TFolder;
    const msg = isFolder
      ? t('Delete folder "{{name}}" and all its contents? (moves to trash)', { name: item.name })
      : t('Delete "{{name}}"? (moves to trash)', { name: item.name });
    const orphans = isFolder ? [] : this.orphanAttachmentsOf(item);
    const extra = orphans.length ? {
      label: t('Also delete {{n}} attachment(s) not referenced by any other note', { n: orphans.length }),
      items: orphans.map((f) => f.path),
      checked: true,
    } : null;
    new ConfirmModal(this.app, msg, async (withExtra) => {
      try {
        await this.app.fileManager.trashFile(item);
        let n = 0;
        if (withExtra) {
          for (const f of orphans) { try { await this.app.fileManager.trashFile(f); n++; } catch (e) {} }
        }
        new Notice(n
          ? t('Moved to trash: {{name}} (+{{n}} attachments)', { name: item.name, n })
          : t('Moved to trash: {{name}}', { name: item.name }));
        this.render();
      } catch (e) {
        new Notice(t('Delete failed: {{msg}}', { msg: e && e.message ? e.message : e }));
      }
    }, extra).open();
  }

  // 把元素設成「拖入即搬移到 targetPath」的落點
  wireMoveTarget(el, targetPath, cls) {
    el.addEventListener('dragover', (e) => {
      if (!this.drag || this.drag.kind === 'fav') return;   // 最愛排序不是搬移
      e.preventDefault();
      el.addClass(cls);
    });
    el.addEventListener('dragleave', () => el.removeClass(cls));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.removeClass(cls);
      const d = this.drag;
      if (!d) return;
      const item = this.app.vault.getAbstractFileByPath(d.path);
      const target = this.folderAt(targetPath);
      if (item && target) this.moveItem(item, target);
    });
  }

  // 用 fileManager.renameFile 搬移：會自動更新所有 [[wiki-link]]
  async moveItem(item, targetFolder) {
    // 防止把資料夾移進自己或自己的子孫
    if (item instanceof TFolder &&
        (targetFolder.path === item.path || targetFolder.path.startsWith(item.path + '/'))) {
      new Notice(t('Cannot move a folder into itself'));
      return;
    }
    const dir = targetFolder.path === '/' ? '' : targetFolder.path + '/';
    const newPath = dir + item.name;
    if (newPath === item.path) { new Notice(t('Already in this folder')); return; }
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(t('Target already has an item with the same name — move cancelled'));
      return;
    }
    try {
      await this.app.fileManager.renameFile(item, newPath);
      new Notice(t('Moved to {{dest}}', { dest: targetFolder.path === '/' ? t('vault root') : targetFolder.path }));
    } catch (e) {
      new Notice(t('Move failed: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  setFolderHidden(path, hide) {
    const set = new Set(this.plugin.state.hiddenFolders || []);
    if (hide) set.add(path); else set.delete(path);
    this.plugin.state.hiddenFolders = [...set];
    this.plugin.saveState();
    this.render();
  }

  setFolderColor(path, key) {
    const map = Object.assign({}, this.plugin.state.folderColors);
    if (key) map[path] = key; else delete map[path];   // key=null → 回到自動配色
    this.plugin.state.folderColors = map;
    this.plugin.saveState();
    this.refreshTree();
  }

  // 卡片底色（feature 1）：key=null → 清除
  setCardColor(path, key) {
    const map = Object.assign({}, this.plugin.state.cardColors);
    if (key) map[path] = key; else delete map[path];
    this.plugin.state.cardColors = map;
    this.plugin.saveState();
    // 就地更新那張卡片，不整頁重畫（改底色不影響高度，免重排）
    const els = this.cardElsFor(path);
    if (els.length) {
      const cp = key && CARD_PALETTE_BY_KEY[key];
      for (const el of els) {
        el.toggleClass('gn-card-colored', !!cp);
        if (cp) { el.style.background = cp.bg; el.style.setProperty('--gn-card-fg', cp.fg); }
        else { el.style.background = ''; el.style.removeProperty('--gn-card-fg'); }
      }
    } else {
      this.render();
    }
  }

  // 資料夾是否顯示內文（feature 2）：清單裡 = 不顯示
  toggleFolderPreview(path) {
    const set = new Set(this.plugin.state.noPreviewFolders || []);
    if (set.has(path)) set.delete(path); else set.add(path);
    this.plugin.state.noPreviewFolders = [...set];
    this.plugin.saveState();
    this.render();
  }

  // 最愛捷徑（feature 3）
  isFavorite(type, path) {
    return (this.plugin.state.favorites || []).some((f) => f.type === type && f.path === path);
  }
  toggleFavorite(type, path) {
    const list = (this.plugin.state.favorites || []).slice();
    const idx = list.findIndex((f) => f.type === type && f.path === path);
    if (idx >= 0) list.splice(idx, 1); else list.push({ type, path });
    this.plugin.state.favorites = list;
    this.plugin.saveState();
    this.refreshTree();
  }

  // 渲染 ★ 最愛區（feature 3）
  renderFavorites(container) {
    const favs = (this.plugin.state.favorites || [])
      .map((f) => ({ f, af: this.app.vault.getAbstractFileByPath(f.path) }))
      .filter((x) => x.af);   // 已不存在的略過
    if (!favs.length) return;
    const collapsed = !!this.plugin.state.favCollapsed;
    const sec = container.createDiv('gn-fav-sec');
    if (collapsed) sec.addClass('gn-fav-collapsed');
    const head = sec.createDiv('gn-fav-head');
    const caret = head.createSpan('gn-fav-caret');
    setIcon(caret, collapsed ? 'chevron-right' : 'chevron-down');
    setIcon(head.createSpan('gn-fav-star'), 'star');
    head.createSpan('gn-fav-title').setText(t('Favorites'));
    head.createSpan('gn-fav-count').setText(String(favs.length));
    head.onclick = () => {
      this.plugin.state.favCollapsed = !this.plugin.state.favCollapsed;
      this.plugin.saveState();
      this.refreshTree();
    };
    if (collapsed) return;   // 收合：只留標題列
    for (const { f, af } of favs) {
      const row = sec.createDiv('gn-tnode gn-fav-row');
      row.style.setProperty('--gn-depth', '1');
      row.createSpan('gn-tcaret');
      const thumb = row.createSpan('gn-tthumb');
      // 資料夾用和樹狀圖同一個自訂資料夾圖示，大小/樣式統一；筆記用 lucide file-text
      if (f.type === 'folder') setFolderIcon(thumb, false);
      else setIcon(thumb, 'file-text');
      row.createSpan('gn-tname').setText(af.basename || af.name);
      row.onclick = () => {
        if (f.type === 'folder') {
          this.plugin.state.leftMode = 'folder';
          this.navigate(f.path);
          this.gotoCardsMobile();
        } else {
          this.openNote(af, false);
        }
      };
      this.wireContextMenu(row, () => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle(t('Remove from favorites')).setIcon('star-off')
          .onClick(() => this.toggleFavorite(f.type, f.path)));
        return menu;
      });

      // 拖曳排序（2026-07-18）：跟資料夾樹同一套視覺（上緣＝排前、下緣＝排後）。
      // f 就是 state.favorites 裡的項目參照 → indexOf 直接定位。
      row.setAttr('draggable', 'true');
      row.addEventListener('dragstart', (e) => {
        this.drag = { kind: 'fav', entry: f };
        row.addClass('gn-tdragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        this.drag = null;
        row.removeClass('gn-tdragging');
        this.clearDropHints();
      });
      const clearFavHints = () => row.removeClass('gn-tbefore', 'gn-tafter');
      row.addEventListener('dragover', (e) => {
        const d = this.drag;
        if (!d || d.kind !== 'fav' || d.entry === f) return;   // 只接受最愛之間互排
        e.preventDefault();
        clearFavHints();
        const r = row.getBoundingClientRect();
        row.addClass(e.clientY - r.top < r.height / 2 ? 'gn-tbefore' : 'gn-tafter');
      });
      row.addEventListener('dragleave', clearFavHints);
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = row.hasClass('gn-tafter');
        clearFavHints();
        const d = this.drag;
        if (!d || d.kind !== 'fav' || d.entry === f) return;
        const list = this.plugin.state.favorites || [];
        const from = list.indexOf(d.entry);
        if (from < 0) return;
        list.splice(from, 1);
        let to = list.indexOf(f);
        if (to < 0) { list.splice(from, 0, d.entry); return; }   // 防呆：目標不見了就放回原位
        if (after) to += 1;
        list.splice(to, 0, d.entry);
        this.plugin.saveState();
        this.refreshTree();
      });
    }
  }

  // 釘選卡片到頂部（feature 4）
  isPinned(path) { return (this.plugin.state.pinnedCards || []).includes(path); }
  togglePin(path) {
    const set = new Set(this.plugin.state.pinnedCards || []);
    if (set.has(path)) set.delete(path); else set.add(path);
    this.plugin.state.pinnedCards = [...set];
    this.plugin.saveState();
    this.render();
  }

  async loadPreview(file, el) {
    try {
      const raw = await this.app.vault.cachedRead(file);
      // 搜尋模式：顯示「命中處的上下文片段」並高亮，而不是筆記開頭前 5 行
      if (this._searchQ) {
        const terms = gnHighlightTerms(this._searchQ);
        const text = gnSnippet(raw, terms, 140);
        if (text) gnHighlightInto(el, text, terms);
        else el.remove();
      } else {
        const text = extractPreview(raw, 5);
        if (text) el.setText(text);
        else el.remove();
      }
    } catch (e) {
      el.remove();
    }
    this.relayoutWalls();   // 預覽文字載入後高度變 → 重排
  }

  // Canvas 縮圖：解析 .canvas JSON，取第一個圖片節點當封面
  async loadCanvasThumb(file, card, placeholder) {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const data = JSON.parse(raw);
      const nodes = (data && data.nodes) || [];
      for (const nd of nodes) {
        if (nd && nd.type === 'file' && nd.file && IMG_EXT.test(nd.file)) {
          const f = this.app.metadataCache.getFirstLinkpathDest(nd.file, file.path)
            || this.app.vault.getAbstractFileByPath(nd.file);
          if (f) {
            const img = card.createEl('img');
            img.src = this.app.vault.getResourcePath(f);
            img.loading = 'lazy';
            card.appendChild(img);   // 滿版圖片
            card.addClass('gn-has-img');
            if (placeholder) placeholder.remove();
            this.relayoutWalls();
            return;
          }
        }
      }
    } catch (e) { /* 解析失敗就保留圖示 */ }
  }

  // PDF 縮圖：用 Obsidian 內建 pdf.js 把第一頁渲染成圖當封面（失敗保留圖示）
  async loadPdfThumb(file, card, placeholder) {
    if (!card.isConnected) return;
    const cache = this.plugin._pdfThumbCache || (this.plugin._pdfThumbCache = new Map());
    const key = file.path + ':' + file.stat.mtime;
    const put = (dataUrl) => {
      const img = card.createEl('img');
      img.src = dataUrl;
      img.addClass('gn-pdf-thumb');
      card.appendChild(img);   // 滿版圖片
      card.addClass('gn-has-img');
      if (placeholder) placeholder.remove();
      this.relayoutWalls();
    };
    // 已渲染過（同檔同 mtime）→ 直接用快取，不重新解析
    if (cache.has(key)) { const d = cache.get(key); if (d) put(d); return; }
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) return;
    let doc = null;
    try {
      const buf = await this.app.vault.readBinary(file);
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 480 / base.width);          // 目標寬約 480px
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      cache.set(key, dataUrl);   // 快取供之後重畫直接用
      if (card.isConnected) put(dataUrl);
    } catch (e) { /* 保留圖示 */ }
    finally { try { if (doc) doc.destroy(); } catch (e) {} }
  }

  // 連結預覽縮圖：無封面的 md 若含外部連結，抓該網頁 og:image、
  // 把圖片下載到外掛的 og-cache/ 資料夾持久保存（跨工作階段/裝置沿用，只抓一次）。
  async loadLinkPreview(file, card) {
    const plugin = this.plugin;
    const idx = plugin._ogIndex || (plugin._ogIndex = {});
    const a = this.app.vault.adapter;
    const dir = plugin.ogCacheDir();
    const put = (resUrl) => {
      if (!resUrl || !card.isConnected) return;
      const img = card.createEl('img');
      img.src = resUrl;
      img.loading = 'lazy';
      img.addClass('gn-linkimg');
      card.appendChild(img);   // 滿版圖片
      // 載入成功 → 以圖代文：改成圖片卡。
      // 內文預覽**不刪除**（只是被 CSS 收起來），hover 時才展開 → 圖跟文都留得住。
      img.onload = () => {
        card.addClass('gn-has-img');
        this.relayoutWalls();
      };
      img.onerror = () => { img.remove(); this.relayoutWalls(); };
      this.relayoutWalls();
    };
    try {
      const c = this.app.metadataCache.getFileCache(file);
      const content = await this.app.vault.cachedRead(file);
      const url = firstExternalUrl(c && c.frontmatter, content);
      if (!url) { idx[file.path] = { url: null, file: null }; plugin.saveOgIndex(); return; }
      // 快取命中（同筆記、同來源網址）
      const rec = idx[file.path];
      if (rec && rec.url === url) {
        if (!rec.file) return;                        // 查過確定無圖 → 不重抓
        const p = dir + '/' + rec.file;
        if (await a.exists(p)) { put(a.getResourcePath(p)); return; }
        // 快取檔遺失 → 往下重抓
      }
      // 抓網頁 HTML → 解析 og:image
      const res = await requestUrl({ url, method: 'GET', throw: false });
      let imgUrl = ogImageFrom(res && res.text, url);
      // Meta 系（Threads/IG）og:image 過濾：-19/ 是作者頭像、rsrc.php 是 logo 佔位圖，
      // 都不是內容、不配當卡片封面 → 記 null（-15/ 的貼文照片照常使用）
      if (imgUrl && (/rsrc\.php|static\.cdninstagram/.test(imgUrl) || /\/t\d+[\d.-]*-19\//.test(imgUrl))) imgUrl = null;
      if (!imgUrl) { idx[file.path] = { url, file: null }; plugin.saveOgIndex(); return; }
      // 下載圖片位元組 → 存進 og-cache/
      const ir = await requestUrl({ url: imgUrl, method: 'GET', throw: false });
      if (!ir || !ir.arrayBuffer || ir.arrayBuffer.byteLength < 64) {
        idx[file.path] = { url, file: null }; plugin.saveOgIndex(); return;
      }
      const extM = imgUrl.split('?')[0].match(/\.(jpe?g|png|gif|webp|avif)$/i);
      const ext = extM ? extM[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
      const fname = hashStr(file.path) + '.' + ext;
      if (!(await a.exists(dir))) await a.mkdir(dir);
      await a.writeBinary(dir + '/' + fname, ir.arrayBuffer);
      idx[file.path] = { url, file: fname, ts: Date.now() };
      plugin.saveOgIndex();
      put(a.getResourcePath(dir + '/' + fname));
    } catch (e) { /* 靜默：保留無圖，下次可再試 */ }
  }

  // macOS overlay 捲軸：捲動中才顯示（掛 .gn-scrolling，停止 700ms 後移除淡出）
  wireOverlayScrollbar(el) {
    el.addEventListener('scroll', () => {
      if (!el.hasClass('gn-scrolling')) el.addClass('gn-scrolling');
      clearTimeout(el._gnSbT);
      el._gnSbT = setTimeout(() => el.removeClass('gn-scrolling'), 700);
    }, { passive: true });
  }

  // ── 左欄捲動位置記憶（資料夾/標籤各記一份，存進 data.json 跨工作階段） ──
  // 為何需要：render() 會 contentEl.empty() 重建左欄，treeScroll.empty() 也會把內容高度歸零，
  // 兩者都讓 scrollTop 被夾回 0 → 點資料夾就「跳回頂端」。
  treeScrollStore() {
    const s = this.plugin.state;
    if (!s.treeScrollTop || typeof s.treeScrollTop !== 'object') s.treeScrollTop = { folder: 0, tag: 0 };
    return s.treeScrollTop;
  }

  treeScrollKey() { return this.plugin.state.leftMode === 'tag' ? 'tag' : 'folder'; }

  // 使用者手動捲動時記錄（重畫過程中上鎖，避免被 empty() 觸發的 scroll=0 蓋掉）
  saveTreeScroll() {
    const el = this._treeScroll;
    if (!el || !el.isConnected || this._treeScrollLock) return;
    this.treeScrollStore()[this.treeScrollKey()] = el.scrollTop;
    clearTimeout(this._treeScrollT);
    this._treeScrollT = setTimeout(() => this.plugin.saveState(), 500);   // 去抖寫檔
  }

  // 重畫後還原捲動位置（rAF 再校一次：首次設定時 scrollHeight 可能還沒成形）
  restoreTreeScroll() {
    const el = this._treeScroll;
    if (!el) { this._treeScrollLock = false; return; }
    const top = this.treeScrollStore()[this.treeScrollKey()] || 0;
    const apply = () => {
      if (!el.isConnected) return;
      el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    };
    apply();
    requestAnimationFrame(() => { apply(); this._treeScrollLock = false; });
  }

  // 只重畫左樹（展開/收合/最愛/資料夾配色用）；沒左樹快取就退回整頁
  refreshTree() {
    if (this._treeScroll && this._treeScroll.isConnected && this._buildTree) {
      this.treeScrollStore()[this.treeScrollKey()] = this._treeScroll.scrollTop;   // 清空前先記住
      this._treeScrollLock = true;
      this._treeScroll.empty();
      this._buildTree();   // 內部結尾會 restoreTreeScroll() 並解鎖
    } else { this.render(); }
  }

  toggleExpand(path) {
    const set = new Set(this.plugin.state.expandedFolders || []);
    if (set.has(path)) set.delete(path); else set.add(path);
    this.plugin.state.expandedFolders = [...set];
    this.plugin.saveState();
    this.refreshTree();
  }

  // 清掉所有樹狀列的拖曳落點提示
  clearDropHints() {
    this.contentEl.findAll('.gn-tnode').forEach((el) => el.removeClass('gn-tmove', 'gn-tbefore', 'gn-tafter'));
  }

  // 樹狀落點：into＝移進資料夾；before/after＝同層排序
  handleTreeDrop(targetFolder, zone) {
    const d = this.drag;
    if (!d) return;
    // 拖曳的是「已選取的筆記」且有多選 → 批次移動全部選取
    if (d.kind === 'note' && this.selected.size > 1 && this.selected.has(d.path)) {
      const paths = [...this.selected];
      (async () => {
        for (const p of paths) {
          const f = this.app.vault.getAbstractFileByPath(p);
          if (f) await this.moveItem(f, targetFolder);
        }
        this.selected.clear();
        this.render();
      })();
      return;
    }
    const item = this.app.vault.getAbstractFileByPath(d.path);
    if (!item) return;
    if (d.kind === 'note' || zone === 'into') { this.moveItem(item, targetFolder); return; }
    const parent = targetFolder.parent || this.app.vault.getRoot();
    const parentKey = parent.path || '/';
    const draggedParent = item.parent || this.app.vault.getRoot();
    if ((draggedParent.path || '/') !== parentKey) {
      this.moveItem(item, parent);   // 跨層：先移進目標的父資料夾
      return;
    }
    this.reorderSibling(parent, parentKey, d.path, targetFolder.path, zone);
  }

  // 更新 folderOrder[parentKey]，把 draggedPath 排到 targetPath 前/後
  reorderSibling(parent, parentKey, draggedPath, targetPath, zone) {
    const saved = (this.plugin.state.folderOrder || {})[parentKey];
    const items = subFolders(parent).map((f) => ({ folder: f, name: f.name }));
    let order = orderFolders(items, saved).map((it) => it.folder.path);   // 目前顯示順序為基底
    order = order.filter((p) => p !== draggedPath);
    let idx = order.indexOf(targetPath);
    if (idx === -1) idx = order.length;
    if (zone === 'after') idx += 1;
    order.splice(idx, 0, draggedPath);
    const orders = Object.assign({}, this.plugin.state.folderOrder);
    orders[parentKey] = order;
    this.plugin.state.folderOrder = orders;
    this.plugin.saveState();
    this.render();
  }

  // render 的保護殼：內部拋例外時（手機沒 console、以前是無聲失敗），
  // ① 彈 Notice 讓人看得到錯誤 ② 不往上丟 → 呼叫端接下來的 gotoCardsMobile() 照常執行。
  render() {
    try {
      this.renderInner();
    } catch (e) {
      console.error('Gallery render 錯誤', e);
      new Notice(t('Gallery render error: {{msg}}', { msg: e && e.message ? e.message : e }), 10000);
    }
  }

  renderInner() {
    const app = this.app;
    const root = this.contentEl;
    if (this._todoPop) { this._todoPop.remove(); this._todoPop = null; }
    this.closeMorePopover();   // 「更多」面板掛在 body 上 → 重畫前要收掉，不然會變孤兒
    // 整頁重畫會丟掉左欄捲動位置 → 清空前先記下來，_buildTree() 結尾再還原
    if (this._treeScroll && this._treeScroll.isConnected) {
      this.treeScrollStore()[this.treeScrollKey()] = this._treeScroll.scrollTop;
    }
    // 右欄卡片牆的捲動位置也記下來：同一面牆重畫時還原。
    // 典型場景：拖曳卡片搬到別的資料夾 → rename 事件 → refreshViews 整頁重畫 → 沒這段會跳回頂部。
    if (this._main && this._main.isConnected) {
      this._mainScrollSaved = { key: this.mainScrollKey(), top: this._main.scrollTop };
    }
    this._treeScrollLock = true;
    root.empty();
    root.addClass('gn-root');

    // 手機：contentEl 本身就是 .view-content；它的父層（.workspace-leaf-content）
    // 在手機不是 flex 直向，導致 gn-root 撐不滿高度 → 底部工具列上方留白。
    // 這裡把父層改成 flex 直向，gn-root 的 flex:1 才能吃滿整個檢視高度。
    if (document.body.classList.contains('is-mobile') && root.parentElement) {
      const host = root.parentElement;
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.minHeight = '0';
    }

    const state = this.plugin.state;

    /* --- 頂部工具列：左＝資料夾相關（對齊左欄）、右＝卡片相關（靠右） --- */
    const bar = root.createDiv('gn-bar');
    const barL = bar.createDiv('gn-bar-group');   // 左：對應左側資料夾樹
    const barR = bar.createDiv('gn-bar-group');   // 右：對應右側卡片牆
    this._barTitle = barR.createDiv('gn-bar-title');   // 右段左側＝目前資料夾標題（Finder 風，2026-07-18）

    /* ===== 搜尋（全文，中文 ICU 斷詞 + bigram；結果直接呈現為卡牆）===== */
    // 搜尋鈕 → 開「懸浮搜尋」（GnSearchModal）；搜尋牆顯示中（Shift+↵ 進來的）→ 變成關閉搜尋
    const searchBtn = barR.createDiv('gn-btn');
    setIcon(searchBtn, 'search');
    searchBtn.setAttr('title', this._searchOn ? t('Close search') : t('Search notes (full-text popup)'));
    searchBtn.toggleClass('gn-btn-on', !!this._searchOn);
    searchBtn.onclick = () => {
      if (this._searchOn) {
        this._searchOn = false;
        this._searchQ = '';
        this._searchTreeOpen = false;   // 左欄回到「搜尋時預設收起」的初始狀態
        this.render();
      } else {
        this.plugin.search.ensureReady();   // 背景先把索引建起來
        new GnSearchModal(this.app, this.plugin).open();
      }
    };

    // 搜尋列放在 gn-root 底下（不在 gn-main 內）：
    //  1) rerenderMain() 只清 gn-main → 輸入框不會被重建 → 不失焦
    //  2) gn-main 有頂部淡出遮罩，放進去會被 mask 淡掉看不見
    if (this._searchOn) {
      const srow = root.createDiv('gn-search-row');
      const sinput = srow.createEl('input', { type: 'search', cls: 'gn-search-input' });
      sinput.placeholder = t('Search full text…');
      sinput.value = this._searchQ || '';

      const sclose = srow.createDiv('gn-search-clear');
      setIcon(sclose, 'x');
      sclose.setAttr('title', t('Close search'));
      const close = () => { this._searchOn = false; this._searchQ = ''; this._searchTreeOpen = false; this.render(); };
      sclose.onclick = close;

      let timer = null;
      const run = async () => {
        const q = sinput.value.trim();
        this._searchQ = q;
        if (q && !this.plugin.search.ready) {
          this.rerenderMain();                      // 先顯示「建立索引中…」
          await this.plugin.search.ensureReady();
          if (sinput.value.trim() !== q) return;    // 建索引期間又打了字 → 交給後面那次
        }
        this.rerenderMain();
      };
      sinput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
      sinput.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      setTimeout(() => sinput.focus(), 0);
    }
    // 桌機：左段寬度對齊左欄（+9 補分隔桿）；收合時用自然寬（保留展開鈕）
    const isMobileUI = document.body.classList.contains('is-mobile');
    const syncBarL = (w) => {
      if (isMobileUI) return;
      barL.style.flex = '0 0 ' + w + 'px';
      // 分界推到「樹寬 + 分隔桿 9px」＝右欄起點，灰色涵蓋分隔桿區，不留白縫
      root.style.setProperty('--gn-treew', (w + 9) + 'px');
    };
    // 搜尋時預設收起左欄（搜尋結果是全 vault，資料夾樹沒意義）；
    // 但搜尋中仍可用收合鈕手動展開（this._searchTreeOpen 當覆寫，不寫進 data.json）
    const treeHidden = this._searchOn ? !this._searchTreeOpen : !!state.treeCollapsed;
    if (!isMobileUI && !treeHidden) syncBarL(state.treeWidth || 232);
    if (!isMobileUI && treeHidden) root.style.setProperty('--gn-treew', '-1px');   // 左欄收合 → 整塊主底色（-1px：連交界線一起滑出畫面）

    // 左：收合 / 展開資料夾面板
    const collapseBtn = barL.createDiv('gn-btn gn-collapse-btn');
    setIcon(collapseBtn, treeHidden ? 'panel-left-open' : 'panel-left-close');
    collapseBtn.setAttr('title', treeHidden ? t('Expand folder pane') : t('Collapse folder pane'));
    collapseBtn.onclick = () => {
      if (this._searchOn) { this._searchTreeOpen = !this._searchTreeOpen; this.render(); return; }   // 搜尋中：只切這次
      state.treeCollapsed = !state.treeCollapsed;
      this.plugin.saveState();
      this.render();
    };

    // 左：待辦按鈕（點了彈出面板；徽章顯示未完成數）
    const todoBtn = barL.createDiv('gn-btn gn-todo-btn');
    setIcon(todoBtn, 'list-checks');
    todoBtn.setAttr('title', t('To-dos'));
    const todoBadge = todoBtn.createSpan('gn-todo-badge');
    todoBadge.style.display = 'none';
    const tf = state.todoNote ? this.app.vault.getAbstractFileByPath(state.todoNote) : null;
    if (tf instanceof TFile) {
      this.app.vault.cachedRead(tf).then((raw) => {
        const undone = parseTasks(raw).filter((t) => !t.done).length;
        if (undone > 0) { todoBadge.style.display = ''; todoBadge.setText(String(undone)); }
      }).catch(() => {});
    }
    todoBtn.onclick = (e) => { e.stopPropagation(); this.openTodoPopover(todoBtn); };

    // 左：資料夾 ⇄ 標籤 模式切換
    const modeBtn = barL.createDiv('gn-btn');
    modeBtn.toggleClass('gn-eye-on', state.leftMode === 'tag');
    setIcon(modeBtn, state.leftMode === 'tag' ? 'hash' : 'folder');
    modeBtn.setAttr('title', state.leftMode === 'tag' ? t('Current: tags (click to switch to folders)') : t('Current: folders (click to switch to tags)'));
    modeBtn.onclick = () => {
      state.leftMode = state.leftMode === 'tag' ? 'folder' : 'tag';
      this.plugin.saveState();
      this.render();
    };

    // 左：同步目前開啟的筆記到資料夾樹
    const syncBtn = barL.createDiv('gn-btn');
    syncBtn.toggleClass('gn-eye-on', !!state.syncActive);
    setIcon(syncBtn, 'crosshair');
    syncBtn.setAttr('title', state.syncActive ? t('Follow active note: on (click to turn off)') : t('Follow active note: off (click to turn on)'));
    syncBtn.onclick = () => {
      state.syncActive = !state.syncActive;
      this.plugin.saveState();
      if (state.syncActive) this.syncToFile(this.app.workspace.getActiveFile());
      else this.render();
    };

    // 左：顯示 / 隱藏資料夾
    if ((state.hiddenFolders || []).length) {
      const eye = barL.createDiv('gn-btn');
      eye.toggleClass('gn-eye-on', !!this.showHidden);
      setIcon(eye, this.showHidden ? 'eye' : 'eye-off');
      eye.setAttr('title', this.showHidden ? t('Hide hidden folders') : t('Show hidden folders'));
      eye.onclick = () => { this.showHidden = !this.showHidden; this.render(); };
    }

    // 右：新建（筆記 / Canvas / Base / 資料夾）—— 常用，留在工具列上
    const newBtn = barR.createDiv('gn-btn');
    setIcon(newBtn, 'file-plus');
    newBtn.setAttr('title', t('Create here (folder / note / canvas / base)'));
    newBtn.onclick = (e) => this.newFileMenu(this.folderAt(this.path), e);

    // 右：⋯ 更多（排序 / 卡片大小滑桿 / 攤平 / 重新整理 → 單層浮動面板）
    const moreBtn = barR.createDiv('gn-btn');
    setIcon(moreBtn, 'more-horizontal');
    moreBtn.setAttr('title', t('More (sort / card size / flatten)'));
    moreBtn.onclick = (e) => { e.stopPropagation(); this.openMorePopover(moreBtn); };

    const zoom = null;   // 滑桿已移進「更多」面板（makeGrid 對 null 有防呆）

    /* --- 兩欄：左巢狀資料夾樹 + 右筆記牆 --- */
    const split = root.createDiv('gn-split');
    const tree = split.createDiv('gn-tree');            // 左欄容器（flex 直向）
    tree.style.flex = '0 0 ' + (state.treeWidth || 232) + 'px';
    const treeScroll = tree.createDiv('gn-tree-scroll'); // 上方：可捲動的資料夾/標籤區
    const splitter = split.createDiv('gn-split-handle');
    const main = split.createDiv('gn-main');
    this._split = split; this._main = main;   // 供手機「點資料夾 → 跳右欄」使用
    this.wireOverlayScrollbar(treeScroll);    // overlay 捲軸：捲動才浮現
    this.wireOverlayScrollbar(main);
    if (treeHidden) { tree.style.display = 'none'; splitter.style.display = 'none'; }

    // 手機：方案⑤ 並排雙欄一起平移（左欄 86% + 右欄 100%，兩欄同步 translateX）
    // 手指拖曳時「即時跟著手指」（inline transform 蓋掉 transition），放開才吸附到某一欄。
    if (document.body.classList.contains('is-mobile')) {
      if (this._pane === undefined) this._pane = this.path ? 'cards' : 'tree';   // 記住目前在哪一欄
      split.dataset.pane = this._pane;   // 重繪後立刻定回目前欄

      // 平移量 --gn-shift ＝ 左欄實際寬（px）；render 後與尺寸變動（旋轉螢幕）時更新
      const setShift = () => split.style.setProperty('--gn-shift', tree.offsetWidth + 'px');
      setShift();
      requestAnimationFrame(setShift);
      if (this._paneRO) this._paneRO.disconnect();
      this._paneRO = new ResizeObserver(setShift);
      this._paneRO.observe(split);

      // 保險：split 雖是 overflow:hidden，程式仍可能捲動它（scrollIntoView 會波及可捲祖先，
      // 這正是方案①「被吸回左欄」的機制）。現在定位全靠 transform → split 永遠不該有捲動量。
      split.addEventListener('scroll', () => {
        if (split.scrollLeft) split.scrollLeft = 0;
      }, { passive: true });

      const panes = [tree, main];
      const shift = () => tree.offsetWidth;
      const baseX = () => (this._pane === 'cards' ? -shift() : 0);   // 目前吸附位置
      let sx = 0, sy = 0, dir = 0, t0 = 0;   // dir: 0 未定 / 1 水平 / 2 垂直
      // ⚠️ 手勢衝突：Gallery 放在 Obsidian 的左側抽屜裡，「往左滑」會被 Obsidian 當成
      //   「關閉側欄」→ 整個抽屜被收掉、太快滑回筆記主畫面。
      //   → 畫廊內的 touch 事件一律 stopPropagation（不讓它冒泡到抽屜手勢），
      //     判定為水平手勢後再 preventDefault 雙保險（touchmove 因此不能 passive）。
      split.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        if (e.touches.length !== 1) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; dir = 0; t0 = e.timeStamp;
      }, { passive: true });
      split.addEventListener('touchmove', (e) => {
        e.stopPropagation();
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        if (!dir) {   // 先判定這次手勢是水平還是垂直（垂直交給子欄捲動）
          if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) dir = 1;
          else if (Math.abs(dy) > 12) dir = 2;
        }
        if (dir !== 1) return;
        e.preventDefault();   // 水平手勢由畫廊獨占（垂直不擋，捲動照常）
        const x = Math.max(-shift(), Math.min(0, baseX() + dx));   // 夾在左右欄兩端點之間
        for (const p of panes) { p.style.transition = 'none'; p.style.transform = 'translateX(' + x + 'px)'; }
      }, { passive: false });
      split.addEventListener('touchend', (e) => {
        e.stopPropagation();
        if (dir !== 1) { dir = 0; return; }
        const dx = e.changedTouches[0].clientX - sx;
        const dt = Math.max(1, e.timeStamp - t0);
        const flick = Math.abs(dx) / dt > 0.35;   // 快甩：位移小也換欄
        let target = this._pane;
        if (dx < 0 && (flick || -dx > shift() * 0.25)) target = 'cards';
        else if (dx > 0 && (flick || dx > shift() * 0.25)) target = 'tree';
        for (const p of panes) p.style.transition = '';   // 還原 CSS transition
        this.setPane(target);                             // data-pane 決定吸附目標
        for (const p of panes) p.style.transform = '';    // 清掉 inline → 從手指位置動畫到目標
        dir = 0;
      }, { passive: true });

      // 在左欄時，點右側露出的那一角卡片牆 → 滑過去卡片欄（不觸發卡片本身）
      main.addEventListener('click', (e) => {
        if (this._pane !== 'cards') {
          e.preventDefault();
          e.stopPropagation();
          this.setPane('cards');
        }
      }, { capture: true });
    }

    // 拖曳分隔桿調整左樹寬度（拖完存進 data.json）
    let pendingW = null;
    const onMove = (e) => {
      const rect = split.getBoundingClientRect();
      let w = e.clientX - rect.left;
      w = Math.max(150, Math.min(rect.width - 200, w));
      tree.style.flex = '0 0 ' + w + 'px';
      syncBarL(w);   // 工具列左段跟著左欄寬度
      pendingW = w;
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (pendingW != null) { state.treeWidth = Math.round(pendingW); this.plugin.saveState(); }
    };
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // 分隔線上的收合鈕（hover 分隔線時浮出；點了收合，不觸發拖曳）
    const splitToggle = splitter.createDiv('gn-split-toggle');
    setIcon(splitToggle, 'chevron-left');
    splitToggle.setAttr('title', t('Collapse folder pane'));
    splitToggle.addEventListener('mousedown', (e) => e.stopPropagation());
    splitToggle.onclick = (e) => {
      e.stopPropagation();
      state.treeCollapsed = true;
      this.plugin.saveState();
      this.render();
    };

    // 左樹內容包成可單獨重畫（展開/收合/最愛/資料夾配色只重畫這裡，不動右卡片牆）
    this._treeScroll = treeScroll;
    // 使用者手動捲左欄 → 記住位置（重畫上鎖期間的 scroll 事件會被忽略）
    treeScroll.addEventListener('scroll', () => this.saveTreeScroll(), { passive: true });
    this._buildTree = () => {
    const folderColors = state.folderColors || {};
    const hiddenSet = new Set(state.hiddenFolders || []);
    const expanded = new Set(state.expandedFolders || []);
    // ★ 最愛捷徑（feature 3）：兩種模式都顯示在最上方
    this.renderFavorites(treeScroll);

    if (state.leftMode === 'tag') {
      this.renderTagTree(treeScroll);
    } else {
    // 根目錄列
    const rootRow = treeScroll.createDiv('gn-tnode');
    rootRow.style.setProperty('--gn-depth', '0');
    rootRow.toggleClass('gn-tsel', !this.path);
    rootRow.createSpan('gn-tcaret');
    setIcon(rootRow.createSpan('gn-tthumb gn-tthumb-home'), 'home');   // 根目錄＝家（2026-07-18）
    rootRow.createSpan('gn-tname').setText(this.app.vault.getName());  // 動態 vault 名（原本寫死 Yaoting）
    rootRow.onclick = () => this.navigate('');
    this.wireMoveTarget(rootRow, '', 'gn-tmove');

    // 遞迴建樹（每列：caret + 縮圖 + 名稱 + 數量）
    const buildLevel = (parentFolder, depth) => {
      const orderKey = parentFolder.path || '/';
      const fitems = subFolders(parentFolder).map((sub) =>
        ({ folder: sub, name: sub.name, count: folderFileCount(sub) }));
      const ordered = orderFolders(fitems, (state.folderOrder || {})[orderKey]);
      const visible = this.showHidden ? ordered : ordered.filter((it) => !hiddenSet.has(it.folder.path));

      for (const it of visible) {
        const hasKids = subFolders(it.folder).length > 0;
        const isOpen = expanded.has(it.folder.path);
        const isHidden = hiddenSet.has(it.folder.path);

        const row = treeScroll.createDiv('gn-tnode');
        row.tabIndex = 0;                            // 可取得鍵盤焦點（供 Enter 改名）
        row.style.setProperty('--gn-depth', String(depth));
        if (depth > 1) row.addClass('gn-tchild');   // 巢狀 → 畫左側引導線
        row.dataset.path = it.folder.path;
        if (this.path === it.folder.path) {
          row.addClass('gn-tsel');
          // 剛用點擊選到這個資料夾 → 選後給它焦點，這樣按 Enter 就能改名
          if (this._focusTreeSel === it.folder.path) {
            this._focusTreeSel = null;
            setTimeout(() => { try { row.focus({ preventScroll: true }); } catch (e) {} }, 0);
          }
        }
        if (isHidden) row.addClass('gn-thidden');
        if (hasKids && isOpen) row.addClass('gn-topen');

        const caret = row.createSpan('gn-tcaret');
        if (hasKids) {
          setIcon(caret, isOpen ? 'chevron-down' : 'chevron-right');
          caret.onclick = (e) => { e.stopPropagation(); this.toggleExpand(it.folder.path); };
        }

        const thumb = row.createSpan('gn-tthumb');
        setFolderIcon(thumb, hasKids && isOpen);
        if (folderColors[it.folder.path]) thumb.style.color = paletteFor(it, folderColors).bg;

        const nameEl = row.createSpan('gn-tname');
        nameEl.setText(it.name);
        row.createSpan('gn-tcount').setText(String(it.count));

        // 選取此資料夾後按 Enter → 原地變輸入框改名（macOS Finder 風格）
        row.onkeydown = (e) => {
          if (e.key === 'Enter' && !nameEl._editing) { e.preventDefault(); this.inlineRenameFolder(it.folder, nameEl); }
        };

        // 點整列 = 只選取（右欄載入）；展開/收合交給箭頭
        row.onclick = () => {
          this.path = it.folder.path;
          state.lastPath = it.folder.path;
          this._focusTreeSel = it.folder.path;   // 選後聚焦此列，讓 Enter 能改名
          this._tagFilter = new Set();           // 換資料夾 → 清掉上一夾的標籤篩選
          this.plugin.saveState();
          this.render();
          this.gotoCardsMobile();
        };

        this.wireContextMenu(row, () => {
          const menu = new Menu();
          if (hasKids) {
            menu.addItem((i) => i.setTitle(isOpen ? t('Collapse') : t('Expand')).setIcon(isOpen ? 'chevron-down' : 'chevron-right')
              .onClick(() => this.toggleExpand(it.folder.path)));
          }
          menu.addItem((i) => {
            i.setTitle(t('Create here')).setIcon('file-plus');
            const sub = i.setSubmenu();
            sub.addItem((s) => s.setTitle(t('Folder')).setIcon('folder-plus').onClick(() => this.newFolder(it.folder)));
            sub.addSeparator();
            sub.addItem((s) => s.setTitle(t('Note')).setIcon('file-text').onClick(() => this.newFile(it.folder, 'md', '')));
            sub.addItem((s) => s.setTitle(t('Canvas')).setIcon('layout-dashboard').onClick(() => this.newFile(it.folder, 'canvas', '{}')));
            sub.addItem((s) => s.setTitle(t('Base')).setIcon('database').onClick(() => this.newFile(it.folder, 'base', 'views:\n  - type: table\n    name: Table\n')));
          });
          menu.addItem((i) => i.setTitle(t('Rename')).setIcon('pencil').onClick(() => this.inlineRenameFolder(it.folder, nameEl)));
          menu.addItem((i) => i.setTitle(t('Copy path')).setIcon('link').onClick(() => copyToClipboard(it.folder.path)));
          menu.addItem((i) => i.setTitle(t('Move to…')).setIcon('folder-input').onClick(() =>
            new FolderSuggest(this.app, (target) => this.moveItem(it.folder, target), it.folder.path).open()));
          menu.addItem((i) => {
            i.setTitle(t('Color')).setIcon('palette');
            const sub = i.setSubmenu();
            const cur = folderColors[it.folder.path] || null;
            sub.addItem((s) => s.setTitle(t('Auto (by name)')).setChecked(!cur)
              .onClick(() => this.setFolderColor(it.folder.path, null)));
            PALETTE.forEach((p) => {
              sub.addItem((s) => {
                s.setTitle(t(p.label)).setIcon('circle').setChecked(cur === p.key)
                  .onClick(() => this.setFolderColor(it.folder.path, p.key));
                // 把圓點圖示塗成該顏色（取代原本的 emoji 色塊）
                try { if (s.iconEl) { s.iconEl.style.color = p.bg; s.iconEl.style.fill = p.bg; } } catch (e) {}
              });
            });
          });
          menu.addSeparator();
          // 加入最愛（feature 3）
          menu.addItem((i) => i.setTitle(this.isFavorite('folder', it.folder.path) ? t('Remove from favorites') : t('Add to favorites'))
            .setIcon('star').onClick(() => this.toggleFavorite('folder', it.folder.path)));
          // 顯示內文開關（feature 2）
          menu.addItem((i) => i.setTitle(t('Show text preview')).setIcon('text')
            .setChecked(!(state.noPreviewFolders || []).includes(it.folder.path))
            .onClick(() => this.toggleFolderPreview(it.folder.path)));
          menu.addSeparator();
          if (isHidden) {
            menu.addItem((i) => i.setTitle(t('Unhide')).setIcon('eye').onClick(() => this.setFolderHidden(it.folder.path, false)));
          } else {
            menu.addItem((i) => i.setTitle(t('Hide this folder')).setIcon('eye-off').onClick(() => this.setFolderHidden(it.folder.path, true)));
          }
          if (this.canReveal()) {
            menu.addItem((i) => i.setTitle(t('Reveal in Finder')).setIcon('folder-open').onClick(() => this.revealInSystem(it.folder)));
          }
          menu.addSeparator();
          menu.addItem((i) => i.setTitle(t('Delete folder')).setIcon('trash').setWarning(true).onClick(() => this.confirmDelete(it.folder)));
          return menu;
        });

        // 拖曳：可拖；作為落點時分三區（上緣＝排前面、下緣＝排後面、中間＝移進去）
        row.setAttr('draggable', 'true');
        row.addEventListener('dragstart', (e) => {
          this.drag = { kind: 'folder', path: it.folder.path };
          row.addClass('gn-tdragging');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          this.drag = null;
          row.removeClass('gn-tdragging');
          this.clearDropHints();
        });
        const clearHints = () => row.removeClass('gn-tmove', 'gn-tbefore', 'gn-tafter');
        row.addEventListener('dragover', (e) => {
          const d = this.drag;
          if (!d || d.path === it.folder.path) return;   // 拖自己不處理
          if (d.kind === 'fav') return;                  // 最愛排序只在最愛區內，不當搬移落點
          e.preventDefault();
          clearHints();
          if (d.kind === 'note') { row.addClass('gn-tmove'); return; }   // 筆記只能移入
          const r = row.getBoundingClientRect();
          const y = e.clientY - r.top;
          if (y < r.height * 0.30) row.addClass('gn-tbefore');
          else if (y > r.height * 0.70) row.addClass('gn-tafter');
          else row.addClass('gn-tmove');
        });
        row.addEventListener('dragleave', clearHints);
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const zone = row.hasClass('gn-tbefore') ? 'before'
            : row.hasClass('gn-tafter') ? 'after' : 'into';
          clearHints();
          this.handleTreeDrop(it.folder, zone);
        });

        if (hasKids && isOpen) buildLevel(it.folder, depth + 1);
      }
    };
    buildLevel(app.vault.getRoot(), 1);
    }
    this.restoreTreeScroll();   // 內容畫完 → 還原捲動位置（並解除上鎖）
    };
    this._buildTree();

    /* --- 右：搜尋結果 / 連結牆 / 標籤筆記 / 資料夾筆記牆 --- */
    this._zoom = zoom;
    this.renderMainContent(main, zoom);
    this.restoreMainScroll();   // 同一面牆重畫（拖曳搬移/檔案變動）→ 還原捲動位置，不跳回頂部
  }

  // 識別「目前右欄是哪一面牆」：換牆（換資料夾/標籤/搜尋詞）就不還原捲動，自然從頂部開始
  mainScrollKey() {
    if (this._searchQ) return 'search:' + this._searchQ;
    if (this.graphFocus) return 'links:' + this.graphFocus;
    if (this.plugin.state.leftMode === 'tag') return 'tag:' + (this.plugin.state.activeTag || '');
    return 'folder:' + (this.path || '');
  }

  // 還原右欄卡片牆的捲動位置。
  // 難點：分批渲染 + 圖片/內文延遲載入 → 內容高度是「慢慢長出來」的，一次設 scrollTop 到不了深處。
  // 做法：分次嘗試——每次把 scrollTop 推到目標（會被當下 scrollHeight 夾住，順勢讓哨兵進視野、
  // 觸發補下一批卡片），直到到位、內容不再長高、或使用者自己動手捲動為止。
  restoreMainScroll() {
    const saved = this._mainScrollSaved;
    const main = this._main;
    if (!saved || !main || !saved.top || saved.key !== this.mainScrollKey()) return;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    main.addEventListener('wheel', cancel, { once: true, passive: true });
    main.addEventListener('touchstart', cancel, { once: true, passive: true });
    let lastH = -1, stale = 0, tries = 0;
    const attempt = () => {
      if (cancelled || this._main !== main || !main.isConnected) return;
      main.scrollTop = saved.top;
      if (Math.abs(main.scrollTop - saved.top) <= 4) return;          // 到位
      stale = main.scrollHeight === lastH ? stale + 1 : 0;            // 高度沒再長，累計就放棄
      lastH = main.scrollHeight;
      if (++tries < 40 && stale < 6) setTimeout(attempt, 50);         // 最多 ~2 秒
    };
    requestAnimationFrame(attempt);
  }

  // 右欄內容的分派。抽出來是為了讓搜尋打字時能「只重繪右欄」——
  // 若每次打字都跑整個 render()，輸入框會被重建 → 立刻失焦，根本沒法打字。
  renderMainContent(main, zoom) {
    if (this._barTitle) this._barTitle.empty();   // 各檢視自己填；連結牆等自帶表頭者留空
    const state = this.plugin.state;
    if (this._searchQ) { this.renderSearchWall(main, zoom); return; }
    const gf = this.graphFocus ? this.app.vault.getAbstractFileByPath(this.graphFocus) : null;
    if (gf instanceof TFile) {
      this.renderLinksWall(main, gf, zoom);
    } else {
      this.graphFocus = null;
      if (state.leftMode === 'tag') this.renderTagNotes(main, zoom);
      else this.renderNoteWall(main, this.folderAt(this.path), zoom);
    }
  }

  // 只重繪右欄（打字時用；搜尋列在 gn-root 底下，不會被清掉 → 保持焦點）
  rerenderMain() {
    if (!this._main) return;
    this._main.empty();
    this.renderMainContent(this._main, this._zoom);
  }

  // 搜尋結果 → 卡牆。keepOrder=true 保住 BM25 相關性排名（不套日期排序）
  renderSearchWall(main, zoom) {
    const idx = this.plugin.search;
    if (!idx.ready) { main.createDiv('gn-empty').setText(t('Building index…')); return; }
    const hits = idx.search(this._searchQ, 0);          // 0 = 不設上限（卡牆本來就懶載入）
    const files = hits
      .filter((h) => this.showHidden || !this.plugin.isHiddenPath(h.path))   // 跳過隱藏資料夾（眼睛開啟時照常顯示）
      .map((h) => this.app.vault.getAbstractFileByPath(h.path))
      .filter((f) => f instanceof TFile);
    this.renderNoteWall(
      main, null, zoom, files,
      t('Search "{{q}}" · {{n}} results', { q: this._searchQ, n: files.length }),
      true,                                            // keepOrder
      t('No matching notes')
    );
  }

  // 選 / 換待辦筆記
  pickTodoNote() {
    new FileSuggest(this.app, (file) => {
      this.plugin.state.todoNote = file.path;
      this.plugin.saveState();
      this.render();
    }).open();
  }

  // 勾選 / 取消勾選某一行任務（改寫 - [ ] ⇄ - [x]）
  async toggleTask(file, lineNo) {
    try {
      const raw = await this.app.vault.read(file);
      const lines = raw.split('\n');
      const m = (lines[lineNo] || '').match(/^(\s*[-*+]\s+\[)([ xX])(\].*)$/);
      if (!m) return;
      const done = m[2].toLowerCase() === 'x';
      lines[lineNo] = m[1] + (done ? ' ' : 'x') + m[3];
      await this.app.vault.modify(file, lines.join('\n'));
      if (this._todoPop) this.renderTodoInto(this._todoPop);   // 面板開著 → 只重繪面板，不收起
      else this.render();
    } catch (e) {
      new Notice(t('Failed to update task: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  // 左樹上方的待辦區（可整區收合、任務依縮排分層級）
  // 點待辦按鈕：彈出/收起浮動面板
  openTodoPopover(anchor) {
    if (this._todoPop) { this._todoPop.remove(); this._todoPop = null; return; }
    const pop = document.body.createDiv('gn-todo-pop');
    this._todoPop = pop;
    const rect = anchor.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    // 按鈕在下半部 → 往上彈；否則往下彈
    if (rect.top > window.innerHeight * 0.5) {
      pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    } else {
      pop.style.top = (rect.bottom + 6) + 'px';
    }
    this.renderTodoInto(pop);
    const closer = (e) => {
      if (!this._todoPop) return;
      if (this._todoPop.contains(e.target) || anchor.contains(e.target)) return;
      this._todoPop.remove(); this._todoPop = null;
      document.removeEventListener('mousedown', closer);
    };
    setTimeout(() => document.addEventListener('mousedown', closer), 0);
  }

  // 把待辦清單渲染進指定容器（面板用）
  renderTodoInto(box) {
    box.empty();
    const state = this.plugin.state;
    const head = box.createDiv('gn-todo-head');
    head.style.cursor = 'default';
    head.createSpan('gn-todo-title').setText(t('To-dos'));
    const gear = head.createSpan('gn-todo-gear');
    setIcon(gear, 'settings');
    gear.setAttr('title', t('Pick a to-do note'));
    gear.onclick = (e) => { e.stopPropagation(); this.pickTodoNote(); };

    const file = state.todoNote ? this.app.vault.getAbstractFileByPath(state.todoNote) : null;
    if (!(file instanceof TFile)) {
      const empty = box.createDiv('gn-todo-empty');
      setIcon(empty.createSpan('gn-todo-empty-ic'), 'plus');
      empty.createSpan().setText(t('Pick a to-do note'));
      empty.onclick = (e) => { e.stopPropagation(); this.pickTodoNote(); };
      return;
    }

    const list = box.createDiv('gn-todo-list');
    list.createDiv('gn-todo-none').setText(t('Loading…'));
    this.app.vault.cachedRead(file).then((raw) => {
      list.empty();
      const tasks = parseTasks(raw);
      if (!tasks.length) { list.createDiv('gn-todo-none').setText(t('No to-dos')); return; }
      for (const task of tasks) {   // ⚠️ 迴圈變數勿叫 t，會遮蔽 i18n 的 t()
        const item = list.createDiv('gn-todo-item');
        item.style.setProperty('--td-depth', String(task.depth));
        if (task.done) item.addClass('gn-todo-done');
        const chk = item.createSpan('gn-todo-check');
        if (task.done) setIcon(chk, 'check');
        chk.setAttr('title', task.done ? t('Mark as not done') : t('Mark as done'));
        chk.onclick = (e) => { e.stopPropagation(); this.toggleTask(file, task.line); };
        item.createSpan('gn-todo-text').setText(task.text);
        item.onclick = () => this.openNote(file, false);
      }
    }).catch(() => {
      list.empty();
      list.createDiv('gn-todo-none').setText(t('Cannot read the to-do note'));
    });
  }

  // 建標籤索引：tag 路徑（含祖先前綴）→ 筆記集合；以及未標籤清單
  buildTagIndex() {
    // 快取：僅在 metadata/檔案異動後（_tagDirty）才重建，避免每次 render 全 vault 掃描
    if (this._tagIndexCache && !this._tagDirty) return this._tagIndexCache;
    const map = new Map();     // 'a/b' -> Set<TFile>
    const untagged = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const tags = tagsOf(this.app.metadataCache.getFileCache(f));
      if (!tags.length) { untagged.push(f); continue; }
      const added = new Set();
      for (const t of tags) {
        const clean = String(t).replace(/^#/, '');
        let acc = '';
        for (const seg of clean.split('/')) {
          acc = acc ? acc + '/' + seg : seg;
          if (added.has(acc)) continue;
          added.add(acc);
          if (!map.has(acc)) map.set(acc, new Set());
          map.get(acc).add(f);
        }
      }
    }
    this._tagDirty = false;
    this._tagIndexCache = { map, untagged };
    return this._tagIndexCache;
  }

  toggleTag(path) {
    const set = new Set(this.plugin.state.expandedTags || []);
    if (set.has(path)) set.delete(path); else set.add(path);
    this.plugin.state.expandedTags = [...set];
    this.plugin.saveState();
    this.refreshTree();
  }

  // 左側：巢狀標籤樹（Bear 風）+ 未標籤
  renderTagTree(container) {
    const idx = this.buildTagIndex();
    this._tagIndex = idx;
    const { map, untagged } = idx;
    const expanded = new Set(this.plugin.state.expandedTags || []);
    const activeTag = this.plugin.state.activeTag;

    // 由 map 的路徑建巢狀樹
    const nodeMap = new Map();
    const roots = [];
    const getNode = (path) => {
      if (nodeMap.has(path)) return nodeMap.get(path);
      const parts = path.split('/');
      const node = { path, name: parts[parts.length - 1], children: [], count: map.has(path) ? map.get(path).size : 0 };
      nodeMap.set(path, node);
      if (parts.length === 1) roots.push(node);
      else getNode(parts.slice(0, -1).join('/')).children.push(node);
      return node;
    };
    [...map.keys()].sort().forEach((p) => getNode(p));

    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hant');
    const renderNode = (node, depth) => {
      const hasKids = node.children.length > 0;
      const isOpen = expanded.has(node.path);
      const row = container.createDiv('gn-tnode');
      row.style.setProperty('--gn-depth', String(depth));
      if (depth > 1) row.addClass('gn-tchild');
      if (activeTag === node.path) row.addClass('gn-tsel');
      const caret = row.createSpan('gn-tcaret');
      if (hasKids) {
        setIcon(caret, isOpen ? 'chevron-down' : 'chevron-right');
        caret.onclick = (e) => { e.stopPropagation(); this.toggleTag(node.path); };
      }
      setIcon(row.createSpan('gn-tthumb'), 'hash');
      row.createSpan('gn-tname').setText(node.name);
      row.createSpan('gn-tcount').setText(String(node.count));
      row.onclick = () => {
        this.plugin.state.activeTag = node.path;
        this.plugin.saveState();
        this.render();
        this.gotoCardsMobile();
      };
      if (hasKids && isOpen) node.children.slice().sort(byName).forEach((c) => renderNode(c, depth + 1));
    };
    roots.sort(byName).forEach((n) => renderNode(n, 1));

    // 未標籤
    const uRow = container.createDiv('gn-tnode');
    uRow.style.setProperty('--gn-depth', '1');
    if (activeTag === '__untagged__') uRow.addClass('gn-tsel');
    uRow.createSpan('gn-tcaret');
    setIcon(uRow.createSpan('gn-tthumb'), 'file-question');
    uRow.createSpan('gn-tname').setText(t('Untagged'));
    uRow.createSpan('gn-tcount').setText(String(untagged.length));
    uRow.onclick = () => { this.plugin.state.activeTag = '__untagged__'; this.plugin.saveState(); this.render(); this.gotoCardsMobile(); };
  }

  // 右側：目前選中標籤的筆記
  renderTagNotes(container, zoom) {
    const idx = this._tagIndex || this.buildTagIndex();
    const tag = this.plugin.state.activeTag;
    let files, head;
    if (tag === '__untagged__') { files = idx.untagged; head = t('Untagged'); }
    else if (tag && idx.map.has(tag)) { files = [...idx.map.get(tag)]; head = '#' + tag; }
    else { container.createDiv('gn-main-head').setText(t('Tags')); container.createDiv('gn-empty').setText(t('Pick a tag on the left')); return; }
    this.renderNoteWall(container, null, zoom, files, head);
  }

  /* ===== 多選 ===== */
  toggleSel(path) {
    if (this.selected.has(path)) this.selected.delete(path); else this.selected.add(path);
    for (const el of this.cardElsFor(path)) el.toggleClass('gn-card-selected', this.selected.has(path));
    this.updateSelBar();
  }
  rangeSel(a, b) {
    const order = this._cardOrder || [];
    let ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia < 0 || ib < 0) return;
    if (ia > ib) { const t = ia; ia = ib; ib = t; }
    for (let i = ia; i <= ib; i++) {
      this.selected.add(order[i]);
      for (const el of this.cardElsFor(order[i])) el.addClass('gn-card-selected');
    }
    this.updateSelBar();
  }
  selectAll() {
    for (const p of (this._cardOrder || [])) {
      this.selected.add(p);
      for (const el of this.cardElsFor(p)) el.addClass('gn-card-selected');
    }
    this.updateSelBar();
  }
  clearSel() {
    for (const p of this.selected) {
      for (const el of this.cardElsFor(p)) el.removeClass('gn-card-selected');
    }
    this.selected.clear();
    this.selAnchor = null;
    this.updateSelBar();
  }
  updateSelBar() {
    const bar = this._selBar;
    if (!bar) return;
    bar.empty();
    const n = this.selected.size;
    if (!n) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.createSpan('gn-selbar-count').setText(t('{{n}} selected', { n }));
    const mk = (label, icon, fn, warn) => {
      const b = bar.createDiv('gn-selbar-btn' + (warn ? ' gn-selbar-warn' : ''));
      setIcon(b, icon); b.setAttr('title', label);
      b.onclick = (e) => { e.stopPropagation(); fn(); };
    };
    mk(t('Select all'), 'check-check', () => this.selectAll());
    mk(t('Copy wiki links (one per line)'), 'link', () => this.copySelectedLinks());
    mk(t('Move to…'), 'folder-input', () => this.moveSelected());
    mk(t('Delete'), 'trash', () => this.deleteSelected(), true);
    mk(t('Clear selection'), 'x', () => this.clearSel());
  }

  // 批次選取 → 複製成 wiki 連結清單，一行一個 [[連結]]
  // 順序照卡片牆的排列（不是點選順序）；連結文字用 fileToLinktext，同名檔會自動帶上路徑避免撞名
  copySelectedLinks() {
    const order = (this._cardOrder || []).filter((p) => this.selected.has(p));
    const paths = order.length ? order : [...this.selected];
    const lines = [];
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      const link = this.app.metadataCache.fileToLinktext(f, '', true);
      lines.push('[[' + link + ']]');
    }
    if (!lines.length) { new Notice(t('Nothing to copy')); return; }
    copyToClipboard(lines.join('\n'), t('{{n}} wiki links', { n: lines.length }));
  }
  moveSelected() {
    const paths = [...this.selected];
    new FolderSuggest(this.app, async (target) => {
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) await this.moveItem(f, target);
      }
      this.selected.clear();
      this.render();
    }).open();
  }
  deleteSelected() {
    const paths = [...this.selected];
    new ConfirmModal(this.app, t('Delete the {{n}} selected items? (moves to trash)', { n: paths.length }), async () => {
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) { try { await this.app.fileManager.trashFile(f); } catch (e) {} }
      }
      this.selected.clear();
      this.render();
    }).open();
  }


  /* ===== 卡片牆基礎：資料夾牆 / 標籤牆 / 連結牆 共用 ===== */

  // 重置一面牆的共用狀態（瀑布流、多選、延遲載入觀察器、動作列）
  beginWall(container) {
    for (const m of (this._masonries || [])) { try { m.destroy(); } catch (e) {} }
    this._masonries = [];

    // 多選狀態：換頁重置
    this.selected.clear();
    this.selAnchor = null;
    this._cardEls = new Map();
    this._cardOrder = [];
    this._selBar = null;   // 動作列在 endWall() 才掛（sticky，必須排在所有卡片之後）

    // 延遲載入：卡片捲進畫面附近才載入內文預覽 / 抓連結 og:image
    // （大資料夾不會一次觸發數百個 cachedRead 或網路請求）
    if (this._ogObserver) this._ogObserver.disconnect();
    if (this._wallIO) { this._wallIO.disconnect(); this._wallIO = null; }
    this._ogObserver = new IntersectionObserver((entries, obs) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        obs.unobserve(en.target);
        const card = en.target;
        if (card._prevFile && card._prevEl) { this.loadPreview(card._prevFile, card._prevEl); card._prevFile = null; }
        if (card._ogFile) { this.loadLinkPreview(card._ogFile, card); card._ogFile = null; }
        if (card._pdfFile) { this.loadPdfThumb(card._pdfFile, card, card._pdfPh); card._pdfFile = null; }
      }
    }, { rootMargin: '400px' });
  }

  // 多選動作列：sticky bottom，必須排在所有卡片之後，牆建完才掛
  endWall(container) {
    this._selBar = container.createDiv('gn-selbar');
    this._selBar.style.display = 'none';
  }

  // 建一個瀑布流 grid。一面牆可以有多個（連結 / 反向連結各一區）
  makeGrid(container, zoom) {
    const grid = container.createDiv('gn-grid');
    // 桌機：依滑桿的最小欄寬自動算欄數。
    // 手機：改用**固定欄數**（設定頁可選 1 / 2 / 3 欄），不吃桌機調大後的 cardWidth，
    //       免得在窄螢幕被撐成 1 欄。
    const isMobileUI = document.body.classList.contains('is-mobile');
    const minCol = isMobileUI ? 120 : (this.plugin.state.cardWidth || 120);
    const fixedCols = isMobileUI ? (this.plugin.state.mobileCols || 2) : 0;
    const masonry = new MasonryLayout(grid, { gap: 16, minCol, fixedCols });   // 2026-07-18 12→16 更透氣
    if (!this._masonries) this._masonries = [];
    this._masonries.push(masonry);
    if (zoom) zoom.oninput = () => {
      const v = Number(zoom.value);
      this.plugin.state.cardWidth = v;
      for (const m of this._masonries) m.setMinCol(v);   // 兩區一起縮放
      this.plugin.saveState();
    };
    return { grid, masonry };
  }

  // 建一張卡片（原 renderNoteWall 內的邏輯，抽出來讓各區共用）
  // opts: { skipPreview }
  makeCard(grid, masonry, it, opts) {
    const o = opts || {};
    const cardColors = this.plugin.state.cardColors || {};
    const card = grid.createDiv('gn-card');
    if (!this._cardEls.has(it.file.path)) {
      this._cardEls.set(it.file.path, []);
      this._cardOrder.push(it.file.path);   // 順序表不重複，範圍選取才不會亂
    }
    this._cardEls.get(it.file.path).push(card);
    if (it.file.path === this.activePath) card.addClass('gn-card-active');
    const isMd = it.ext === 'md';
    const skipPreview = !!o.skipPreview;

    // 卡片底色（feature 1）：底色 + 對比字色
    const cp = cardColors[it.file.path] && CARD_PALETTE_BY_KEY[cardColors[it.file.path]];
    if (cp) {
      card.addClass('gn-card-colored');
      card.style.background = cp.bg;
      card.style.setProperty('--gn-card-fg', cp.fg);
    }
    // 釘選角標（feature 4）：點角標即取消釘選
    if (this.isPinned(it.file.path)) {
      card.addClass('gn-card-pinned');
      const pin = card.createDiv('gn-card-pin');
      setIcon(pin, 'pin');
      pin.setAttr('title', t('Unpin'));
      pin.onclick = (e) => { e.stopPropagation(); this.togglePin(it.file.path); };
    }
    // 文字區塊置頂（iOS 備忘錄式）：日期 → 粗標題
    const body = card.createDiv('gn-body');
    body.createDiv('gn-date').setText(fmtDate(it.ctime));
    const titleEl = body.createDiv('gn-title');
    if (this._searchQ) gnHighlightInto(titleEl, it.name, gnHighlightTerms(this._searchQ));
    else titleEl.setText(it.name);

    if (it.src) {
      // 有封面 → 圖片在上、標題/日期在下
      card.addClass('gn-has-img');
      const img = card.createEl('img');
      img.src = it.src;
      img.loading = 'lazy';
      img.decoding = 'async';   // 非同步解碼：不擋主執行緒（手機捲動時很有感）
      // 圖片卡不顯示內文（2026-07-18 使用者移除 hover 內文功能，也省下讀檔）
    } else if (!isMd) {
      // 非 md 且無封面 → 檔型圖示卡；Canvas 抓內部圖、PDF 渲染第一頁當縮圖
      body.createDiv('gn-filetype').setText(it.ext.toUpperCase());
      const ph = card.createDiv('gn-fileicon');
      setIcon(ph, iconForExt(it.ext));
      if (it.ext === 'canvas') this.loadCanvasThumb(it.file, card, ph);
      else if (it.ext === 'pdf' && window.pdfjsLib) { card._pdfFile = it.file; card._pdfPh = ph; }   // 捲到才渲染
    } else {
      // md 無封面 → 顯示內文預覽；同時試抓外部連結 og:image，抓到則以圖代文
      if (!skipPreview) {
        const prev = body.createDiv('gn-preview');
        card._prevEl = prev; card._prevFile = it.file;   // 延遲載入內文
      }
      card._ogFile = it.file;   // 捲到才抓 og:image（持久快取）
    }

    // 外連 wiki 關係按鈕：暫時停用（2026-07-18 使用者要求）。
    // 連結牆仍可從右鍵選單或其他入口進入；要復原把 false 改回 isMd 即可。
    if (false && isMd) {
      const lb = card.createDiv('gn-card-btn');
      setIcon(lb, 'link');
      lb.setAttr('title', t('Show linked notes'));
      lb.onclick = (e) => { e.stopPropagation(); this.showLinks(it.file); };
    }

    let ndrag = false;
    card.onclick = (e) => {
      if (ndrag) return;
      if (e.metaKey || e.ctrlKey) {
        // 起手第一下複選：把「目前開啟中的那張卡」一併納入——
        // 使用者的心理模型是「這張＋那張」是同一組動作（Finder 行為，2026-07-18）
        if (!this.selected.size && this.activePath && this.activePath !== it.file.path
            && this.cardElsFor(this.activePath).length) {
          this.toggleSel(this.activePath);
        }
        this.toggleSel(it.file.path);
        this.selAnchor = it.file.path;
      }
      else if (e.shiftKey && (this.selAnchor || this.activePath)) {
        // 範圍選取的錨點：優先用上次複選的卡，沒有就用目前開啟中的卡
        this.rangeSel(this.selAnchor || this.activePath, it.file.path);
      }
      else if (this.selected.size) { this.clearSel(); }
      else { this.openNote(it.file, false); }
    };

    // 拖曳搬移：把筆記拖到左側資料夾列
    card.setAttr('draggable', 'true');
    card.addEventListener('dragstart', (e) => {
      ndrag = true;
      this.drag = { kind: 'note', path: it.file.path };
      card.addClass('gn-card-dragging');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      this.drag = null;
      card.removeClass('gn-card-dragging');
      setTimeout(() => { ndrag = false; }, 0);
    });

    // 右鍵（桌機）/ 長按（手機）選單
    this.wireContextMenu(card, () => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle(t('Open')).setIcon('file').onClick(() => this.openNote(it.file, false)));
      menu.addItem((i) => i.setTitle(t('Open in new tab')).setIcon('plus').onClick(() => this.openNote(it.file, true)));
      menu.addItem((i) => i.setTitle(t('Move to…')).setIcon('folder-input').onClick(() =>
        new FolderSuggest(this.app, (target) => this.moveItem(it.file, target)).open()));
      if (it.src && this.plugin.state.enablePinterest) {
        const srcFolder = it.file.parent && it.file.parent.path !== '/' ? it.file.parent.path : '';
        menu.addItem((i) => i.setTitle(t('Pinterest visual search')).setIcon('search').onClick(() =>
          new PinterestModal(this.app, it.src, it.name, srcFolder).open()));
      }
      menu.addSeparator();
      // 釘選到頂部（feature 4）
      menu.addItem((i) => i.setTitle(this.isPinned(it.file.path) ? t('Unpin') : t('Pin to top'))
        .setIcon('pin').onClick(() => this.togglePin(it.file.path)));
      // 加入最愛（feature 3）
      menu.addItem((i) => i.setTitle(this.isFavorite('file', it.file.path) ? t('Remove from favorites') : t('Add to favorites'))
        .setIcon('star').onClick(() => this.toggleFavorite('file', it.file.path)));
      // 卡片顏色（feature 1）
      menu.addItem((i) => {
        i.setTitle(t('Card color')).setIcon('palette');
        const sub = i.setSubmenu();
        const cur = (this.plugin.state.cardColors || {})[it.file.path] || null;
        sub.addItem((s) => s.setTitle(t('None')).setChecked(!cur).onClick(() => this.setCardColor(it.file.path, null)));
        CARD_PALETTE.forEach((p) => {
          sub.addItem((s) => {
            s.setTitle(t(p.label)).setIcon('square').setChecked(cur === p.key)
              .onClick(() => this.setCardColor(it.file.path, p.key));
            try { if (s.iconEl) { s.iconEl.style.color = p.bg; s.iconEl.style.fill = p.bg; } } catch (e) {}
          });
        });
      });
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t('Copy wiki link')).setIcon('link').onClick(() => copyToClipboard('[[' + it.name + ']]')));
      if (this.canReveal()) {
        menu.addItem((i) => i.setTitle(t('Reveal in Finder')).setIcon('folder-open').onClick(() => this.revealInSystem(it.file)));
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t('Delete')).setIcon('trash').setWarning(true).onClick(() => this.confirmDelete(it.file)));
      return menu;
    });

    // 有延遲工作（內文預覽 / 連結圖 / PDF 縮圖）→ 掛觀察器，捲到附近才載入
    if (card._prevFile || card._ogFile || card._pdfFile) this._ogObserver.observe(card);

    masonry.add(card);
    return card;
  }

  // keepOrder: 保持傳入順序，不套日期排序、不把釘選浮到最前
  //            （搜尋結果必須維持 BM25 相關性排名，一排序就毀了）
  renderNoteWall(container, folder, zoom, filesOverride, headOverride, keepOrder, emptyText) {
    const app = this.app;

    // 攤平模式（全域開關）：遞迴顯示該資料夾底下所有子孫筆記
    const flatten = !filesOverride && folder && this.plugin.state.flattenFolders;

    const headText = headOverride || (folder && folder.path && folder.path !== '/' ? folder.path : this.app.vault.getName());
    const useBarTitle = this._barTitle && !document.body.classList.contains('is-mobile');
    const head = useBarTitle ? this._barTitle : container.createDiv('gn-main-head');
    if (useBarTitle) head.empty();
    if (!headOverride && folder) {
      // 麵包屑（2026-07-18）：vault 名 + 各層資料夾皆可點擊跳轉；斜線灰色、間隔加寬
      const crumbs = head.createDiv('gn-bar-crumbs');
      const segs = folder.path && folder.path !== '/' ? folder.path.split('/') : [];
      const rootEl = crumbs.createSpan({ cls: 'gn-crumb2' + (segs.length ? '' : ' gn-crumb2-cur'), text: this.app.vault.getName() });
      rootEl.onclick = () => this.navigate('');
      let acc = '';
      segs.forEach((seg, i) => {
        crumbs.createSpan({ cls: 'gn-crumb2-sep', text: '/' });
        acc = acc ? acc + '/' + seg : seg;
        const p = acc;
        const el = crumbs.createSpan({ cls: 'gn-crumb2' + (i === segs.length - 1 ? ' gn-crumb2-cur' : ''), text: seg });
        el.onclick = () => this.navigate(p);
      });
    } else {
      head.createSpan({ cls: 'gn-bar-title-text', text: headText });
    }
    if (flatten) head.createSpan({ cls: 'gn-head-flat', text: t('Including subfolders') });
    // 標籤篩選中 → 表頭掛上小標（點一下即清除），免得忘了自己開著篩選
    const tagFilterOn = !filesOverride && this._tagFilter && this._tagFilter.size;
    if (tagFilterOn) {
      const chip = head.createSpan({ cls: 'gn-head-flat gn-head-tag', text: '#' + [...this._tagFilter].join(' #') + ' ✕' });
      chip.setAttr('title', t('Clear tag filter'));
      chip.onclick = () => { this._tagFilter = new Set(); this.rerenderMain(); };
    }

    let items = filesOverride
      ? filesOverride.map((f) => itemFromFile(app, f))
      : (flatten ? notesInDeep(app, folder, new Set(this.plugin.state.hiddenFolders || [])) : notesIn(app, folder));
    // 本夾標籤篩選（「更多」面板的膠囊；多選＝OR，含子標籤）
    if (tagFilterOn) items = items.filter((it) => it.ext === 'md' && this.matchTagFilter(it.file));
    const sorted = keepOrder ? items : sortItems(items, this.plugin.state.sort || 'new');
    // 釘選的卡片浮到最前（feature 4），其餘維持原排序
    const pinnedSet = new Set(this.plugin.state.pinnedCards || []);
    const notes = keepOrder ? sorted : [
      ...sorted.filter((it) => pinnedSet.has(it.file.path)),
      ...sorted.filter((it) => !pinnedSet.has(it.file.path)),
    ];
    // 此資料夾是否隱藏內文預覽
    const perFolderHide = folder ? (this.plugin.state.noPreviewFolders || []).includes(folder.path) : false;

    this.beginWall(container);
    const { grid, masonry } = this.makeGrid(container, zoom);

    if (!notes.length) {
      container.createDiv('gn-empty').setText(emptyText || t('No notes'));
      return;
    }

    // ⚠️ 分批渲染（不要一次畫完）：
    //   img/ 這種 4000+ 檔的資料夾若一次生成 4000 張卡片，光是瀑布流重排就要量測 4000 次 offsetHeight，
    //   旋轉螢幕／切分頁時整批重排 → iOS WebView 記憶體爆掉 → Obsidian 直接重載。
    //   改成先畫一批，捲到底再補下一批（哨兵 + IntersectionObserver）。
    this.renderInChunks(container, grid, masonry, notes, { skipPreview: perFolderHide });
    this.endWall(container);
  }

  // 分批把卡片畫進瀑布流：先畫第一批，捲到接近底部才補下一批
  renderInChunks(container, grid, masonry, notes, opts) {
    const isMobileUI = document.body.classList.contains('is-mobile');
    const CHUNK = isMobileUI ? 40 : 120;      // 手機一次 40 張、桌機 120 張
    let drawn = 0;

    const drawNext = () => {
      const end = Math.min(drawn + CHUNK, notes.length);
      for (let i = drawn; i < end; i++) this.makeCard(grid, masonry, notes[i], opts || {});
      drawn = end;
      if (drawn >= notes.length && this._wallIO) { this._wallIO.disconnect(); this._wallIO = null; }
      if (sentinel) sentinel.style.display = drawn >= notes.length ? 'none' : '';
    };

    // 哨兵放在瀑布流下方；進入視野（提前 600px）就補下一批
    const sentinel = container.createDiv('gn-wall-sentinel');
    if (this._wallIO) this._wallIO.disconnect();
    this._wallIO = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) drawNext();
    }, { root: container.closest('.gn-main') || null, rootMargin: '600px 0px' });

    drawNext();                       // 第一批
    // ⚠️ 資料夾 ≤ 一批的量時，第一批就畫完 → drawNext 已把 _wallIO 收掉設 null，
    //    直接 .observe 會炸 "null is not an object"（且 render 中斷 → 手機點資料夾不跳欄）。
    if (this._wallIO) this._wallIO.observe(sentinel);
  }

  // 右欄：某則筆記的關係牆。沿用卡片牆的呈現，分「連結」與「反向連結」兩區
  renderLinksWall(container, file, zoom) {
    const app = this.app;

    // 標頭：返回 + 筆記名 + 開啟
    const head = container.createDiv('gn-main-head gn-links-head');
    const back = head.createDiv('gn-btn');
    setIcon(back, 'arrow-left');
    back.setAttr('title', t('Back to card wall'));
    back.onclick = () => { this.graphFocus = null; this.render(); };
    head.createDiv('gn-links-title').setText(file.basename);
    const openBtn = head.createDiv('gn-btn');
    setIcon(openBtn, 'file');
    openBtn.setAttr('title', t('Open this note'));
    openBtn.onclick = () => this.openNote(file, false);

    const outFiles = this.outgoingMdFiles(file);
    const inFiles = this.incomingMdFiles(file);

    this.beginWall(container);

    const sort = this.plugin.state.sort || 'new';
    const section = (label, icon, files) => {
      const sec = container.createDiv('gn-links-sec');
      const sh = sec.createDiv('gn-links-sec-head');
      setIcon(sh.createSpan('gn-links-sec-icon'), icon);
      sh.createSpan({ cls: 'gn-links-sec-label', text: label });
      sh.createSpan({ cls: 'gn-links-sec-count', text: String(files.length) });
      if (!files.length) {
        sec.createDiv('gn-links-sec-empty').setText(t('None'));
        return;
      }
      const notes = sortItems(files.map((f) => itemFromFile(app, f)), sort);
      const { grid, masonry } = this.makeGrid(sec, zoom);
      for (const it of notes) this.makeCard(grid, masonry, it, {});
    };

    // 連結＝這則筆記連出去的；反向連結＝誰引用了這則
    section(t('Links'), 'arrow-up-right', outFiles);
    section(t('Backlinks'), 'corner-down-left', inFiles);
    this.endWall(container);
  }
}

/* ===== 行事曆（Mini Calendar，讀 Google ICS，唯讀）===== */

const CAL_VIEW_TYPE = 'gallery-navigator-calendar';
const CAL_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const CAL_WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAL_DOT_COLORS = ['#ef5da8', '#8a5cf6', '#5ac8c8', '#f2913d', '#3a86ff', '#43b581', '#e0518f', '#e9b949'];

const calStartOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const calAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const calSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const calPad2 = (n) => String(n).padStart(2, '0');
const calHHMM = (d) => calPad2(d.getHours()) + ':' + calPad2(d.getMinutes());

function calUnfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, ''); }
function calUnescape(s) { return String(s).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
function calParseDate(val) {
  if (!val) return null;
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
  const date = m[7] ? new Date(Date.UTC(y, mo, d, hh, mi, ss)) : new Date(y, mo, d, hh, mi, ss);
  return { date, allDay: !m[4] };
}
function calParseICS(text) {
  const lines = calUnfold(text).split('\n');
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':'); if (idx < 0) continue;
    let key = line.slice(0, idx); const val = line.slice(idx + 1);
    const semi = key.indexOf(';'); if (semi >= 0) key = key.slice(0, semi);
    if (key === 'SUMMARY') cur.summary = calUnescape(val);
    else if (key === 'LOCATION') cur.location = calUnescape(val);
    else if (key === 'DTSTART') cur.start = calParseDate(val);
    else if (key === 'DTEND') cur.end = calParseDate(val);
    else if (key === 'RRULE') cur.rrule = val;
    else if (key === 'EXDATE') { cur.exdates = cur.exdates || []; for (const part of val.split(',')) { const p = calParseDate(part); if (p) cur.exdates.push(p.date.getTime()); } }
  }
  return events;
}
function calParseRRule(s) { const out = {}; for (const p of String(s).split(';')) { const kv = p.split('='); if (kv[0]) out[kv[0]] = kv[1]; } return out; }
function calExpand(ev, color, calName, winStart, winEnd) {
  const occ = []; if (!ev.start || !ev.start.date) return occ;
  const durMs = (ev.end && ev.end.date) ? Math.max(0, ev.end.date - ev.start.date) : (ev.start.allDay ? 86400000 : 3600000);
  const exset = new Set(ev.exdates || []);
  const push = (sd) => {
    if (exset.has(sd.getTime())) return;
    const end = new Date(sd.getTime() + durMs);
    if (end < winStart || sd > winEnd) return;
    occ.push({ start: sd, end, allDay: ev.start.allDay, summary: ev.summary || t('(untitled)'), location: ev.location || '', color, calName });
  };
  if (!ev.rrule) { push(new Date(ev.start.date)); return occ; }
  const rule = calParseRRule(ev.rrule);
  const freq = rule.FREQ, interval = Math.max(1, +(rule.INTERVAL || 1));
  const count = rule.COUNT ? +rule.COUNT : null;
  const until = rule.UNTIL ? (calParseDate(rule.UNTIL) || {}).date : null;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((x) => x.replace(/^[+-]?\d+/, '')) : null;
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let cursor = new Date(ev.start.date), n = 0;
  for (let i = 0; i < 2000; i++) {
    if (count != null && n >= count) break;
    if (until && cursor > until) break;
    if (cursor > winEnd) break;
    if (freq === 'WEEKLY' && byday && byday.length) {
      const weekStart = calAddDays(cursor, -cursor.getDay());
      for (const bd of byday) {
        const target = calAddDays(weekStart, DOW[bd] != null ? DOW[bd] : 0);
        target.setHours(cursor.getHours(), cursor.getMinutes(), cursor.getSeconds(), 0);
        if (target >= ev.start.date && (!until || target <= until)) push(new Date(target));
      }
    } else { push(new Date(cursor)); }
    n++;
    if (freq === 'DAILY') cursor = calAddDays(cursor, interval);
    else if (freq === 'WEEKLY') cursor = calAddDays(cursor, 7 * interval);
    else if (freq === 'MONTHLY') { const c = new Date(cursor); c.setMonth(c.getMonth() + interval); cursor = c; }
    else if (freq === 'YEARLY') { const c = new Date(cursor); c.setFullYear(c.getFullYear() + interval); cursor = c; }
    else break;
  }
  return occ;
}

class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const now = new Date();
    this.viewYear = now.getFullYear(); this.viewMonth = now.getMonth();
    this.selected = calStartOfDay(now);
  }
  getViewType() { return CAL_VIEW_TYPE; }
  getDisplayText() { return 'Mini Calendar'; }
  getIcon() { return 'calendar'; }
  async onOpen() { this.render(); this.loadFeeds(); }

  loadFeeds() { this.plugin.loadCalFeeds(); }   // 抓取集中在 plugin（與迷你月曆共用快取）
  occurrences(winStart, winEnd) { return this.plugin.calOccurrences(winStart, winEnd); }
  gotoMonth(delta) {
    let m = this.viewMonth + delta, y = this.viewYear;
    while (m < 0) { m += 12; y--; } while (m > 11) { m -= 12; y++; }
    this.viewMonth = m; this.viewYear = y; this.render();
  }
  gotoToday() { const now = new Date(); this.viewYear = now.getFullYear(); this.viewMonth = now.getMonth(); this.selected = calStartOfDay(now); this.render(); }

  render() {
    const root = this.contentEl; root.empty(); root.addClass('mc-root');
    const today = calStartOfDay(new Date());
    const first = new Date(this.viewYear, this.viewMonth, 1);
    const gridStart = calAddDays(first, -first.getDay());
    const gridEnd = calAddDays(gridStart, 41);
    const agendaDays = this.plugin.state.agendaDays || 14;
    const winStart = calStartOfDay(this.selected < gridStart ? this.selected : gridStart);
    const winEnd = calAddDays(this.selected, agendaDays) > gridEnd ? calAddDays(this.selected, agendaDays) : gridEnd;
    const occ = this.occurrences(winStart, calAddDays(winEnd, 1));

    const dotsByDay = new Map();
    for (const o of occ) {
      const k = o.start.getFullYear() + '-' + o.start.getMonth() + '-' + o.start.getDate();
      if (!dotsByDay.has(k)) dotsByDay.set(k, []);
      const arr = dotsByDay.get(k);
      if (arr.length < 3 && !arr.includes(o.color)) arr.push(o.color);
    }

    const head = root.createDiv('mc-head');
    const title = head.createDiv('mc-title');
    title.createSpan('mc-month').setText(t(CAL_MONTHS[this.viewMonth]));
    title.createSpan('mc-year').setText(' ' + this.viewYear);
    head.createDiv('mc-head-spacer');
    // 控制鈕收進毛玻璃膠囊（與懸浮工具列同語言）
    const pill = head.createDiv('mc-toolpill');
    const prev = pill.createDiv('mc-iconbtn'); setIcon(prev, 'chevron-left'); prev.setAttr('title', t('Previous month')); prev.onclick = () => this.gotoMonth(-1);
    const todayBtn = pill.createDiv('mc-iconbtn mc-today-btn'); todayBtn.setText(t('Today')); todayBtn.setAttr('title', t('Go to today')); todayBtn.onclick = () => this.gotoToday();
    const next = pill.createDiv('mc-iconbtn'); setIcon(next, 'chevron-right'); next.setAttr('title', t('Next month')); next.onclick = () => this.gotoMonth(1);
    const refresh = pill.createDiv('mc-iconbtn'); setIcon(refresh, 'refresh-cw'); refresh.setAttr('title', t('Refresh')); refresh.onclick = () => this.loadFeeds();

    const wk = root.createDiv('mc-weekdays');
    for (const w of CAL_WEEKDAYS) wk.createSpan('mc-weekday').setText(t(w));

    // 有每日筆記的日子（用快取索引，不每次全掃）
    const noteDays = this.plugin.buildCalNoteIndex().noteDays;

    const grid = root.createDiv('mc-grid');
    for (let i = 0; i < 42; i++) {
      const day = calAddDays(gridStart, i);
      const cell = grid.createDiv('mc-cell');
      if (day.getMonth() !== this.viewMonth) cell.addClass('mc-other');
      if (calSameDay(day, today)) cell.addClass('mc-today');
      if (calSameDay(day, this.selected)) cell.addClass('mc-selected');
      if (noteDays.has(day.getFullYear() + '-' + calPad2(day.getMonth() + 1) + '-' + calPad2(day.getDate()))) cell.addClass('mc-hasnote');
      cell.createSpan('mc-num').setText(String(day.getDate()));
      const dots = dotsByDay.get(day.getFullYear() + '-' + day.getMonth() + '-' + day.getDate());
      if (dots && dots.length) { const w = cell.createDiv('mc-dots'); for (const c of dots) { const dd = w.createSpan('mc-dot'); dd.style.background = c; } }
      cell.onclick = () => { this.selected = calStartOfDay(day); this.render(); };
    }

    const sheet = root.createDiv('mc-sheet');
    sheet.createDiv('mc-handle');
    const list = sheet.createDiv('mc-agenda');
    this.renderDayNotes(list, this.selected);   // 當日筆記（不依賴 ICS）
    if (this.plugin.calLoading) { list.createDiv('mc-hint').setText(t('Loading…')); return; }
    if (!(this.plugin.state.calFeeds || []).some((f) => f.url && f.url.trim())) {
      list.createDiv('mc-hint').setText(t('No calendars yet. Paste your Google Calendar ICS URL in Settings → Gallery Navigator.'));
      return;
    }
    if (this.plugin.calError) list.createDiv('mc-hint mc-err').setText(this.plugin.calError);
    buildDayTimeline(list, this.selected, occ);
  }

  // 當日筆記：①檔名以該日日期開頭的每日筆記 ②當天建立(ctime)的筆記
  renderDayNotes(container, day) {
    const dateStr = day.getFullYear() + '-' + calPad2(day.getMonth() + 1) + '-' + calPad2(day.getDate());
    const idx = this.plugin.buildCalNoteIndex();   // O(1) 查表，不每次全掃
    const dated = (idx.datedByDay.get(dateStr) || []).slice().sort((a, b) => a.basename.localeCompare(b.basename));
    const datedSet = new Set(dated.map((f) => f.path));
    const created = (idx.createdByDay.get(dateStr) || []).filter((f) => !datedSet.has(f.path))
      .sort((a, b) => a.stat.ctime - b.stat.ctime);

    const sec = container.createDiv('mc-notes');
    const noteRow = (f, timeLabel) => {
      const row = sec.createDiv('mc-note');
      setIcon(row.createSpan('mc-note-icon'), 'file-text');
      row.createSpan('mc-note-name').setText(f.basename);
      if (timeLabel) row.createSpan('mc-note-time').setText(timeLabel);
      row.onclick = () => this.openNoteNoSync(f.path);
    };
    const groupHead = (text, extraClass) => sec.createDiv('mc-notes-head' + (extraClass ? ' ' + extraClass : '')).createSpan('mc-notes-title').setText(text);

    // ① 當日筆記（日期命名）
    groupHead(t('Daily notes'));
    if (dated.length) { for (const f of dated) noteRow(f); }
    else {
      const add = sec.createDiv('mc-notes-add');
      setIcon(add.createSpan('mc-note-icon'), 'plus');
      add.createSpan().setText(t('Create daily note'));
      add.onclick = () => this.createDailyNote(day);
    }

    // ② 當天建立（依 ctime）
    if (created.length) {
      groupHead(t('Created that day ({{n}})', { n: created.length }), 'mc-notes-head2');
      for (const f of created) noteRow(f, calHHMM(new Date(f.stat.ctime)));
    }
  }

  // 從日曆開筆記：設跳過旗標，避免牽動畫廊同步（跨資料夾整頁重畫）
  openNoteNoSync(path) {
    this.plugin._skipNextSync = true;
    window.setTimeout(() => { this.plugin._skipNextSync = false; }, 800);   // 安全網：沒觸發就自動清
    this.app.workspace.openLinkText(path, '', false);
  }

  async createDailyNote(day) {
    const dateStr = day.getFullYear() + '-' + calPad2(day.getMonth() + 1) + '-' + calPad2(day.getDate());
    const wd = t(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()]);
    const folder = this.app.vault.getAbstractFileByPath('每日筆記') ? '每日筆記/' : '';
    let path = folder + dateStr + ' ' + wd + '.md';
    let f = this.app.vault.getAbstractFileByPath(path);
    try {
      if (!f) f = await this.app.vault.create(path, await this.dailyTemplateContent(dateStr, wd));
      this.openNoteNoSync(f.path);
      this.render();
    } catch (e) { new Notice(t('Failed to create: {{msg}}', { msg: e && e.message ? e.message : e })); }
  }

  // 每日筆記模板：讀「設定 → 行事曆 → 每日筆記模板」指定的筆記，代入變數。
  // 支援 {{title}}（檔名）、{{date}}（YYYY-MM-DD）、{{time}}（HH:mm）、{{weekday}}（週X）。
  // 未設定 → 自動沿用 Obsidian 核心「每日筆記」外掛設定的模板（零設定開箱即用）。
  // 兩者都沒有 → 空白；設了但找不到檔 → 提示並建空白（不擋建立流程）。
  async dailyTemplateContent(dateStr, wd) {
    let p = (this.plugin.state.calDailyTemplate || '').trim();
    if (!p) {
      try {
        const dn = this.app.internalPlugins.getPluginById('daily-notes');
        p = ((dn && dn.instance && dn.instance.options && dn.instance.options.template) || '').trim();
      } catch (e) { /* 內部 API 變動時安靜退回空白 */ }
    }
    if (!p) return '';
    if (!/\.md$/i.test(p)) p += '.md';   // 核心設定存的路徑不帶副檔名（如 Template/每日筆記）
    const tf = this.app.vault.getAbstractFileByPath(p);
    if (!(tf instanceof TFile)) {
      new Notice(t('Daily note template not found: {{path}} (created a blank note)', { path: p }));
      return '';
    }
    const now = new Date();
    return (await this.app.vault.cachedRead(tf))
      .replace(/\{\{\s*title\s*\}\}/gi, dateStr + ' ' + wd)
      .replace(/\{\{\s*date\s*\}\}/gi, dateStr)
      .replace(/\{\{\s*time\s*\}\}/gi, calPad2(now.getHours()) + ':' + calPad2(now.getMinutes()))
      .replace(/\{\{\s*weekday\s*\}\}/gi, (isZh() ? '週' : '') + wd);
  }
}

// 單日時間軸（共用：完整檢視 + 迷你月曆 hover 浮層）
// 左側小時刻度，事件依起訖時間定位成方塊（重疊自動並排）
function buildDayTimeline(container, day, occ) {
    const HOUR_H = 50;                       // 每小時高度(px)
    const PXMIN = HOUR_H / 60;
    const dayStart = calStartOfDay(day), dayEnd = calAddDays(dayStart, 1);
    const ds = dayStart.getTime(), de = dayEnd.getTime();
    const today = calStartOfDay(new Date());

    // 選取日標題
    const dh = container.createDiv('mc-dayhead');
    dh.createSpan('mc-dayname').setText(t(CAL_WEEKDAYS_LONG[day.getDay()]));
    dh.createSpan('mc-daynum').setText(t('{{m}}/{{d}}', { m: day.getMonth() + 1, d: day.getDate() }));

    const dayItems = occ.filter((o) => o.start.getTime() < de && o.end.getTime() > ds);
    const allDay = dayItems.filter((o) => o.allDay);
    const timed = dayItems.filter((o) => !o.allDay).map((o) => {
      const s = Math.max(o.start.getTime(), ds), e = Math.min(o.end.getTime(), de);
      return { o, startMin: (s - ds) / 60000, endMin: Math.max((e - ds) / 60000, (s - ds) / 60000 + 15) };
    });

    // 全天事件：頂部藥丸
    if (allDay.length) {
      const wrap = container.createDiv('mc-allday');
      for (const o of allDay) {
        const p = wrap.createDiv('mc-allday-pill');
        p.style.setProperty('--mc-c', o.color);
        p.setText(o.summary);
      }
    }
    if (!timed.length) {
      if (!allDay.length) container.createDiv('mc-hint').setText(t('No timed events this day.'));
      return;
    }

    // 顯示範圍：涵蓋所有事件的整點
    let startHour = 24, endHour = 0;
    for (const t of timed) { startHour = Math.min(startHour, Math.floor(t.startMin / 60)); endHour = Math.max(endHour, Math.ceil(t.endMin / 60)); }
    startHour = Math.max(0, startHour); endHour = Math.min(24, Math.max(endHour, startHour + 1));

    // 重疊分欄（lane）
    timed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [], curEnd = -1;
    const clusters = [];
    for (const t of timed) {
      if (cluster.length && t.startMin >= curEnd) { clusters.push(cluster); cluster = []; curEnd = -1; }
      cluster.push(t); curEnd = Math.max(curEnd, t.endMin);
    }
    if (cluster.length) clusters.push(cluster);
    for (const cl of clusters) {
      const laneEnds = [];
      for (const t of cl) {
        let placed = false;
        for (let i = 0; i < laneEnds.length; i++) { if (t.startMin >= laneEnds[i]) { t.lane = i; laneEnds[i] = t.endMin; placed = true; break; } }
        if (!placed) { t.lane = laneEnds.length; laneEnds.push(t.endMin); }
      }
      for (const t of cl) t.lanes = laneEnds.length;
    }

    const tl = container.createDiv('mc-timeline');
    tl.style.height = ((endHour - startHour) * HOUR_H) + 'px';
    // 小時線 + 標籤
    for (let h = startHour; h <= endHour; h++) {
      const y = (h - startHour) * HOUR_H;
      const line = tl.createDiv('mc-hourline'); line.style.top = y + 'px';
      const lbl = tl.createDiv('mc-hourlabel'); lbl.style.top = y + 'px'; lbl.setText(calPad2(h % 24) + ':00');
    }
    // 現在時間線（僅選取日=今天時）
    if (calSameDay(day, today)) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= startHour * 60 && nowMin <= endHour * 60) {
        const nl = tl.createDiv('mc-nowline'); nl.style.top = ((nowMin - startHour * 60) * PXMIN) + 'px';
      }
    }
    // 事件方塊
    const area = tl.createDiv('mc-events');
    for (const t of timed) {
      const b = area.createDiv('mc-block');
      b.style.setProperty('--mc-c', t.o.color);
      b.style.top = ((t.startMin - startHour * 60) * PXMIN) + 'px';
      b.style.height = Math.max(20, (t.endMin - t.startMin) * PXMIN - 2) + 'px';
      b.style.left = (t.lane / t.lanes * 100) + '%';
      b.style.width = 'calc(' + (100 / t.lanes) + '% - 3px)';
      b.createDiv('mc-btime').setText(calHHMM(t.o.start) + (t.o.end - t.o.start >= 60000 ? '–' + calHHMM(t.o.end) : ''));
      b.createDiv('mc-btitle').setText(t.o.summary);
      if (t.o.location && (t.endMin - t.startMin) * PXMIN > 44) b.createDiv('mc-bsub').setText(t.o.location);
    }
}

class CalendarSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  /* 小工具：一個功能分組的標題（左對齊、正常字色的 H2） */
  group(containerEl, title, desc) {
    const h = containerEl.createEl('h2', { text: title, cls: 'gn-set-h' });
    if (desc) containerEl.createEl('p', { text: desc, cls: 'setting-item-description gn-set-desc' });
    return h;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('gn-settings');
    const st = this.plugin.state;
    const save = () => this.plugin.saveState();
    const reloadHint = () => new Notice(t('Takes effect after reloading the plugin (or restarting Obsidian)'), 5000);

    /* ══ 0. 語言 ══ */
    new Setting(containerEl).setName(t('Language'))
      .setDesc(t('Interface language. Auto follows the Obsidian language setting.'))
      .addDropdown((d) => {
        d.addOption('', t('Auto'));
        d.addOption('en', 'English');
        d.addOption('zh-TW', '繁體中文');
        d.setValue(st.lang || '');
        d.onChange((v) => { st.lang = v; setLang(v); save(); this.display(); this.plugin.refreshViews(); this.plugin.refreshCalViews(); });
      });

    /* ══ 1. 卡片牆（核心，永遠啟用） ══ */
    this.group(containerEl, t('Card wall'));
    new Setting(containerEl)
      .setName(t('Mobile columns'))
      .setDesc(t('Mobile uses a fixed column count. On desktop, use the card size slider in the toolbar more panel.'))
      .addDropdown((d) => {
        d.addOption('1', t('1 column')); d.addOption('2', t('2 columns')); d.addOption('3', t('3 columns'));
        d.setValue(String(st.mobileCols || 2));
        d.onChange((v) => {
          st.mobileCols = Math.min(3, Math.max(1, +v || 2));
          save();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName(t('Pinterest visual search (experimental)'))
      .setDesc(t('Adds a reverse-image search entry to image menus. Uses an unofficial Pinterest endpoint that may stop working at any time; the image you search with is uploaded to Pinterest.'))
      .addToggle((tg) => tg.setValue(!!st.enablePinterest)
        .onChange((v) => { st.enablePinterest = v; save(); this.plugin.refreshViews(); }));

    /* ══ 2. 圖片預覽 ══ */
    this.group(containerEl, t('Image peek'), t('Double-click an image or press Space for a Quick Look style preview; includes Pinterest visual search.'));
    new Setting(containerEl)
      .setName(t('Enable image peek'))
      .addToggle((tg) => tg.setValue(st.enablePeek !== false)
        .onChange((v) => { st.enablePeek = v; save(); reloadHint(); this.display(); }));
    if (st.enablePeek !== false && this.plugin.renderPeekSettings) {
      this.plugin.renderPeekSettings(containerEl, this.plugin);
    }

    /* ══ 3. 連結卡片 ══ */
    this.group(containerEl, t('Link cards'), t('Bare URLs on their own line become rich preview cards (reading mode / Live Preview / Canvas).'));
    new Setting(containerEl)
      .setName(t('Enable link cards'))
      .addToggle((tg) => tg.setValue(st.enableLinkCards !== false)
        .onChange((v) => { st.enableLinkCards = v; save(); reloadHint(); this.display(); }));
    if (st.enableLinkCards !== false && this.plugin.renderLinkCardSettings) {
      this.plugin.renderLinkCardSettings(containerEl, this.plugin);
    }

    /* ══ 4. 行事曆 ══ */
    this.group(containerEl, t('Calendar'),
      t('Paste the secret iCal URL of your Google Calendar (Calendar settings → Integrate calendar → URL ending in .ics). Multiple calendars supported, one color each.'));
    new Setting(containerEl).setName(t('Agenda days')).setDesc(t('How many days ahead the agenda lists events'))
      .addText((tx) => tx.setValue(String(st.agendaDays || 14))
        .onChange((v) => { st.agendaDays = Math.max(1, +v || 14); save(); }));

    new Setting(containerEl).setName(t('Daily note template'))
      .setDesc(t('Applied when creating a daily note from the calendar. Supports {{title}}, {{date}}, {{time}}, {{weekday}}. Leave empty to use the template from the core Daily notes plugin.'))
      .addText((tx) => {
        tx.setPlaceholder(t('e.g. Templates/Daily.md')).setValue(st.calDailyTemplate || '')
          .onChange((v) => { st.calDailyTemplate = v.trim(); save(); });
        tx.inputEl.style.width = '240px';
      })
      .addExtraButton((b) => b.setIcon('search').setTooltip(t('Pick a template note from the vault'))
        .onClick(() => new FileSuggest(this.app, (f) => {
          st.calDailyTemplate = f.path; save(); this.display();
        }, t('Pick a daily note template…')).open()));

    const feeds = st.calFeeds || (st.calFeeds = []);
    feeds.forEach((feed, idx) => {
      new Setting(containerEl).setName(t('Calendar {{n}}', { n: idx + 1 }))
        .addText((tx) => tx.setPlaceholder(t('Name')).setValue(feed.name || '')
          .onChange((v) => { feed.name = v; save(); }))
        .addText((tx) => {
          tx.setPlaceholder(t('ICS URL (.ics)')).setValue(feed.url || '').onChange((v) => { feed.url = v; save(); });
          tx.inputEl.style.width = '240px';
        })
        .addColorPicker((c) => c.setValue(feed.color || CAL_DOT_COLORS[idx % CAL_DOT_COLORS.length])
          .onChange((v) => { feed.color = v; save(); }))
        .addExtraButton((b) => b.setIcon('trash').setTooltip(t('Remove'))
          .onClick(() => { feeds.splice(idx, 1); save(); this.display(); }));
    });
    new Setting(containerEl).addButton((b) => b.setButtonText(t('+ Add calendar')).setCta()
      .onClick(() => { feeds.push({ name: '', url: '', color: CAL_DOT_COLORS[feeds.length % CAL_DOT_COLORS.length] }); save(); this.display(); }));
    new Setting(containerEl).addButton((b) => b.setButtonText(t('Reload calendars'))
      .onClick(() => { this.plugin.loadCalFeeds(); new Notice(t('Reloading…')); }));
  }
}

/* ===== Plugin ===== */

/* ==================== 搜尋索引（ICU 斷詞 + bigram 兜底 + BM25）====================
   為什麼要混合兩種斷詞：
   - Intl.Segmenter（瀏覽器內建 ICU）：詞義正確、排名準，但會切錯。
       實測「極簡直觀」→ [極][簡直][觀]，導致搜「極簡」「直觀」全都漏掉。
   - bigram（雙字元）：把「設計思考」拆成 設計/計思/思考，絕不漏搜，但雜訊多、排名差。
   → 兩者同時索引：ICU 負責「排名準」，bigram 負責「不漏搜」。
   （Omnisearch 要另外裝 Chinese Segmenter 才能搜中文，這裡不用。）
   ============================================================================ */

const GN_CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const _gnSeg = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter('zh-TW', { granularity: 'word' })
  : null;

function gnTokenize(text) {
  const out = [];
  if (!text) return out;
  const s = String(text).toLowerCase();
  if (_gnSeg) {
    for (const x of _gnSeg.segment(s)) if (x.isWordLike) out.push(x.segment);
  } else {
    for (const m of s.match(/[a-z0-9_]+/g) || []) out.push(m); // 沒有 Segmenter 時的退路
  }
  // CJK bigram 兜底
  const runs = s.match(GN_CJK_RUN);
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

// 去掉 frontmatter / 程式碼區塊 / 網址，減少索引雜訊
function gnCleanBody(raw) {
  let s = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/!?\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, ' $1 ');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  return s;
}

// 查詢用斷詞：若已有 2 字以上的 token，就丟掉單字 CJK
// （ICU 會把「極簡」也切出單字 極/簡，導致任何含「極」或「簡」的筆記都被撈進來、稀釋排名）
function gnTokenizeQuery(q) {
  const all = gnTokenize(q);
  const multi = all.filter((t) => t.length >= 2);
  return multi.length ? multi : all;
}

/* ===== 命中高亮 ===== */

// 要高亮的詞：完整查詢字串 + ICU 切出的詞（≥2 字）。
// 刻意「不」用 bigram —— bigram 會產生「計思」這種怪片段，高亮起來很醜。
function gnHighlightTerms(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const set = new Set([s.toLowerCase()]);
  if (_gnSeg) {
    for (const x of _gnSeg.segment(s.toLowerCase())) {
      if (x.isWordLike && x.segment.length >= 2) set.add(x.segment);
    }
  } else {
    for (const m of s.toLowerCase().match(/[a-z0-9_]+/g) || []) set.add(m);
  }
  return [...set].sort((a, b) => b.length - a.length);   // 長的先配，避免被短的切斷
}

// 把 text 寫進 el，命中的詞包成 <span class="gn-hit">
// 用 DOM API 而非 innerHTML：筆記內容是使用者資料，絕不能直接塞 HTML
function gnHighlightInto(el, text, terms) {
  el.empty();
  if (!terms || !terms.length) { el.setText(text); return; }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try { re = new RegExp('(' + terms.map(esc).join('|') + ')', 'gi'); }
  catch (e) { el.setText(text); return; }

  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }   // 防呆：零長度匹配會無限迴圈
    if (m.index > last) el.appendText(text.slice(last, m.index));
    el.createSpan({ cls: 'gn-hit', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendText(text.slice(last));
}

// 取「命中處的上下文片段」，而不是筆記開頭前幾行。
// 搜尋時你要看的是「這個詞出現在什麼脈絡」，不是這篇筆記怎麼開頭的。
function gnSnippet(raw, terms, maxLen) {
  maxLen = maxLen || 140;
  const body = gnCleanBody(raw).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  if (!terms || !terms.length) return body.slice(0, maxLen);

  const lower = body.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return body.slice(0, maxLen);   // 只命中標題/標籤，內文沒有 → 退回開頭

  const start = Math.max(0, pos - 24);
  const end = Math.min(body.length, start + maxLen);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

/* ===== 懸浮搜尋（Spotlight 風）=====
   SuggestModal + GnSearchIndex（BM25，含 PDF）。由指令「🔍 懸浮搜尋」開啟，
   可在 設定→快捷鍵 綁快捷鍵、手機可加到工具列。
   ↵ 開啟 / Cmd+↵ 新分頁 / Shift+↵ 把全部結果丟到畫廊卡片牆。 */
class GnSearchModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder(t('Search notes and PDFs (full-text)…'));
    this.emptyStateText = t('No matching notes');
    this.limit = 30;
    this.modalEl.addClass('gn-search-modal');
    this.setInstructions([
      { command: '↑↓', purpose: t('to navigate') },
      { command: '↵', purpose: t('to open') },
      { command: 'Cmd/Ctrl+↵', purpose: t('to open in a new tab') },
      { command: 'Shift+↵', purpose: t('show all results in gallery') },
    ]);
    this.scope.register(['Shift'], 'Enter', () => { this.toGallery(); return false; });
  }

  async getSuggestions(q) {
    q = (q || '').trim();
    this._q = q;
    if (!q) return [];
    const idx = this.plugin.search;
    if (!idx.ready) await idx.ensureReady();   // 惰性建索引（首次 ~1 秒，之後增量）
    // 多撈一些再過濾隱藏資料夾，湊滿 30 筆
    return idx.search(q, 90).filter((h) => !this.plugin.isHiddenPath(h.path)).slice(0, 30);
  }

  renderSuggestion(hit, el) {
    el.addClass('gn-search-sug');
    const terms = gnHighlightTerms(this._q);
    const f = this.app.vault.getAbstractFileByPath(hit.path);

    // 左：文字堆疊（標題 / 路徑 / 內文片段）
    const txt = el.createDiv('gn-search-sug-txt');
    const t = txt.createDiv('gn-search-sug-title');
    gnHighlightInto(t, hit.title, terms);
    if (/\.pdf$/i.test(hit.path)) t.createSpan({ cls: 'gn-search-sug-ext', text: 'PDF' });
    txt.createDiv({ cls: 'gn-search-sug-path', text: hit.path });
    // 內文片段：先渲染標題不卡清單，讀到內文再補上（md 才有）
    if (f instanceof TFile && f.extension === 'md') {
      const sn = txt.createDiv('gn-search-sug-snippet');
      this.app.vault.cachedRead(f).then((raw) => {
        const s = gnSnippet(raw, terms, 90);
        if (s) gnHighlightInto(sn, s, terms); else sn.remove();
      }).catch(() => sn.remove());
    }

    // 右：縮圖（沿用卡片牆的封面邏輯：圖片檔本身 / md 的 cover 或第一張內嵌圖）
    if (f instanceof TFile) {
      const src = IMG_EXT.test(f.path)
        ? this.app.vault.getResourcePath(f)
        : (f.extension === 'md' ? coverSrc(this.app, this.app.metadataCache.getFileCache(f), f.path) : null);
      if (src) {
        const im = el.createEl('img', { cls: 'gn-search-sug-thumb' });
        im.src = src;
        im.loading = 'lazy';
        im.decoding = 'async';
        im.onerror = () => im.remove();   // 外部圖抓不到就安靜拿掉，不留破圖
      }
    }
  }

  onChooseSuggestion(hit, evt) {
    this.app.workspace.openLinkText(hit.path, '', !!(evt && (evt.metaKey || evt.ctrlKey)));
  }

  // Shift+Enter：關閉面板，改在畫廊卡片牆顯示全部結果
  toGallery() {
    const q = (this.inputEl.value || '').trim();
    this.close();
    if (q) this.plugin.openGallerySearch(q);
  }
}

class GnSearchIndex {
  constructor(app) {
    this.app = app;
    this.docs = [];        // id → { path, title, len, mtime }；null = 墓碑（已刪除/已過期）
    this.byPath = new Map(); // path → id（增量更新時要找回舊 id）
    // token → 扁平陣列 [id, tf, id, tf, …]
    // 用扁平陣列而非 Map-of-Map：postings 約 29 萬筆，Map-of-Map 會吃掉上百 MB，手機扛不住
    this.inv = new Map();
    this.totalLen = 0;
    this.live = 0;         // 有效（非墓碑）文件數
    this.avgLen = 1;
    this.ready = false;
    this._buildPromise = null;
  }

  /* ── PDF 內文：借用 text-extractor 外掛的 API（它自帶持久快取，Omnisearch 也是用這支） ── */
  teApi() {
    const p = this.app.plugins && this.app.plugins.plugins
      ? this.app.plugins.plugins['text-extractor'] : null;
    return p && p.api ? p.api : null;
  }

  // onlyCached=true：只拿「已經擷取過」的文字（不觸發解析/OCR）→ 建索引時不會卡住。
  // onlyCached=false：真的去擷取（可能很慢）→ 給「擷取全部 PDF 內文」指令用。
  async pdfText(f, onlyCached) {
    const api = this.teApi();
    if (!api || typeof api.extractText !== 'function') return '';
    try {
      if (onlyCached && typeof api.isInCache === 'function') {
        const cached = await api.isInCache(f);
        if (!cached) return '';
      }
      return (await api.extractText(f)) || '';
    } catch (e) { return ''; }
  }

  // 把單一檔案寫進索引（build 與增量更新共用）
  // md → 檔名/標題/標籤/內文；pdf → 檔名 + （已擷取的）內文
  async _indexFile(f, opts) {
    const o = opts || {};
    let fields;

    if (f.extension === 'pdf') {
      const text = await this.pdfText(f, o.forcePdf ? false : true);
      fields = [
        [f.basename, 8],
        [text, 1],
      ];
    } else {
      let raw = '';
      try { raw = await this.app.vault.cachedRead(f); } catch (e) { return; }
      const cache = this.app.metadataCache.getFileCache(f) || {};
      // 欄位加權：檔名 8 > 標題/標籤 3 > 內文 1
      fields = [
        [f.basename, 8],
        [(cache.headings || []).map((h) => h.heading).join(' '), 3],
        [tagsOf(cache).join(' '), 3],
        [gnCleanBody(raw), 1],
      ];
    }

    const tf = new Map();
    let len = 0;
    for (const [text, w] of fields) {
      for (const tok of gnTokenize(text)) {
        tf.set(tok, (tf.get(tok) || 0) + w);
        len += w;
      }
    }

    const id = this.docs.length;
    for (const [tok, n] of tf) {
      let arr = this.inv.get(tok);
      if (!arr) { arr = []; this.inv.set(tok, arr); }
      arr.push(id, n);
    }
    this.docs.push({ path: f.path, title: f.basename, len: len || 1, mtime: f.stat.mtime });
    this.byPath.set(f.path, id);
    this.totalLen += len;
    this.live++;
    this.avgLen = this.totalLen / Math.max(1, this.live) || 1;
  }

  // 把某個 path 的舊資料標成墓碑。
  // 不去 inv 裡刪 postings（那要掃全表，很慢）——搜尋時跳過墓碑即可。
  // 一個 session 內的編輯次數有限，殘留的 postings 量可以忽略。
  _tombstone(path) {
    const old = this.byPath.get(path);
    if (old == null) return;
    const d = this.docs[old];
    if (d) { this.totalLen -= d.len; this.live--; }
    this.docs[old] = null;
    this.byPath.delete(path);
    this.avgLen = this.totalLen / Math.max(1, this.live) || 1;
  }

  // 要進索引的檔案：全部 md + 全部 pdf
  // （pdf 的內文只吃 text-extractor「已快取」的部分，建索引時不會去解析／OCR）
  indexTargets() {
    const md = this.app.vault.getMarkdownFiles();
    const pdf = this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
    return md.concat(pdf);
  }

  async build(onProgress) {
    const t0 = Date.now();
    const files = this.indexTargets();
    this.docs = []; this.byPath = new Map(); this.inv = new Map();
    this.totalLen = 0; this.live = 0;

    for (let i = 0; i < files.length; i++) {
      await this._indexFile(files[i]);
      // 每 100 檔讓出 event loop，手機才不會整個卡住
      if (i % 100 === 99) {
        if (onProgress) onProgress(i + 1, files.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.ready = true;
    // 背景把「還沒擷取過」的 PDF 慢慢抽完（不 await：不擋搜尋、不擋 UI）
    this.warmPdfCache();
    return { files: this.live, tokens: this.inv.size, ms: Date.now() - t0 };
  }

  // 惰性建索引：第一次搜尋才建，並且併發呼叫只會建一次
  ensureReady(onProgress) {
    if (this.ready) return Promise.resolve(null);
    if (!this._buildPromise) {
      this._buildPromise = this.build(onProgress).finally(() => { this._buildPromise = null; });
    }
    return this._buildPromise;
  }

  // 這個副檔名要進索引嗎
  indexable(file) {
    return file instanceof TFile && (file.extension === 'md' || file.extension === 'pdf');
  }

  /* ===== 增量更新：只重建「那一篇」，幾 ms ===== */
  async onFileChanged(file) {
    if (!this.ready || !this.indexable(file)) return;
    this._tombstone(file.path);
    await this._indexFile(file);
    // 新加進來的 PDF → 背景把內文抽出來（抽完會自己再索引一次）
    if (file.extension === 'pdf') this.warmPdfCache();
  }
  onFileDeleted(file) {
    if (!this.ready) return;
    this._tombstone(file.path);
  }
  async onFileRenamed(file, oldPath) {
    if (!this.ready) return;
    this._tombstone(oldPath);
    if (this.indexable(file)) await this._indexFile(file);
  }

  /* ── 背景暖機：把「還沒擷取過」的 PDF 慢慢抽完，使用者不用做任何事 ──
     • 只跑「沒在快取裡」的 PDF（絕大多數早就被 Omnisearch 抽過了 → 通常一個都不用跑）
     • 一次一個、每個之間讓出 event loop 並停 300ms → 不卡 UI
     • 手機不跑：text-extractor 的快取放在 vault 內（.obsidian/plugins/text-extractor/cache），
       會經 iCloud 同步過去，手機直接吃現成的，不必自己耗電做 OCR
     • 抽完就地更新索引 → 下一次搜尋馬上搜得到 */
  warmPdfCache() {
    if (this._warming) return;
    if (document.body.classList.contains('is-mobile')) return;
    const api = this.teApi();
    if (!api || typeof api.isInCache !== 'function') return;
    this._warming = true;

    (async () => {
      try {
        const pdfs = this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
        for (const f of pdfs) {
          let cached = true;
          try { cached = await api.isInCache(f); } catch (e) { cached = true; }
          if (cached) continue;                       // 已經有文字 → 跳過（零成本）
          await this.pdfText(f, false);               // 真的擷取（只有新 PDF 會走到這）
          if (this.ready) { this._tombstone(f.path); await this._indexFile(f); }
          await new Promise((r) => setTimeout(r, 300));   // 節流，別跟使用者搶 CPU
        }
      } catch (e) { /* 靜默：暖機失敗不影響搜尋，下次再試 */ }
      this._warming = false;
    })();
  }

  // 「擷取全部 PDF 內文」：真的去跑 text-extractor（可能很慢／會 OCR），
  // 擷取完就把該檔重新索引。回報進度給呼叫端。
  async extractAllPdfs(onProgress) {
    if (!this.teApi()) return { ok: false, reason: t('Text Extractor plugin is not enabled') };
    const pdfs = this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
    let done = 0, withText = 0;
    for (const f of pdfs) {
      const text = await this.pdfText(f, false);        // false = 真的擷取
      if (text && text.trim()) withText++;
      if (this.ready) {                                  // 索引已建 → 立刻更新這一筆
        this._tombstone(f.path);
        await this._indexFile(f);
      }
      done++;
      if (onProgress) onProgress(done, pdfs.length);
      await new Promise((r) => setTimeout(r, 0));        // 讓出 event loop，UI 不卡死
    }
    return { ok: true, total: pdfs.length, withText };
  }

  search(query, limit = 30) {
    if (!this.ready) return [];
    const qtoks = gnTokenizeQuery(query);
    if (!qtoks.length) return [];

    const qCount = new Map();
    for (const t of qtoks) qCount.set(t, (qCount.get(t) || 0) + 1);

    // 前綴展開：拉丁/數字 token（≥2 字）額外比對「以它開頭」的索引詞——
    // 打「032」就命中「032c」、打「mag」就命中「magazine」（中文本來就有 bigram 兜底，
    // 英數沒有 → 以前一定要整個詞打完才搜得到）。展開詞打 0.7 折權重，
    // 精確命中永遠排前面；每個前綴最多展開 24 個詞，太氾濫的前綴自然被擋住。
    const qWeight = new Map();
    for (const tk of qCount.keys()) qWeight.set(tk, 1);
    for (const tk of [...qCount.keys()]) {
      if (!/^[a-z0-9_]{2,}$/.test(tk)) continue;
      let added = 0;
      for (const key of this.inv.keys()) {
        if (added >= 24) break;
        if (key.length > tk.length && key.startsWith(tk) && !qCount.has(key)) {
          qCount.set(key, 1);
          qWeight.set(key, 0.7);
          added++;
        }
      }
    }

    const N = Math.max(1, this.live);
    const k1 = 1.2, b = 0.75;         // BM25 標準參數
    const scores = new Map();

    for (const [t, qn] of qCount) {
      const arr = this.inv.get(t);
      if (!arr) continue;
      const df = arr.length / 2;
      // 出現在 >60% 文件的詞（「的」「是」…）沒有鑑別力，跳過：既拖慢又污染排名
      if (df > N * 0.6) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const w = qWeight.get(t) || 1;
      for (let i = 0; i < arr.length; i += 2) {
        const id = arr[i], freq = arr[i + 1];
        const d = this.docs[id];
        if (!d) continue;               // 墓碑：已刪除或已被新版本取代
        const s = idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * d.len / this.avgLen)) * qn * w;
        scores.set(id, (scores.get(id) || 0) + s);
      }
    }

    // 注意：上面已經對「所有」命中的文件算過分數了。
    // limit 只是最後切一刀（顯示用），不影響搜尋範圍。limit <= 0 = 全部回傳。
    const ranked = [...scores.entries()].sort((a, c) => c[1] - a[1]);
    const out = (limit && limit > 0) ? ranked.slice(0, limit) : ranked;
    return out.map(([id, score]) => Object.assign({ score }, this.docs[id]));
  }
}

class GalleryPlugin extends Plugin {
  async onload() {
    this.state = Object.assign({ lastPath: '', cardWidth: 120, sort: 'new', folderOrder: {}, hiddenFolders: [], folderColors: {}, expandedFolders: [], todoNote: '', todoCollapsed: false, treeWidth: 232, treeCollapsed: false, syncActive: true, leftMode: 'folder', activeTag: '', expandedTags: [], cardColors: {}, noPreviewFolders: [], favorites: [], pinnedCards: [], calFeeds: [], agendaDays: 14, calDailyTemplate: '', lang: '', enablePinterest: false }, await this.loadData());
    setLang(this.state.lang || '');   // i18n：''=跟隨 Obsidian 介面語言

    this.registerView(VIEW_TYPE, (leaf) => new GalleryView(leaf, this));
    this.registerView(CAL_VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    this.addRibbonIcon('egg', 'Gallery Navigator', () => this.activateView());   // 🥚
    this.addRibbonIcon('calendar', 'Mini Calendar', () => this.activateCalendar());

    this.addCommand({
      id: 'open-gallery-navigator',
      name: t('Open Gallery Navigator'),
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'open-mini-calendar',
      name: t('Open Mini Calendar'),
      callback: () => this.activateCalendar(),
    });
    // 懸浮搜尋：可在 設定→快捷鍵 綁快捷鍵；手機可加到工具列快捷按鈕
    this.addCommand({
      id: 'gn-search-popup',
      name: t('Search (popup)'),
      callback: () => new GnSearchModal(this.app, this).open(),
    });
    this.addSettingTab(new CalendarSettingTab(this.app, this));

    /* ===== 搜尋索引 =====
       設計：不持久化。索引 4MB，但存成 JSON 會膨脹到 5~10MB，
       手機讀寫比「直接重建（0.6 秒）」還慢，而且要處理版本/失效/髒資料。
       → 惰性建立（第一次搜尋才建）＋ 增量更新，一個 session 只建一次。 */
    this.search = new GnSearchIndex(this.app);

    // 增量更新：改一篇只重索引那一篇（幾 ms），索引全程保持新鮮
    this.registerEvent(this.app.vault.on('modify', (f) => this.search.onFileChanged(f)));
    this.registerEvent(this.app.vault.on('create', (f) => this.search.onFileChanged(f)));
    this.registerEvent(this.app.vault.on('delete', (f) => this.search.onFileDeleted(f)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.search.onFileRenamed(f, old)));

    if (this.state.devMode) this.addCommand({
      id: 'gn-search-test',
      name: t('Search: test query'),
      callback: async () => {
        // 惰性建索引：第一次搜尋才建，之後直接用
        if (!this.search.ready) {
          const n = new Notice(t('First search — building index…'), 0);
          const r = await this.search.ensureReady((done, total) => n.setMessage(t('Building index… {{done}}/{{total}}', { done, total })));
          n.hide();
          if (r) console.log('[GN Search] 索引完成', r);
        }
        new InputModal(this.app, t('Search test (full ranking in console)'), '', (q) => {
          const t0 = Date.now();
          const hits = this.search.search(q, 20);
          const ms = Date.now() - t0;
          console.log(`\n🔍 「${q}」→ ${hits.length} 筆 (${ms}ms)`);
          console.log('   斷詞:', gnTokenizeQuery(q).join(' / '));
          hits.forEach((h, i) => console.log(`   ${String(i + 1).padStart(2)}. ${h.score.toFixed(2).padStart(6)}  ${h.path}`));
          new Notice(
            `「${q}」→ ${hits.length} 筆 (${ms}ms)\n\n` +
            (hits.slice(0, 8).map((h, i) => `${i + 1}. ${h.title}`).join('\n') || t('(no results)')),
            10000
          );
        }, t('Search')).open();
      },
    });

    // PDF 內文：借 text-extractor 擷取（它有持久快取，只需要跑一次；之後建索引就會自動吃到）
    // 診斷：手機點資料夾沒跳右欄時，用這個指令看實際數值
    if (this.state.devMode) this.addCommand({
      id: 'gn-diagnose-mobile-scroll',
      name: t('Diagnose: mobile pane switching'),
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (leaf && leaf.view && leaf.view.diagnoseMobileScroll) leaf.view.diagnoseMobileScroll();
        else new Notice(t('Open Gallery Navigator first'));
      },
    });

    this.addCommand({
      id: 'gn-search-extract-pdfs',
      name: t('Search: extract all PDF text (Text Extractor)'),
      callback: async () => {
        if (!this.search.teApi()) { new Notice(t('Text Extractor plugin is required to extract PDF text')); return; }
        const n = new Notice(t('Extracting PDF text… (large files may take a while)'), 0);
        const r = await this.search.extractAllPdfs((done, total) => n.setMessage(t('Extracting PDF text… {{done}}/{{total}}', { done, total })));
        n.hide();
        if (r.ok) new Notice(t('{{total}} PDFs — text extracted from {{withText}}', { total: r.total, withText: r.withText }), 6000);
        else new Notice('❌ ' + r.reason);
      },
    });

    this.addCommand({
      id: 'gn-search-rebuild',
      name: t('Search: rebuild index'),
      callback: async () => {
        this.search.ready = false;
        const n = new Notice(t('Rebuilding index…'), 0);
        const r = await this.search.ensureReady((done, total) => n.setMessage(t('Rebuilding index… {{done}}/{{total}}', { done, total })));
        n.hide();
        if (r) new Notice(t('{{files}} files · {{tokens}} tokens · {{ms}}ms', { files: r.files, tokens: r.tokens.toLocaleString(), ms: r.ms }), 5000);
      },
    });

    // 行事曆事件快取（完整檢視 + 迷你月曆共用）
    this.calRaw = []; this.calLoading = false; this.calError = '';
    this.loadCalFeeds();

    // 連結預覽持久快取索引（筆記路徑 → og:image 下載到 og-cache/ 的檔名）
    this._ogIndex = {};
    this.loadOgIndex();

    // 檔案增刪/改名時，若 View 開著就重畫；同時讓日曆筆記索引失效
    const onVaultChange = () => { this._calNoteDirty = true; this.refreshViews(); };
    this.registerEvent(this.app.vault.on('create', onVaultChange));
    this.registerEvent(this.app.vault.on('delete', onVaultChange));
    this.registerEvent(this.app.vault.on('rename', onVaultChange));

    // 筆記/Canvas 內的圖片：找出可接手的目標（回傳 src 或 null）
    const IMG_AREAS = '.markdown-preview-view, .markdown-source-view, .markdown-reading-view, .cm-content, .markdown-embed, .canvas-node, .canvas-wrapper';
    const imgSrcOf = (img) => {   // ⚠️ 參數勿叫 t，會遮蔽 i18n 的 t()
      if (!(img instanceof HTMLImageElement)) return null;
      if (!img.closest(IMG_AREAS)) return null;
      return img.currentSrc || img.src || null;
    };
    const buildImageMenu = (img, src) => {
      const af = this.app.workspace.getActiveFile();
      const srcFolder = af && af.parent && af.parent.path !== '/' ? af.parent.path : '';
      const file = this.imgToVaultFile(img);   // 對應回 vault 檔案（本機圖才有）
      const menu = new Menu();
      menu.addItem((i) => i.setTitle(t('Copy image')).setIcon('copy')
        .onClick(() => this.copyImage(src)));
      menu.addItem((i) => i.setTitle(t('Copy image URL')).setIcon('link')
        .onClick(() => copyToClipboard(src)));
      if (this.state.enablePinterest) menu.addItem((i) => i.setTitle(t('Pinterest visual search')).setIcon('search')
        .onClick(() => new PinterestModal(this.app, src, img.alt || '', srcFolder).open()));
      if (file) {
        menu.addSeparator();
        const a = this.app.vault.adapter;
        if (a && typeof a.getFullPath === 'function') {
          menu.addItem((i) => i.setTitle(t('Reveal in system explorer')).setIcon('folder-open')
            .onClick(() => { try { if (typeof this.app.showInFolder === 'function') this.app.showInFolder(file.path); } catch (e) {} }));
        }
        menu.addSeparator();
        menu.addItem((i) => i.setTitle(t('Delete image')).setIcon('trash').setWarning(true)
          .onClick(() => new ConfirmModal(this.app, t('Delete image "{{name}}"? (moves to trash)', { name: file.name }), async () => {
            try { await this.app.fileManager.trashFile(file); new Notice(t('Deleted {{name}}', { name: file.name })); }
            catch (e) { new Notice(t('Delete failed: {{msg}}', { msg: e && e.message ? e.message : e })); }
          }).open()));
      }
      return menu;
    };

    // 桌機：右鍵
    this.registerDomEvent(document, 'contextmenu', (evt) => {
      const src = imgSrcOf(evt.target);
      if (!src) return;
      evt.preventDefault();
      buildImageMenu(evt.target, src).showAtPosition({ x: evt.clientX, y: evt.clientY });
    });

    // 手機：長按（自製計時器；移動或放開即取消，並攔掉後續 click）
    let lpTimer = null, lpX = 0, lpY = 0;
    this.registerDomEvent(document, 'touchstart', (evt) => {
      if (evt.touches.length !== 1) return;
      const t = evt.target;
      const src = imgSrcOf(t);
      if (!src) return;
      lpX = evt.touches[0].clientX; lpY = evt.touches[0].clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (er) {} }
        buildImageMenu(t, src).showAtPosition({ x: lpX, y: lpY });
        const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', kill, true); };
        document.addEventListener('click', kill, true);
        setTimeout(() => document.removeEventListener('click', kill, true), 700);
      }, 500);
    }, { passive: true });
    const cancelLp = (evt) => {
      if (!lpTimer) return;
      if (evt && evt.touches && evt.touches[0]) {
        const t = evt.touches[0];
        if (Math.abs(t.clientX - lpX) < 10 && Math.abs(t.clientY - lpY) < 10) return;
      }
      clearTimeout(lpTimer); lpTimer = null;
    };
    this.registerDomEvent(document, 'touchmove', cancelLp, { passive: true });
    this.registerDomEvent(document, 'touchend', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    this.registerDomEvent(document, 'touchcancel', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
  }

  // 筆記內的 <img> 對應回 vault 檔案（本機圖才有；外部網址圖回 null）
  imgToVaultFile(img) {
    const af = this.app.workspace.getActiveFile();
    // 1) 閱讀檢視嵌入：用 embed 的 src 屬性解 linkpath
    const emb = img.closest('.internal-embed, .image-embed');
    const link = emb && emb.getAttribute('src');
    if (link) {
      const f = this.app.metadataCache.getFirstLinkpathDest(link.split('#')[0].split('|')[0], af ? af.path : '');
      if (f) return f;
    }
    // 2) 從 resource path 反推 vault 相對路徑（桌機）
    try {
      const a = this.app.vault.adapter;
      const base = a && typeof a.getBasePath === 'function' ? a.getBasePath() : '';
      let p = decodeURIComponent(img.currentSrc || img.src || '').replace(/^\w+:\/\/[^/]+/, '').split('?')[0];
      if (base && p.startsWith(base)) p = p.slice(base.length);
      p = p.replace(/^\/+/, '');
      const f = p && this.app.vault.getAbstractFileByPath(p);
      if (f) return f;
    } catch (e) {}
    return null;
  }

  // 複製圖片點陣圖到剪貼簿（一律轉 PNG，相容性最好）
  async copyImage(src) {
    try {
      const blob = await new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          const c = document.createElement('canvas');
          c.width = im.naturalWidth; c.height = im.naturalHeight;
          c.getContext('2d').drawImage(im, 0, 0);
          c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
        };
        im.onerror = () => reject(new Error(t('Failed to load image')));
        im.src = src;
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      new Notice(t('Image copied'));
    } catch (e) {
      new Notice(t('Failed to copy image: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  refreshViews() {
    // 去抖：檔案增刪改名常一次一批，合併成一次重畫
    clearTimeout(this._refreshT);
    this._refreshT = setTimeout(() => {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        if (leaf.view instanceof GalleryView && !leaf.view.drag) leaf.view.render();
      });
    }, 150);
  }

  // 去抖寫檔：連續操作（釘選/上色/展開…）只寫一次 data.json，減少 iCloud 寫入
  saveState() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { this.saveData(this.state); }, 400);
    return Promise.resolve();
  }

  // 連結預覽快取：資料夾與索引檔（放外掛資料夾，不污染 vault 筆記）
  ogCacheDir() { return this.manifest.dir + '/og-cache'; }
  async loadOgIndex() {
    try {
      const a = this.app.vault.adapter;
      const p = this.ogCacheDir() + '/index.json';
      if (await a.exists(p)) this._ogIndex = JSON.parse(await a.read(p)) || {};
    } catch (e) { this._ogIndex = {}; }
  }
  saveOgIndex() {
    clearTimeout(this._ogSaveT);
    this._ogSaveT = setTimeout(async () => {
      try {
        const a = this.app.vault.adapter;
        const dir = this.ogCacheDir();
        if (!(await a.exists(dir))) await a.mkdir(dir);
        await a.write(dir + '/index.json', JSON.stringify(this._ogIndex));
      } catch (e) {}
    }, 800);
  }

  async onunload() {
    // 卸載前把尚未寫入的狀態刷出去
    clearTimeout(this._saveT);
    await this.saveData(this.state);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateCalendar() {
    const { workspace } = this.app;
    // 確保 dock 在右側邊欄：移除不在右欄的既有日曆分頁（浮動視窗 / 主區）
    for (const l of workspace.getLeavesOfType(CAL_VIEW_TYPE)) {
      const inRight = typeof l.getRoot === 'function' && l.getRoot() === workspace.rightSplit;
      if (!inRight) l.detach();
    }
    let leaf = workspace.getLeavesOfType(CAL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: CAL_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // 這個路徑是否落在「隱藏資料夾」裡（含子孫資料夾）——搜尋結果要跳過這些
  isHiddenPath(path) {
    const hidden = this.state.hiddenFolders || [];
    return hidden.some((h) => path === h || path.startsWith(h + '/'));
  }

  // 懸浮搜尋的 Shift+Enter：開畫廊並直接進入搜尋模式顯示全部結果
  async openGallerySearch(q) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const v = leaf && leaf.view;
    if (v instanceof GalleryView) {
      v._searchOn = true;
      v._searchQ = q;
      v.render();
    }
  }

  // 只重畫日曆檢視（不重新抓）
  refreshCalViews() {
    this.app.workspace.getLeavesOfType(CAL_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof CalendarView) leaf.view.render();
    });
  }

  // 抓所有 ICS → 解析成事件快取（完整檢視 + 迷你月曆共用）
  async loadCalFeeds() {
    if (this._calLoadingLock) return;
    this._calLoadingLock = true;
    const feeds = (this.state.calFeeds || []).filter((f) => f.url && f.url.trim());
    this.calLoading = true; this.calError = ''; this.refreshCalUI();
    const raw = [];
    for (let i = 0; i < feeds.length; i++) {
      const f = feeds[i], color = f.color || CAL_DOT_COLORS[i % CAL_DOT_COLORS.length];
      try {
        const res = await requestUrl({ url: f.url.trim(), method: 'GET', throw: false });
        if (res.status >= 200 && res.status < 300 && res.text) {
          for (const ev of calParseICS(res.text)) raw.push({ ev, color, calName: f.name || '' });
        } else { this.calError = t('ICS responded with status {{status}}', { status: res.status }); }
      } catch (e) { this.calError = t('Fetch failed: {{msg}}', { msg: e && e.message ? e.message : e }); }
    }
    this.calRaw = raw; this.calLoading = false;
    this._calLoadingLock = false;
    this.refreshCalUI();
  }

  calOccurrences(winStart, winEnd) {
    const out = [];
    for (const r of (this.calRaw || [])) for (const o of calExpand(r.ev, r.color, r.calName, winStart, winEnd)) out.push(o);
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // 日曆筆記索引（快取；vault 增刪改名才重建）：
  //  noteDays: 有日期命名筆記的日期集合；datedByDay: 日期→檔; createdByDay: 建立日→檔
  buildCalNoteIndex() {
    if (this._calNoteIndex && !this._calNoteDirty) return this._calNoteIndex;
    const noteDays = new Set(), datedByDay = new Map(), createdByDay = new Map();
    const push = (map, key, f) => { if (!map.has(key)) map.set(key, []); map.get(key).push(f); };
    for (const f of this.app.vault.getMarkdownFiles()) {
      const m = f.basename.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) { noteDays.add(m[1]); push(datedByDay, m[1], f); }
      const d = new Date(f.stat.ctime);
      push(createdByDay, d.getFullYear() + '-' + calPad2(d.getMonth() + 1) + '-' + calPad2(d.getDate()), f);
    }
    this._calNoteDirty = false;
    this._calNoteIndex = { noteDays, datedByDay, createdByDay };
    return this._calNoteIndex;
  }

  // 資料變動 → 更新完整日曆檢視
  refreshCalUI() {
    this.refreshCalViews();
  }
};

module.exports = { GalleryPlugin, CalendarSettingTab, VIEW_TYPE, CAL_VIEW_TYPE };
