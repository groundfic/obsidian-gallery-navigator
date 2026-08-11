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

/* 定位是否可以用獨立的 translate 屬性（見 _update 的說明）。
   偵測一次就好，不必每次寫入都問。 */
const VW_HAS_TRANSLATE = (() => {
  try { return !!(window.CSS && CSS.supports && CSS.supports('translate', '1px 1px')); }
  catch (e) { return false; }
})();

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
    this.kindOf = o.kindOf || null;   // 把卡片分類，讓「版型固定開銷」分開學（見 _resetCorrection）
    this.isSettled = o.isSettled || null;   // 卡片內容是否已定案（圖片載完）——見 measure()
    this.onMeasured = o.onMeasured || null; // 量到定案高度時回報（呼叫端可持久化，見 measure()）
    this._kindCache = [];
    this._lastScrollTop = 0;
    this._settleT = 0;

    this.items = [];
    this.h = [];          // 每項高度
    this.measured = [];   // 是否已量測過真值
    this.top = [];
    this.left = [];
    this.maxBot = null;   // _pack() 建；長度對不上時 _update 會退回全掃描
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
    this._kindCache = [];
    // 換一批資料 → 高度從頭算起，不能沿用上一批的已寫入值（否則第一次寫會被當成「縮小」而延後）
    clearTimeout(this._hT);
    this._writtenH = undefined;
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

    if (!this.items.length) { this._writeHeight(0); return; }

    /* ⚠️ 寬度暫時量到 0（面板被隱藏、切分頁、版面動畫中、側欄收合…）→ **什麼都不要做**。

       舊寫法在這裡直接 `grid.style.height = '0px'`，那是這整個「捲軸一直跳」
       問題的真兇：
         • 高度歸零後容器不再撐開，scrollHeight 改由「目前掛載的那十幾張
           絕對定位卡片」決定（絕對定位子元素仍計入捲動溢出區）
         • 而卡片隨捲動不斷掛載/卸載 → 最下緣一直變 → scrollHeight 一直變
           → 捲軸拇指狂跳
         • 實測 8 秒內 grid 高度在 50174 ↔ 0 之間翻了 4 次，
           連帶 scrollHeight 變動 90 次
         • 它還是直接寫 style.height、繞過 _writeHeight，
           導致 _writtenH 失準，後續的「只單向成長」判斷全部失效

       寬度為 0 只是暫時狀態，保留既有高度即可；等寬度恢復，
       ResizeObserver 會再叫一次 relayout。 */
    if (!W) return;
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

  /* ── 高度預測：學一次開銷，之後用算的，不要每張都量 ──

     ⚠️ 這是「捲軸拇指一直跳」的根治點，改動前務必讀懂。

     捲軸拇指的大小與位置＝視窗高 ÷ 內容總高。只要總高一直被修正，
     拇指就一直在變 —— 即使內容本身（有捲動錨定）完全沒有位移。
     所以光是「錨定」不夠，必須讓**總高度盡快停止變動**。

     關鍵觀察：圖片卡的高度其實是可以算出來的。
     img 是 width:100% / height:auto / display:block，
     所以圖片高度嚴格等於「欄寬 × 長寬比」；卡片其餘部分（邊框、內距、
     標題、日期）對同一種版型是**固定的常數**。
     也就是說我們不需要量每一張卡，只要量幾張、把那個常數學起來，
     其他全部用算的 —— 總高度一開始就正確，之後不再變動。

     做法：
       • kindOf(item) 把卡片分類（有長寬比的圖片卡 / 未知長寬比 / 純文字…）
       • 每一類各自累積「實測 − 算式基準」的平均值，就是該類的開銷常數
       • 預測與實測差在容差內 → **採信預測**，不改高度、不重排
         （容差取 6px，小於欄距 16px，不會造成重疊或明顯縫隙）

     這樣一來，走過幾張卡之後預測就幾乎都命中，重排停止，拇指也就不動了。 */
  _resetCorrection() {
    this._oh = new Map();   // kind → { sum, n, mean }
    this._rawEst = [];
  }

  _kind(i) {
    if (!this.kindOf) return '*';
    const k = this._kindCache[i];
    if (k !== undefined) return k;
    return (this._kindCache[i] = this.kindOf(this.items[i]) || '*');
  }

  _baseFor(i) {
    let raw = this._rawEst[i];
    if (raw === undefined) {
      raw = Math.max(1, this.estimate(this.items[i], this.colW));
      this._rawEst[i] = raw;
    }
    return raw;
  }

  _estimateFor(i) {
    const oh = this._oh.get(this._kind(i));
    return Math.max(1, Math.round(this._baseFor(i) + (oh ? oh.mean : 0)));
  }

  /* 把一次實測餵給該類別的開銷常數。
     用移動平均而非只取第一張：標題長度會讓文字卡有些微差異，平均比較穩。 */
  _learn(i, measuredH) {
    const k = this._kind(i);
    let oh = this._oh.get(k);
    if (!oh) { oh = { sum: 0, n: 0, mean: 0 }; this._oh.set(k, oh); }
    if (oh.n >= 40) return;          // 夠穩了就不再更新，避免常數一直微幅漂移
    oh.sum += measuredH - this._baseFor(i);
    oh.n++;
    oh.mean = oh.sum / oh.n;
  }

  /* 貪婪法：每張卡放進目前最矮的那一欄（與 MasonryLayout 相同，但純算術、不碰 DOM） */
  _pack() {
    const colH = new Array(this.cols).fill(0);
    const n = this.items.length;
    // maxBot[i] = 前 i 張裡最深的底部。單調遞增 → _update 可以二分找視窗起點。
    const maxBot = new Array(n);
    let mb = -Infinity;
    for (let i = 0; i < n; i++) {
      let c = 0;
      for (let k = 1; k < this.cols; k++) if (colH[k] < colH[c]) c = k;
      this.left[i] = c * (this.colW + this.gap);
      this.top[i] = colH[c];
      colH[c] += this.h[i] + this.gap;
      if (this.top[i] + this.h[i] > mb) mb = this.top[i] + this.h[i];
      maxBot[i] = mb;
    }
    this.maxBot = maxBot;
    this.totalH = Math.max.apply(null, colH);
    this._applyHeight(this.totalH);
  }

  /* ── 容器高度的寫入時機（捲軸拇指穩定的最後一哩）──

     即使卡片位置完全正確、內容也有錨定不會位移，只要 grid 的高度一直被改，
     捲軸拇指就會一直變大變小 —— 使用者看到的就是「滑桿在跳」。

     高度變動有兩個方向，性質完全不同：
       • **變高**：必須立刻寫。不寫的話捲不到最後幾張卡（捲動範圍不夠）。
       • **變矮**：可以延後。這純粹是估計值收斂，晚幾百毫秒寫沒有任何副作用。

     所以規則是「只單向即時成長，縮小等安靜下來再一次到位」。
     捲動過程中拇指只會單調地小幅變化，不會來回抖；手一停就收斂到精確值。 */
  _applyHeight(h) {
    const cur = this._writtenH;
    if (cur === undefined || h > cur) { this._writeHeight(h); return; }
    if (cur - h < 1) return;                       // 差不到 1px，不值得動
    clearTimeout(this._hT);
    this._hT = setTimeout(() => this._writeHeight(this.totalH), 200);
  }

  _writeHeight(h) {
    clearTimeout(this._hT);
    if (this._destroyed) return;
    this._writtenH = h;
    this.grid.style.height = Math.round(h) + 'px';
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
    const st = this.scroller.scrollTop;
    const jump = Math.abs(st - this._lastScrollTop);
    this._lastScrollTop = st;

    // 上下各留一屏當緩衝：快速捲動時來得及補上，不會看到空白
    const from = st - this.gridTop - viewH;
    const to = st - this.gridTop + viewH * 2;

    /* 視窗範圍：以前每一幀都掃過全部項目（4000 檔＝每幀 4000 次比較）。
       改成二分找起點、掃到超出視窗就停 —— 實測掃描量 4000 → 約 22 張。

       兩個成立條件（_pack 保證，已用亂數對照測試驗證 1/2/3/5/8 欄 × 2000 組視窗）：
         ① top[] 單調遞增：貪婪法每張都放進「目前最矮的欄」，
            所以 min(colH) 只會變大，不會變小。→ 可以「看到 top > to 就 break」。
         ② maxBot[i] = max(top[k]+h[k], k ≤ i)，本身也是單調遞增。
            對它二分找「第一個 maxBot >= from」＝ 第一個可能與視窗相交的項目。
       ⚠️ 起點**不能**用 top 二分後往回走幾格：一張很高的卡可能落在很前面、
          底部卻延伸進視窗，中間隔著一堆矮卡 —— 往回走會提早停下而漏掉它。
          （這個 bug 就是被上面那組對照測試抓出來的。） */
    const n = this.items.length;
    const mb = this.maxBot;
    let lo = 0;
    if (mb && mb.length === n) {
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (mb[mid] < from) lo = mid + 1; else hi = mid;
      }
    }
    const want = new Set();
    for (let i = lo; i < n; i++) {
      if (this.top[i] > to) break;
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
    /* 進入視窗 → 建立。
       ⚠️ 但「拖捲軸拖很快」時先不要建。
          一次 create 要蓋出整張卡（DOM、右鍵選單、各種監聽器），一屏約 40–50 張；
          拖曳時每一幀都掃過一整個新視窗，等於每幀蓋掉再重蓋五十張卡，
          主執行緒被吃滿 → 捲軸拖不動、跟不上游標。
          飛過去的畫面本來也看不清楚，先留白，手一慢下來（_scheduleSettle）再補。 */
    const flinging = jump > viewH * 2.5;
    let created = false;
    if (flinging) {
      this._scheduleSettle();
    } else {
      for (const i of want) {
        if (this.mounted.has(i)) continue;
        const el = this.create(this.items[i], i);
        if (!el) continue;
        this.mounted.set(i, el);
        created = true;
      }
    }
    /* 定位（含既有的：高度校正後位置會改變）。
       位置沒變就不要重寫 —— 寫入同樣的值一樣會讓樣式失效，
       而這段在捲動時每一幀都會跑過所有掛載中的卡片。 */
    for (const [i, el] of this.mounted) {
      const l = this.left[i], t = this.top[i], w = this.colW;
      /* 次像素級的差異不重寫：translate 寫入會讓合成層失效，
         而這段在捲動時每一幀都會跑過所有掛載中的卡片。
         （之前用嚴格相等，0.01px 的差也會整批重寫。） */
      if (el._vwW === w && Math.abs(el._vwL - l) < 0.5 && Math.abs(el._vwT - t) < 0.5) continue;
      el.style.position = 'absolute';
      // 寬度只有真的變了才寫（換欄數時才會變）
      if (el._vwW !== w) el.style.width = w + 'px';
      /* 定位用 translate 而不是 left/top：
           • left/top 是版面屬性 → 每次重排都讓整個 grid 重新排版
           • translate 只影響合成階段
         ⚠️ 用「translate 這個獨立屬性」而不是 transform：
            .gn-card:hover 有 transform: scale()，若定位也寫在 transform 上，
            hover 那一刻會整個蓋掉位移 → 卡片瞬間跳回 grid 原點。
            translate 與 transform 是兩個屬性，可以同時存在、互相疊加。
         舊瀏覽器沒有 translate 屬性時退回 left/top（行為與改版前相同）。 */
      if (VW_HAS_TRANSLATE) {
        el.style.translate = l + 'px ' + t + 'px';
      } else {
        el.style.left = l + 'px';
        el.style.top = t + 'px';
      }
      el._vwL = l; el._vwT = t; el._vwW = w;
      /* 定位完成才讓卡片現身（2026-08-10）。
         沒有這個標記的話，卡片在建立到第一次定位之間會全部疊在容器原點，
         畫面上會閃一下「一疊卡片」。CSS：.gn-card-in 未 placed 時 visibility: hidden。 */
      el.classList.add('gn-placed');
    }
    if (created) this._scheduleMeasure();
  }

  /* 快速拖曳期間略過建立卡片，手一慢下來就補畫。
     60ms：比一幀長、比人察覺得到的停頓短。 */
  _scheduleSettle() {
    clearTimeout(this._settleT);
    this._settleT = setTimeout(() => { this._settleT = 0; this._update(); }, 60);
  }

  /* 量測去抖：每張圖 onload 都會叫一次，而 measure() 是掃過所有掛載中的卡片。
     一屏四五十張圖陸續回來 ＝ 連續幾十次全量量測。改成 50ms 的 trailing 去抖，
     一批圖載入完只量一次。
     ⚠️ 是 trailing（每次呼叫都往後推），不是 leading —— 要的是「安靜下來才量」。 */
  _scheduleMeasure() {
    clearTimeout(this._measureT);
    this._measureT = setTimeout(() => {
      this._measureT = 0;
      if (this._measureRaf) return;
      this._measureRaf = requestAnimationFrame(() => { this._measureRaf = 0; this.measure(); });
    }, 50);
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
    const els = idx.map((i) => this.mounted.get(i));
    const hs = els.map((el) => el.offsetHeight);                       // 讀（一次讀完）
    const ok = els.map((el, k) => !this.isSettled || this.isSettled(el, this.items[idx[k]]));

    this._syncGridTop();   // 挑錨點要用到，且這裡本來就要動版面

    /* ⚠️ 使用者正在捲動時**不要**錨定。
       錨定的做法是改 scrollTop，而拖曳捲軸時瀏覽器每一次 pointermove 都會依
       游標位置重新設定 scrollTop —— 兩邊互相覆蓋，結果就是「拖不動 / 一直被拉回」。
       錨定真正需要發揮作用的時機是「使用者停著不動、內容自己在收斂」，
       捲動中本來就在移動，幾像素的位移看不出來。 */
    const moving = Math.abs(this.scroller.scrollTop - this._lastScrollTop) > 1;
    const anchor = moving ? -1 : this._pickAnchor();
    const anchorBefore = anchor >= 0 ? this.top[anchor] : 0;

    const TOL = 6;   // 容差：必須小於欄距（16px），否則會出現重疊
    let changed = false;
    let learned = false;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], hv = hs[k];
      if (!hv) continue;                       // 完全沒高度 → 留著預測值

      /* ⚠️ 內容還沒定案（圖片仍在載入 / 縮圖還在產生）就**不能**採信這個高度。
         此時量到的是佔位高度（4:3），不是真正的圖片高度。
         之前沒擋這一關，導致：
           • h[i] 被寫成佔位高度 → 總高度整個塌陷 → 捲軸拇指變得很長
           • 更糟的是這個值還被 _learn() 學進「版型固定開銷」，
             實測 −141px 的常數，把所有尚未量測的卡片也一起壓扁
           • 圖片陸續載入後高度才長回來 → 拇指再變短
         這就是「一開始很長再變很短」的成因。 */
      if (!ok[k]) continue;

      if (this.measured[i] && Math.abs(this.h[i] - hv) < 0.5) continue;

      if (!this.measured[i]) {
        const ohBefore = (this._oh.get(this._kind(i)) || {}).mean || 0;
        this._learn(i, hv);
        const ohAfter = (this._oh.get(this._kind(i)) || {}).mean || 0;
        /* ⚠️ 容差不可省。移動平均每吸收一張卡就一定會變（哪怕 0.01px），
           用嚴格不等於的話，捲動中每量測到一張新卡就會觸發下面那段全域重算
           → _pack() → 所有卡片的 translate 全部重寫 → 畫面上就是「整片卡片
           在重新對位」。這與卡片是圖片卡或文字卡無關，是系統性的抖動來源。
           0.5px 遠低於單張卡的視覺可辨差異，卻能擋掉絕大多數無意義的重排。 */
        if (Math.abs(ohAfter - ohBefore) > 0.5) learned = true;
      }
      this.measured[i] = true;

      /* 把實測值回報給呼叫端存起來（跨工作階段沿用）。
         注意要放在 TOL 判斷**之前**：預測命中時 hv 一樣是有效的實測值，
         那才是最該被記下來的「已經對了」的高度。
         此處已通過 ok[k]（內容定案）檢查，不會記到骨架高度。 */
      if (this.onMeasured) {
        try { this.onMeasured(this.items[i], hv, this.colW); } catch (e) {}
      }

      /* 預測夠準 → **採信預測**，不動高度也不重排。
         這是讓總高度停止變動的關鍵：只要預測命中，重排就不會發生。 */
      if (Math.abs(this.h[i] - hv) <= TOL) continue;

      this.h[i] = hv;
      changed = true;
    }

    /* 開銷常數有更新 → 還沒量測的項目要跟著重算。
       只在常數真的變了才做，常數收斂後這裡就不再觸發。 */
    if (learned) {
      for (let i = 0; i < this.items.length; i++) {
        if (this.measured[i]) continue;
        const next = this._estimateFor(i);
        // 同樣要容差：差 1px 就整批改寫等於每次都重排（見上方 _learn 的說明）
        if (Math.abs(next - this.h[i]) >= 1) { this.h[i] = next; changed = true; }
      }
    }
    if (!changed) return;

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

  /* 外部補齊了長寬比（DimPrefetcher）→ 丟掉快取的估計基準、重算尚未量測的項目。
     ⚠️ 一定要清 _rawEst：那是「每一項的算式基準」的快取，
        不清的話新拿到的長寬比根本不會被用上，白補。 */
  invalidateEstimates() {
    this._rawEst = [];
    this._kindCache = [];
    let changed = false;
    for (let i = 0; i < this.items.length; i++) {
      if (this.measured[i]) continue;          // 已經量到真值的不動
      const next = this._estimateFor(i);
      if (next !== this.h[i]) { this.h[i] = next; changed = true; }
    }
    if (!changed) return;
    this._syncGridTop();
    const anchor = Math.abs(this.scroller.scrollTop - this._lastScrollTop) > 1 ? -1 : this._pickAnchor();
    const before = anchor >= 0 ? this.top[anchor] : 0;
    this._pack();
    if (anchor >= 0) {
      const d = this.top[anchor] - before;
      if (d) this.scroller.scrollTop += d;
    }
    this._update();
  }

  unmountAll() {
    for (const [i, el] of this.mounted) {
      try { this.destroy(el, this.items[i], i); } catch (e) {}
      el.remove();
    }
    this.mounted.clear();
  }

  destroyAll() {
    this._destroyed = true;
    this.scroller.removeEventListener('scroll', this._onScroll);
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._measureRaf) cancelAnimationFrame(this._measureRaf);
    clearTimeout(this._measureT);      // 去抖中的量測
    clearTimeout(this._hT);            // 延後中的高度寫入
    clearTimeout(this._settleT);       // 快速拖曳後的補畫
    this.unmountAll();
  }
}

module.exports = { VirtualWall };
