'use strict';

/* ===== data.json 的跨裝置合併（2026-09-30）=====
 *
 * 問題：整個外掛的狀態是一包 data.json，啟動時讀一次，之後每次存檔都把記憶體裡那一份
 * **整包覆寫**回去。桌機與手機同時開著時：
 *   • 手機排好的資料夾順序，要等桌機重啟才讀得到；
 *   • 而桌機只要點一下資料夾（lastPath 變了 → 存檔），就拿自己那份舊的整包蓋回去，
 *     手機的變更直接消失。反過來也一樣。
 * 點資料夾、展開收合、捲動左欄都會存檔，所以這幾乎是必然發生，不是偶發。
 *
 * 做法分兩半：
 *   1. 「只屬於這台裝置的檢視狀態」（LOCAL_KEYS）不再寫進 data.json，改存在本機。
 *      最頻繁的寫入就是它們；搬走之後，data.json 只有在真的改了共用設定時才會被寫。
 *   2. 共用設定採三方合併：以「上次看到的磁碟內容」為基準（base），
 *      本機沒動過的欄位採用磁碟上的新值，本機動過的欄位以本機為準。
 *      存檔前、以及偵測到檔案被別台裝置改過時各做一次。
 *
 * 這個檔案只有純函式，不碰 Obsidian API，方便離線測試。
 */

/* 只屬於這台裝置的檢視狀態：目前在哪個資料夾、展開了哪些、捲到哪、欄寬、卡片大小……
   桌機和手機本來就該各記各的。
   ⚠️ 新增「檢視狀態」類的 state 欄位時，記得回來加進這張清單，
      否則它會跟著 data.json 同步到別台裝置，而且每改一次就寫一次 data.json。 */
const LOCAL_KEYS = [
  'lastPath', 'treeScrollTop', 'treeWidth', 'treeCollapsed', 'cardWidth', 'mobileCols',
  'expandedFolders', 'expandedTags', 'leftMode', 'activeTag', 'tagDockOpen', 'favCollapsed',
];
const LOCAL_SET = new Set(LOCAL_KEYS);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 深度比較（物件不看 key 的順序；陣列看順序）
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/* 把整包狀態拆成 { shared, local }，兩邊都是深拷貝
   （之後狀態物件被就地修改，也不會動到這裡拿走的快照）。 */
function splitState(state) {
  const shared = {}, local = {};
  for (const k of Object.keys(state || {})) {
    const v = clone(state[k]);
    if (v === undefined) continue;
    (LOCAL_SET.has(k) ? local : shared)[k] = v;
  }
  return { shared, local };
}

/* 物件型欄位逐個子鍵合併（folderOrder 的每個父層、folderColors 的每個資料夾……）。
   這一層要處理「刪除」：另一台把某個資料夾的顏色拿掉，這邊也要跟著拿掉。 */
function mergeObject(base, local, remote) {
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    const inB = Object.prototype.hasOwnProperty.call(base, k);
    const inL = Object.prototype.hasOwnProperty.call(local, k);
    const inR = Object.prototype.hasOwnProperty.call(remote, k);
    const localChanged = inL !== inB || (inL && !deepEqual(local[k], base[k]));
    if (localChanged) { if (inL) out[k] = local[k]; }   // 本機動過（含刪除）→ 照本機
    else if (inR) out[k] = remote[k];                   // 本機沒動 → 照磁碟（磁碟上沒有＝被刪了）
  }
  return out;
}

/**
 * 三方合併共用設定。
 *   base   ＝上次看到的磁碟內容
 *   local  ＝記憶體裡現在的共用設定
 *   remote ＝磁碟上現在的共用設定（null ＝讀不到，當成沒有別人動過）
 * 回傳 { merged, fromRemote, needsWrite }：
 *   fromRemote ＝合併結果和 local 不同（有別台裝置的變更要套進來）
 *   needsWrite ＝合併結果和 remote 不同（本機有東西還沒寫出去）
 */
function mergeShared(base, local, remote) {
  base = base || {};
  if (!remote) return { merged: clone(local), fromRemote: false, needsWrite: true };
  const merged = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    const inL = Object.prototype.hasOwnProperty.call(local, k);
    const inR = Object.prototype.hasOwnProperty.call(remote, k);
    /* 最上層的欄位不做「刪除」：磁碟上沒有某個欄位，幾乎都是因為那台裝置的版本比較舊、
       還不認得它，而不是有人刻意刪掉。 */
    if (!inR) { merged[k] = local[k]; continue; }
    if (!inL) { merged[k] = remote[k]; continue; }
    const b = base[k];
    if (isPlainObject(local[k]) && isPlainObject(remote[k]) && (b === undefined || isPlainObject(b))) {
      merged[k] = mergeObject(b || {}, local[k], remote[k]);
    } else {
      merged[k] = deepEqual(local[k], b) ? remote[k] : local[k];
    }
  }
  const out = clone(merged);
  return { merged: out, fromRemote: !deepEqual(out, local), needsWrite: !deepEqual(out, remote) };
}

module.exports = { LOCAL_KEYS, splitState, mergeShared, deepEqual, clone, isPlainObject };
