'use strict';

/* ===== 長寬比預取（2026-08-04）=====
 *
 * 為什麼需要這支：
 *   卡片高度＝欄寬 × 長寬比（overlay 版型實測固定開銷只有 0.4px，見診斷指令），
 *   所以只要知道每張圖的長寬比，整個資料夾的總高度就能**在畫之前算準**，
 *   捲軸從第一幀就正確、之後完全不動。
 *
 *   但長寬比原本只在「卡片真的被掛上去、圖片真的載入完成」時才記錄。
 *   虛擬化一次只掛十幾張，於是 305 張的資料夾捲半天命中率也才 3% ——
 *   總高度永遠在收斂，捲軸就永遠在跳。
 *
 * 做法：開啟資料夾時，在背景把「還沒有長寬比」的項目補齊。
 *
 * ⚠️ 為什麼用脫離 DOM 的 Image 而不是自己解檔頭：
 *    看似「讀檔頭解析寬高」最省，但 Obsidian 的 adapter 沒有範圍讀取，
 *    readBinary 一律整檔讀進來 —— 305 張就是幾百 MB 的 I/O，反而更貴。
 *    脫離 DOM 且從未繪製的 <img>，瀏覽器不會配置完整點陣圖，
 *    naturalWidth/Height 拿完就把 src 清掉即可。
 *
 * ⚠️ 併發一定要壓住。這裡每一張都是真的在解圖，一次放太多就會重演
 *    「一次解碼幾十張原圖」的記憶體問題（thumbs.js 開頭那個坑）。
 */

const CONCURRENCY_DESKTOP = 4;
const CONCURRENCY_MOBILE = 2;
const BATCH_NOTIFY = 40;   // 每補齊這麼多筆就回報一次，讓版面漸進收斂而不是等到最後

class DimPrefetcher {
  constructor(plugin) {
    this.plugin = plugin;
    this.queue = [];
    this.busy = 0;
    this.token = 0;        // 換資料夾就 +1，舊的回呼一律作廢
    this.done = 0;
    this.onBatch = null;
  }

  /* items：[{ file, src }]；onBatch：補齊一批後的回呼（通常拿去重算版面） */
  start(items, onBatch) {
    this.cancel();
    const idx = this.plugin._dimIndex || (this.plugin._dimIndex = {});
    const want = [];
    for (const it of items || []) {
      if (!it || !it.src || !it.file) continue;
      const key = it.file.path;
      if (idx[key]) continue;                 // 已經知道了
      want.push({ key, src: it.src });
    }
    if (!want.length) return 0;

    // ⚠️ 先把數量存下來再開跑：this.queue 就是 want 這個陣列本身，
    //    _pump() 會 shift 掉元素，跑完之後 want.length 已經不是原本的量了。
    const total = want.length;
    this.queue = want;
    this.onBatch = onBatch || null;
    this.done = 0;
    const n = document.body.classList.contains('is-mobile') ? CONCURRENCY_MOBILE : CONCURRENCY_DESKTOP;
    for (let i = 0; i < n; i++) this._pump();
    return total;
  }

  cancel() {
    this.token++;
    this.queue = [];
    this.onBatch = null;
    this.busy = 0;
  }

  _pump() {
    if (!this.queue.length) {
      // 全部跑完 → 最後回報一次，讓版面用完整資訊重算
      if (this.busy === 0 && this.onBatch) { const cb = this.onBatch; this.onBatch = null; cb(true); }
      return;
    }
    const my = this.token;
    const job = this.queue.shift();
    this.busy++;

    const img = new Image();
    let settled = false;
    const finish = (w, h) => {
      if (settled) return;
      settled = true;
      img.onload = img.onerror = null;
      img.src = '';                            // 立刻放掉，不等 GC
      this.busy--;
      if (my !== this.token) return;           // 已經換資料夾了，這筆結果作廢
      if (w > 0 && h > 0) {
        (this.plugin._dimIndex || (this.plugin._dimIndex = {}))[job.key] = [w, h];
        this.plugin.saveDimIndex();
        this.done++;
        if (this.done % BATCH_NOTIFY === 0 && this.onBatch) this.onBatch(false);
      }
      this._pump();
    };

    img.onload = () => finish(img.naturalWidth, img.naturalHeight);
    // 失敗也要往下走，否則整條佇列會卡住（壞檔、權限、路徑失效都可能）
    img.onerror = () => finish(0, 0);
    img.decoding = 'async';
    img.src = job.src;
  }
}

module.exports = { DimPrefetcher };
