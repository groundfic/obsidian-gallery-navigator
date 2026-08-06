'use strict';

/*
 * Gallery Navigator
 * 以封面卡片視覺化瀏覽整個 vault。集合總覽(資料夾) → 進資料夾 → 筆記卡片牆。
 * 核心封面/標籤邏輯移植自 vault 內的 BASE/Code/Collections code.md (js-engine)。
 */

const { Plugin, ItemView, MarkdownView, TFolder, TFile, Menu, FuzzySuggestModal, SuggestModal, Notice, setIcon, addIcon, Modal, requestUrl, PluginSettingTab, Setting } = require('obsidian');
const { t, setLang, isZh } = require('./i18n.js');
const { LocalGraph } = require('./graph.js');
const { ThumbCache } = require('./thumbs.js');
const { DimPrefetcher } = require('./dims.js');
const { setupCanvasImageToNote } = require('./canvasnote.js');
const { VirtualWall } = require('./virtual.js');

/* 外掛專屬圖示（2026-07-20）：三個互扣的圓角方塊＝卡片牆意象。
   ⚠️ addIcon() 的內容必須適配 0 0 100 100 的 viewBox，但原稿是 24×24
   → 包一層 scale(4.16667)（24 × 4.16667 = 100，幾何不變形）。
   fill 用 currentColor，圖示才會跟著主題明暗與 hover 狀態變色。 */
// 編輯風索引卡的最小欄寬（2026-07-20）：縮圖 94px + 左右內距，再窄標題/日期會擠在一起。
const GN_EDITORIAL_MIN_COL = 150;

const GN_ICON_ID = 'gallery-navigator';
/* 線條版 logo（2026-08-01 圖稿再更新）。原稿：vault 的 img/icon-line.svg（18.5×19.4，直式）
   換算：addIcon() 要求適配 0 0 100 100
     • 等比 scale 80/19.4 = 4.12371（取長邊，內容佔 80%、留 10% 邊距）
     • 渲染後 76.29 × 80.00 → translate(11.86, 10) 置中
     • 縮放倍率與前幾版相同 → 換圖稿不會忽大忽小
   ⚠️ 原稿的 stroke 是 #000（Illustrator 匯出），一定要改成 currentColor，
      否則深色主題下會變成看不見的黑線，也不會跟著 hover 變色。
   ⚠️ 線寬**不能在這裡控制**：Obsidian 有一條 `svg.svg-icon { stroke-width: var(--icon-stroke) }`，
      CSS 會蓋掉 SVG 的 presentation attribute。實際粗細由 gallery.css 的
      `.svg-icon.gallery-navigator` 決定（那裡把 --icon-stroke 按 100/24 放大還原）。
      這裡留 stroke-width="2" 只是萬一 class 沒掛上時的保底值。
   註：原稿裡兩個方框各被畫了兩次（幾何相同、只差 .9 / 1 的線寬，Illustrator 的重複圖層）。
      我們統一線寬後兩份會完全重疊，所以這裡只留一份，視覺零差異。
      兩個方框刻意不同大小（右上 4.5、左下 4.3），照原稿保留。 */
const GN_ICON_SVG =
  '<g transform="translate(11.86 10) scale(4.12371)" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-miterlimit="10">' +
  '<path d="M10.4,7.1V2.4c0-1-.9-1.9-1.9-1.9H2.4c-1.1,0-1.9.8-1.9,1.9v6.1c0,1.1.8,1.9,1.9,1.9h3.9c1.1,0,1.9.9,1.9,1.9v4.7c0,1,.9,1.9,1.9,1.9h6c1,0,1.9-.9,1.9-1.9v-6.1c0-1.1-.9-1.9-1.9-1.9h-3.9c-1.1,0-1.8-.9-1.8-1.9h0Z"/>' +
  '<rect x="13.5" y="1.5" width="4.5" height="4.5" rx="1.4" ry="1.4"/>' +
  '<rect x=".9" y="13.7" width="4.3" height="4.3" rx="1.3" ry="1.3"/>' +
  '</g>';


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
// 上限 500 筆的 FIFO：多輪以圖搜圖會一直往裡加，沒有上限就是單調成長到重載為止
const PIN_GIF_CACHE_MAX = 500;
const TINT_CACHE_MAX = 2000;   // 卡片主色快取上限（key = path:mtime，逛過的每張圖都會留一筆）
const _pinGifCache = new Map();
function _pinGifCacheSet(key, value) {
  if (_pinGifCache.size >= PIN_GIF_CACHE_MAX) {
    const oldest = _pinGifCache.keys().next().value;
    if (oldest !== undefined) _pinGifCache.delete(oldest);
  }
  _pinGifCache.set(key, value);
}
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
  _pinGifCacheSet(guess, p);
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
    /* 任何圖片（含之後才插入的縮圖/連結圖/PDF 圖）載入完成 → 重排。
       load 事件不會冒泡，但捕獲階段抓得到，一條就涵蓋所有後續插入的圖。
       ⚠️ 這個監聽**必須**在 destroy() 裡移除，見該處說明。 */
    this._destroyed = false;
    /* 只把「那一張卡」標記成要重量測（見 layout 的說明）。
       抓不到對應的卡就退回全量重量，行為與舊版一致。 */
    this._onLoad = (e) => this.scheduleLayout(this._itemOf(e && e.target));
    container.addEventListener('load', this._onLoad, true);
    /* 量測與寫入的快取（2026-08-05）：
         _hCache 卡片高度、_pos 上次寫入的 left/top、_elW 上次寫入的 width。
       非虛擬化路徑下，每張晚到的預覽圖以前都會讓「整面牆」重量測 + 整批重寫定位。 */
    this._hCache = new WeakMap();
    this._pos = new WeakMap();
    this._elW = new WeakMap();
    this._dirty = new Set();     // 這一輪要重量測的卡
    this._fullDirty = true;      // true = 這一輪全部重量測
    this._lastH = -1;
  }
  /* 外部通知「某個節點底下的內容變了」（內文預覽載入、og 圖插入、PDF 縮圖…）。
       • 節點不在這面牆裡 → 這面牆什麼都沒變，不用動
       • 在這面牆裡 → 只標記那張卡
       • 不知道是哪個節點（node 為 null）→ 保守起見全量重量 */
  noteChanged(node) {
    if (!node) { this.scheduleLayout(); return; }
    if (!this.container.contains(node)) return;
    this.scheduleLayout(this._itemOf(node));
  }
  // 從事件目標往上找到「container 的直接子元素」＝那張卡
  _itemOf(node) {
    let n = node;
    while (n && n.parentElement && n.parentElement !== this.container) n = n.parentElement;
    return n && n.parentElement === this.container ? n : null;
  }
  add(el) {
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    this.items.push(el);
    // ⚠️ 這裡**不要**再逐張 img 掛 load：建構式已在 container 用捕獲階段接了所有
    //    後代的 load（見上方註解），逐張再掛一次等於同一張圖觸發兩次 scheduleLayout。
    //    rAF 會合併所以不致命，但 layout() 是 O(全部卡片)，白跑一次代價不小。
    this.scheduleLayout(el);   // 新卡：只有它需要量測
  }
  clear() {
    this.items = [];
    this.container.empty();
    this.container.style.height = '0px';
    this._lastW = 0;
    this._lastH = 0;
    this._dirty.clear();
    this._fullDirty = true;
  }
  // 事後才發現不該顯示的項目（例如拿不到 gif 的動態 pin）→ 移除並重排
  remove(el) {
    const i = this.items.indexOf(el);
    if (i >= 0) this.items.splice(i, 1);
    el.remove();
    this.scheduleLayout();
  }
  setMinCol(w) { this.minCol = w; this.scheduleLayout(); }
  /* el 有給 → 只有那張卡需要重量測；沒給 → 全量重量（不知道誰變了時的安全預設）。
     同一幀內只要有任何一次沒給 el，這一輪就是全量。 */
  scheduleLayout(el) {
    if (el) this._dirty.add(el); else this._fullDirty = true;
    if (this._destroyed || this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.layout(); });
  }
  layout() {
    if (this._destroyed) return;
    const W = this.container.clientWidth;
    if (!W || !this.items.length) { if (!this.items.length) this.container.style.height = '0px'; return; }
    this._lastW = W;
    const cols = this.fixedCols || Math.max(1, Math.floor((W + this.gap) / (this.minCol + this.gap)));
    const colW = (W - this.gap * (cols - 1)) / cols;
    // 只有真的變了才寫 width（同值也寫會讓整牆樣式失效 → 白白多一次 reflow）
    let wChanged = false;
    for (const el of this.items) {
      if (this._elW.get(el) === colW) continue;
      el.style.width = colW + 'px';
      this._elW.set(el, colW);
      wChanged = true;
    }
    if (wChanged && colW !== this._lastColW) this._fullDirty = true;   // 欄寬變 → 所有高度都不能用了
    this._lastColW = colW;

    /* 高度只重量 dirty 的卡。以前是 items.map(offsetHeight)：
       任何一張晚到的圖載入完成，整面牆（可能數百張）就重量一次，
       跨幀連續載入＝連續滿版 reflow。 */
    const full = this._fullDirty;
    const dirty = this._dirty;
    const heights = this.items.map((el) => {
      if (!full && !dirty.has(el)) {
        const c = this._hCache.get(el);
        if (c !== undefined) return c;
      }
      const h = el.offsetHeight;
      this._hCache.set(el, h);
      return h;
    });
    dirty.clear();
    this._fullDirty = false;

    const colH = new Array(cols).fill(0);
    this.items.forEach((el, i) => {
      let c = 0;
      for (let k = 1; k < cols; k++) if (colH[k] < colH[c]) c = k;      // 找最矮的欄
      const L = c * (colW + this.gap), T = colH[c];
      const p = this._pos.get(el);
      if (!p || p.l !== L || p.t !== T) {                               // 位置沒變就不寫
        el.style.left = L + 'px';
        el.style.top = T + 'px';
        this._pos.set(el, { l: L, t: T });
      }
      colH[c] += heights[i] + this.gap;
    });
    const H = Math.max.apply(null, colH);
    if (H !== this._lastH) { this.container.style.height = H + 'px'; this._lastH = H; }
  }
  /* ⚠️ 一定要把容器上的 load 監聽也拿掉，否則會變成「殭屍 masonry」。

     虛擬化模式下 makeGrid() 仍會建一個 MasonryLayout，
     renderVirtual() 隨即把它 destroy() —— 但容器（.gn-grid）還活著，
     而且卡片都不經過 masonry.add()，所以它的 items 永遠是空的。
     舊版 destroy() 沒移除 load 監聽，於是每當牆上任何一張圖載入完成：
       load（捕獲）→ scheduleLayout() → layout()
       → items.length === 0 → container.style.height = '0px'
     容器高度被歸零 → 不再撐開 → scrollHeight 改由「目前掛載的十幾張
     絕對定位卡片」決定 → 卡片一直掛載/卸載 → 捲軸拇指狂跳。

     實測：8 秒內 grid 高度 50173 → 0 → 50173，scrollHeight 變動 66 次，
     而 VirtualWall 自己一次高度都沒寫（heightWrites = 0）—— 兇手就是這裡。 */
  destroy() {
    this._destroyed = true;
    if (this._onLoad) this.container.removeEventListener('load', this._onLoad, true);
    if (this.ro) this.ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

/* ===== 交換圖片：挑一張 vault 內的圖替換掉筆記裡的嵌入（2026-07-20）=====
   視窗＝「最近修改的圖片瀑布牆」＋檔名搜尋；點一張就替換。
   分批渲染（同卡片牆的理由：img/ 可能有數千張，一次畫完手機會爆記憶體）。 */
class SwapImageModal extends Modal {
  constructor(app, oldFile, onPick) {
    super(app);
    this.oldFile = oldFile;      // 目前這張圖的 vault 檔案（TFile）
    this.onPick = onPick;        // 選定新圖的回呼
    this.q = '';
    this.drawn = 0;
    // ⚠️ 一次畫太多會爆記憶體：img/ 可能有數千張高解析原圖，
    //    同時解碼 60 張（每張數 MB~十幾 MB）足以讓 Obsidian 當掉。
    //    → 一批 18 張、捲到才補；並限制候選總數（見 candidates()）。
    this.CHUNK = document.body.classList.contains('is-mobile') ? 12 : 18;
    this.MAX = 300;
  }

  onOpen() {
    this.modalEl.addClass('gn-swap-modal');
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv('gn-swap-title').setText(t('Swap image'));

    // 搜尋列：即時篩檔名/路徑
    const search = contentEl.createEl('input', { type: 'search', cls: 'gn-swap-search' });
    search.placeholder = t('Filter by file name…');
    /* 去抖 150ms：每個 keystroke 重畫整面牆（含建 MasonryLayout、掛卡片）太貴。
       畫廊內的搜尋列本來就有去抖，這裡比照。 */
    search.addEventListener('input', () => {
      const v = search.value.trim().toLowerCase();
      if (v === this.q) return;
      clearTimeout(this._qT);
      this._qT = setTimeout(() => { this.q = v; this.renderWall(); }, 150);
    });
    setTimeout(() => search.focus(), 0);

    this.wallEl = contentEl.createDiv('gn-swap-wall');
    this.renderWall();

    // 捲到底補下一批
    this.wallEl.addEventListener('scroll', () => {
      if (this.wallEl.scrollTop + this.wallEl.clientHeight >= this.wallEl.scrollHeight - 600) this.drawNext();
    }, { passive: true });
  }

  /* 基底清單（全 vault 圖片、依最近修改排序、排除目前這張）只算一次。
     以前每個 keystroke 都重跑 getFiles() + 副檔名 filter + 全量 sort——
     vault 有 4000+ 張圖，打一個字就是一次全表掃描加排序。
     視窗開著的期間清單不會變，篩選只是在這份基底上做 includes。 */
  baseList() {
    if (this._base) return this._base;
    const cur = this.oldFile ? this.oldFile.path : '';
    const list = this.app.vault.getFiles()
      .filter((f) => IMG_EXT.test(f.path) && f.path !== cur);
    list.sort((a, b) => b.stat.mtime - a.stat.mtime);
    // 先存「已排序的全部」：篩選後還是要能從全體挑出最近的 MAX 張
    this._base = list;
    return list;
  }

  candidates() {
    const base = this.baseList();
    const list = this.q ? base.filter((f) => f.path.toLowerCase().includes(this.q)) : base;
    return list.slice(0, this.MAX);   // 只留最近的 N 張：沒人會捲到第 300 張，也避免記憶體壓力
  }

  renderWall() {
    this.wallEl.empty();
    this.drawn = 0;
    if (this.masonry) { try { this.masonry.destroy(); } catch (e) {} }
    const grid = this.wallEl.createDiv('gn-swap-grid');
    const isMobileUI = document.body.classList.contains('is-mobile');
    this.masonry = new MasonryLayout(grid, { gap: 10, minCol: isMobileUI ? 110 : 130 });
    this.grid = grid;
    this.list = this.candidates();
    if (!this.list.length) {
      this.wallEl.createDiv('gn-swap-empty').setText(t('No images found'));
      return;
    }
    this.drawNext();
  }

  drawNext() {
    if (!this.list || this.drawn >= this.list.length) return;
    const end = Math.min(this.drawn + this.CHUNK, this.list.length);
    for (let i = this.drawn; i < end; i++) {
      const f = this.list[i];
      const cell = this.grid.createDiv('gn-swap-cell');
      const img = cell.createEl('img');
      img.src = this.app.vault.getResourcePath(f);
      img.loading = 'lazy';
      img.decoding = 'async';
      cell.createDiv('gn-swap-name').setText(f.name);
      cell.setAttr('title', f.path);
      cell.onclick = () => { this.close(); this.onPick(f); };
      this.masonry.add(cell);
    }
    this.drawn = end;
  }

  onClose() {
    clearTimeout(this._qT);          // 關閉後別再觸發一次重畫
    this._base = null;               // 放掉基底清單（數千個 TFile 參照）
    if (this.masonry) { try { this.masonry.destroy(); } catch (e) {} }
    this.contentEl.empty();
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

    /* 拖曳分隔桿調整左欄寬度。
       同畫廊分隔桿：rect 在 mousedown 讀一次，mousemove 只記座標、rAF 內才寫，
       避免每次移動都「讀 rect → 寫樣式」交錯造成強制版面重算。 */
    let dragRect = null, dragX = 0, moveRaf = 0;
    const applyW = () => {
      moveRaf = 0;
      if (!dragRect) return;
      let w = dragX - dragRect.left;
      w = Math.max(140, Math.min(dragRect.width - 220, w));
      left.style.flex = '0 0 ' + w + 'px';
    };
    const onMove = (e) => {
      dragX = e.clientX;
      if (!moveRaf) moveRaf = requestAnimationFrame(applyW);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; applyW(); }
      dragRect = null;
    };
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragRect = bodyEl.getBoundingClientRect();
      dragX = e.clientX;
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

/* 取圖片主色（2026-07-20，自動卡片底色用）
   畫進 16×16 canvas（只有 256 像素，成本可忽略）讀像素，**量化分組取最多的一群**——
   不用「全圖平均」，因為平均值幾乎都會變成灰泥色，看不出圖片個性。
   略過近黑/近白/透明像素，否則多數圖只會取到黑白邊框色。
   canvas 讀 vault 圖片不會被 CORS 汙染（外掛既有的 toJpeg / PDF 縮圖已證實）。 */
function gnDominantColor(img) {
  try {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;

    const buckets = new Map();     // 只裝「有顏色」的像素（近黑/近白排除）
    let total = 0;                 // 全部非透明像素
    const light = [0, 0, 0, 0];    // 近白像素的累加（保留米白/象牙白的實際色調）
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;                       // 透明
      const r = d[i], g = d[i + 1], b = d[i + 2];
      total++;
      if (Math.min(r, g, b) > 232) { light[0] += r; light[1] += g; light[2] += b; light[3]++; continue; }
      if (Math.max(r, g, b) < 24) continue;               // 近黑：不當主色（混進淺底也只是灰）
      const key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);            // 量化成 8 階
      const rec = buckets.get(key) || [0, 0, 0, 0];
      rec[0] += r; rec[1] += g; rec[2] += b; rec[3]++;
      buckets.set(key, rec);
    }
    if (!total) return null;

    // ① 白底圖 → 就用白（2026-07-20 使用者要求）。
    //    近白像素過半即視為白底；回傳它們的平均，米白/象牙白會被保留而不是硬套純白。
    if (light[3] / total > 0.45) {
      return [Math.round(light[0] / light[3]), Math.round(light[1] / light[3]), Math.round(light[2] / light[3])];
    }
    // ② 否則取「有顏色」像素裡最多的一群當主色（白邊/黑邊不會搶走整張卡的顏色）
    let best = null;
    for (const rec of buckets.values()) if (!best || rec[3] > best[3]) best = rec;
    if (!best) {
      // 整張都是近白/近黑 → 用近白平均（有的話），否則放棄
      if (light[3]) return [Math.round(light[0] / light[3]), Math.round(light[1] / light[3]), Math.round(light[2] / light[3])];
      return null;
    }
    return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
  } catch (e) { return null; }   // 解碼未完成等狀況 → 放棄，維持原底色
}
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

/* ===== 封面解析快取（2026-08-05）=====
   md 的封面要跑 getFileCache + 3 條 regex + getFirstLinkpathDest + getResourcePath。
   4000 檔的資料夾每次 render / 每次標籤篩選 / 搜尋牆每 150ms 重繪都全量重算一遍，
   是「點資料夾第一下卡頓」的主因。這裡以 path 為 key、mtime 當版本快取結果。

   失效（invalidateCoverCache）：
     • metadataCache 'changed' → 只清那一筆（mtime 可能已更新但 cache 還是舊的，
       光靠 mtime 比對會把過期結果永久黏住）
     • vault create / delete / rename → 整份清掉（封面可能指向別的檔案，
       那個檔案被改名/刪除時 md 自己的 mtime 不會變） */
const _coverCache = new Map();   // path → { mtime, src }
function invalidateCoverCache(path) {
  if (path) _coverCache.delete(path); else _coverCache.clear();
}
function coverFor(app, f, isImg) {
  const hit = _coverCache.get(f.path);
  if (hit && hit.mtime === f.stat.mtime) return hit.src;
  const src = isImg
    ? app.vault.getResourcePath(f)
    : coverSrc(app, app.metadataCache.getFileCache(f), f.path);
  if (_coverCache.size > 20000) _coverCache.clear();   // 上限防呆，成本只是重算一次
  _coverCache.set(f.path, { mtime: f.stat.mtime, src });
  return src;
}

function itemFromFile(app, f) {
  const isImg = IMG_EXT.test(f.path);
  const it = {
    file: f,
    name: f.basename,
    ext: (f.extension || '').toLowerCase(),
    isImg,
    ctime: f.stat.ctime,
    mtime: f.stat.mtime,
  };
  /* src（封面）惰性求值：被標籤篩選掉、或根本沒進到可視範圍的項目完全不用算。
     圖片檔本身即封面（免讀 cache）；md 才讀 frontmatter/內文封面；其他檔型無封面。 */
  Object.defineProperty(it, 'src', {
    enumerable: true,
    configurable: true,
    get() {
      const v = coverFor(app, f, isImg);
      // 求過一次就把 getter 換成一般欄位，之後連 Map 查詢都省
      Object.defineProperty(it, 'src', { value: v, writable: true, enumerable: true, configurable: true });
      return v;
    },
    set(v) {
      Object.defineProperty(it, 'src', { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
  return it;
}

// 非圖片、無封面的檔型 → 對應的 lucide 圖示
// 自訂資料夾圖示：闔起＝實心填滿（明顯關閉）、展開＝線框開啟（明顯打開），差異大、不依賴 lucide
const FOLDER_CLOSED_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

/* SVG 樣板快取（2026-08-05）：同一個圖示在樹上每一列都要一份，
   以前每列都 new DOMParser() 重解一次（>100 列的子樹就是 100 次解析）。
   改成每種圖示只解析一次存成樣板，之後一律 cloneNode(true)。
   ⚠️ 樣板本身永遠不掛到畫面上，只當複製來源。 */
const _svgTpl = new Map();
function svgClone(key, make) {
  let tpl = _svgTpl.get(key);
  if (tpl === undefined) { tpl = make() || null; _svgTpl.set(key, tpl); }
  return tpl ? tpl.cloneNode(true) : null;
}

// SVG 常數 → DOM（不用 innerHTML：上架審查會標記，且 DOMParser 同樣快）
function setSvg(el, svg) {
  el.textContent = '';
  try {
    const node = svgClone(svg, () => {
      // ⚠️ 一定要用 text/html 模式：SVG 常數沒寫 xmlns，XML 模式解析出來的 <svg>
      //   是「無命名空間元素」，掛上去不會渲染（2026-07-18 圖示消失事故）。
      //   HTML 解析器會把 <svg> 當外來內容、自動給正確命名空間——跟 innerHTML 行為一致。
      const parsed = new DOMParser().parseFromString(svg, 'text/html').body.firstElementChild;
      if (!parsed || !parsed.tagName || parsed.tagName.toLowerCase() !== 'svg') return null;
      return document.importNode(parsed, true);
    });
    if (node) el.appendChild(node);
  } catch (e) {}
}

/* lucide 圖示的樣板版：setIcon() 每次呼叫都要重建一次 SVG，
   樹列的箭頭、卡片的檔型圖示都是「同一個圖示畫幾百次」。
   取不到樣板（API 行為改變）時自動退回原生 setIcon。 */
function setIconCached(el, name) {
  try {
    const node = svgClone('lucide:' + name, () => {
      const tmp = document.createElement('span');
      setIcon(tmp, name);
      return tmp.firstElementChild || null;
    });
    if (node) { el.textContent = ''; el.appendChild(node); return; }
  } catch (e) {}
  setIcon(el, name);
}

function setFolderIcon(el, open) {
  setSvg(el, open ? FOLDER_OPEN_SVG : FOLDER_CLOSED_SVG);
}

/* 樹列的圖示欄（2026-07-31）：圖示與展開箭頭疊在同一格，hover 時交叉淡入。
   以前是「箭頭一欄 + 圖示一欄」，箭頭欄對不能展開的資料夾永遠是空的，
   白白吃掉 26px 又讓視線多一個落點。合併後列更緊湊，而且因為兩者疊在
   同一格，有沒有箭頭都不會讓列寬跳動。
   回傳 { slot, thumb, caret }；不需要箭頭的列（根目錄、最愛）不碰 caret 即可。 */
function makeIconSlot(row) {
  const slot = row.createSpan('gn-tslot');
  const thumb = slot.createSpan('gn-tthumb');
  const caret = slot.createSpan('gn-tcaret');
  return { slot, thumb, caret };
}

function iconForExt(ext) {
  if (ext === 'canvas') return 'frame';        // 畫布（artboard 風）
  if (ext === 'pdf') return 'file-text';
  if (ext === 'base') return 'layout-grid';    // 圖庫（2x2 四格）
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

// （2026-07-20 移除）GN_VIDEO_URL_RE：自動影片卡下架，卡片不再偵測影片連結

// 卡片樣式選項（2026-07-18）：[key, i18n label, lucide icon]；null = 預設
const CARD_STYLES = [
  [null, 'Auto (default)', 'sparkles'],            // 2026-07-20 起自動偵測已全部下架（待辦卡/影片卡），此項等同一般卡片
  ['plain', 'Plain card', 'rectangle-horizontal'], // 強制一般卡片（抑制自動偵測）
  ['todo', 'To-do list card', 'list-checks'],
  // 書籍卡/影片卡手動樣式暫時下架（2026-07-19 使用者要求；程式保留休眠，恢復＝加回此清單）
  // ['video', 'Video card', 'play'],
  // ['book', 'Book card', 'book'],
];
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

/* 路徑字串或 TFile 都收，一律回 TFile / null。
   ⚠️ 為什麼需要這層：buildTagIndex() 的 map 存的是 **TFile 物件**（不是路徑字串），
      而 renameTag / renameTagInBody / deleteTag 都把它當路徑餵給 getAbstractFileByPath()。
      原生實作是 `this.fileMap.hasOwnProperty(e) ? this.fileMap[e] : null`，
      物件會被轉成 "[object Object]" → 永遠查無 → `instanceof TFile` 檢查把**每一個**
      檔案都跳過，改名靜默失敗（顯示「已更新 0 則筆記」且不報錯）。
      統一走這個函式，之後兩種型別都不會再踩到。 */
function asFile(app, p) {
  return p instanceof TFile ? p : app.vault.getAbstractFileByPath(p);
}

/* 反向連結索引：被引用的路徑 → 引用它的來源路徑 Set。
   resolvedLinks 的方向是 src → { target: 次數 }，要問「誰引用了我」只能反查。
   ⚠️ 舊寫法是在 candidate 迴圈**裡面**跑 `for (const src of Object.keys(res))`，
      每個附件都重新配置一次全 vault 長度的陣列 → O(附件數 × vault 大小)。
      多選 200 則圖多的筆記時 candidate 可達上千個，乘上萬檔 vault 就是上千萬次迭代，
      刪除確認框會凍住好幾秒。改成一次 O(V+E) 建表，之後每個 candidate 都是 O(1) 查詢。 */
function buildBacklinkIndex(mc) {
  const res = mc.resolvedLinks || {};
  const back = new Map();
  for (const src of Object.keys(res)) {
    const targets = res[src];
    if (!targets) continue;
    for (const tgt of Object.keys(targets)) {
      let s = back.get(tgt);
      if (!s) { s = new Set(); back.set(tgt, s); }
      s.add(src);
    }
  }
  return back;
}

/* 只算資料夾底下的檔案總數（樹狀清單用；不排序、不讀 metadata，比 folderStats 輕很多）

   ⚠️ 這個函式在 buildLevel 裡對**每個可見的兄弟資料夾**都會被呼叫一次，
      而每次都遞迴走完整個子樹。第一層所有兄弟的子樹加起來就是整個 vault，
      所以光是畫根層就已經 O(全 vault 檔案數)；每展開一層，該層子樹又被重走一遍。
      而 refreshTree() 掛在展開／收合／拖曳排序／最愛開合等**所有**左樹互動上
      —— 等於每點一次資料夾箭頭都付一次全 vault 走訪的稅。

   解法：以 folder.path 為 key 快取，而且遞迴時也走快取
   （子資料夾的數字算過就直接取用，同一批檔案不會被重複數 D 次）。
   結構改變（create/delete/rename）時由 invalidateFolderCounts() 整個清掉。 */
const _folderCountCache = new Map();
function invalidateFolderCounts() { _folderCountCache.clear(); }
function folderFileCount(folder) {
  const hit = _folderCountCache.get(folder.path);
  if (hit !== undefined) return hit;
  let n = 0;
  for (const ch of folder.children) {
    if (ch instanceof TFolder) n += folderFileCount(ch);   // 走快取，不重新遞迴整棵子樹
    else n++;
  }
  _folderCountCache.set(folder.path, n);
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
    const btns = contentEl.createDiv('modal-button-container');   // 原生 class，主題才吃得到
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
  // onCancel：使用者按取消／Esc／點外面關閉時呼叫。
  // 批次流程（例如 Canvas 一次轉多張圖）需要靠它知道要中止剩下的，
  // 沒有的話關掉視窗跟「送出空字串」無法區分。
  constructor(app, title, initial, onSubmit, okLabel, onCancel) {
    super(app);
    this.titleText = title;
    this.initial = initial || '';
    this.onSubmit = onSubmit;
    this.okLabel = okLabel || t('Create');
    this.onCancel = onCancel || null;
    this._submitted = false;
  }
  onOpen() {
    const { contentEl } = this;
    /* 用 Obsidian 的標準結構（2026-08-01）：
       以前是裸 <h3> + 自訂的 .gn-modal-btns → 主題針對 .modal-title /
       .modal-button-container 寫的規則全部套不到，按鈕只吃得到通用 <button>
       樣式（在 Velocity 就變成兩顆巨大膠囊）。改用原生 class 之後，
       這個對話框在任何主題下都會跟該主題其他對話框長得一樣。 */
    this.setTitle(this.titleText);
    const input = contentEl.createEl('input', { type: 'text', cls: 'gn-input' });
    input.value = this.initial;
    const btns = contentEl.createDiv('modal-button-container');
    const cancel = btns.createEl('button', { text: t('Cancel') });
    cancel.onclick = () => this.close();
    const ok = btns.createEl('button', { text: this.okLabel });
    ok.addClass('mod-cta');
    const submit = () => { const v = input.value.trim(); if (v) { this._submitted = true; this.close(); this.onSubmit(v); } };
    ok.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() {
    this.contentEl.empty();
    if (!this._submitted && this.onCancel) this.onCancel();
  }
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
    this._tagDirty = true;       // 標籤索引快取失效旗標（buildTagIndex 專用，用完會清掉）
    /* 世代編號：標籤相關資料每變動一次就 +1。
       ⚠️ 不能讓多個快取共用 _tagDirty 這個布林——先跑的那個會把旗標清掉，
          後跑的就永遠看不到「該失效」。每個快取記下自己算的時候是第幾代即可。 */
    this._tagGen = 0;
    this._folderTagsCache = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Gallery Navigator'; }
  getIcon() { return GN_ICON_ID; }   // 外掛專屬圖示（2026-07-20，取代原本的 egg 🥚）

  async onOpen() {
    this.render();
    // 開啟任一筆記時，若同步開著 → 定位到它的資料夾（從日曆開的會設跳過旗標）
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (this._graph) this._graph.setFile(file);
      // 只跳過「從行事曆開的那個特定檔案」——用路徑比對，不用無差別旗標
      // （否則日記若已開著、不觸發 file-open，旗標會殘留 → 被之後點的連結誤消耗 → 連結不定位）
      if (file && this.plugin._skipSyncPath === file.path) { this.plugin._skipSyncPath = null; return; }
      if (!this.plugin.state.syncActive) return;
      if (this.isCanvasEmbed(file)) return;   // 在 Canvas 裡點圖片/內嵌節點 → 不要跳去 img/
      this.syncToFile(file);
    }));
    // 標籤索引快取失效：metadata 變動或檔案增刪改名時標記，下次用到才重建
    const markTagDirty = () => { this._tagDirty = true; this._tagGen++; };
    this.registerEvent(this.app.metadataCache.on('changed', markTagDirty));
    /* 'create' 在 Obsidian 啟動時會對「每個既有檔案」各發一次（數千次），
       延到 layout ready 後才註冊，避開啟動期洪水。 */
    let createAlive = true;
    this.register(() => { createAlive = false; });
    this.app.workspace.onLayoutReady(() => {
      if (!createAlive) return;
      this.registerEvent(this.app.vault.on('create', markTagDirty));
    });
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
        if (this._hover && this._cardOrder && this._cardOrder.length) {
          e.preventDefault();
          this.selectAll();
        }
      } else if (e.key === 'Escape' && this.selected && this.selected.size) {
        this.clearSel();
      }
    });
  }

  async onClose() {
    if (this._dockRO) { try { this._dockRO.disconnect(); } catch (e) {} this._dockRO = null; }
    if (this._graph) { this._graph.destroy(); this._graph = null; }   // 停掉 RAF 與 ResizeObserver
    // gn-leaf 掛在外層的 .workspace-leaf-content 上（不屬於 contentEl，empty() 清不到）
    // → 關閉時自己收回來，避免這個葉面板被別的 view 重用時殘留樣式
    if (this.contentEl && this.contentEl.parentElement) this.contentEl.parentElement.removeClass('gn-leaf');
    // 清理 observer，避免關閉分頁後殘留
    for (const m of (this._masonries || [])) { try { m.destroy(); } catch (e) {} }
    this._masonries = [];
    for (const v of (this._virtuals || [])) { try { v.destroyAll(); } catch (e) {} }
    this._virtuals = [];
    if (this._ogObserver) { this._ogObserver.disconnect(); this._ogObserver = null; }
    if (this._wallIO) { this._wallIO.disconnect(); this._wallIO = null; }
    if (this._paneRO) { this._paneRO.disconnect(); this._paneRO = null; }
    if (this._syncRaf) { cancelAnimationFrame(this._syncRaf); this._syncRaf = 0; }
    // 關閉分頁 → 停掉還在背景解圖的長寬比預取（下次 render 會自己重啟）
    if (this.plugin.dimPrefetch) this.plugin.dimPrefetch.cancel();
    this.closeTodoPopover();   // 連同 document 上的 mousedown 監聽一起解除
    this.closeMorePopover();   // 掛在 body 上的浮動面板要一起收掉
  }

  // 重排目前這面牆的所有分區。延遲載入（內文預覽 / og:image / PDF 縮圖）會改變卡片高度，
  // 連結牆有兩個 grid，只重排其中一個會漏掉另一區 → 破版。
  // 重排所有瀑布流。（手機兩欄改用 transform 平移後，重排不會影響「顯示哪一欄」，這裡不必再顧捲動）
  /* node（可省略）＝內容真正變動的那個節點。給了就只重量那一張卡，
     沒給就全量重量（舊行為）。見 MasonryLayout.noteChanged。 */
  relayoutWalls(node) {
    for (const m of (this._masonries || [])) m.noteChanged(node || null);
    for (const v of (this._virtuals || [])) v.notifyContentChanged();
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

  /* 這個檔案是不是「目前這面牆上本來就有」的項目。
     攤平模式下右欄是整棵子樹的檔案，子資料夾的檔案也在牆上 —— 這種情況
     **不該**跳去它所在的子資料夾，否則使用者在攤平的大牆上捲很久之後點一張卡，
     畫面會立刻換成那個子資料夾的牆、捲動位置全丟（2026-08-06 使用者回報）。 */
  isInCurrentWall(file) {
    if (!this.plugin.state.flattenFolders) return false;
    if (this._searchQ) return false;                       // 搜尋牆有自己的來源清單
    const base = this.path || '';
    // 根目錄（base 為空）攤平＝整個 vault 都在牆上
    if (base && !file.path.startsWith(base + '/')) return false;
    // 攤平時 notesInDeep 會跳過隱藏子資料夾 → 那些檔案並不在牆上
    if (this.plugin.isHiddenPath(file.path)) return false;
    return true;
  }

  syncToFile(file) {
    if (this.drag) return;                        // 拖曳進行中 → 不重繪，避免中斷拖曳
    if (this.plugin.state.leftMode === 'tag') return;   // 標籤模式不做資料夾定位
    if (!(file instanceof TFile)) return;
    const curFolder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    // 同一面牆＝同資料夾，或攤平模式下這個檔案本來就在牆上
    const sameWall = curFolder === this.path || this.isInCurrentWall(file);
    if (sameWall && this.activePath === file.path) return;  // 無變化不重繪
    // 同一面牆內換檔 → 只更新 active 卡片，不整頁重畫（避免 PDF 縮圖等重載）
    if (sameWall) { this.setActiveCard(file.path); return; }
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
      /* 跨資料夾定位（2026-07-20）：右欄卡片牆也要捲到 active 卡片。
         若該筆記在分批渲染的第一批之外，卡片還沒建出來 → 以前用固定 400ms 再試一次猜，
         現在改成「卡片出現了就定位」（內容長高才會再試，見 settleScroll）。 */
      this.setActiveCard(file.path);
      this.settleScroll(() => {
        if (!this.cardElsFor(file.path).length) return false;
        this.setActiveCard(file.path);
        return true;
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

  async openNote(file, newTab) {
    // 從畫廊開的筆記「不聚焦編輯器」（2026-07-18）：游標不落在第一行，
    // Live Preview 的首行嵌入圖片就不會展開成 ![[...]] 原始碼。
    // 作法：openFile 直接要求不聚焦（eState.focus:false），再於開檔後幾個時間點補 blur
    // （Obsidian 某些路徑會晚一步搶焦點）→ 不會像先前 120ms 單發那樣「閃一下」。
    if (this.plugin.state.openUnfocused === false) {   // 設定關閉 → 原生行為
      this.app.workspace.openLinkText(file.path, '', !!newTab);
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf(!!newTab);
      await leaf.openFile(file, { eState: { focus: false } });
    } catch (e) {
      this.app.workspace.openLinkText(file.path, '', !!newTab);   // 萬一 API 變動退回舊路
    }
    const blurNow = () => {
      try {
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mv && mv.editor && mv.editor.hasFocus && mv.editor.hasFocus()) mv.editor.blur();
      } catch (e) {}
    };
    blurNow();
    requestAnimationFrame(blurNow);
    window.setTimeout(blurNow, 60);
    window.setTimeout(blurNow, 160);
  }

  // （2026-07-20 移除）連結牆整套下架：outgoingMdFiles / incomingMdFiles / showLinks / renderLinksWall 一併移除。

  // 在資料夾內新建檔案（自動避開同名），建立後開啟。ext: md / canvas / base
  async newFile(folder, ext, content) {
    const dir = !folder || folder.path === '/' ? '' : folder.path + '/';
    let path = dir + t('Untitled') + '.' + ext;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) { path = dir + t('Untitled') + ' ' + n + '.' + ext; n++; }
    try {
      const file = await this.app.vault.create(path, content || '');
      /* 這裡不自己 render()：vault 'create' 事件 → refreshViews() 的 150ms 去抖
         本來就會重畫這個 View，多打一次只是把整頁重建成本翻倍。 */
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
  /* 本夾標籤統計。一次 render 至少被叫兩次（標籤 dock、「更多」面板），
     攤平模式下每次都要遞迴整棵子樹 + 對每則 md 讀 metadata cache。
     → 以「資料夾 + 攤平 + 隱藏清單 + 標籤世代」為 key 快取。 */
  folderTags() {
    if (this.plugin.state.leftMode === 'tag') return [];   // 標籤模式本身就在看標籤，不重複
    const folder = this.folderAt(this.path);
    if (!folder) return [];
    const flatten = !!this.plugin.state.flattenFolders;
    const hidden = this.plugin.state.hiddenFolders || [];
    const key = (folder.path || '/') + '|' + (flatten ? 1 : 0) + '|' + (this.showHidden ? 1 : 0) + '|' + hidden.join(',');
    const gen = this._tagGen || 0;
    const c = this._folderTagsCache;
    if (c && c.key === key && c.gen === gen) return c.value;
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
    const value = [...count.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    this._folderTagsCache = { key, gen, value };
    return value;
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
    if (this._morePop) { this.closeMorePopover(); return; }   // 再點一次＝收起（走同一條路徑，才會一併清事件）
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
        this.rerenderMainKeepScroll();   // sort 只被 renderNoteWall 讀到
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

    /* ── 手機：卡片欄數 1/2/3（2026-07-19 從設定頁移入；選了即時重畫） ──
         編輯風索引卡固定 2 欄 → 該模式下不顯示此區，免得點了沒反應。 */
    if (document.body.classList.contains('is-mobile') && state.imageCardLayout !== 'editorial') {
      pop.createDiv('gn-more-label').setText(t('Mobile columns'));
      for (const n of [1, 2, 3]) {
        const row = pop.createDiv('gn-more-row');
        row.createSpan('gn-more-text').setText(t(n + (n === 1 ? ' column' : ' columns')));
        const mark = row.createSpan('gn-more-check');
        if ((state.mobileCols || 2) === n) setIcon(mark, 'check');
        row.onclick = () => {
          state.mobileCols = n;
          this.plugin.saveState();
          this.closeMorePopover();
          this.render();   // 欄數變了 → 整面重畫（含單欄豁免 class 更新）
        };
      }
      pop.createDiv('gn-more-sep');
    }

    /* ── 卡片大小：真的滑桿，拖曳即時生效（手機不顯示：手機是固定欄數，改在「更多」面板調） ── */
    if (!document.body.classList.contains('is-mobile')) {
      pop.createDiv('gn-more-label').setText(t('Card size'));
      const zoom = pop.createEl('input', { type: 'range' });
      zoom.addClass('gn-zoom');
      // 編輯風索引卡有欄寬下限（縮圖+內距塞不下）→ 滑桿最小值跟著提高，
      // 否則拉到 120~140 會「看起來沒反應」（makeGrid 那邊會被 Math.max 夾住）。
      const zMin = state.imageCardLayout === 'editorial' ? GN_EDITORIAL_MIN_COL : 120;
      zoom.min = String(zMin); zoom.max = '300'; zoom.step = '10';
      zoom.value = String(Math.max(zMin, state.cardWidth || 120));
      zoom.oninput = () => {
        const v = Math.max(zMin, Number(zoom.value));
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

    /* ── 同步定位（2026-07-19 從工具列移入）── */
    const syncRow = pop.createDiv('gn-more-row');
    const sIcon = syncRow.createSpan('gn-more-icon');
    setIcon(sIcon, 'crosshair');
    syncRow.createSpan('gn-more-text').setText(t('Follow active note'));
    const syncMark = syncRow.createSpan('gn-more-check');
    if (state.syncActive) setIcon(syncMark, 'check');
    syncRow.onclick = () => {
      state.syncActive = !state.syncActive;
      this.plugin.saveState();
      this.closeMorePopover();
      // 關閉時不用重畫：syncActive 只被 file-open 監聽器與本面板讀到，畫面上沒有任何依賴
      if (state.syncActive) this.syncToFile(this.app.workspace.getActiveFile());
    };

    /* ── 待辦筆記（2026-07-20）：工具列待辦鈕改成「有指定才顯示」，
         這裡是沒指定時唯一的設定入口，指定後鈕就會回到工具列 ──
         ⏸️ 暫時停用（2026-07-20 使用者要求）：連同工具列待辦鈕一起註解，恢復＝取消本區與工具列同標記區塊的註解 */
    /*
    const todoRow = pop.createDiv('gn-more-row');
    const tdIcon = todoRow.createSpan('gn-more-icon');
    setIcon(tdIcon, 'list-checks');
    const tdFile = state.todoNote ? this.app.vault.getAbstractFileByPath(state.todoNote) : null;
    todoRow.createSpan('gn-more-text').setText(
      tdFile instanceof TFile ? t('To-do note: {{name}}', { name: tdFile.basename }) : t('Pick a to-do note')
    );
    todoRow.onclick = () => { this.closeMorePopover(); this.pickTodoNote(); };
    */

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

  /* 卡片區空白處右鍵 →「在此新建」（與工具列那顆＋同一個選單）。

     ⚠️ 一定要自己判斷「右鍵點到的是不是卡片」。
        卡片有自己的右鍵選單（wireContextMenu），而那裡只有 preventDefault、
        **沒有 stopPropagation** —— 不擋的話右鍵一張卡會同時跳出兩個選單。
        工具列與多選動作列同理，它們自己就有操作。

     ⚠️ 手機刻意不掛長按。長按已經被卡片的選單佔用，在容器上再掛一層就會
        變成兩個選單疊加（2026-07-31 踩過同型的坑）。
        手機請用工具列那顆＋，它本來就在。

     只在「資料夾檢視」啟用：搜尋結果與標籤檢視都沒有明確的「這裡」——
     folderAt() 在那兩種情況會回退到上次的資料夾或根目錄，
     建出來的檔案會跑到使用者沒預期的地方。 */
  wireMainCreateMenu(main) {
    main.addEventListener('contextmenu', (e) => {
      if (this._searchOn) return;
      if (this.plugin.state.leftMode === 'tag') return;
      const el = e.target;
      if (el && el.closest && el.closest('.gn-card, .gn-main-head, .gn-bar, .gn-selbar, .gn-dock, .gn-empty-actions')) return;
      const folder = this.folderAt(this.path);
      if (!folder) return;
      e.preventDefault();
      this.newFileMenu(folder, e);
    });
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
    const back = buildBacklinkIndex(mc);   // 一次建表，取代迴圈內的全 vault 掃描
    const seen = new Set();
    const out = [];
    for (const r of raws) {
      const lp = String(r.link || '').split('#')[0].split('|')[0].trim();
      if (!lp) continue;
      const f = mc.getFirstLinkpathDest(lp, file.path);
      if (!(f instanceof TFile) || f.extension === 'md' || seen.has(f.path)) continue;
      seen.add(f.path);
      let used = false;
      for (const src of (back.get(f.path) || [])) {
        if (src !== file.path) { used = true; break; }
      }
      if (!used) out.push(f);
    }
    return out;
  }

  // 批次版孤兒判定（2026-07-20）：一次刪多個筆記時，附件只要「所有引用它的筆記都在刪除清單內」
  // 就算孤兒——單筆版的 orphanAttachmentsOf 會把「被另一個也要刪的筆記引用」誤判成非孤兒。
  orphanAttachmentsOfMany(paths) {
    const mc = this.app.metadataCache;
    const back = buildBacklinkIndex(mc);   // 一次建表，取代 candidate 迴圈內的全 vault 掃描
    const delSet = new Set(paths);
    const candidates = new Set();   // 被刪筆記引用到的非 md 附件路徑
    const byPath = new Map();
    for (const p of paths) {
      const file = this.app.vault.getAbstractFileByPath(p);
      if (!(file instanceof TFile)) continue;
      const cache = mc.getFileCache(file);
      if (!cache) continue;
      for (const r of [...(cache.embeds || []), ...(cache.links || [])]) {
        const lp = String(r.link || '').split('#')[0].split('|')[0].trim();
        if (!lp) continue;
        const f = mc.getFirstLinkpathDest(lp, file.path);
        if (!(f instanceof TFile) || f.extension === 'md') continue;
        if (delSet.has(f.path)) continue;   // 附件自己也在刪除清單 → 主迴圈會處理，不重複
        candidates.add(f.path); byPath.set(f.path, f);
      }
    }
    const out = [];
    for (const ap of candidates) {
      let externalRef = false;
      for (const src of (back.get(ap) || [])) {
        if (delSet.has(src)) continue;                       // 被刪的來源不算引用
        externalRef = true; break;
      }
      if (!externalRef) out.push(byPath.get(ap));
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
    const before = (this.plugin.state.hiddenFolders || []).length;
    const set = new Set(this.plugin.state.hiddenFolders || []);
    if (hide) set.add(path); else set.delete(path);
    this.plugin.state.hiddenFolders = [...set];
    this.plugin.saveState();
    /* hiddenFolders 影響：左樹（隱藏列）＋卡片牆（攤平時排除）＋工具列眼睛鈕的「有無」。
       眼睛鈕只在 0 ↔ 非 0 的交界才出現/消失 → 只有那時才需要整頁重畫。 */
    const emptyChanged = (before === 0) !== (set.size === 0);
    if (emptyChanged) { this.render(); return; }
    this.refreshTree();
    this.rerenderMainKeepScroll();
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
    // noPreviewFolders 只被 renderNoteWall 與右鍵選單（現場建）讀到
    this.rerenderMainKeepScroll();
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
    /* 2026-07-31：原本是「箭頭一欄 + 星星一欄」，比下面的資料夾列多一欄，
       所以「最愛」的文字跟「Yaoting」對不齊。改用跟資料夾樹同一個圖示欄：
       平常顯示星星、hover 才換成箭頭，縮排就跟其他列一致了。
       整列本來就可點擊收合（head.onclick），箭頭只是視覺提示，藏起來不損失功能。 */
    const fav = makeIconSlot(head);
    setIcon(fav.thumb, 'star');
    setIcon(fav.caret, 'chevron-right');   // 展開狀態由 .gn-topen 轉 90°
    if (!collapsed) head.addClass('gn-topen');
    head.addClass('gn-thaskids');           // 讓 hover 換箭頭的規則生效
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
      // 最愛是捷徑、不能展開 → 只用圖示欄的圖示
      const { thumb } = makeIconSlot(row);
      // 資料夾用和樹狀圖同一個自訂資料夾圖示（並加 folder class 一起藏）；筆記用 lucide file-text（保留）
      if (f.type === 'folder') { thumb.addClass('gn-tthumb-folder'); setFolderIcon(thumb, false); }
      else setIconCached(thumb, 'file-text');
      row.createSpan('gn-tname').setText(af.basename || af.name);
      row.onclick = () => {
        if (f.type === 'folder') {
          this.plugin.state.leftMode = 'folder';
          this.navigate(f.path);
          this.gotoCardsMobile();
        } else {
          this.openNote(af, false);
          // 右欄強制定位到這個檔案（2026-07-19）：檔案已開啟時 file-open 不會再觸發、
          // syncToFile 遇「已 active」也會無動作返回 → 直接補 setActiveCard 捲到卡片。
          // 不受「同步定位」開關影響——點最愛＝明確的定位意圖。
          this.plugin.state.leftMode = 'folder';
          this.syncToFile(af);
          this.setActiveCard(af.path);   // 同牆已 active → 立刻捲到卡片
          /* 跨資料夾的情況不用在這裡補 400ms：syncToFile 內部重畫後自己會走
             settleScroll（卡片一出現就定位），不必再猜一個時間。 */
          this.gotoCardsMobile();
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
    // pinnedCards 只被 renderNoteWall（排序）與 makeCard（角標）讀到 → 右欄就夠
    this.rerenderMainKeepScroll();
  }

  async loadPreview(file, el) {
    const card = el.parentElement;   // el 可能被 remove()，先留著卡片本體給重排用
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
    this.relayoutWalls(card);   // 預覽文字載入後高度變 → 只重排這張卡
  }

  // Canvas 縮圖：解析 .canvas JSON，取第一個圖片節點當封面

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
      card.removeClass('gn-icon-cover');   // 換成真圖 → 文字改回疊圖模式
      if (placeholder) placeholder.remove();
      this.relayoutWalls(card);
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
      /* 快取供之後重畫直接用。
         ⚠️ 一定要設上限：存的是 480px 寬 PNG 的 base64 字串，每筆約 200–600 KB。
            這個 Map 掛在 plugin 上（不是 view），onClose / onunload 都不會清 ——
            瀏覽一個 200 個 PDF 的資料夾就是 50–120 MB 常駐字串，直到 Obsidian 重啟。
            Map 保有插入順序，取第一個 key 就是最舊的那筆（近似 LRU 的 FIFO）。 */
      const PDF_THUMB_MAX = 60;   // 約 12–36 MB 上限
      while (cache.size >= PDF_THUMB_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      cache.set(key, dataUrl);
      if (card.isConnected) put(dataUrl);
    } catch (e) { /* 保留圖示 */ }
    finally { try { if (doc) doc.destroy(); } catch (e) {} }
  }

  /* 用長寬比索引先佔好圖片高度，並在真的載入後回填 / 校正索引。
     沒有這一步的話：img 只有 width:100%、height:auto，載入前高度是 0，
     載入後才撐開 → 每張圖都改變卡片高度 → 每張圖都觸發一次 O(全部卡片) 的重排。
     圖片是陸續載入的，於是連續數十上百個 frame 都在跑滿版重排。
     key 用去掉查詢字串的資源路徑：getResourcePath() 會在尾巴加 ?mtime，
     去掉之後 vault 圖片與 og-cache 圖片都能得到穩定的鍵。 */
  /* 長寬比索引的 key：**vault 相對路徑**，不是資源網址。

     ⚠️ 這裡踩過一個很貴的坑，不要改回去。
        原本是拿 vault.getResourcePath() 回來的字串（去掉 ?mtime）當 key，
        長這樣：app://8a1c160e943893115be8616e16ea16b19f23/Users/…
        但那串十六進位前綴是 Obsidian 每次啟動向主行程要的隨機權杖
        （app.js：resourcePathPrefix = ipcRenderer.sendSync("file-url")）。

        後果：每重開一次 Obsidian，整份索引就全部對不上。
          • 卡片拿不到長寬比 → 不預留高度 → 初始高度 0
          • 圖片陸續載入後容器才長高 → **捲軸一開始很長、然後變短**
          • dims.json 每次啟動再累積一整份死 key（實測 898 筆幾乎全是廢的）

        檔案路徑跨工作階段穩定，才是正確的 key。 */
  dimKeyOf(it) {
    if (!it) return '';
    if (typeof it === 'string') return it;              // 已經是 key（例如 'og:筆記路徑'）
    return it.file ? it.file.path : '';
  }

  /* 決定卡片圖片實際要載入哪一個檔案：縮圖優先，原圖是退路。
     ⚠️ 沒有縮圖時**不先塞原圖再替換**——那樣峰值記憶體跟完全沒做縮圖一樣
        （見 thumbs.js 設計說明 2）。寧可先留白，縮圖好了再填。 */
  setCardImage(img, it) {
    const file = it.file;
    const useOriginal = () => {
      this.applyDim(img, it);
      img.src = it.src;
    };
    // 非圖片檔（md 的封面 / og 圖）與小圖、GIF、SVG：本來就不貴，直接用原圖
    if (!it.isImg || this.plugin.thumbs.shouldSkip(file)) { useOriginal(); return; }

    const ready = this.plugin.thumbs.urlFor(file);
    if (ready) { this.applyDim(img, it); img.src = ready; return; }

    // 先用長寬比佔好高度（若已知），避免縮圖填入時整牆重排
    this.applyDim(img, it);
    img.addClass('gn-img-pending');
    this.plugin.thumbs.request(file, (url) => {
      if (!img.isConnected) return;                 // 已經捲走 / 重畫過了
      img.removeClass('gn-img-pending');
      img.src = url || it.src;                      // 做不出縮圖 → 退回原圖
    });
  }

  applyDim(img, itOrKey) {
    const key = this.dimKeyOf(itOrKey);
    if (!key) return;
    const idx = this.plugin._dimIndex || (this.plugin._dimIndex = {});
    const d = idx[key];
    if (d && d[0] > 0 && d[1] > 0) img.style.aspectRatio = d[0] + ' / ' + d[1];
    // 一律掛一次性 load：沒快取時建立、有快取時校正（圖片被換掉長寬比會變）。
    // {once:true} 會自動解除，不會累積監聽器；這裡也**不呼叫** scheduleLayout——
    // 重排交給 masonry container 的捕獲監聽統一處理，避免同一張圖排兩次。
    img.addEventListener('load', () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      const prev = idx[key];
      if (prev && prev[0] === w && prev[1] === h) return;   // 沒變就不寫、不存檔
      idx[key] = [w, h];
      img.style.aspectRatio = w + ' / ' + h;
      this.plugin.saveDimIndex();
    }, { once: true });
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
      /* key 用 'og:<筆記路徑>'：og 圖存在外掛資料夾、沒有 vault 路徑可用，
         但一則筆記固定對應一張 og 圖，用筆記路徑當 key 一樣跨工作階段穩定。 */
      this.applyDim(img, 'og:' + file.path);
      img.src = resUrl;
      img.loading = 'lazy';
      img.addClass('gn-linkimg');
      card.appendChild(img);   // 滿版圖片
      // 載入成功 → 以圖代文：改成圖片卡。
      // 內文預覽**不刪除**（只是被 CSS 收起來），hover 時才展開 → 圖跟文都留得住。
      img.onload = () => {
        card.addClass('gn-has-img');
        this.autoTintCard(card, img, 'og:' + file.path);   // 連結預覽圖也套自動底色
        /* 這裡不用再叫 relayoutWalls()：圖片 load 會被 masonry 容器的捕獲監聽、
           以及虛擬牆 grid 上的捕獲監聽各接一次，重排本來就會發生。
           以前這支在 put / onload / onerror 連叫三次，等於同一張圖排三輪。 */
      };
      img.onerror = () => { img.remove(); this.relayoutWalls(card); };
      this.relayoutWalls(card);
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

  /* 右欄底部的浮動面板（2026-08-01）
     ⚠️ 刻意用「絕對定位掛在 .gn-split 上」而不是把 .gn-main 包一層：
        手機的雙欄平移仰賴 .gn-main 是 .gn-split 的直接 flex 子元素
        （flex: 0 0 100% + translateX），包一層就會壞掉。
     ⚠️ 手機不啟用：螢幕太窄，面板會跟左右滑動的換欄手勢搶觸控。

     目前預設內容是「本資料夾的標籤」。區域關聯圖（graph.js）先收起來不顯示，
     程式碼保留 —— 開 state.enableGraph 就會改掛關聯圖。 */
  mountDock(split) {
    if (document.body.classList.contains('is-mobile')) return;

    if (this.plugin.state.enableGraph) {
      this._graph = this._graph || new LocalGraph(this.plugin);
      this._graph.mount(split);
      this._dockEl = this._graph.el;
      this._graph.setFile(this.app.workspace.getActiveFile());
    } else {
      this._dockEl = this.buildTagDock(split);
    }
    if (!this._dockEl) return;

    split.addClass('gn-has-dock');
    this.syncDockBounds();
    if (this._dockRO) { try { this._dockRO.disconnect(); } catch (e) {} }
    try {
      this._dockRO = new ResizeObserver(() => this.syncDockBounds());
      this._dockRO.observe(this._main);   // 涵蓋：拖曳分隔線、左欄收合、視窗縮放
    } catch (e) {}
  }

  /* 標籤面板：本資料夾出現過的 tag，點擊即篩選卡片牆。
     可收合成右下角的懸浮按鈕（狀態存在 state.tagDockOpen）。 */
  buildTagDock(split) {
    const tags = this.folderTags();
    if (!tags.length) return null;          // 沒有標籤就整個不出現，不佔空間

    const open = this.plugin.state.tagDockOpen !== false;
    const dock = split.createDiv('gn-dock gn-dock-tags');
    dock.toggleClass('gn-dock-mini', !open);
    split.toggleClass('gn-dock-collapsed', !open);

    const setOpen = (v) => {
      this.plugin.state.tagDockOpen = v;
      this.plugin.saveState();
      dock.toggleClass('gn-dock-mini', !v);
      split.toggleClass('gn-dock-collapsed', !v);   // 卡片牆的底部留白（取代 :has()）
      this.syncDockBounds();
    };

    /* 收合態＝一顆懸浮按鈕。整顆可點，展開後才顯示內容。
       標籤數當作角標，收起來也知道這個資料夾有多少種標籤。 */
    const fab = dock.createDiv('gn-dock-fab');
    setIcon(fab.createDiv('gn-dock-fab-ic'), 'tags');
    // 標籤種類數移到 tooltip，收合態就是一顆乾淨的圓鈕
    fab.setAttr('aria-label', t('Tags in this folder') + ' · ' + tags.length);
    fab.onclick = () => setOpen(true);

    const head = dock.createDiv('gn-dock-head');
    head.createDiv('gn-dock-title').setText(t('Tags in this folder'));
    const active = this._tagFilter && this._tagFilter.size;
    if (active) {
      const clear = head.createDiv('gn-dock-clear');
      clear.setText(t('Clear'));
      clear.onclick = (e) => { e.stopPropagation(); this._tagFilter = new Set(); this.render(); };
    }
    const collapse = head.createDiv('gn-dock-toggle');
    setIcon(collapse, 'chevron-down');
    collapse.setAttr('aria-label', t('Collapse'));
    collapse.onclick = () => setOpen(false);

    const body = dock.createDiv('gn-dock-body');
    for (const it of tags) {
      const chip = body.createDiv('gn-more-chip');   // 沿用「⋯ 更多」面板的晶片樣式
      chip.toggleClass('gn-more-chip-on', !!(this._tagFilter && this._tagFilter.has(it.tag)));
      // 只顯示標籤名，數量移到 tooltip —— 晶片並排時數字會讓每個寬度不一、視覺很碎
      chip.setText('#' + it.tag);
      chip.setAttr('aria-label', '#' + it.tag + ' · ' + it.n);
      chip.onclick = () => {
        if (!this._tagFilter) this._tagFilter = new Set();
        if (this._tagFilter.has(it.tag)) this._tagFilter.delete(it.tag);
        else this._tagFilter.add(it.tag);
        chip.toggleClass('gn-more-chip-on', this._tagFilter.has(it.tag));
        this.rerenderMain();   // 只重畫卡片牆，面板留著繼續點
      };

      /* 右鍵（手機長按）→ 改名 / 刪除。
         沿用標籤樹那一套 renameTag / deleteTag —— 它們會同時處理
         frontmatter 的 tags 與子標籤（#a/b 會跟著 #a 一起改）。 */
      this.wireContextMenu(chip, () => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle(t('Rename tag')).setIcon('pencil').onClick(() => {
          new InputModal(this.app, t('Rename tag'), it.tag, async (name) => {
            const target = String(name || '').trim().replace(/^#/, '');
            if (!target || target === it.tag) return;
            await this.renameTag(it.tag, target);
            // 篩選中的舊名要跟著換，否則改完卡片牆會突然變空
            if (this._tagFilter && this._tagFilter.has(it.tag)) {
              this._tagFilter.delete(it.tag);
              this._tagFilter.add(target);
            }
            this.render();
          }, t('Rename')).open();
        }));
        menu.addItem((i) => i.setTitle(t('Copy path')).setIcon('link')
          .onClick(() => copyToClipboard('#' + it.tag)));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle(t('Delete tag')).setIcon('trash').setWarning(true).onClick(() => {
          new ConfirmModal(this.app,
            t('Remove #{{tag}} (and its sub-tags) from all notes?', { tag: it.tag }),
            async () => {
              await this.deleteTag(it.tag);
              if (this._tagFilter) this._tagFilter.delete(it.tag);
              this.render();
            }).open();
        }));
        return menu;
      });
    }
    return dock;
  }

  /** 把面板的左右邊界對齊 .gn-main 的內容框（padding 以內）。
      收合成懸浮按鈕時不撐寬，只靠右下角定位。 */
  syncDockBounds() {
    const el = this._dockEl, main = this._main, split = this._split;
    if (!el || !el.isConnected || !main || !split) return;
    /* ⚠️ 先把要用的幾何量一次讀完再寫。
       原本是「讀 offsetLeft → 寫 style.right → 再讀 offsetLeft」，
       中間那次寫會讓版面失效，第二次讀就強制重算一次。
       這支掛在 _dockRO 上，拖分隔桿時每個 mousemove 都會觸發 → 每幀多付一次。 */
    const cs = getComputedStyle(main);
    const padR = parseFloat(cs.paddingRight) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const mainLeft = main.offsetLeft;
    const mainW = main.offsetWidth;
    const splitW = split.clientWidth;

    el.style.right = Math.max(0, splitW - (mainLeft + mainW) + padR) + 'px';
    // 懸浮按鈕不撐寬
    el.style.left = el.hasClass('gn-dock-mini') ? 'auto' : (mainLeft + padL) + 'px';
  }

  // 只重畫左樹（展開/收合/最愛/資料夾配色用）；沒左樹快取就退回整頁
  refreshTree() {
    if (this._treeScroll && this._treeScroll.isConnected && this._buildTree) {
      this.treeScrollStore()[this.treeScrollKey()] = this._treeScroll.scrollTop;   // 清空前先記住
      this._treeScrollLock = true;
      const before = this.treeSnapshot();   // 動畫：重建前先記位置
      this._treeScroll.empty();
      this._buildTree();   // 內部結尾會 restoreTreeScroll() 並解鎖
      this.treePlay(before);               // 動畫：把新舊位置差補成滑動
    } else { this.render(); }
  }

  /* ── 資料夾樹的動態（FLIP）──
     樹是「整棵重建」的（扁平的 .gn-tnode 清單、靠 --gn-depth 縮排），
     所以無法用 CSS transition —— 新元素沒有起始值可以過渡。
     改用 FLIP：重建前記位置，重建後從舊位置動畫到新位置。
       • 原本就在的列 → 滑動（收合時下方的列自然往上遞補）
       • 新出現的列   → 淡入 + 微幅下滑（展開時子資料夾滑出來）
       • 箭頭         → 從舊角度轉到新角度
     只動 transform / opacity，不觸發版面重算。
     這一套同時涵蓋展開、收合、拖曳排序、最愛開合——因為全都走 refreshTree()。 */

  motionOk() {
    if (this.plugin.state.reduceMotion) return false;
    try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return true; }
  }

  treeSnapshot() {
    if (!this.motionOk() || !this._treeScroll) return null;
    const rows = this._treeScroll.querySelectorAll('.gn-tnode[data-path]');
    // 樹太大就跳過：offsetTop 會強制版面計算，幾百列以上不划算
    if (!rows.length || rows.length > 400) return null;
    const map = new Map();
    rows.forEach((el) => map.set(el.dataset.path, {
      top: el.offsetTop,
      open: el.classList.contains('gn-topen'),
    }));
    return map;
  }

  /* ⚠️ 這裡刻意分成「先全部讀、再全部寫」兩輪，不要合併回一個迴圈。
     el.animate() 會在該元素掛上新的動畫效果 → 使樣式失效；
     下一圈再讀 el.offsetTop 就必須強制重算樣式與版面。
     一個迴圈裡 read→write→read 交錯的話，400 列就是 400 次強制版面計算，
     展開資料夾會明顯頓一下（掉 3–7 幀）。 */
  treePlay(before) {
    if (!before || !this._treeScroll) return;
    const DUR = 170, EASE = 'cubic-bezier(.2,.7,.2,1)';
    const rows = [...this._treeScroll.querySelectorAll('.gn-tnode[data-path]')];

    // ── 第一輪：只讀，不碰任何會讓樣式失效的東西 ──
    const plan = rows.map((el) => {
      const prev = before.get(el.dataset.path);
      return {
        el,
        prev,
        top: prev ? el.offsetTop : 0,                     // 只有需要算位移的才讀
        nowOpen: el.classList.contains('gn-topen'),
        caret: prev ? el.querySelector('.gn-tcaret') : null,
      };
    });

    // ── 第二輪：只寫 ──
    for (const p of plan) {
      if (!p.prev) {   // 新出現：淡入
        p.el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
          { duration: DUR, easing: EASE });
        continue;
      }
      const dy = p.prev.top - p.top;   // 位置有變 → 從舊位置滑過來
      if (dy) p.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: DUR, easing: EASE });

      // 箭頭：展開狀態改變時轉 90°（靜態角度由 CSS 的 .gn-topen 決定）
      if (p.caret && p.prev.open !== p.nowOpen) {
        p.caret.animate(
          [{ transform: `rotate(${p.prev.open ? 90 : 0}deg)` }, { transform: `rotate(${p.nowOpen ? 90 : 0}deg)` }],
          { duration: DUR, easing: EASE });
      }
    }
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
          const f = asFile(this.app, p);
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
    // folderOrder 只被 buildLevel 讀到 → 重畫左樹就好（順帶保有 FLIP 滑動動畫）
    this.refreshTree();
  }

  // render 的保護殼：內部拋例外時（手機沒 console、以前是無聲失敗），
  // ① 彈 Notice 讓人看得到錯誤 ② 不往上丟 → 呼叫端接下來的 gotoCardsMobile() 照常執行。
  render() {
    try {
      this.renderInner();
    } catch (e) {
      console.error('[Gallery Navigator] render error', e);
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
    /* 以下兩個狀態 class 取代原本的 :has()（2026-07-31）。
       :has() 的失效範圍很廣，瀏覽器要在整棵子樹變動時重算祖先是否仍匹配；
       這兩件事 JS 本來就知道，直接掛 class 更省也更明確。
         • gn-leaf     ← 原 .workspace-leaf-content:has(> .gn-root)
         • gn-search-on ← 原 .gn-root:has(> .gn-search-row) */
    if (root.parentElement) root.parentElement.addClass('gn-leaf');
    root.toggleClass('gn-search-on', !!this._searchOn);
    // （2026-07-20 移除）待辦卡對比色計算：底色已取消，不再需要 --gn-todo-bg

    // 手機單欄時掛狀態 class：豁免「卡片最小 1:1」限制（單欄全寬卡不需要，2026-07-19）
    // ⚠️ 編輯風索引卡固定 2 欄（makeGrid 寫死）→ 即使 mobileCols 存的是 1 也不能掛這個 class，
    //    否則會套到用不到的單欄豁免規則（2026-07-20）。
    root.toggleClass('gn-mobile-1col',
      document.body.classList.contains('is-mobile')
      && this.plugin.state.imageCardLayout !== 'editorial'
      && (this.plugin.state.mobileCols || 2) === 1);

    // 圖片卡版面（2026-07-20，設定 → 卡片牆 可選）：預設「白字疊圖」（圖滿版）；
    // 'stacked' ＝ 舊版「圖上文下」，CSS 用 .gn-imgcard-stacked 切回底層規則（見 gallery.css）。
    root.toggleClass('gn-imgcard-stacked', this.plugin.state.imageCardLayout === 'stacked');
    root.toggleClass('gn-imgcard-editorial', this.plugin.state.imageCardLayout === 'editorial');

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
    // 精簡（2026-07-20）：桌機「左欄展開時」不顯示——分隔線 hover 已有同功能的收合鈕。
    // ⚠️ 但收合後分隔線本身也 display:none（見下方 treeHidden 分支）→ 那時**必須**留展開鈕，
    //    否則左欄再也叫不回來。手機沒有分隔線 hover，一律保留。
    if (isMobileUI || treeHidden) {
      const collapseBtn = barL.createDiv('gn-btn gn-collapse-btn');
      setIcon(collapseBtn, treeHidden ? 'panel-left-open' : 'panel-left-close');
      collapseBtn.setAttr('title', treeHidden ? t('Expand folder pane') : t('Collapse folder pane'));
      collapseBtn.onclick = () => {
        if (this._searchOn) { this._searchTreeOpen = !this._searchTreeOpen; this.render(); return; }   // 搜尋中：只切這次
        state.treeCollapsed = !state.treeCollapsed;
        this.plugin.saveState();
        this.render();
      };
    }

    // 左：待辦按鈕（點了彈出面板；徽章顯示未完成數）
    // ⏸️ 暫時停用（2026-07-20 使用者要求）：整顆待辦鈕連同「更多」面板的「選擇待辦筆記」一起註解。
    //    恢復＝取消本區與 openMorePopover() 內同標記區塊的註解（openTodoPopover/renderTodoInto/pickTodoNote 都留著）。
    // 精簡（2026-07-20）：**沒指定待辦筆記就不顯示**——那時這顆鈕只是個空殼。
    // 設定入口改放「⋯ 更多」面板的「選擇待辦筆記」，指定後這顆鈕就會回到工具列。
    /*
    const tf = state.todoNote ? this.app.vault.getAbstractFileByPath(state.todoNote) : null;
    if (tf instanceof TFile) {
      const todoBtn = barL.createDiv('gn-btn gn-todo-btn');
      setIcon(todoBtn, 'list-checks');
      todoBtn.setAttr('title', t('To-dos'));
      const todoBadge = todoBtn.createSpan('gn-todo-badge');
      todoBadge.style.display = 'none';
      this.app.vault.cachedRead(tf).then((raw) => {
        const undone = parseTasks(raw).filter((x) => !x.done).length;   // ⚠️ 勿叫 t（遮蔽 i18n）
        if (undone > 0) { todoBadge.style.display = ''; todoBadge.setText(String(undone)); }
      }).catch(() => {});
      todoBtn.onclick = (e) => { e.stopPropagation(); this.openTodoPopover(todoBtn); };
    }
    */

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

    // 同步定位鈕已移入「⋯ 更多」面板（2026-07-19）

    // 左：顯示 / 隱藏資料夾
    if ((state.hiddenFolders || []).length) {
      const eye = barL.createDiv('gn-btn');
      eye.toggleClass('gn-eye-on', !!this.showHidden);
      setIcon(eye, this.showHidden ? 'eye' : 'eye-off');
      eye.setAttr('title', this.showHidden ? t('Hide hidden folders') : t('Show hidden folders'));
      eye.onclick = () => { this.showHidden = !this.showHidden; this.render(); };
    }

    // 右：新建（筆記 / Canvas / Base / 資料夾）
    // 精簡（2026-07-20）：**只在資料夾情境顯示**。搜尋牆沒有「這個資料夾」的概念，
    // 「在此新建」在那裡沒有語意（會建到上次的 this.path，是個陷阱）。
    const inFolderView = !this._searchOn;
    if (inFolderView) {
      const newBtn = barR.createDiv('gn-btn');
      setIcon(newBtn, 'file-plus');
      newBtn.setAttr('title', t('Create here (folder / note / canvas / base)'));
      newBtn.onclick = (e) => this.newFileMenu(this.folderAt(this.path), e);
    }

    // 右：⋯ 更多（排序 / 卡片大小滑桿 / 攤平 / 重新整理 → 單層浮動面板）
    const moreBtn = barR.createDiv('gn-btn');
    setIcon(moreBtn, 'more-horizontal');
    moreBtn.setAttr('title', t('More (sort / card size / flatten)'));
    moreBtn.onclick = (e) => { e.stopPropagation(); this.openMorePopover(moreBtn); };

    // 鍵盤可及性：.gn-btn 是 div，預設不可 focus → 補上 button 語意與 Enter/Space 觸發。
    // （工具列「懸浮膠囊」版已還原成左右兩段，此段與版面無關、保留。）
    if (!isMobileUI) {
      for (const btn of Array.from(barR.children)) {
        if (!btn.hasClass || !btn.hasClass('gn-btn')) continue;
        btn.setAttr('tabindex', '0');
        btn.setAttr('role', 'button');
        const label = btn.getAttr('title');
        if (label && !btn.getAttr('aria-label')) btn.setAttr('aria-label', label);
        btn.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          btn.click();
        });
      }
    }

    const zoom = null;   // 滑桿已移進「更多」面板（makeGrid 對 null 有防呆）

    /* --- 兩欄：左巢狀資料夾樹 + 右筆記牆 --- */
    const split = root.createDiv('gn-split');
    const tree = split.createDiv('gn-tree');            // 左欄容器（flex 直向）
    tree.style.flex = '0 0 ' + (state.treeWidth || 232) + 'px';
    const treeScroll = tree.createDiv('gn-tree-scroll'); // 上方：可捲動的資料夾/標籤區
    const splitter = split.createDiv('gn-split-handle');
    const main = split.createDiv('gn-main');
    this._split = split; this._main = main;   // 供手機「點資料夾 → 跳右欄」使用
    this.mountDock(split);                    // 右欄底部的浮動面板（桌機）
    this.wireOverlayScrollbar(treeScroll);    // overlay 捲軸：捲動才浮現
    this.wireOverlayScrollbar(main);
    this.wireMainCreateMenu(main);            // 卡片區空白處右鍵 →「在此新建」
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

    /* 拖曳分隔桿調整左樹寬度（拖完存進 data.json）。
       ⚠️ 讀寫要分離：以前每個 mousemove 都 getBoundingClientRect()（讀）再寫 flex／CSS 變數，
          讀-寫-讀-寫交錯 → 每次移動都強制同步版面重算。
          改成 rect 在 mousedown 讀一次快取，mousemove 只記座標、rAF 內才寫。 */
    let pendingW = null, dragRect = null, dragX = 0, moveRaf = 0;
    const applyW = () => {
      moveRaf = 0;
      if (!dragRect) return;
      let w = dragX - dragRect.left;
      w = Math.max(150, Math.min(dragRect.width - 200, w));
      tree.style.flex = '0 0 ' + w + 'px';
      syncBarL(w);   // 工具列左段跟著左欄寬度
      pendingW = w;
    };
    const onMove = (e) => {
      dragX = e.clientX;
      if (!moveRaf) moveRaf = requestAnimationFrame(applyW);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; applyW(); }   // 補上最後一次位置
      dragRect = null;
      if (pendingW != null) { state.treeWidth = Math.round(pendingW); this.plugin.saveState(); }
    };
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragRect = split.getBoundingClientRect();   // 拖曳期間容器不會變 → 讀一次就夠
      dragX = e.clientX;
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
    // 根目錄不能展開 → 只用圖示欄的圖示，箭頭留空
    const rootSlot = makeIconSlot(rootRow);
    rootSlot.thumb.addClass('gn-tthumb-home');
    setIcon(rootSlot.thumb, 'home');   // 根目錄＝家（2026-07-18）
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

        // 圖示欄：平常是資料夾圖示，hover 時換成箭頭（可展開的話）
        const { thumb, caret } = makeIconSlot(row);
        thumb.addClass('gn-tthumb-folder');   // folder class 保留：日後要再藏資料夾圖示用
        setFolderIcon(thumb, hasKids && isOpen);
        // 資料夾配色套在圖示上（2026-07-25 還原；07-20 曾因藏圖示改套在名稱文字）
        if (folderColors[it.folder.path]) thumb.style.color = paletteFor(it, folderColors).bg;

        if (hasKids) {
          row.addClass('gn-thaskids');   // CSS 靠它決定 hover 要不要換成箭頭
          // 固定用 chevron-right，展開狀態靠 CSS 轉 90°（換圖示無法做旋轉動畫）
          setIconCached(caret, 'chevron-right');
          // 綁在箭頭上：桌機的 caret 是 inset:0 撐滿整格 → 點整格都能展開；
          // 手機的 caret 只佔箭頭那一格 → 點資料夾圖示是「選取」，點箭頭才展開。
          caret.onclick = (e) => { e.stopPropagation(); this.toggleExpand(it.folder.path); };
        }

        const nameEl = row.createSpan('gn-tname');
        nameEl.setText(it.name);
        row.createSpan('gn-tcount').setText(String(it.count));

        // 選取此資料夾後按 Enter → 原地變輸入框改名（macOS Finder 風格）
        row.onkeydown = (e) => {
          if (e.key === 'Enter' && !nameEl._editing) { e.preventDefault(); this.inlineRenameFolder(it.folder, nameEl); }
        };

        // 點整列 = 只選取（右欄載入）；展開/收合交給箭頭
        row.onclick = (e) => {
          /* 已選取的資料夾，再點一次「名稱」→ 原地改名（2026-08-01）。
             照 Finder 的慢速雙擊邏輯：第一下先選取，第二下才進編輯，
             所以不會犧牲「點名稱＝選取」這個最常用的動作。
             ⚠️ 手機不啟用：觸控要連續點同一個資料夾導覽很常見，
                容易誤觸；手機改名走長按選單的「重新命名」。 */
          if (!document.body.classList.contains('is-mobile')
              && this.path === it.folder.path
              && e.target === nameEl && !nameEl._editing) {
            e.preventDefault();
            this.inlineRenameFolder(it.folder, nameEl);
            return;
          }
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
    if (this.plugin.state.leftMode === 'tag') return 'tag:' + (this.plugin.state.activeTag || '');
    return 'folder:' + (this.path || '');
  }

  /* 「內容穩定後才定位」的共用機制（2026-08-05）。
     背景：分批渲染 + 圖片/內文延遲載入 → 內容高度是慢慢長出來的，
     一次設 scrollTop 到不了深處，卡片也可能還沒建出來。
     以前用兩套猜時間的做法：每 50ms 輪詢最多 2 秒（每次都寫 scrollTop 再讀 scrollHeight，
     一次強制版面重算）＋固定 400ms 再定位一次。

     改成事件驅動：在卡片牆上掛 ResizeObserver，只有「內容真的長高」時才再試一次。
     apply() 回傳 true = 已到位（解除監聽）。使用者自己動手捲、或逾時，也一律解除。 */
  settleScroll(apply, opts) {
    opts = opts || {};
    const main = this._main;
    if (!main || !main.isConnected) return;
    const target = main.querySelector('.gn-grid') || main;
    let done = false, ro = null, timer = 0;
    const stop = () => {
      if (done) return;
      done = true;
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      if (timer) { clearTimeout(timer); timer = 0; }
      main.removeEventListener('wheel', stop);
      main.removeEventListener('touchstart', stop);
    };
    const tick = () => {
      if (done) return;
      if (this._main !== main || !main.isConnected) { stop(); return; }
      let ok = false;
      try { ok = !!apply(); } catch (e) { ok = true; }
      if (ok) stop();
    };
    main.addEventListener('wheel', stop, { once: true, passive: true });
    main.addEventListener('touchstart', stop, { once: true, passive: true });
    try {
      ro = new ResizeObserver(tick);   // observe 當下會先觸發一次，等於第一次嘗試
      ro.observe(target);
    } catch (e) {}
    timer = window.setTimeout(stop, opts.timeout || 3000);
    requestAnimationFrame(tick);
  }

  // 還原右欄卡片牆的捲動位置（同一面牆重畫時；換牆就不還原，自然從頂部開始）
  restoreMainScroll() {
    const saved = this._mainScrollSaved;
    const main = this._main;
    if (!saved || !main || !saved.top || saved.key !== this.mainScrollKey()) return;
    this.settleScroll(() => {
      main.scrollTop = saved.top;                       // 會被當下 scrollHeight 夾住，
      return Math.abs(main.scrollTop - saved.top) <= 4; // 順勢讓哨兵進視野、觸發補下一批
    });
  }

  // 右欄內容的分派。抽出來是為了讓搜尋打字時能「只重繪右欄」——
  // 若每次打字都跑整個 render()，輸入框會被重建 → 立刻失焦，根本沒法打字。
  renderMainContent(main, zoom) {
    if (this._barTitle) this._barTitle.empty();   // 各檢視自己填
    const state = this.plugin.state;
    if (this._searchQ) { this.renderSearchWall(main, zoom); return; }
    if (state.leftMode === 'tag') this.renderTagNotes(main, zoom);
    else this.renderNoteWall(main, this.folderAt(this.path), zoom);
  }

  // 只重繪右欄（打字時用；搜尋列在 gn-root 底下，不會被清掉 → 保持焦點）
  rerenderMain() {
    if (!this._main) return;
    this._main.empty();
    this.renderMainContent(this._main, this._zoom);
  }

  /* 只重繪右欄並保住捲動位置（釘選、排序、切換內文預覽等「只影響卡片牆」的小操作）。
     ⚠️ 這些操作以前一律走 render()：工具列＋左樹（每列 10+ 監聽器、DOMParser 解 SVG）
     ＋dock 全部重建，4000 檔下每次數百 ms，而且左樹捲動位置會跳。
     判準：改動的 state 只被 renderNoteWall / makeCard 讀到 → 用這支；
           會影響工具列或左樹 → 才需要 render() 或另外補 refreshTree()。 */
  rerenderMainKeepScroll() {
    if (!this._main) { this.render(); return; }
    this._mainScrollSaved = { key: this.mainScrollKey(), top: this._main.scrollTop };
    this.rerenderMain();
    this.restoreMainScroll();
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
  // 批次指定卡片樣式（右鍵單張 / 多選動作列共用）；null = 還原預設
  setCardStyle(paths, style) {
    const map = Object.assign({}, this.plugin.state.cardStyles);
    for (const p of paths) { if (style) map[p] = style; else delete map[p]; }
    this.plugin.state.cardStyles = map;
    this.plugin.saveState();
    this.rerenderMain();   // 樣式會改卡片結構 → 重建右欄（捲動位置有記憶）
  }

  // 多選動作列的樣式選單
  styleSelectedMenu(e) {
    if (!this.selected.size) return;
    const menu = new Menu();
    for (const [key, label, icon] of CARD_STYLES) {
      menu.addItem((i) => i.setTitle(t(label)).setIcon(icon)
        .onClick(() => this.setCardStyle([...this.selected], key)));
    }
    menu.showAtMouseEvent(e);
  }

  // （2026-07-20 移除）detectVideoCard()：自動影片卡整套下架

  // （2026-07-20 移除）loadCardTodos()：卡片上的待辦清單已下架，待辦只留浮動面板。


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
  /* ⚠️ 關閉一律走這裡。
     舊寫法是「再點一次按鈕」時直接 remove 面板，但**沒有**解除掛在 document 上的
     mousedown 監聽 —— 只有「點面板外面」那條路會解除。於是每開關一次就永久多留
     一個 document 級監聽器，而且那個閉包還抓著整個 view，view 也回收不掉。
     同檔的 closeMorePopover() 本來就寫對了，這裡是漏掉。 */
  closeTodoPopover() {
    if (this._todoCloser) {
      document.removeEventListener('mousedown', this._todoCloser);
      this._todoCloser = null;
    }
    if (this._todoPop) { this._todoPop.remove(); this._todoPop = null; }
  }

  openTodoPopover(anchor) {
    if (this._todoPop) { this.closeTodoPopover(); return; }
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
      this.closeTodoPopover();
    };
    this._todoCloser = closer;
    setTimeout(() => document.addEventListener('mousedown', closer), 0);
  }

  // 把待辦清單渲染進指定容器（面板用）
  renderTodoInto(box) {
    box.empty();
    const state = this.plugin.state;
    const head = box.createDiv('gn-todo-head');
    head.style.cursor = 'default';
    head.createSpan('gn-todo-title').setText(t('To-dos'));
    const acts = head.createDiv('gn-todo-acts');

    const file = state.todoNote ? this.app.vault.getAbstractFileByPath(state.todoNote) : null;

    // 開啟待辦來源筆記（錨定的那則）
    if (file instanceof TFile) {
      const openBtn = acts.createSpan('gn-todo-act');
      setIcon(openBtn, 'file-text');
      openBtn.setAttr('title', t('Open the to-do note'));
      openBtn.onclick = (e) => {
        e.stopPropagation();
        this.openNote(file, false);
        if (this._todoPop) { this._todoPop.remove(); this._todoPop = null; }
      };
    }

    // 顯示 / 隱藏已完成（預設只顯示未完成）
    const hideDone = state.todoHideDone !== false;
    const eye = acts.createSpan('gn-todo-act');
    setIcon(eye, hideDone ? 'eye-off' : 'eye');
    eye.setAttr('title', hideDone ? t('Show completed') : t('Hide completed'));
    eye.onclick = (e) => {
      e.stopPropagation();
      state.todoHideDone = !hideDone;
      this.plugin.saveState();
      this.renderTodoInto(box);
    };

    const gear = acts.createSpan('gn-todo-act');
    setIcon(gear, 'settings');
    gear.setAttr('title', t('Pick a to-do note'));
    gear.onclick = (e) => { e.stopPropagation(); this.pickTodoNote(); };

    if (!(file instanceof TFile)) {
      const empty = box.createDiv('gn-todo-empty');
      setIcon(empty.createSpan('gn-todo-empty-ic'), 'plus');
      empty.createSpan().setText(t('Pick a to-do note'));
      empty.onclick = (e) => { e.stopPropagation(); this.pickTodoNote(); };
      return;
    }

    const list = box.createDiv('gn-todo-list');
    list.createDiv('gn-ctodo-none').setText(t('Loading…'));
    this.app.vault.cachedRead(file).then((raw) => {
      list.empty();
      const all = parseTasks(raw);
      if (!all.length) { list.createDiv('gn-ctodo-none').setText(t('No to-dos')); return; }
      const doneCount = all.filter((x) => x.done).length;
      const tasks = hideDone ? all.filter((x) => !x.done) : all;
      if (!tasks.length) { list.createDiv('gn-ctodo-none').setText(t('All done 🎉')); return; }
      // gn-ctodo：原生核取方塊 + 單行省略（卡片版下架後，這是唯一使用者）
      for (const task of tasks) {   // ⚠️ 迴圈變數勿叫 t，會遮蔽 i18n 的 t()
        const item = list.createDiv('gn-todo-item gn-ctodo');
        item.style.setProperty('--td-depth', String(task.depth));
        const chk = item.createEl('input', { type: 'checkbox' });
        chk.checked = task.done;
        chk.setAttr('title', task.done ? t('Mark as not done') : t('Mark as done'));
        chk.onclick = (e) => { e.stopPropagation(); this.toggleTask(file, task.line); };
        item.createSpan({ cls: 'gn-ctodo-text' + (task.done ? ' gn-ctodo-done' : ''), text: task.text });
        item.onclick = () => this.openNote(file, false);
      }
      if (hideDone && doneCount) list.createDiv('gn-ctodo-more').setText('✓ ' + doneCount);
    }).catch(() => {
      list.empty();
      list.createDiv('gn-ctodo-none').setText(t('Cannot read the to-do note'));
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

  // 拖卡片到標籤列：把標籤寫進筆記 frontmatter（2026-07-19）。
  // processFrontMatter 是官方 API——沒有 frontmatter 會自動建立、tags 字串/陣列格式都處理。
  async addTagToNote(file, tag) {
    try {
      let added = false;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        let tags = fm.tags;
        if (!tags) tags = [];
        else if (typeof tags === 'string') tags = tags.split(/[,\s]+/).filter(Boolean);
        else tags = [...tags];
        const clean = tags.map((x) => String(x).replace(/^#/, ''));
        if (!clean.includes(tag)) { clean.push(tag); added = true; }
        fm.tags = clean;
      });
      new Notice(added
        ? t('Added #{{tag}} to "{{name}}"', { tag, name: file.basename })
        : t('"{{name}}" already has #{{tag}}', { tag, name: file.basename }));
      // metadata 變動會自動觸發 tag 索引失效與重畫（markTagDirty + refreshViews）
    } catch (e) {
      new Notice(t('Failed to add tag: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  // 標籤改名/合併核心（2026-07-19）：把 oldPath（含子孫如 old/xxx）改成 newPath。
  // 逐筆走 processFrontMatter（內文行內標籤不動）；回傳更新筆數。
  async renameTag(oldPath, newPath, silent) {
    const idx = this.buildTagIndex();
    const files = [...(idx.map.get(oldPath) || [])];
    let changed = 0;
    for (const p of files) {
      const f = asFile(this.app, p);
      if (!(f instanceof TFile)) continue;
      try {
        let touched = false;
        await this.app.fileManager.processFrontMatter(f, (fm) => {
          let tags = fm.tags;
          if (!tags) return;
          if (typeof tags === 'string') tags = tags.split(/[,\s]+/).filter(Boolean);
          else tags = [...tags];
          const next = tags.map((x) => {
            const c = String(x).replace(/^#/, '');
            if (c === oldPath) { touched = true; return newPath; }
            if (c.startsWith(oldPath + '/')) { touched = true; return newPath + c.slice(oldPath.length); }
            return c;
          });
          if (touched) fm.tags = [...new Set(next)];   // 合併撞名時去重
        });
        if (touched) changed++;
      } catch (e) {}
    }
    // 內文的 #標籤（frontmatter 以外）
    const body = await this.renameTagInBody(oldPath, newPath, files);
    changed += body.changed;

    if (!silent) {
      new Notice(t('Renamed #{{old}} → #{{new}} in {{n}} note(s)', { old: oldPath, new: newPath, n: changed }));
      // 快取過期而跳過的檔案要講出來，不然使用者會以為全部改完了
      if (body.skipped) new Notice(t('Skipped {{n}} note(s) — reopen them and try again', { n: body.skipped }), 6000);
    }
    return changed;
  }

  /* 改寫內文裡的 #標籤（2026-08-01）
     ⚠️ 刻意**不用正則**掃文字。內文的 # 有太多陷阱：程式碼區塊裡的註解、
        網址的 #fragment、Markdown 標題、以及 #life 會誤中 #lifestyle 的前綴問題。
        改用 metadataCache 的 cache.tags —— 它已經是 Obsidian 解析器的結果，
        帶精確的字元偏移量，上面那些情況全都不在裡面。

     ⚠️ 偏移量來自「上次解析時」的內容。若檔案在那之後被改過，位置就不準了 →
        替換前先比對該位置的字串是否真的等於預期的標籤，不符就**整個檔案跳過**
        並回報，寧可少改也不要改壞內容。 */
  async renameTagInBody(oldPath, newPath, files) {
    let changed = 0, skipped = 0;
    for (const p of files) {
      const f = asFile(this.app, p);
      if (!(f instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(f) || {};
      const hits = (cache.tags || []).filter((x) => {
        const c = String(x.tag || '').replace(/^#/, '');
        return c === oldPath || c.startsWith(oldPath + '/');
      });
      if (!hits.length) continue;

      // 由後往前替換，前面的偏移量才不會被位移影響
      const ordered = [...hits].sort((a, b) => b.position.start.offset - a.position.start.offset);
      const rewrite = (data) => {
        let out = data;
        for (const h of ordered) {
          const st = h.position.start.offset, en = h.position.end.offset;
          if (out.slice(st, en) !== h.tag) return null;   // 快取過期
          const c = h.tag.replace(/^#/, '');
          const next = '#' + (c === oldPath ? newPath : newPath + c.slice(oldPath.length));
          out = out.slice(0, st) + next + out.slice(en);
        }
        return out;
      };

      try {
        let ok = true;
        if (this.app.vault.process) {
          await this.app.vault.process(f, (data) => { const r = rewrite(data); if (r === null) { ok = false; return data; } return r; });
        } else {
          const data = await this.app.vault.read(f);
          const r = rewrite(data);
          if (r === null) ok = false; else await this.app.vault.modify(f, r);
        }
        if (ok) changed++; else skipped++;
      } catch (e) { skipped++; }
    }
    return { changed, skipped };
  }

  // 標籤刪除（2026-07-19）：從所有筆記的 frontmatter 移除該標籤（含子孫）。內文行內標籤不動。
  async deleteTag(tagPath) {
    const idx = this.buildTagIndex();
    const files = [...(idx.map.get(tagPath) || [])];
    let changed = 0;
    for (const p of files) {
      const f = asFile(this.app, p);
      if (!(f instanceof TFile)) continue;
      try {
        let touched = false;
        await this.app.fileManager.processFrontMatter(f, (fm) => {
          let tags = fm.tags;
          if (!tags) return;
          if (typeof tags === 'string') tags = tags.split(/[,\s]+/).filter(Boolean);
          else tags = [...tags];
          const clean = tags.map((x) => String(x).replace(/^#/, ''));
          const next = clean.filter((c) => c !== tagPath && !c.startsWith(tagPath + '/'));
          if (next.length !== clean.length) { touched = true; fm.tags = next; }
        });
        if (touched) changed++;
      } catch (e) {}
    }
    new Notice(t('Deleted #{{tag}} from {{n}} note(s)', { tag: tagPath, n: changed }));
    if (this.plugin.state.activeTag === tagPath) { this.plugin.state.activeTag = ''; this.plugin.saveState(); }
    this.render();
  }

  // 卡片右鍵「移除 #tag」：從 frontmatter tags 拿掉（2026-07-19）。
  // 限制：標籤若寫在內文（#inline）不動筆記內文，改用 Notice 明講，不做危險的內文改寫。
  async removeTagFromNote(file, tag) {
    try {
      let removed = false;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        let tags = fm.tags;
        if (!tags) return;
        if (typeof tags === 'string') tags = tags.split(/[,\s]+/).filter(Boolean);
        else tags = [...tags];
        const clean = tags.map((x) => String(x).replace(/^#/, ''));
        const next = clean.filter((x) => x !== tag);
        if (next.length !== clean.length) { removed = true; fm.tags = next; }
      });
      new Notice(removed
        ? t('Removed #{{tag}} from "{{name}}"', { tag, name: file.basename })
        : t('#{{tag}} is not in frontmatter (it may be an inline tag in the note body)', { tag }));
    } catch (e) {
      new Notice(t('Failed to remove tag: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
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
      // data-path + gn-topen：讓標籤樹也吃到 treePlay() 的展開/收合與箭頭旋轉動畫
      // （兩棵樹不會同時顯示，所以 path 不會跟資料夾撞）
      row.dataset.path = 'tag:' + node.path;
      if (hasKids && isOpen) row.addClass('gn-topen');
      // 圖示欄：平常是 #，hover 時換成箭頭（與資料夾樹同一套行為）
      const { thumb, caret } = makeIconSlot(row);
      setIconCached(thumb, 'hash');
      if (hasKids) {
        row.addClass('gn-thaskids');
        setIconCached(caret, 'chevron-right');   // 展開狀態靠 CSS 轉 90°
        caret.onclick = (e) => { e.stopPropagation(); this.toggleTag(node.path); };
      }
      row.createSpan('gn-tname').setText(node.name);
      row.createSpan('gn-tcount').setText(String(node.count));
      if (this._tagSel && this._tagSel.has(node.path)) row.addClass('gn-tmsel');
      row.onclick = (e) => {
        // Cmd/Ctrl+點 → 複選標籤（合併用，記憶體狀態）
        if (e.metaKey || e.ctrlKey) {
          this._tagSel = this._tagSel || new Set();
          if (this._tagSel.has(node.path)) this._tagSel.delete(node.path);
          else this._tagSel.add(node.path);
          row.toggleClass('gn-tmsel', this._tagSel.has(node.path));
          return;
        }
        this._tagSel = new Set();   // 一般點擊清空複選
        this.plugin.state.activeTag = node.path;
        this.plugin.saveState();
        this.render();
        this.gotoCardsMobile();
      };
      // 右鍵：重新命名 / 合併（2026-07-19）
      this.wireContextMenu(row, () => {
        const menu = new Menu();
        const sel = [...(this._tagSel || new Set())];
        if (sel.includes(node.path) && sel.length > 1) {
          menu.addItem((i) => i.setTitle(t('Merge {{n}} tags into…', { n: sel.length })).setIcon('combine')
            .onClick(() => {
              new InputModal(this.app, t('Merge tags into'), node.path, async (name) => {
                const target = String(name || '').trim().replace(/^#/, '');
                if (!target) return;
                // 父子同選時只處理最上層（父改名已涵蓋子孫）
                const tops = sel.filter((p) => !sel.some((q) => q !== p && p.startsWith(q + '/')));
                let total = 0;
                for (const p of tops) { if (p !== target) total += await this.renameTag(p, target, true); }
                new Notice(t('Merged into #{{tag}} ({{n}} notes updated)', { tag: target, n: total }));
                this._tagSel = new Set();
                this.plugin.state.activeTag = target;
                this.plugin.saveState();
                this.render();
              }, t('Merge')).open();
            }));
        }
        menu.addItem((i) => i.setTitle(t('Delete tag')).setIcon('trash').setWarning(true).onClick(() => {
          new ConfirmModal(this.app,
            t('Remove #{{tag}} (and its sub-tags) from all notes?', { tag: node.path }),
            () => this.deleteTag(node.path)).open();
        }));
        menu.addItem((i) => i.setTitle(t('Rename tag')).setIcon('pencil').onClick(() => {
          new InputModal(this.app, t('Rename tag'), node.path, async (name) => {
            const target = String(name || '').trim().replace(/^#/, '');
            if (!target || target === node.path) return;
            await this.renameTag(node.path, target);
            if (this.plugin.state.activeTag === node.path) this.plugin.state.activeTag = target;
            this.plugin.saveState();
            this.render();
          }, t('Rename')).open();
        }));
        return menu;
      });
      // 拖卡片到標籤列 → 幫該筆記加上這個標籤（2026-07-19；待辦清單項目）
      row.addEventListener('dragover', (e) => {
        const d = this.drag;
        if (!d || d.kind !== 'note') return;
        e.preventDefault();
        row.addClass('gn-tmove');
      });
      row.addEventListener('dragleave', () => row.removeClass('gn-tmove'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.removeClass('gn-tmove');
        const d = this.drag;
        if (!d || d.kind !== 'note') return;
        const f = this.app.vault.getAbstractFileByPath(d.path);
        if (f instanceof TFile) this.addTagToNote(f, node.path);
      });
      if (hasKids && isOpen) node.children.slice().sort(byName).forEach((c) => renderNode(c, depth + 1));
    };
    roots.sort(byName).forEach((n) => renderNode(n, 1));

    // 未標籤
    const uRow = container.createDiv('gn-tnode');
    uRow.style.setProperty('--gn-depth', '1');
    if (activeTag === '__untagged__') uRow.addClass('gn-tsel');
    // 未標籤不能展開 → 只用圖示欄的圖示
    setIcon(makeIconSlot(uRow).thumb, 'file-question');
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
      b.onclick = (e) => { e.stopPropagation(); fn(e); };
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
      const f = asFile(this.app, p);
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
        const f = asFile(this.app, p);
        if (f) await this.moveItem(f, target);
      }
      this.selected.clear();
      this.render();
    }).open();
  }
  deleteSelected() {
    const paths = [...this.selected];
    // 連同孤兒附件（2026-07-20，比照單筆刪除）：確認視窗多一個勾選項（預設勾）
    const orphans = this.orphanAttachmentsOfMany(paths);
    const extra = orphans.length ? {
      label: t('Also delete {{n}} attachment(s) not referenced by any other note', { n: orphans.length }),
      items: orphans.map((f) => f.path),
      checked: true,
    } : null;
    new ConfirmModal(this.app, t('Delete the {{n}} selected items? (moves to trash)', { n: paths.length }), async (withExtra) => {
      for (const p of paths) {
        const f = asFile(this.app, p);
        if (f) { try { await this.app.fileManager.trashFile(f); } catch (e) {} }
      }
      let n = 0;
      if (withExtra) {
        for (const f of orphans) { try { await this.app.fileManager.trashFile(f); n++; } catch (e) {} }
      }
      this.selected.clear();
      this.render();
      new Notice(n
        ? t('Moved {{c}} items to trash (+{{n}} attachments)', { c: paths.length, n })
        : t('Moved {{c}} items to trash', { c: paths.length }));
    }, extra).open();
  }


  /* ===== 卡片牆基礎：資料夾牆 / 標籤牆 / 連結牆 共用 ===== */

  // 重置一面牆的共用狀態（瀑布流、多選、延遲載入觀察器、動作列）
  beginWall(container) {
    for (const m of (this._masonries || [])) { try { m.destroy(); } catch (e) {} }
    this._masonries = [];
    for (const v of (this._virtuals || [])) { try { v.destroyAll(); } catch (e) {} }
    this._virtuals = [];

    /* 換頁/重畫 → 丟掉還沒開工的縮圖任務。
       使用者已經捲走了，繼續做只會排擠新畫面該做的那幾張
       （正在解碼中的 1–2 張無法中斷，讓它做完，反正結果會進快取）。 */
    if (this.plugin.thumbs) this.plugin.thumbs.dropPending();

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
    // 換資料夾／換標籤時，整面牆淡入一次（同一個位置重畫則不動，避免捲動時閃）
    if (this.motionOk()) {
      const key = (this.plugin.state.leftMode === 'tag' ? 'tag:' : 'dir:') + (this.path || '');
      if (this._lastGridKey !== key) { this._lastGridKey = key; grid.addClass('gn-grid-enter'); }
    }
    // 桌機：依滑桿的最小欄寬自動算欄數。
    // 手機：改用**固定欄數**（設定頁可選 1 / 2 / 3 欄），不吃桌機調大後的 cardWidth，
    //       免得在窄螢幕被撐成 1 欄。
    const isMobileUI = document.body.classList.contains('is-mobile');
    // 編輯風索引卡：欄寬有下限（GN_EDITORIAL_MIN_COL）——縮圖 94px + 內距，
    // 再窄下去標題與日期會擠在一起（2026-07-20 使用者定為目前寬度 150）。
    const isEditorial = this.plugin.state.imageCardLayout === 'editorial';
    const edMin = isEditorial ? GN_EDITORIAL_MIN_COL : 0;
    const minCol = isMobileUI ? 120 : Math.max(edMin, this.plugin.state.cardWidth || 120);
    // 手機欄數：一般版面吃「⋯ 更多」的 1/2/3 欄設定；
    // 編輯風索引卡**固定 2 欄**（2026-07-20 使用者要求）——1 欄太空、3 欄塞不下縮圖+日期。
    const fixedCols = isMobileUI ? (isEditorial ? 2 : (this.plugin.state.mobileCols || 2)) : 0;
    const masonry = new MasonryLayout(grid, { gap: 16, minCol, fixedCols });   // 2026-07-18 12→16 更透氣
    if (!this._masonries) this._masonries = [];
    this._masonries.push(masonry);
    if (zoom) zoom.oninput = () => {
      const v = Number(zoom.value);
      this.plugin.state.cardWidth = v;
      for (const m of this._masonries) m.setMinCol(v);   // 兩區一起縮放
      for (const vw of (this._virtuals || [])) vw.setMinCol(v);
      this.plugin.saveState();
    };
    return { grid, masonry };
  }

  // 建一張卡片（原 renderNoteWall 內的邏輯，抽出來讓各區共用）
  // opts: { skipPreview }
  /* 自動卡片底色（2026-07-20，設定 → 卡片牆可開關）：從封面圖抽主色，混入主題底色當卡片背景。
     （主色快取上限見 TINT_CACHE_MAX）
     ⚠️ 手動右鍵上色（gn-card-colored）永遠優先，不會被自動色蓋掉。
     快取 key＝path:mtime（同一張圖只算一次；只存記憶體，重載後重算，成本極低）。 */
  autoTintCard(card, img, key) {
    if (!this.plugin.state.autoCardColor) return;
    if (card.hasClass('gn-card-colored')) return;   // 手動上色優先
    const cache = this.plugin._tintCache || (this.plugin._tintCache = new Map());
    const apply = (rgb) => {
      if (!rgb || !card.isConnected) return;
      card.style.setProperty('--gn-tint', 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')');
      card.addClass('gn-card-tinted');
    };
    if (cache.has(key)) { apply(cache.get(key)); return; }
    const run = () => {
      const rgb = gnDominantColor(img);
      // 連 null 也記，避免反覆重算失敗的圖。加 FIFO 上限：
      // key 是 path:mtime，逛過的每一張圖都會留一筆，沒有上限就是單調成長。
      if (cache.size >= TINT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, rgb);
      apply(rgb);
    };
    if (img.complete && img.naturalWidth) run();
    else img.addEventListener('load', run, { once: true });
  }

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
    // 虛擬化下卡片會被卸載再重建 → 選取狀態要從 this.selected 補回來，
    // 否則捲出去再捲回來，勾選的卡就變成沒選（狀態其實還在，只是沒畫出來）
    if (this.selected.has(it.file.path)) card.addClass('gn-card-selected');
    const isMd = it.ext === 'md';
    // 全自動樣式（2026-07-19，手動樣式選單已移除）：
    // 有核取方塊的筆記 → 自動待辦卡（metadataCache.listItems 同步判斷，零讀檔）
    // （2026-07-20 移除）自動待辦卡：卡片不再渲染核取方塊清單，待辦筆記＝一般卡片（內文預覽）。
    // 待辦清單只留工具列的浮動面板一個入口。
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
    // 編輯風索引卡（imageCardLayout='editorial'）：右上角「大日數 ＋ 小月年」日期塊。
    // 只在該模式建立（切換設定會 refreshViews 整頁重畫，不必常駐佔 DOM）。
    if (this.plugin.state.imageCardLayout === 'editorial') {
      const d0 = new Date(it.ctime);
      const dbox = body.createDiv('gn-datebox');
      dbox.createSpan({ cls: 'gn-datebox-day', text: String(d0.getDate()) });
      // 月名固定英文三字母（設計元素，2026-07-20 使用者指定；不跟隨語言，中文才不會變「11月」）
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d0.getMonth()];
      // 年份不加撇號（2026-07-20 使用者要求）：JUL 26，不是 JUL '26
      dbox.createSpan({ cls: 'gn-datebox-my', text: mon + ' ' + String(d0.getFullYear()).slice(2) });
    }
    body.createDiv('gn-date').setText(fmtDate(it.ctime));
    const titleEl = body.createDiv('gn-title');
    if (this._searchQ) gnHighlightInto(titleEl, it.name, gnHighlightTerms(this._searchQ));
    else titleEl.setText(it.name);

    if (it.src) {
      // 有封面 → 圖片在上、標題/日期在下
      card.addClass('gn-has-img');
      const img = card.createEl('img');
      img.loading = 'lazy';
      img.decoding = 'async';   // 非同步解碼：不擋主執行緒（手機捲動時很有感）
      this.setCardImage(img, it);
      this.autoTintCard(card, img, it.file.path + ':' + it.file.stat.mtime);   // 自動卡片底色（設定可開關）
      // 圖片卡預設不顯示內文（2026-07-18 移除 hover 內文，省讀檔）；
      // 但「編輯風索引卡」要有內文預覽（2026-07-20）→ 該模式下補建，走既有延遲載入管線（捲到才 cachedRead）。
      if (isMd && !skipPreview && this.plugin.state.imageCardLayout === 'editorial') {
        const prev = body.createDiv('gn-preview');
        card._prevEl = prev; card._prevFile = it.file;
      }
    } else if (!isMd) {
      // 非 md 且無封面 → 檔型「圖示封面」卡：套 gn-has-img 圖片卡版型（icon 方塊當封面、標題/日期在下），
      //   與圖片卡一致（canvas/base/pdf 皆然）。PDF 渲染第一頁 → 之後無縫換成真圖封面。
      card.addClass('gn-has-img');
      // gn-icon-cover 取代原本的 :has(.gn-fileicon)（2026-07-31）：
      // 「封面其實是檔型圖示、不是真圖」→ 文字不疊在圖上。
      // PDF 之後渲染出封面時會在 loadPdfThumb 移除這個 class。
      card.addClass('gn-icon-cover');
      const ph = card.createDiv('gn-fileicon');
      setIconCached(ph.createDiv('gn-fileicon-ic'), iconForExt(it.ext));       // icon 在上
      ph.createSpan('gn-fileicon-label').setText(it.ext.toUpperCase());  // 文字（BASE / CANVAS…）在下，一起置中
      /* Canvas 不抓縮圖（2026-08-01 使用者要求）：以前會把 canvas 裡第一張嵌入圖當封面，
         但那張圖是隨機的、跟 canvas 的內容無關，同一面牆上每張 canvas 卡長得都不一樣。
         改成一律灰底 + CANVAS 字樣，跟 base 一致、也一眼看得出檔案類型。
         PDF 保留渲染第一頁——那確實代表該檔案的內容。 */
      if (it.ext === 'pdf' && window.pdfjsLib) { card._pdfFile = it.file; card._pdfPh = ph; }   // 捲到才渲染
    } else {
      // md 無封面 → 顯示內文預覽；同時試抓外部連結 og:image，抓到則以圖代文
      if (!skipPreview) {
        const prev = body.createDiv('gn-preview');
        card._prevEl = prev; card._prevFile = it.file;   // 延遲載入內文
      }
      card._ogFile = it.file;   // 捲到才抓 og:image（持久快取）
    }

    // （2026-07-20 移除）卡片上的「顯示連結牆」🔗 按鈕：連結牆功能整套下架。

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
      this.drag = { kind: 'note', path: it.file.path };   // GN 內部用（拖到樹狀圖搬檔案）
      card.addClass('gn-card-dragging');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'all';

      /* 讓 Canvas / 編輯器 / 其他外掛也收得到（2026-08-01）。
         以前只設了 effectAllowed，dataTransfer 裡什麼都沒放 → 卡片只能在 GN 內部拖，
         拖到 Canvas 完全沒反應。

         Obsidian 自己的檔案總管走 app.dragManager：
           dragFile(evt, file, source) 會 ① 把 obsidian:// 網址寫進 dataTransfer
                                        ② 回傳 { type:'file', file, icon, title } 描述物件
           再交給 onDragStart(evt, draggable)。
         Canvas 是用 dragManager.handleDrop 接收，走同一條路才會變成「檔案節點」，
         而不是純文字節點。

         ⚠️ app.dragManager 未列在官方 API typings（雖然大量外掛都在用）。
            這裡做特徵偵測，取不到就退回 text/plain 的 wiki 連結 ——
            至少還能拖出一個文字節點，不會整個沒反應。 */
      try {
        const dm = this.app.dragManager;
        if (dm && typeof dm.dragFile === 'function' && typeof dm.onDragStart === 'function') {
          dm.onDragStart(e, dm.dragFile(e, it.file, 'gallery-navigator'));
        } else if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', '[[' + it.file.basename + ']]');
        }
      } catch (err) {
        if (e.dataTransfer) e.dataTransfer.setData('text/plain', '[[' + it.file.basename + ']]');
      }
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
      // 標籤模式：移除「目前檢視中的標籤」（2026-07-19）
      const curTag = this.plugin.state.leftMode === 'tag' ? this.plugin.state.activeTag : null;
      if (curTag && curTag !== '__untagged__') {
        menu.addItem((i) => i.setTitle(t('Remove #{{tag}} from this note', { tag: curTag }))
          .setIcon('tag').onClick(() => this.removeTagFromNote(it.file, curTag)));
      }
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

    // masonry 為 null＝虛擬化模式：位置與寬度由 VirtualWall 統一寫，這裡只設定位方式
    if (masonry) masonry.add(card);
    else { card.style.position = 'absolute'; card.style.top = '0'; card.style.left = '0'; }
    return card;
  }

  /* 虛擬化卸載一張卡片前的清理。
     ⚠️ 一定要把 el 從 _cardEls 裡拿掉：那個 Map 是選取、範圍選取、捲動定位共用的
        參照表，留著已移除的節點會讓後續操作對著殭屍元素設 class（看起來像沒反應）。 */
  unregisterCard(el, it) {
    if (this._ogObserver) { try { this._ogObserver.unobserve(el); } catch (e) {} }
    const arr = this._cardEls && this._cardEls.get(it.file.path);
    if (!arr) return;
    const i = arr.indexOf(el);
    if (i >= 0) arr.splice(i, 1);
    /* 這個路徑已經沒有任何掛載中的卡片 → 取消它排隊中的縮圖工作，
       別讓看不見的卡片排擠掉現在畫面上的（已在解碼的無法中斷，讓它做完）。
       ⚠️ 一定要等 splice 之後再判斷：同一個檔案可能同時有多張卡（互相引用的牆），
          還有別張卡在等的話就不能取消。 */
    if (!arr.length && this.plugin.thumbs) {
      try { this.plugin.thumbs.cancel(it.file.path); } catch (e) {}
    }
  }

  /* 卡片還沒建出來時的高度估計。準不準只影響捲動時的跳動幅度，
     不影響正確性——卡片真的掛上去後 VirtualWall.measure() 會用實測值取代。 */
  /* 啟動長寬比預取，並在每補齊一批之後讓版面用新資訊重算。
     兩條渲染路徑（虛擬化 / 分批）都會走這裡：
       • 虛擬化 → invalidateEstimates()，重算尚未量測項目的預測高度
       • 分批   → relayoutWalls()，masonry 重新排一次
     換資料夾時 start() 內部會先 cancel()，舊資料夾的回呼一律作廢。 */
  startDimPrefetch(notes) {
    const pf = this.plugin.dimPrefetch;
    if (!pf) return;
    pf.start(notes, () => {
      if (!this.contentEl || !this.contentEl.isConnected) return;
      const vws = this._virtuals || [];
      if (vws.length) for (const vw of vws) vw.invalidateEstimates();
      else this.relayoutWalls();
    });
  }

  /* 卡片分類，給 VirtualWall 分開學「該類版型的固定開銷」。
     同一類的卡片，實際高度減掉算式基準之後應該幾乎是常數；
     混在一起學的話（例如把純文字卡跟圖片卡算成同一類）平均值會被拉歪，
     預測就永遠命中不了、總高度也就一直在修 → 捲軸拇指一直跳。 */
  /* 這張卡的高度是否已經定案（可以拿去量測與學習）。

     ⚠️ 沒有這一關會出大事：卡片剛掛上去時圖片還沒載入，量到的是 4:3 佔位高度，
        不是真正的圖片高度。把它當真值會 (a) 壓扁該卡，(b) 更糟的是被學進
        「版型固定開銷」——實測會學成 −141px 這種離譜的值，連帶把所有還沒
        量測的卡片一起壓扁 → 總高度塌陷 → 捲軸拇指變得很長，等圖片陸續載入
        才長回來、拇指再變短。

     判斷方式：卡片裡每個 <img> 都要 complete 且有 naturalWidth。
     還沒設 src 的 img（縮圖產生中）complete 是 true 但 naturalWidth 為 0，
     所以這個條件同時涵蓋「圖片載入中」與「縮圖還在背景產生」。
     沒有任何圖片的純文字卡直接算定案。 */
  cardSettled(el) {
    const imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
    for (const im of imgs) {
      if (!im.complete || !im.naturalWidth) return false;
    }
    return true;
  }

  cardKind(it) {
    const layout = this.plugin.state.imageCardLayout || 'overlay';
    if (!it.src) return layout + ':text';
    // 長寬比已知與未知要分開：未知的用 4:3 猜，算式基準本身就不可靠，
    // 不該把它的誤差混進「已知長寬比」那一類的開銷常數裡
    const known = !!(this.plugin._dimIndex || {})[this.dimKeyOf(it)];
    return layout + (known ? ':img' : ':img?');
  }

  estimateCardHeight(it, colW) {
    /* ⚠️ 三種圖片卡版型的文字區定位不同，估計必須分開算，
          不然整批卡片會被系統性高估或低估，總高度一路被修正 → 捲軸一直跳：
            overlay（預設）：.gn-body 是 position:absolute 疊在圖上 → **不佔高度**
            stacked        ：.gn-body 在圖片下方（relative）→ 約 +62px
            editorial      ：另有日期塊與內文預覽 → 約 +96px
          （見 gallery.css:540 / 1423 兩組規則） */
    const layout = this.plugin.state.imageCardLayout;
    if (it.src) {
      const d = (this.plugin._dimIndex || {})[this.dimKeyOf(it)];
      // 長寬比未知（第一次看到這張圖）→ 用 4:3 當中性預設，載入後會校正
      const ratio = (d && d[0] > 0 && d[1] > 0) ? (d[1] / d[0]) : 0.75;
      const imgH = colW * ratio;
      if (layout === 'editorial') return imgH + 96;
      if (layout === 'stacked') return imgH + 62;
      return imgH;
    }
    return layout === 'editorial' ? 150 : 180;   // 無封面：內文預覽卡
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
    // 狀態膠囊（攤平／標籤篩選）獨立成一列，放在卡片牆頂端、不再塞進工具列標題列（2026-07-20）：
    //   多選標籤時字串會很長（#a #b #c ✕），塞在工具列會把麵包屑擠爆＝破格。
    //   獨立一列後可自行換行（flex-wrap），長度再長也不影響工具列。
    const tagFilterOn = !filesOverride && this._tagFilter && this._tagFilter.size;
    if (flatten || tagFilterOn) {
      const chips = container.createDiv('gn-wall-chips');
      if (flatten) chips.createSpan({ cls: 'gn-head-flat', text: t('Including subfolders') });
      // 標籤篩選中 → **每個標籤各自一顆膠囊**，點哪顆就只移除那一個篩選條件
      // （2026-07-20 改：原本全部標籤擠成一顆、一點就整組清空，無法逐一取消）
      if (tagFilterOn) {
        for (const tag of [...this._tagFilter]) {
          const chip = chips.createSpan({ cls: 'gn-head-flat gn-head-tag', text: '#' + tag + ' ✕' });
          chip.setAttr('title', t('Remove this filter'));
          chip.onclick = () => {
            this._tagFilter.delete(tag);
            this.rerenderMain();
          };
        }
      }
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

  /* 虛擬化瀑布流：只保留視窗上下各一屏的卡片，其餘拆掉（見 virtual.js）。
     小資料夾不走這條——幾十張卡全留著沒有成本，反而省下估計/校正的複雜度與跳動。 */
  renderVirtual(container, grid, masonry, notes, opts) {
    // masonry 不再管理項目，收掉以免它的 ResizeObserver 跟 VirtualWall 打架
    try { masonry.destroy(); } catch (e) {}
    const mi = (this._masonries || []).indexOf(masonry);
    if (mi >= 0) this._masonries.splice(mi, 1);

    /* 順序表一次填滿：範圍選取（shift 點選）要能跨到還沒建出來的卡片。
       ⚠️ _cardEls 也要一起預填空陣列。makeCard 是用「_cardEls 沒有這個 path」
          當作「第一次見到，推進 _cardOrder」的判斷；只填 _cardOrder 不填 _cardEls
          的話，每張卡第一次掛載時都會再推一次 → 順序表出現重複 → 範圍選取抓錯範圍。 */
    this._cardOrder = [];
    this._cardEls = new Map();
    for (const n of notes) {
      const p = n.file.path;
      if (this._cardEls.has(p)) continue;   // 同一檔案重複出現時只登記一次（與原本語意一致）
      this._cardEls.set(p, []);
      this._cardOrder.push(p);
    }

    const vw = new VirtualWall({
      scroller: container.closest('.gn-main') || container,
      grid,
      gap: masonry.gap,
      minCol: masonry.minCol,
      fixedCols: masonry.fixedCols,
      create: (it) => this.makeCard(grid, null, it, opts || {}),
      destroy: (el, it) => this.unregisterCard(el, it),
      estimate: (it, colW) => this.estimateCardHeight(it, colW),
      kindOf: (it) => this.cardKind(it),
      isSettled: (el) => this.cardSettled(el),
    });
    // 圖片載入完成 → 卡片高度變了 → 重新量測。
    // 捕獲階段一條就涵蓋所有後續插入的圖（load 不冒泡）。
    grid.addEventListener('load', () => vw.notifyContentChanged(), true);
    if (!this._virtuals) this._virtuals = [];
    this._virtuals.push(vw);
    vw.setItems(notes);
    /* 保險：setItems 當下 grid 可能還沒完成版面（容器仍在組裝中），
       此時量到的 gridTop / clientWidth 會是錯的 → 下一個 frame 再算一次。 */
    requestAnimationFrame(() => { if (grid.isConnected) vw.relayout(); });
  }

  // 分批把卡片畫進瀑布流：先畫第一批，捲到接近底部才補下一批
  renderInChunks(container, grid, masonry, notes, opts) {
    const isMobileUI = document.body.classList.contains('is-mobile');

    /* 先在背景把整批的長寬比補齊。
       卡片高度＝欄寬 × 長寬比（overlay 版型實測固定開銷僅 0.4px），
       所以長寬比一旦到齊，總高度就是算得準的，捲軸不會再收斂。
       原本只有「卡片被掛上去且圖片載完」才記錄，虛擬化一次只掛十幾張，
       305 張的資料夾捲半天命中率也才 3% —— 總高度永遠在變。
       這裡改成一開資料夾就整批補，補完存進 dims.json，下次直接命中。 */
    this.startDimPrefetch(notes);
    /* 超過這個量才虛擬化。門檻不能太低：虛擬化靠估計高度排版，
       第一次瀏覽（長寬比還沒進索引）捲動會有輕微跳動，小資料夾不值得付這個代價。 */
    const VIRTUAL_MIN = isMobileUI ? 150 : 300;
    if (this.plugin.state.virtualWall !== false && notes.length >= VIRTUAL_MIN) {
      this.renderVirtual(container, grid, masonry, notes, opts);
      return;
    }
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
      // 點行事曆「當天筆記」→ 正常開啟（觸發畫廊同步定位，2026-07-20 使用者要求）。
      // 之前用 openNoteNoSync 刻意不同步，現改回會同步。
      row.onclick = () => this.app.workspace.openLinkText(f.path, '', false);
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

  // 從日曆開筆記：只跳過「這個特定路徑」的同步（避免牽動畫廊跨資料夾重畫），
  // 不用無差別旗標——否則旗標殘留會被之後「從日記點的連結」誤消耗，害連結不定位（2026-07-20 修）。
  openNoteNoSync(path) {
    this.plugin._skipSyncPath = path;
    window.setTimeout(() => { if (this.plugin._skipSyncPath === path) this.plugin._skipSyncPath = null; }, 1500);   // 安全網：沒觸發就自動清
    this.app.workspace.openLinkText(path, '', false);
  }

  async createDailyNote(day) {
    const dateStr = day.getFullYear() + '-' + calPad2(day.getMonth() + 1) + '-' + calPad2(day.getDate());
    const wd = t(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()]);
    // 每日筆記資料夾：讀 Obsidian 核心「每日筆記」外掛設定的 folder（跟模板同一套來源）。
    // （2026-07-20 修：原本寫死中文「每日筆記」→ 別人沒有這個資料夾會建到 vault 根目錄。）
    let folder = '';
    try {
      const dn = this.app.internalPlugins.getPluginById('daily-notes');
      const df = ((dn && dn.instance && dn.instance.options && dn.instance.options.folder) || '').trim();
      if (df && this.app.vault.getAbstractFileByPath(df)) folder = df.replace(/\/?$/, '/');
    } catch (e) { /* 內部 API 變動 → 退回根目錄 */ }
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
    // 手機欄數設定已移入工具列「⋯ 更多」面板（2026-07-19）

    new Setting(containerEl)
      .setName(t('Image card layout'))
      .setDesc(t('How cards with a cover image show their title and date.'))
      .addDropdown((d) => {
        d.addOption('overlay', t('Overlay text on image (current)'));
        d.addOption('stacked', t('Image on top, text below (classic)'));
        d.addOption('editorial', t('Editorial index card (thumbnail + big date)'));
        d.setValue(['stacked', 'editorial'].includes(st.imageCardLayout) ? st.imageCardLayout : 'overlay');
        d.onChange((v) => { st.imageCardLayout = v; save(); this.plugin.refreshViews(); });
      });

    new Setting(containerEl)
      .setName(t('Auto card color from cover image'))
      .setDesc(t('Tints each card with the dominant color of its cover image. Cards you colored manually are left alone.'))
      .addToggle((tg) => tg.setValue(!!st.autoCardColor)
        .onChange((v) => { st.autoCardColor = v; save(); this.plugin.refreshViews(); }));

    new Setting(containerEl)
      .setName(t('Open notes without focusing the editor'))
      .setDesc(t('Notes opened from the gallery start unfocused, so a first-line image embed stays rendered instead of expanding to markdown. Click into the note to edit as usual.'))
      .addToggle((tg) => tg.setValue(st.openUnfocused !== false)
        .onChange((v) => { st.openUnfocused = v; save(); }));

    new Setting(containerEl)
      .setName(t('Pinterest visual search (experimental)'))
      .setDesc(t('Adds a reverse-image search entry to image menus. Uses an unofficial Pinterest endpoint that may stop working at any time; the image you search with is uploaded to Pinterest.'))
      .addToggle((tg) => tg.setValue(!!st.enablePinterest)
        .onChange((v) => { st.enablePinterest = v; save(); this.plugin.refreshViews(); }));

    new Setting(containerEl)
      .setName(t('Image lightbox actions'))
      .setDesc(t('Adds a floating action bar (copy, visual search, reveal in Finder) to the image lightbox Obsidian shows when you click an image. Turn this off if a future Obsidian update changes the lightbox and the bar misbehaves.'))
      .addToggle((tg) => tg.setValue(st.enableLightboxActions !== false)
        .onChange((v) => { st.enableLightboxActions = v; save(); }));

    new Setting(containerEl)
      .setName(t('Virtualized card wall'))
      .setDesc(t('In large folders, keeps only the cards near the viewport in the DOM and recycles the rest. Greatly reduces memory and scrolling lag. Turn off if you see layout jumps while scrolling.'))
      .addToggle((tg) => tg.setValue(st.virtualWall !== false)
        .onChange((v) => { st.virtualWall = v; save(); this.plugin.refreshViews(); }));

    new Setting(containerEl)
      .setName(t('Image thumbnails'))
      .setDesc(t('Large images are downscaled once and cached, so cards no longer decode full-resolution originals. This is what keeps big image folders from exhausting memory on mobile.'))
      .addButton((b) => b.setButtonText(t('Clear thumbnail cache')).onClick(async () => {
        const n = await this.plugin.thumbs.prune();
        new Notice(t('Removed {{n}} stale thumbnails', { n }));
      }));

    /* ══ 2. 圖片預覽 ══ */
    this.group(containerEl, t('Image peek'), t('Canvas has no built-in image viewer, so this fills that gap: double-click an image or press Space. Matches the look of the lightbox Obsidian shows in notes. Notes themselves are left to Obsidian.'));
    new Setting(containerEl)
      .setName(t('Enable image peek (Canvas)'))
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

    /* ══ 3.5 淨化連結 ══ */
    this.group(containerEl, t('Clean links'),
      t('Adds a right-click item in the editor that strips tracking parameters (utm_*, xmt, slof, fbclid, gclid…) from URLs. Everything else in the query string is kept.'));
    new Setting(containerEl)
      .setName(t('Enable clean links'))
      .addToggle((tg) => tg.setValue(st.enableCleanLink !== false)
        .onChange((v) => { st.enableCleanLink = v; save(); this.display(); }));
    if (st.enableCleanLink !== false && this.plugin.renderCleanLinkSettings) {
      this.plugin.renderCleanLinkSettings(containerEl, this.plugin);
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

  /* 去抖 150ms：SuggestModal 每個 keystroke 都會叫這支，而 search() 要跑 BM25
     掃過所有命中文件。打字中途的每一個中間字串都算一次純屬浪費（畫廊內的搜尋列
     早就有去抖，這裡比照）。做法：等 150ms，期間又有新輸入就直接放棄這一輪。 */
  async getSuggestions(q) {
    q = (q || '').trim();
    this._q = q;
    if (!q) return [];
    const seq = (this._seq = (this._seq || 0) + 1);
    await new Promise((r) => setTimeout(r, 150));
    if (seq !== this._seq) return [];           // 已經有更新的輸入 → 這輪作廢
    const idx = this.plugin.search;
    if (!idx.ready) await idx.ensureReady();   // 惰性建索引（首次 ~1 秒，之後增量）
    if (seq !== this._seq) return [];
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
    this.deadLen = 0;        // 墓碑累積的 token 量（估計值，用來決定何時整理 inv）
    this._modT = new Map();  // path → 去抖計時器（modify 事件）
    /* 前綴查詢用的排序 token 表（見 _tokenKeys）。
       inv 有約 29 萬個 key，前綴展開原本每次查詢都對整份做 startsWith，
       是搜尋 modal 打字卡頓的主因。 */
    this._keys = null;       // 排序後的 token 陣列
    this._keysNew = [];      // 新增但尚未併入的 token（線性合併，不重排）
    this._keysDirty = true;  // true = 下次查詢整份重建
  }

  /* 排序 token 表：
       • 整份重建只發生在 build() / compact() 之後（罕見）
       • 平時新增的 token 累積在 _keysNew，查詢時做一次 O(n+k) 線性合併
       • 累積太多（>2000）就乾脆整份重排，避免合併成本超過重排 */
  _tokenKeys() {
    if (this._keysDirty || !this._keys) {
      this._keys = [...this.inv.keys()].sort();
      this._keysNew = [];
      this._keysDirty = false;
      return this._keys;
    }
    if (this._keysNew.length) {
      if (this._keysNew.length > 2000) { this._keysDirty = true; return this._tokenKeys(); }
      const add = [...new Set(this._keysNew)].sort();
      this._keysNew = [];
      const a = this._keys, out = new Array(a.length + add.length);
      let i = 0, j = 0, k = 0;
      while (i < a.length && j < add.length) out[k++] = a[i] <= add[j] ? a[i++] : add[j++];
      while (i < a.length) out[k++] = a[i++];
      while (j < add.length) out[k++] = add[j++];
      out.length = k;
      this._keys = out;
    }
    return this._keys;
  }

  /* 前綴查詢：二分找下界，再往後掃到不符為止 → O(log n + k)。
     ⚠️ sort() 的 UTF-16 碼位順序與 startsWith 一致，同前綴的 key 必為連續區段。 */
  prefixTokens(prefix, max) {
    const keys = this._tokenKeys();
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < prefix) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo; i < keys.length && out.length < max; i++) {
      if (!keys[i].startsWith(prefix)) break;
      out.push(keys[i]);
    }
    return out;
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
      if (!arr) {
        arr = []; this.inv.set(tok, arr);
        if (this._keys) this._keysNew.push(tok);   // 併入排序表（_keys 還沒建就不用記）
      }
      arr.push(id, n);
    }
    this.docs.push({ path: f.path, title: f.basename, len: len || 1, mtime: f.stat.mtime });
    this.byPath.set(f.path, id);
    this.totalLen += len;
    this.live++;
    this.avgLen = this.totalLen / Math.max(1, this.live) || 1;
  }

  /* 把某個 path 的舊資料標成墓碑。
     這裡**不**立刻去 inv 刪 postings——那要掃全表，每次存檔都掃太貴。
     改為累計死掉的 token 量（deadLen），累積到一定比例才整理一次（見 maybeCompact）。

     ⚠️ 舊註解寫「一個 session 內編輯次數有限，殘留量可忽略」，這個假設不成立：
        Obsidian 自動存檔約每 2 秒就發一次 modify，編輯一小時就是上千次重新索引，
        每次都往 inv 各個 token 陣列 push 一份完整 postings。
        後果有兩層：(a) 記憶體單調成長、重啟才恢復；
        (b) IDF 用 df = arr.length / 2，墓碑也被算進 document frequency → 排名逐漸失真。 */
  _tombstone(path) {
    const old = this.byPath.get(path);
    if (old == null) return;
    const d = this.docs[old];
    if (d) { this.totalLen -= d.len; this.live--; this.deadLen += d.len; }
    this.docs[old] = null;
    this.byPath.delete(path);
    this.avgLen = this.totalLen / Math.max(1, this.live) || 1;
  }

  /* 死 postings 佔比過高時整理一次 inv。
     門檻取「死的比活的還多」且至少 5 萬 token——小 vault 不會沒事就掃全表，
     長時間編輯的 session 則大約每累積一輪就整理一次。 */
  maybeCompact() {
    if (this.deadLen <= Math.max(50000, this.totalLen * 0.5)) return false;
    this.compact();
    return true;
  }

  /* 掃過 inv，就地擠掉指向墓碑的 postings。
     只重寫陣列、不重新編號 docs——docs 的洞是幾個小物件，相對 postings 可忽略，
     而重新編號要動到所有 postings 的 id，風險大很多。 */
  compact() {
    const docs = this.docs;
    for (const [tok, arr] of this.inv) {
      let w = 0;
      for (let i = 0; i < arr.length; i += 2) {
        if (!docs[arr[i]]) continue;          // 墓碑 → 丟掉
        arr[w++] = arr[i]; arr[w++] = arr[i + 1];
      }
      if (w === arr.length) continue;         // 這個 token 沒有死 postings
      if (w === 0) { this.inv.delete(tok); this._keysDirty = true; }   // 整個 token 都沒人用了（Map 迭代中刪除是安全的）
      else arr.length = w;
    }
    this.deadLen = 0;
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
    this._keys = null; this._keysNew = []; this._keysDirty = true;   // 排序 token 表跟著重來

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
    this.maybeCompact();
    // 新加進來的 PDF → 背景把內文抽出來（抽完會自己再索引一次）
    if (file.extension === 'pdf') this.warmPdfCache();
  }

  /* modify 專用入口：per-path 去抖。
     ⚠️ 不能直接接 onFileChanged——自動存檔約每 2 秒一次，而 _indexFile 會
        cachedRead 整篇再重新斷詞（含 CJK bigram）。編輯一篇長文時等於每 2 秒
        重新 tokenize 整篇，還每次都在 inv 留下一份死 postings。
        create / rename 不走這裡（那些是單次事件，要即時生效）。 */
  onFileModified(file) {
    if (!this.ready || !this.indexable(file)) return;
    const p = file.path;
    clearTimeout(this._modT.get(p));
    this._modT.set(p, setTimeout(() => {
      this._modT.delete(p);
      this.onFileChanged(file);
    }, 1200));
  }

  // 外掛卸載時把待觸發的去抖計時器收乾淨
  disposeTimers() {
    for (const tm of this._modT.values()) clearTimeout(tm);
    this._modT.clear();
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
      /* 以前這裡對整份 inv（約 29 萬 key）跑 startsWith，每次查詢一輪。
         改走排序表的二分下界 → O(log n + k)。多抓幾個是因為要扣掉
         「長度相同」與「查詢已含」的 key，扣完再取前 24 個。 */
      let added = 0;
      for (const key of this.prefixTokens(tk, 48)) {
        if (added >= 24) break;
        if (key.length > tk.length && !qCount.has(key)) {
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
    this.state = Object.assign({ lastPath: '', cardWidth: 120, sort: 'new', folderOrder: {}, hiddenFolders: [], folderColors: {}, expandedFolders: [], todoNote: '', todoCollapsed: false, todoHideDone: true, treeWidth: 232, treeCollapsed: false, syncActive: true, leftMode: 'folder', activeTag: '', expandedTags: [], cardColors: {}, noPreviewFolders: [], favorites: [], pinnedCards: [], calFeeds: [], agendaDays: 14, calDailyTemplate: '', lang: '', enablePinterest: false, openUnfocused: true, cardStyles: {}, imageCardLayout: 'stacked', autoCardColor: false }, await this.loadData());
    setLang(this.state.lang || '');   // i18n：''=跟隨 Obsidian 介面語言

    // 註冊外掛專屬圖示（必須在 registerView / addRibbonIcon 之前）
    addIcon(GN_ICON_ID, GN_ICON_SVG);

    this.registerView(VIEW_TYPE, (leaf) => new GalleryView(leaf, this));
    this.registerView(CAL_VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    this.addRibbonIcon(GN_ICON_ID, 'Gallery Navigator', () => this.activateView());
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
    this.registerEvent(this.app.vault.on('modify', (f) => this.search.onFileModified(f)));
    // 'create' 延到 layout ready 後註冊：啟動期每個既有檔案都會發一次
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (f) => this.search.onFileChanged(f)));
    });
    this.registerEvent(this.app.vault.on('delete', (f) => this.search.onFileDeleted(f)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.search.onFileRenamed(f, old)));

    // PDF 內文：借 text-extractor 擷取（它有持久快取，只需要跑一次；之後建索引就會自動吃到）
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

    // 圖片長寬比索引（資源路徑 → [w, h]）：讓卡片在圖片載入前就把高度佔好
    this._dimIndex = {};
    this.loadDimIndex();

    // 縮圖快取：卡片牆不再直接解碼原圖（見 thumbs.js 開頭的說明）
    this.thumbs = new ThumbCache(this);
    this.thumbs.load();

    // 長寬比預取：開資料夾時在背景把整批的長寬比補齊，總高度才能一次算準（見 dims.js）
    this.dimPrefetch = new DimPrefetcher(this);

    // 檔案增刪/改名時，若 View 開著就重畫；同時讓日曆筆記索引失效
    // 檔案結構變了 → 資料夾檔案數快取失效（只有增刪改名會影響，內容修改不會）
    // 筆記內容變動 → 只清那一筆封面快取（見 itemFromFile 上方說明）
    this.registerEvent(this.app.metadataCache.on('changed', (f) => invalidateCoverCache(f && f.path)));
    const onVaultChange = () => {
      this._calNoteDirty = true;
      invalidateFolderCounts();
      invalidateCoverCache();      // 結構變動：封面可能指向被改名/刪除的檔案 → 整份清掉
      this.refreshViews();
    };
    // 'create' 延到 layout ready 後註冊：啟動期數千次回呼會反覆清快取、順延 debounce
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', onVaultChange));
    });
    this.registerEvent(this.app.vault.on('delete', onVaultChange));
    this.registerEvent(this.app.vault.on('rename', onVaultChange));

    // （2026-07-31 移除）imgSrcOf / buildImageMenu / IMG_AREAS 與手機長按選單：
    //   圖片選單改走 setupImageFileMenu() 的 file-menu，桌機右鍵與手機長按都由
    //   Obsidian 原生選單承接。舊的長按計時器會在原生選單之前先彈出自己那一份，
    //   使用者會看到「先舊選單、再新選單」兩層，所以整組拿掉。

    // 點筆記內的 #標籤 → 開畫廊標籤模式（2026-07-19；Cmd/Ctrl+點 = 保留原生全域搜尋）
    this.registerDomEvent(document, 'click', (evt) => {
      if (evt.metaKey || evt.ctrlKey) return;
      const el0 = evt.target;
      if (!(el0 instanceof Element)) return;
      let tag = null;
      const a = el0.closest('a.tag');                       // 閱讀模式
      if (a) {
        tag = (a.getAttribute('href') || a.textContent || '').replace(/^#/, '');
      } else {
        const cm = el0.closest('.cm-hashtag');              // Live Preview（hashtag 拆成相鄰 span）
        if (cm) {
          const parts = [cm];
          let p = cm;
          while (p.previousElementSibling && p.previousElementSibling.classList.contains('cm-hashtag')) { p = p.previousElementSibling; parts.unshift(p); }
          p = cm;
          while (p.nextElementSibling && p.nextElementSibling.classList.contains('cm-hashtag')) { p = p.nextElementSibling; parts.push(p); }
          tag = parts.map((x) => x.textContent).join('').replace(/^#/, '');
        }
      }
      if (!tag) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.openGalleryTag(tag);
    }, true);

    // 桌機右鍵改走 file-menu（見 setupImageFileMenu）——
    // 以前這裡攔 document 的 contextmenu 再 preventDefault，但 Obsidian 自己的
    // 處理器掛在更內層、先跑完就把原生選單顯示出來了，這段等於從來沒生效過。
    // 而且劫持原生選單是上架審查的減分項，所以直接拿掉，改成把項目「加進」原生選單。
    this.setupImageFileMenu();
    this.setupFolderFileMenu();

    // 原生 lightbox（Obsidian 1.13+）補上動作膠囊
    this.setupLightboxActions();

    // Canvas：圖片節點右鍵 → 轉成內嵌該圖的筆記（見 canvasnote.js）
    setupCanvasImageToNote(this, InputModal);

  }

  // 筆記內的 <img> 對應回 vault 檔案（本機圖才有；外部網址圖回 null）
  /* 交換圖片（2026-07-20）：把「筆記裡指向 oldFile 的那個嵌入」換成 newFile。
     ⚠️ 不能用字串盲取代——同一則筆記可能嵌入同一張圖多次，也可能有 ![[a.png|300]] / ![alt](path) 多種語法。
     做法：用 metadataCache 的 embeds 取得**精確位置**（position.offset），只改那一段；
     並保留原本的顯示參數（|300 之類）與語法形式（wiki / markdown）。
     nth = 這是該筆記裡「第幾個指向 oldFile 的嵌入」（由 DOM 推算，見 imgEmbedIndex）。 */
  async swapImage(note, oldFile, newFile, nth) {
    try {
      const cache = this.app.metadataCache.getFileCache(note) || {};
      const embeds = (cache.embeds || []).filter((e) => {
        const lp = String(e.link || '').split('#')[0].split('|')[0].trim();
        const f = this.app.metadataCache.getFirstLinkpathDest(lp, note.path);
        return f && f.path === oldFile.path;
      });
      if (!embeds.length) { new Notice(t('Could not locate this image in the note')); return; }
      const target = embeds[Math.min(nth || 0, embeds.length - 1)];

      const raw = await this.app.vault.read(note);
      const from = target.position.offset.start;
      const to = target.position.offset.end;
      const orig = raw.slice(from, to);

      // 沿用原本的顯示參數（|300、|left 之類）
      const pipe = String(target.link || '').includes('|')
        ? '|' + String(target.link).split('|').slice(1).join('|')
        : '';
      // 新的連結文字：用官方 API，同名檔會自動帶路徑避免撞名
      const linktext = this.app.metadataCache.fileToLinktext(newFile, note.path);
      // 維持原語法形式：![alt](path) 保持 markdown、其餘用 wikilink
      const isMd = /^!\[[^\]]*\]\(/.test(orig);
      const replacement = isMd
        ? '![' + (orig.match(/^!\[([^\]]*)\]/) || ['', ''])[1] + '](' + encodeURI(linktext) + ')'
        : '![[' + linktext + pipe + ']]';

      await this.app.vault.modify(note, raw.slice(0, from) + replacement + raw.slice(to));
      new Notice(t('Swapped to {{name}}', { name: newFile.name }));
    } catch (e) {
      new Notice(t('Swap failed: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }

  /* 這張 <img> 是筆記裡「第幾個指向同一個檔案的嵌入」——交換時才不會改到別張。
     閱讀檢視：同 src 的 .internal-embed 依 DOM 順序數。數不出來就回 0（改第一個）。 */
  /* 把 GN 的圖片功能掛進 Obsidian 原生的檔案選單（筆記內右鍵圖片、檔案總管右鍵圖檔都會觸發）。
     這是 Text Extractor、Claudian 用的同一個 API —— 加進去，而不是取代掉原生選單。
     只加「原生沒有」的三項；複製圖片、刪除、在 Finder 顯示原生本來就有，重複只是噪音。 */
  setupImageFileMenu() {
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !IMG_EXT.test(file.path)) return;

      const img = this.findImgEl(file);          // 畫面上這張圖的 <img>（找不到＝不在目前筆記裡）
      const note = this.app.workspace.getActiveFile();

      // ① 圖片預覽：peek 需要真正的 DOM 元素來收集同一篇的圖做 ← → 導覽，
      //    所以只在圖確實顯示於畫面上時提供。
      if (img && this.peek && this.state.enablePeek !== false) {
        menu.addItem((i) => i.setTitle(t('Peek image')).setIcon('scan-eye')
          .onClick(() => { try { this.peek.open(img); } catch (e) {} }));
      }

      // ② Pinterest 找相似：不需要 DOM，vault 的 resource path 就夠
      if (this.state.enablePinterest) {
        const srcFolder = note && note.parent && note.parent.path !== '/' ? note.parent.path : '';
        menu.addItem((i) => i.setTitle(t('Pinterest visual search')).setIcon('search')
          .onClick(() => new PinterestModal(
            this.app, this.app.vault.getResourcePath(file), (img && img.alt) || '', srcFolder).open()));
      }

      // ③ 交換圖片：要改寫來源筆記，所以必須確定「這張圖真的被目前這篇引用」——
      //    否則在檔案總管右鍵時會去改到一篇不相干的筆記。
      if (note && note.extension === 'md' && this.noteEmbeds(note, file)) {
        menu.addItem((i) => i.setTitle(t('Swap image…')).setIcon('image-plus')
          .onClick(() => {
            const nth = img ? this.imgEmbedIndex(img, file) : 0;   // 沒有 DOM 就換第一個
            new SwapImageModal(this.app, file, (picked) => this.swapImage(note, file, picked, nth)).open();
          }));
      }
    }));
  }

  /* 資料夾右鍵 →「在畫廊開啟」。
     為什麼走 file-menu 而不是自己攔點擊（2026-08-06）：
       分頁標題列那排原生路徑麵包屑（.view-header-breadcrumb），左鍵是寫死的
       「在核心檔案總管裡展開該資料夾」，那個 listener 拿不到參照、無法移除，
       要擋只能在捕獲階段 stopPropagation —— 等於默默拿掉使用者本來就有的核心功能，
       而且會波及同一個元素上的原生右鍵與拖曳。
       但原生麵包屑的**右鍵**最後會呼叫
         workspace.trigger('file-menu', menu, folder, 'file-explorer-context-menu')
       （已從 obsidian-1.13.4.asar 確認），所以掛這個公開事件就能接到那個 TFolder：
       零 DOM 依賴、不攔截任何原生行為、registerEvent 會自動清理。
       同一項也會出現在檔案總管的資料夾右鍵，順便涵蓋。 */
  setupFolderFileMenu() {
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFolder)) return;
      menu.addItem((i) => i.setTitle(t('Open in Gallery Navigator')).setIcon(GN_ICON_ID)
        .onClick(async () => {
          await this.activateView();
          const path = file.path && file.path !== '/' ? file.path : '';
          // 展開祖先，選到的資料夾在左樹才看得到（同 syncToFile 的做法）
          const expanded = new Set(this.state.expandedFolders || []);
          let acc = '';
          for (const seg of (path ? path.split('/') : [])) {
            acc = acc ? acc + '/' + seg : seg;
            expanded.add(acc);
          }
          this.state.expandedFolders = [...expanded];
          this.state.leftMode = 'folder';   // 標籤模式下也要切回資料夾模式，否則導覽沒有意義
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            const v = leaf.view;
            if (v instanceof GalleryView) {
              v._searchOn = false; v._searchQ = '';   // 搜尋牆顯示中的話先收掉，不然看不到資料夾
              v.navigate(path);
            }
          }
        }));
    }));
  }

  /* ── 原生 lightbox 的動作膠囊（2026-07-31）──
     Obsidian 1.13 點圖片會開一個 div.lightbox（app.js 是 activeDocument.body.appendChild），
     但它沒有「複製 / 在 Finder 顯示 / 找相似」這些動作。這裡在它出現時補一條底部膠囊，
     外觀沿用 Image Peek 手機版那顆。

     ⚠️ Obsidian 沒有給 lightbox 任何擴充 API，只能靠 MutationObserver 認私有 class。
        1.12→1.13 就整套換過一次（舊的 .mod-image-lightbox 已成廢棄 CSS），
        所以這裡全程防禦性寫法：認不得就安靜不做，絕不拋錯、不影響原生行為。
        observer 只看 body 的直接子節點（不開 subtree），成本極低。 */
  setupLightboxActions() {
    const LB = 'lightbox';
    const build = (lb) => {
      if (this.state.enableLightboxActions === false) return;
      if (lb.querySelector('.gn-lb-actions')) return;          // 已經加過
      const media = lb.querySelector('.lightbox-media');
      if (!media) return;                                      // 結構不認得 → 放棄

      // 每次點擊都重新讀當下的 img：lightbox 可左右換圖，不能把檔案抓死
      const curImg = () => lb.querySelector('.lightbox-media img');
      const curFile = () => { const im = curImg(); return im ? this.imgToVaultFile(im) : null; };

      const bar = lb.createDiv('gn-lb-actions');
      const add = (icon, label, onClick) => {
        const b = bar.createDiv({ cls: 'gn-lb-btn', attr: { 'aria-label': label } });
        setIcon(b, icon);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();   // 不要讓點擊穿透到背景（背景點擊＝關閉 lightbox）
          try { onClick(); } catch (err) { new Notice(t('Action failed: {{msg}}', { msg: err.message })); }
        });
      };

      add('copy', t('Copy image'), () => {
        const im = curImg();
        if (im) this.copyImage(im.currentSrc || im.src);
      });

      if (this.state.enablePinterest) {
        add('search', t('Pinterest visual search'), () => {
          const im = curImg();
          if (!im) return;
          const af = this.app.workspace.getActiveFile();
          const srcFolder = af && af.parent && af.parent.path !== '/' ? af.parent.path : '';
          new PinterestModal(this.app, im.currentSrc || im.src, im.alt || '', srcFolder).open();
        });
      }

      // 只有 vault 內的圖才有實體檔案可以定位
      if (typeof this.app.showInFolder === 'function' && curFile()) {
        add('folder', t('Reveal in system explorer'), () => {
          const f = curFile();
          if (f) this.app.showInFolder(f.path);
        });
      }
    };

    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains(LB)) {
            try { build(n); } catch (e) {}
          }
        }
      }
    });
    // lightbox 是 body 的直接子節點 → 不開 subtree，避免監聽整個 app 的 DOM 變動
    try { obs.observe(activeDocument.body, { childList: true }); } catch (e) {}
    this.register(() => obs.disconnect());
  }

  /* 目前畫面上對應到這個 vault 檔案的 <img>（沒有就回 null） */
  findImgEl(file) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const root = view && view.containerEl;
    if (!root) return null;
    for (const el of Array.from(root.querySelectorAll('img'))) {
      const f = this.imgToVaultFile(el);
      if (f && f.path === file.path) return el;
    }
    return null;
  }

  /* 這篇筆記有沒有嵌入這個檔案（用 metadataCache，不必讀檔） */
  noteEmbeds(note, file) {
    const cache = this.app.metadataCache.getFileCache(note) || {};
    return (cache.embeds || []).some((e) => {
      const lp = String(e.link || '').split('#')[0].split('|')[0].trim();
      const f = lp && this.app.metadataCache.getFirstLinkpathDest(lp, note.path);
      return f && f.path === file.path;
    });
  }

  imgEmbedIndex(img, oldFile) {
    try {
      const root = img.closest('.markdown-preview-view, .markdown-reading-view, .markdown-source-view, .cm-content');
      if (!root) return 0;
      const emb = img.closest('.internal-embed, .image-embed');
      if (!emb) return 0;
      const all = Array.from(root.querySelectorAll('.internal-embed, .image-embed')).filter((el) => {
        const lp = String(el.getAttribute('src') || '').split('#')[0].split('|')[0].trim();
        if (!lp) return false;
        const af = this.app.workspace.getActiveFile();
        const f = this.app.metadataCache.getFirstLinkpathDest(lp, af ? af.path : '');
        return f && f.path === oldFile.path;
      });
      const i = all.indexOf(emb);
      return i < 0 ? 0 : i;
    } catch (e) { return 0; }
  }

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

  /* 圖片長寬比索引：去查詢字串的資源路徑 → [w, h]。
     用途是在圖片**載入前**就把卡片高度佔好（img 設 aspect-ratio），
     否則每張圖載完都會改變卡片高度 → 觸發一次 O(全部卡片) 的瀑布流重排。
     捲過兩千張之後，這等於每張新圖都要重排兩千張，是滾動掉幀的主因。
     只存兩個數字，一萬張圖約 300KB，跟 og 索引同一個資料夾。 */
  dimIndexPath() { return this.ogCacheDir() + '/dims.json'; }
  async loadDimIndex() {
    try {
      const a = this.app.vault.adapter;
      const p = this.dimIndexPath();
      if (!(await a.exists(p))) return;
      const raw = JSON.parse(await a.read(p)) || {};

      /* 丟掉舊版留下的 app:// key。
         那版拿資源網址當 key，而網址含每次啟動都會變的權杖 —— 那些 key
         從寫下的那一刻就注定對不上，只會愈積愈多（實測 898 筆幾乎全是廢的）。
         這裡順手清掉，不留給使用者一個永遠長大的垃圾檔。 */
      let dropped = 0;
      for (const k of Object.keys(raw)) {
        if (k.startsWith('app://')) { delete raw[k]; dropped++; }
      }
      this._dimIndex = raw;
      if (dropped) this.saveDimIndex();
    } catch (e) { this._dimIndex = {}; }
  }
  /* 長寬比索引落地。
     ⚠️ 這是「整份 stringify + 整檔重寫」，而呼叫端是 dims.js 的預取器：
        開一個 4000 張的資料夾，每解析出一張就叫一次。舊寫法用 trailing debounce
        （每次都把計時器往後推），預取期間變動是連續的 → 反而一路被順延到最後，
        中途當掉就整批白做；而每次真的寫出去又是整份幾百 KB。

     改成「累積門檻 + 固定窗 + 閒置時才寫」：
       • 每次呼叫只累加待寫筆數，不重排計時器（固定窗，不會被一直順延）
       • 到期時若瀏覽器有 requestIdleCallback，就等主執行緒閒下來才 stringify
       • onunload 由 flushDimIndex() 補寫，不會掉資料 */
  saveDimIndex() {
    this._dimDirty = (this._dimDirty || 0) + 1;
    if (this._dimSaveT) return;
    // 累積夠多筆就縮短等待（大批預取時每 ~1.5 秒落地一次），零星變動則等久一點
    const wait = this._dimDirty >= 50 ? 1500 : 4000;
    this._dimSaveT = setTimeout(() => {
      this._dimSaveT = 0;
      const run = () => { this._writeDimIndex().catch(() => {}); };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        run();
      }
    }, wait);
  }

  // 還有沒寫出去的變更就立刻寫（onunload 用）
  async flushDimIndex() {
    if (this._dimSaveT) { clearTimeout(this._dimSaveT); this._dimSaveT = 0; }
    if (this._dimDirty) await this._writeDimIndex();
  }

  async _writeDimIndex() {
    this._dimDirty = 0;
    try {
      const a = this.app.vault.adapter;
      const dir = this.ogCacheDir();
      if (!(await a.exists(dir))) await a.mkdir(dir);
      await a.write(this.dimIndexPath(), JSON.stringify(this._dimIndex));
    } catch (e) {}
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
    if (this.search) this.search.disposeTimers();   // modify 去抖的待觸發計時器
    await this.flushDimIndex();                     // 長寬比索引改成閒置才寫 → 這裡要補刷
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

  // 點筆記內 #標籤 → 開畫廊標籤模式（2026-07-19）
  async openGalleryTag(tag) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const v = leaf && leaf.view;
    if (!(v instanceof GalleryView)) return;
    this.state.leftMode = 'tag';
    this.state.activeTag = tag;
    // 巢狀標籤：展開所有祖先，左樹才看得到選中的節點
    const expanded = new Set(this.state.expandedTags || []);
    const parts = tag.split('/');
    let acc = '';
    for (const p of parts.slice(0, -1)) { acc = acc ? acc + '/' + p : p; expanded.add(acc); }
    this.state.expandedTags = [...expanded];
    this.saveState();
    v._searchOn = false; v._searchQ = '';
    v.render();
    v.gotoCardsMobile();
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
