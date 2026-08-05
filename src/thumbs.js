'use strict';

/* ===== 縮圖快取（2026-08-04）=====
 *
 * 問題：卡片牆過去直接把 `vault.getResourcePath(原圖)` 塞進 <img>。
 *   欄寬只有 120–300px，但一張 6000×4000 的 JPEG 仍會被**完整解碼**成
 *   6000 × 4000 × 4 bytes ≈ 96 MB 的點陣圖。
 *   `loading="lazy"` / `decoding="async"` 只影響「何時解碼」，不影響「解碼多大」。
 *   一個資料夾裡視窗附近同時有 30–50 張這種圖，就是數 GB 的解碼快取
 *   —— 這是 iOS WebView 直接被系統砍掉的主因。
 *
 * 做法：第一次看到某張大圖時，在背景把它縮到 THUMB_MAX 寬存成 JPEG，
 *   放進外掛資料夾的 thumb-cache/，之後一律用縮圖。
 *   縮圖約 40–120 KB、解碼後約 1 MB，比原圖省兩個數量級。
 *
 * ⚠️ 三個關鍵設計，改動前請先讀懂：
 *
 * 1. **產生縮圖本身也要解碼原圖**，所以「同時只做 N 張」是重點中的重點。
 *    佇列序列化 + 每張做完就 `bmp.close()` 立刻釋放，峰值記憶體才壓得住。
 *    若改成並行，這個模組就失去意義。
 *
 * 2. **沒有縮圖時不顯示原圖**，而是留空等縮圖好了再填。
 *    若「先顯示原圖、好了再換」，第一次瀏覽的峰值記憶體跟沒做完全一樣，
 *    等於白做。代價是首次瀏覽會看到卡片漸進填入。
 *
 * 3. **小檔、GIF、SVG 一律直接用原圖**（見 shouldSkip）。
 *    小檔省不了多少；GIF 縮圖會變成靜態圖、動畫沒了；SVG 是向量，
 *    本來就不佔解碼記憶體，轉成點陣反而變糊。
 */

const { TFile } = require('obsidian');

const THUMB_MAX = 640;              // 縮圖長邊上限（px）。卡片最寬約 300，2 倍給高 DPI 螢幕用
const THUMB_QUALITY = 0.82;         // JPEG 品質：0.82 在卡片尺寸下肉眼無差，檔案又夠小
const SKIP_UNDER_BYTES = 200 * 1024; // 小於此大小的圖不處理（省下來的不值得一次解碼＋寫檔）
const SKIP_EXT = /\.(gif|svg)$/i;    // GIF 會失去動畫、SVG 是向量，都不轉
const IS_IMG = /\.(png|jpe?g|webp|bmp|avif)$/i;

function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

class ThumbCache {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.index = {};          // path → [檔名, mtime]
    this.queue = [];          // 待處理：{ file, cbs: [] }
    this.pending = new Map(); // path → 佇列項目（避免同一張排兩次）
    this.busy = 0;
    this.failed = new Set();  // 失敗過的路徑：本次工作階段不再重試，免得無限重排
    this._saveT = 0;
    // 手機記憶體更緊，一次只做一張；桌機 2 張仍遠低於「全部一起解碼」
    this.concurrency = document.body.classList.contains('is-mobile') ? 1 : 2;
  }

  dir() { return this.plugin.manifest.dir + '/thumb-cache'; }
  indexPath() { return this.dir() + '/index.json'; }

  async load() {
    try {
      const a = this.app.vault.adapter;
      if (await a.exists(this.indexPath())) {
        this.index = JSON.parse(await a.read(this.indexPath())) || {};
      }
    } catch (e) { this.index = {}; }
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(async () => {
      try {
        const a = this.app.vault.adapter;
        if (!(await a.exists(this.dir()))) await a.mkdir(this.dir());
        await a.write(this.indexPath(), JSON.stringify(this.index));
      } catch (e) {}
    }, 1500);
  }

  /* 這張圖不值得（或不能）做縮圖 → 呼叫端直接用原圖 */
  shouldSkip(file) {
    if (!(file instanceof TFile)) return true;
    if (SKIP_EXT.test(file.path)) return true;
    if (!IS_IMG.test(file.path)) return true;
    if ((file.stat.size || 0) < SKIP_UNDER_BYTES) return true;
    return false;
  }

  /* 已有可用縮圖 → 回傳資源路徑；沒有 → null。
     mtime 不符代表原圖被換過，視為沒有（會重做）。 */
  urlFor(file) {
    const rec = this.index[file.path];
    if (!rec || rec[1] !== file.stat.mtime) return null;
    return this.app.vault.adapter.getResourcePath(this.dir() + '/' + rec[0]);
  }

  /* 請求縮圖。done(resourceUrl) 會在縮圖可用時被呼叫（可能是同步的既有快取）。
     失敗則 done(null)，呼叫端自行決定要不要退回原圖。 */
  request(file, done) {
    const have = this.urlFor(file);
    if (have) { done(have); return; }
    if (this.failed.has(file.path)) { done(null); return; }

    const exist = this.pending.get(file.path);
    if (exist) { exist.cbs.push(done); return; }

    const item = { file, cbs: [done] };
    this.pending.set(file.path, item);
    this.queue.push(item);
    this._pump();
  }

  /* 切換資料夾時把還沒開工的項目丟掉——使用者已經捲走了，
     繼續做只會排擠新畫面的縮圖。已經在做的那 1–2 張讓它做完（無法中斷解碼）。 */
  dropPending() {
    for (const item of this.queue) this.pending.delete(item.file.path);
    this.queue.length = 0;
  }

  /* 單張取消：虛擬牆把卡片卸載時呼叫（使用者已經捲過去了）。
     只丟「還沒開工」的項目；已經在解碼的無法中斷，讓它做完（結果仍會進快取，不浪費）。 */
  cancel(path) {
    const i = this.queue.findIndex((it) => it.file.path === path);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.pending.delete(path);
  }

  _pump() {
    while (this.busy < this.concurrency && this.queue.length) {
      /* LIFO（pop 而非 shift）：最後排進來的＝使用者剛捲到的那一屏。
         FIFO 會先做早就捲過去、現在根本看不到的卡片，可視區反而一直等。
         （被壓在底下的舊項目仍會做完，只是排在後面。） */
      const item = this.queue.pop();
      this.busy++;
      this._make(item.file)
        .then((url) => { for (const cb of item.cbs) { try { cb(url); } catch (e) {} } })
        .catch(() => { for (const cb of item.cbs) { try { cb(null); } catch (e) {} } })
        .then(() => {
          this.busy--;
          this.pending.delete(item.file.path);
          this._pump();
        });
    }
  }

  async _make(file) {
    const a = this.app.vault.adapter;
    let bmp = null;
    try {
      const buf = await this.app.vault.readBinary(file);
      const blob = new Blob([buf]);

      /* 長寬比索引（dims.js 已經在背景補齊）先查一次：
         知道原圖尺寸就能在**解碼時**直接指定輸出大小，
         省掉「先解成完整點陣圖再縮」這一步——6000×4000 的原圖光那一步就要 ~96MB，
         桌機併發 2 張＝峰值近 200MB，正是 iOS 被系統砍掉的那個峰值。
         查不到尺寸才退回原本的「先解一次看多大」。 */
      const known = (this.plugin._dimIndex || {})[file.path];
      const kw = known && known[0] > 0 ? known[0] : 0;
      const kh = known && known[1] > 0 ? known[1] : 0;

      if (kw && kh && Math.max(kw, kh) <= THUMB_MAX) {
        // 索引就知道夠小了 → 連解碼都不用做
        this.failed.add(file.path);
        return null;
      }

      /* ⚠️ 只在「索引說長邊 ≥ 2×THUMB_MAX」時才走 resize 解碼。
         索引可能過期（同路徑換成另一張圖，長寬比要等下次載入才校正）；
         若索引誤報成大圖而實際很小，resizeWidth 會把它**放大**成糊掉的縮圖，
         而且會一直留在縮圖快取裡。留 2 倍的安全邊界：
         真正吃記憶體的是幾千像素的原圖，640~1280 那段解碼成本本來就不高。 */
      const trustDims = kw && kh && Math.max(kw, kh) >= THUMB_MAX * 2;
      if (trustDims) {
        // 只給一邊，另一邊由瀏覽器等比推算（給兩邊會在尺寸有出入時被拉變形）
        const opts = kw >= kh
          ? { resizeWidth: THUMB_MAX, resizeQuality: 'high' }
          : { resizeHeight: THUMB_MAX, resizeQuality: 'high' };
        bmp = await createImageBitmap(blob, opts);
      } else {
        /* 先不縮放解碼一次，才知道原圖多大。
           不能無條件用 resizeWidth：原圖比 THUMB_MAX 小的話會被**放大**，
           檔案變大、畫質變糊，兩頭空。 */
        bmp = await createImageBitmap(blob);
      }
      const iw = bmp.width, ih = bmp.height;
      if (!iw || !ih) throw new Error('bad bitmap');

      // 已經夠小 → 不值得存一份幾乎一樣大的副本，登記跳過即可
      // （走 resize 解碼時 bmp 本來就是 640，不能拿來當「原圖很小」的判斷）
      if (Math.max(iw, ih) <= THUMB_MAX && !trustDims) {
        bmp.close();
        bmp = null;
        this.failed.add(file.path);   // 「不需要縮圖」與「做不出來」對呼叫端是同一件事：用原圖
        return null;
      }

      // 走 resize 解碼時 bmp 已經是目標大小，scale 會是 1
      const scale = Math.min(1, THUMB_MAX / Math.max(iw, ih));
      const tw = Math.max(1, Math.round(iw * scale));
      const th = Math.max(1, Math.round(ih * scale));

      const canvas = document.createElement('canvas');
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, tw, th);
      bmp.close();
      bmp = null;

      const outBlob = await new Promise((res) =>
        canvas.toBlob(res, 'image/jpeg', THUMB_QUALITY));
      // 畫完立刻把 backing store 歸零，不等 GC（大 canvas 是 tw*th*4 bytes）
      canvas.width = 0; canvas.height = 0;
      if (!outBlob) throw new Error('toBlob failed');

      const bytes = await outBlob.arrayBuffer();
      const fname = hash32(file.path) + '.jpg';
      if (!(await a.exists(this.dir()))) await a.mkdir(this.dir());
      await a.writeBinary(this.dir() + '/' + fname, bytes);

      this.index[file.path] = [fname, file.stat.mtime];
      this.save();
      return a.getResourcePath(this.dir() + '/' + fname);
    } catch (e) {
      this.failed.add(file.path);   // 本階段不再重試（避免每次重繪都重新解碼一次壞檔）
      return null;
    } finally {
      if (bmp) { try { bmp.close(); } catch (e) {} }
    }
  }

  /* 原圖已刪除的縮圖清掉。手動觸發（設定頁），不自動跑。 */
  async prune() {
    const a = this.app.vault.adapter;
    let removed = 0;
    for (const p of Object.keys(this.index)) {
      if (this.app.vault.getAbstractFileByPath(p)) continue;
      try { await a.remove(this.dir() + '/' + this.index[p][0]); } catch (e) {}
      delete this.index[p];
      removed++;
    }
    if (removed) this.save();
    return removed;
  }
}

module.exports = { ThumbCache, THUMB_MAX };
