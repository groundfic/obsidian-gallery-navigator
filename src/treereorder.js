'use strict';

/* ===== 手機的資料夾拖移排序（2026-09-30）=====
 *
 * 桌機的排序走 HTML5 拖放（dragstart / dragover / drop），觸控裝置上這組事件不會發，
 * 所以手機一直沒辦法調整資料夾順序。這裡另外做一套給觸控用的：
 *
 *   長按選單 →「調整順序」→ 每列右側出現把手 → 按住把手上下拖 → 放開
 *
 * 為什麼是「進入模式＋把手」而不是「長按後直接拖」：
 *   • 長按已經是開選單的手勢，兩個搶同一個手勢一定有一邊難用。
 *   • 左欄本身要能上下捲。把手以外的地方維持捲動，只有把手吃拖曳，兩者不打架。
 *
 * 只做「同一層之內排序」。搬到別的資料夾另有「移動到…」，混在同一個手勢裡
 * 手指稍微偏一點就會搬錯地方。
 *
 * 落點的表達方式是「其他列讓出空位」，不是插入線：被拖的那列浮在手指底下，
 * 插入線正好會被它蓋住，看不到要插在哪；讓位的話空出來的那一格就是落點。
 *
 * 用 Pointer Events（滑鼠也會動，方便在桌機上測），不依賴 Obsidian API。
 * 落點的結果交給呼叫端（onDrop），這裡不碰任何狀態。
 */

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/* 手指在 y（內容座標）時，被拖的那列該插在「其他同層列」的第幾個位置（0 ＝最前面）。
   mids 是其他同層列在拖曳開始時的中線位置（由上到下）：手指越過誰的中線，就排到誰後面。
   一律用「開始時」的位置比，不看讓位之後的即時位置 —— 否則列一讓位、判定跟著變，
   會在兩個位置之間來回跳。 */
function slotIndex(y, mids) {
  let k = 0;
  while (k < mids.length && y >= mids[k]) k++;
  return k;
}

/**
 * 在把手上 pointerdown 時呼叫，開始一次拖曳。
 *   event    把手的 pointerdown 事件
 *   row      被拖的那一列（要有 data-path）
 *   scroller 左欄的捲動容器（拖到上下緣時自動捲）
 *   rows     () => 目前樹上所有資料夾列（依畫面順序）
 *   onDrop   (draggedPath, targetPath, 'before' | 'after') => void
 *            呼叫當下，所有列都還停在拖曳中的位置（被拖的在手指底下、其他的已讓位）。
 * 回傳 false ＝這一層只有它一個，沒有順序可調。
 */
function startReorderDrag({ event, row, scroller, rows, onDrop }) {
  const path = row.dataset.path;
  const parent = parentOf(path);
  const all = Array.from(rows());
  const sameLevel = all.filter((el) => parentOf(el.dataset.path) === parent);
  const origIdx = sameLevel.indexOf(row);
  const others = sameLevel.filter((el) => el !== row);
  if (origIdx < 0 || !others.length) return false;

  // 一個資料夾「那一組」＝它自己＋底下展開的子列，要一起動才不會被拆散
  const groupOf = (el) => {
    const p = el.dataset.path;
    return all.filter((x) => x === el || x.dataset.path.startsWith(p + '/'));
  };

  /* 起始版面，一次量完（內容座標＝相對捲動內容的頂端，不受之後捲動影響）。 */
  const box = scroller.getBoundingClientRect();
  const startScroll = scroller.scrollTop;
  const contentY = (clientY) => clientY - box.top + scroller.scrollTop;
  const group = groupOf(row);
  const gTop = group[0].getBoundingClientRect().top;
  const gBottom = group[group.length - 1].getBoundingClientRect().bottom;
  const groupH = gBottom - gTop;                       // 被拖那一組的總高度＝其他列要讓出的距離
  const slots = others.map((el, i) => {
    const r = el.getBoundingClientRect();
    return {
      el,
      rows: groupOf(el),
      mid: r.top - box.top + startScroll + r.height / 2,
      below: i >= origIdx,                             // 原本排在被拖那列的下面
      shift: 0,
    };
  });
  const mids = slots.map((s) => s.mid);

  const handle = event.currentTarget;
  const pid = event.pointerId;
  try { handle.setPointerCapture(pid); } catch (e) {}

  const startY = event.clientY;
  let y = startY, dirty = true, done = false, raf = 0;
  let k = origIdx;                                     // 目前的落點（在 others 裡的插入位置）

  for (const el of group) el.classList.add('gn-treorder-drag');
  scroller.classList.add('gn-treorder-active');

  /* 離上下緣多近開始自動捲、最快每秒捲幾 px（約每秒 10 列）。
     速度照「經過的時間」算而不是照幀數：120Hz 的螢幕一秒跑兩倍的幀，
     照幀數算就會捲兩倍快。 */
  const EDGE = 56, SPEED = 480;
  let lastT = 0;
  const frame = (now) => {
    if (done) return;
    const dt = lastT ? Math.min(now - lastT, 50) : 16;   // 分頁被卡住再回來時別一次跳太遠
    lastT = now;
    // 手指靠近上下緣 → 自動捲動，越靠邊越快
    let v = 0;
    if (y < box.top + EDGE) v = -SPEED * Math.min(1, (box.top + EDGE - y) / EDGE);
    else if (y > box.bottom - EDGE) v = SPEED * Math.min(1, (y - (box.bottom - EDGE)) / EDGE);
    if (v) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + v * dt / 1000;
      if (scroller.scrollTop !== before) dirty = true;
    }
    if (dirty) {
      dirty = false;
      // 被拖的那組跟著手指走（捲動量也要補進去，否則一自動捲它就離開手指）
      const dy = (y - startY) + (scroller.scrollTop - startScroll);
      for (const el of group) el.style.transform = 'translateY(' + dy + 'px)';
      // 其他列讓位：被越過的往反方向挪一組的高度，空出來的那格就是落點
      k = slotIndex(contentY(y), mids);
      slots.forEach((s, i) => {
        const shift = s.below ? (i < k ? -groupH : 0) : (i >= k ? groupH : 0);
        if (shift === s.shift) return;
        s.shift = shift;
        const tf = shift ? 'translateY(' + shift + 'px)' : '';
        for (const el of s.rows) el.style.transform = tf;
      });
    }
    raf = requestAnimationFrame(frame);
  };

  const onMove = (e) => {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    y = e.clientY;
    dirty = true;
  };
  const restore = () => {
    for (const el of group) { el.classList.remove('gn-treorder-drag'); el.style.transform = ''; }
    for (const s of slots) for (const el of s.rows) el.style.transform = '';
  };
  const finish = (commit) => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    handle.removeEventListener('lostpointercapture', onCancel);
    try { handle.releasePointerCapture(pid); } catch (e) {}
    scroller.classList.remove('gn-treorder-active');
    /* 位置有變才交給呼叫端。它會重畫整棵樹 —— 這時所有列都還停在拖曳中的樣子，
       呼叫端可以據此把動畫接上。重畫後這些舊元素已不在畫面上，restore 只是保險
       （呼叫端沒重畫的話，列會滑回原位）。 */
    if (commit && k !== origIdx) {
      const target = k < others.length ? others[k] : others[others.length - 1];
      const zone = k < others.length ? 'before' : 'after';
      try { onDrop(path, target.dataset.path, zone); } catch (e) { console.error(e); }
    }
    restore();
  };
  const onUp = (e) => { if (e.pointerId === pid) finish(true); };
  const onCancel = (e) => { if (e.pointerId === pid) finish(false); };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  handle.addEventListener('lostpointercapture', onCancel);
  raf = requestAnimationFrame(frame);
  return true;
}

module.exports = { startReorderDrag, parentOf, slotIndex };
