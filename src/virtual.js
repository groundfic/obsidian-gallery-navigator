'use strict';

/* ===== 虛擬化瀑布流（2026-08-04）=====
 *
 * 問題：原本的分批渲染「只加不減」——捲到第 5000 張時，前面 4900 張看不見的卡片
 *   仍然全部留在 DOM 裡。5000 張圖約 2.5–4 萬個節點、3 萬個事件監聽器，
 *   而且 MasonryLayout.layout() 是 O(全部卡片)，於是每張新圖載入都要重排五千張。
 *
 * 做法：只保留「視窗上下各一屏」範圍內的卡片，其餘拆掉。
 *   捲動時比對新舊視窗：離開的卸載、進入的建立。
 *   DOM 節點數與資料夾大小脫鉤，永遠維持在一兩百張。
 *
 * ⚠️ 瀑布流虛擬化比一般清單難，難在**位置依賴高度**：
 *   一般清單每列等高，第 N 項的 y 用乘法就算得出來；瀑布流每張卡高度不同，
 *   而「還沒建出來的卡」量不到高度。
 *
 *   解法是「估計 + 漸進校正」：
 *     1. 先用長寬比索引（dims.json）估高度 —— 欄寬 ÷ 長寬比 + 文字區高度。
 *     2. 卡片真的被建出來時量一次 offsetHeight，寫回高度表。
 *     3. 高度有變 → 重算版面 → 重新定位目前掛載中的卡片。
 *
 *   第一次瀏覽某資料夾時估計值可能不準，捲動會有輕微跳動；
 *   之後長寬比都進了索引，估計就相當準了。這也是為什麼
 *   「長寬比索引」必須先做，虛擬化才成立。
 *
 * ⚠️ 卸載卡片時**必須**同步清掉外部持有的參照（gallery.js 的 _cardEls），
 *    否則會留下一堆指向已移除節點的殭屍陣列，選取／捲動定位都會出錯。
 *    這件事透過 destroy callback 交給呼叫端做。
 */

class VirtualWall {
  /**
   * @param {object} o
   *   scroller  捲動容器（.gn-main）
   *   grid      卡片容器（position: relative）
   *   gap/minCol/fixedCols  與 MasonryLayout 相同語意
   *   create(item, index) -> HTMLElement   建立卡片（呼叫端負責 append 進 grid）
   *   destroy(el, item, index)             卸載卡片前的清理
   *   estimate(item, colW) -> number       未量測前的高度估計
   */
  constructor(o) {
    this.scroller = o.scroller;
    this.grid = o.grid;
    this.gap = o.gap || 10;
    this.minCol = o.minCol || 150;
    this.fixedCols = o.fixedCols || 0;
    this.create = o.create;
    this.destroy = o.destroy;
    this.estimate = o.estimate;

    this.items = [];
    this.h = [];          // 每項高度
    this.measured = [];   // 是否已量測過真值
    this.top = [];
    this.left = [];
    this.mounted = new Map();   // index → el

    this.colW = 0;
    this.cols = 0;
    this.gridTop = 0;     // grid 在 scroller 內容座標系裡的頂端
    this._raf = 0;
    this._measureRaf = 0;
    this._destroyed = false;
    this._resetCorrection();

    this._onScroll = () => this._schedule();
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });

    this._ro = new ResizeObserver(() => {
      // 寬度變了才需要整個重算（高度變化由捲動處理）
      if (this.grid.clientWidth !== this._lastW) this.relayout();
    });
    this._ro.observe(this.grid);
  }

  setItems(items) {
    this.unmountAll();
    this._resetCorrection();
    this.items = items || [];
    this.h = new Array(this.items.length).fill(0);
    this.measured = new Array(this.items.length).fill(false);
    this.top = new Array(this.items.length).fill(0);
    this.left = new Array(this.items.length).fill(0);
    this.relayout();
  }

  /* 重算欄寬 → 重估未量測項 → 排版 → 更新視窗 */
  relayout() {
    if (this._destroyed) return;
    const W = this.grid.clientWidth;
    if (!W || !this.items.length) {
      this.grid.style.height = '0px';
      return;
    }
    const widthChanged = W !== this._lastW;
    this._lastW = W;
    this.cols = this.fixedCols || Math.max(1, Math.floor((W + this.gap) / (this.minCol + this.gap)));
    this.colW = (W - this.gap * (this.cols - 1)) / this.cols;

    /* 欄寬變了，已量測的高度也失效（圖片會跟著縮放）——全部退回估計值。
       不這麼做的話，轉螢幕或拖分隔桿之後版面會整個錯位。 */
    if (widthChanged) { this.measured.fill(false); this._resetCorrection(); }
    for (let i = 0; i < this.items.length; i++) {
      if (!this.measured[i]) this.h[i] = this._estimateFor(i);
    }
    this._pack();
    this._syncGridTop();
    this._update();
  }

  /* ── 估計值的自我校正 ──
     估計高度只考慮圖片本身（欄寬 ÷ 長寬比），但實際卡片還有邊框、內距、
     標題與日期。少算的那一截對每張卡大致相同，於是**每一張都被低估**，
     總高度持續被往上修 → 捲軸拇指不停變大 → 看起來就是「一直跳」。
     這裡從已量測的卡片學出「實測 ÷ 估計」的平均倍率，套回還沒量的項目，
     讓估計一開始就接近真值，校正幅度自然變小。 */
  _resetCorrection() { this._corrSum = 0; this._corrN = 0; this._corr = 1; this._rawEst = []; }

  _estimateFor(i) {
    let raw = this._rawEst[i];
    if (raw === undefined) {
      raw = Math.max(1, this.estimate(this.items[i], this.colW));
      this._rawEst[i] = raw;
    }
    return Math.max(1, raw * (this._corr || 1));
  }

  /* 貪婪法：每張卡放進目前最矮的那一欄（與 MasonryLayout 相同，但純算術、不碰 DOM） */
  _pack() {
    const colH = new Array(this.cols).fill(0);
    for (let i = 0; i < this.items.length; i++) {
      let c = 0;
      for (let k = 1; k < this.cols; k++) if (colH[k] < colH[c]) c = k;
      this.left[i] = c * (this.colW + this.gap);
      this.top[i] = colH[c];
      colH[c] += this.h[i] + this.gap;
    }
    this.totalH = Math.max.apply(null, colH);
    this.grid.style.height = this.totalH + 'px';
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._update(); });
  }

  /* grid 在 scroller 內容座標中的位置。只在排版時重算，捲動時不重讀（省一次強制 layout）。 */
  _syncGridTop() {
    const gr = this.grid.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    this.gridTop = gr.top - sr.top + this.scroller.scrollTop;
  }

  _update() {
    if (this._destroyed || !this.items.length) return;
    /* ⚠️ 這裡**不**重算 gridTop。它是「內容座標」——捲動並不會改變它，
       但 getBoundingClientRect() 每次都會強制一次版面計算，而 _update 是
       捲動路徑上每一幀都會跑的。改在 relayout() / measure() 這種真的會
       改變版面的時機才同步。 */
    const viewH = this.scroller.clientHeight || 800;
    // 上下各留一屏當緩衝：快速捲動時來得及補上，不會看到空白
    const from = this.scroller.scrollTop - this.gridTop - viewH;
    const to = this.scroller.scrollTop - this.gridTop + viewH * 2;

    const want = new Set();
    for (let i = 0; i < this.items.length; i++) {
      if (this.top[i] > to) continue;
      if (this.top[i] + this.h[i] < from) continue;
      want.add(i);
    }

    // 離開視窗 → 卸載
    for (const [i, el] of [...this.mounted]) {
      if (want.has(i)) continue;
      try { this.destroy(el, this.items[i], i); } catch (e) {}
      el.remove();
      this.mounted.delete(i);
    }
    // 進入視窗 → 建立
    let created = false;
    for (const i of want) {
      if (this.mounted.has(i)) continue;
      const el = this.create(this.items[i], i);
      if (!el) continue;
      this.mounted.set(i, el);
      created = true;
    }
    /* 定位（含既有的：高度校正後位置會改變）。
       位置沒變就不要重寫 —— 寫入同樣的值一樣會讓樣式失效，
       而這段在捲動時每一幀都會跑過所有掛載中的卡片。 */
    for (const [i, el] of this.mounted) {
      const l = this.left[i], t = this.top[i], w = this.colW;
      if (el._vwL === l && el._vwT === t && el._vwW === w) continue;
      el._vwL = l; el._vwT = t; el._vwW = w;
      el.style.position = 'absolute';
      el.style.width = w + 'px';
      el.style.left = l + 'px';
      el.style.top = t + 'px';
    }
    if (created) this._scheduleMeasure();
  }

  _scheduleMeasure() {
    if (this._measureRaf) return;
    this._measureRaf = requestAnimationFrame(() => { this._measureRaf = 0; this.measure(); });
  }

  /* 找捲動錨點：目前視窗頂端**之上或之內**、位置最靠下的那一張已掛載卡片。
     重排後把它保持在原本的視覺位置，使用者才不會覺得內容在腳下滑動。
     回傳 -1 代表不需要錨定（已經捲到最頂端）。 */
  _pickAnchor() {
    const y = this.scroller.scrollTop - this.gridTop;
    if (y <= 0) return -1;
    let best = -1, bestTop = -Infinity;
    for (const i of this.mounted.keys()) {
      const t = this.top[i];
      if (t <= y && t > bestTop) { bestTop = t; best = i; }
    }
    return best;
  }

  /* 量測掛載中卡片的真實高度；有變動就重排並重新定位。

     ⚠️ 兩個關鍵，改動前請先讀懂：

     1. 先把所有 offsetHeight 讀完再寫，不要邊讀邊寫
        （否則每張卡都強制一次版面重算）。

     2. **一定要做捲動錨定**。重排會改變所有後續項目的位置與總高度；
        若使用者正停在中段，上方某張卡的高度被修正，下面所有東西就會
        整體位移 —— 畫面在手指底下滑走、捲軸拇指不停跳動。
        做法是記住錨點卡在重排前的位置，重排後把差值補進 scrollTop。 */
  measure() {
    if (this._destroyed || !this.mounted.size) return;
    const idx = [...this.mounted.keys()];
    const hs = idx.map((i) => this.mounted.get(i).offsetHeight);   // 讀（一次讀完）

    this._syncGridTop();   // 挑錨點要用到，且這裡本來就要動版面
    const anchor = this._pickAnchor();
    const anchorBefore = anchor >= 0 ? this.top[anchor] : 0;

    let changed = false;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], hv = hs[k];
      if (!hv) continue;                       // 還沒有內容（圖片沒載完）→ 留著估計值
      if (this.measured[i] && Math.abs(this.h[i] - hv) < 0.5) continue;
      // 第一次量到 → 拿來校正往後的估計倍率
      if (!this.measured[i]) {
        const raw = this._rawEst[i];
        if (raw > 0) {
          this._corrSum += hv / raw;
          this._corrN++;
          // 取樣夠多才啟用，且夾在合理範圍，避免少數極端卡片把估計帶歪
          if (this._corrN >= 8) this._corr = Math.min(3, Math.max(0.4, this._corrSum / this._corrN));
        }
      }
      this.h[i] = hv;
      this.measured[i] = true;
      changed = true;
    }
    if (!changed) return;

    // 未量測的項目沿用新的校正倍率，總高度才不會一路被往上修
    for (let i = 0; i < this.items.length; i++) {
      if (!this.measured[i]) this.h[i] = this._estimateFor(i);
    }

    this._pack();                              // 寫
    if (anchor >= 0) {
      const delta = this.top[anchor] - anchorBefore;
      if (delta) this.scroller.scrollTop += delta;   // 把錨點卡拉回原本的視覺位置
    }
    this._update();
  }

  /* 圖片載入完成之類的外部事件 → 重新量測（高度可能變了） */
  notifyContentChanged() { this._scheduleMeasure(); }

  // 縮放滑桿改了最小欄寬 → 欄數與欄寬都會變，等同一次完整重排
  setMinCol(w) { this.minCol = w; this._lastW = -1; this.relayout(); }

  unmountAll() {
    for (const [i, el] of this.mounted) {
      try { this.destroy(el, this.items[i], i); } catch (e) {}
      el.remove();
    }
    this.mounted.clear();
  }

  /* 讓某一項進入視窗（例如「定位到目前開啟的筆記」）。回傳該項的 top，找不到回 -1。 */
  topOf(index) {
    if (index < 0 || index >= this.items.length) return -1;
    return this.gridTop + this.top[index];
  }

  destroyAll() {
    this._destroyed = true;
    this.scroller.removeEventListener('scroll', this._onScroll);
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._measureRaf) cancelAnimationFrame(this._measureRaf);
    this.unmountAll();
  }
}

module.exports = { VirtualWall };
