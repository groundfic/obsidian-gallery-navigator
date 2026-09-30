/* 兩台裝置共用一個 data.json 的模擬：直接用 GalleryPlugin 真正的存檔／拉取方法。 */
const Module = require('module');
const path = require('path');
const assert = require('assert');
const SRC = process.argv[2] || require('path').join(__dirname, '..', 'src');

const klass = () => class { constructor() {} };
const obsidianStub = new Proxy({ Platform: { isMobile: false }, requestUrl: async () => ({ status: 404 }) }, {
  get(t, k) { if (k in t) return t[k]; if (/^[A-Z]/.test(String(k))) return (t[k] = klass()); return (t[k] = () => {}); },
});
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };
global.window = global;
global.document = { body: { classList: { contains: () => false } }, visibilityState: 'visible' };
global.navigator = { language: 'zh-TW' };
const _warn = console.warn; console.warn = () => {};
const { GalleryPlugin } = require(path.join(SRC, 'gallery.js'));
console.warn = _warn;
assert.ok(GalleryPlugin, 'gallery.js 應匯出 GalleryPlugin');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

// 一顆「雲端硬碟」，兩台裝置讀寫同一份 data.json
function makeDisk(initial) { return { data: clone(initial), writes: 0 }; }
function makeDevice(disk, { localStore = true } = {}) {
  const ls = {};
  const p = Object.create(GalleryPlugin.prototype);
  p.app = localStore ? {
    loadLocalStorage: (k) => (k in ls ? clone(ls[k]) : null),
    saveLocalStorage: (k, v) => { ls[k] = clone(v); },
  } : {};
  p.loadData = async () => { await tick(1); return disk.data ? clone(disk.data) : null; };
  p.saveData = async (d) => { await tick(1); disk.data = clone(d); disk.writes++; };
  p.refreshed = 0;
  p.refreshViews = () => { p.refreshed++; };
  p._ls = ls;
  return p;
}
// 照 onload 的做法把狀態讀進來
async function boot(p) {
  const { splitState } = require(path.join(SRC, 'statesync.js'));
  const disk = (await p.loadData()) || {};
  const localSaved = p.loadLocalState();
  p.state = Object.assign({ lastPath: '', folderOrder: {}, folderColors: {}, expandedFolders: [] }, disk, localSaved ? splitState(localSaved).local : null);
  p._syncBase = splitState(disk).shared;
}
const save = async (p) => { p.saveState(); await p.flushState(); };

(async () => {
  let n = 0;
  const ok = (name) => { console.log('  ✓ ' + name); n++; };
  const initial = {
    lastPath: 'Project', expandedFolders: ['Project'], treeWidth: 221,
    folderOrder: { '/': ['inbox', 'Studio', 'Project'] }, folderColors: { Studio: 'red' },
    hiddenFolders: [], linkcard: { threadsPasteInsert: true },
  };

  // 1. 只換資料夾／展開收合 → data.json 完全不寫
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk); await boot(mac);
    mac.state.lastPath = 'Studio'; mac.state.expandedFolders = ['Project', 'Studio'];
    await save(mac);
    assert.strictEqual(disk.writes, 0, 'data.json 不該被寫');
    assert.strictEqual(mac._ls['gallery-navigator-view-state'].lastPath, 'Studio');
    // 重新啟動：檢視狀態從本機那份回來，不是 data.json 裡的舊值
    const mac2 = makeDevice(disk); mac2.app = mac.app; await boot(mac2);
    assert.strictEqual(mac2.state.lastPath, 'Studio');
    assert.deepStrictEqual(mac2.state.expandedFolders, ['Project', 'Studio']);
    ok('換資料夾、展開收合不再寫 data.json；重啟後檢視狀態仍在');
  }

  // 2. 手機排順序 → 桌機（一直開著）拉到新順序並重畫；之後桌機點資料夾也不會把它蓋回去
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk), phone = makeDevice(disk);
    await boot(mac); await boot(phone);
    phone.state.folderOrder = { '/': ['Project', 'inbox', 'Studio'] };
    await save(phone);
    assert.strictEqual(disk.writes, 1);
    // 桌機還沒拉之前先點了資料夾（以前這一步就會把手機的順序蓋掉）
    mac.state.lastPath = 'inbox';
    await save(mac);
    assert.deepStrictEqual(disk.data.folderOrder['/'], ['Project', 'inbox', 'Studio'], '手機的順序不該被蓋掉');
    await mac.pullExternalState();
    assert.deepStrictEqual(mac.state.folderOrder['/'], ['Project', 'inbox', 'Studio']);
    assert.strictEqual(mac.refreshed, 1, '拉到新順序應重畫');
    assert.strictEqual(disk.writes, 1, '桌機只是接收，不必再寫');
    assert.strictEqual(mac.state.lastPath, 'inbox', '桌機自己的目前資料夾不受影響');
    await mac.pullExternalState();
    assert.strictEqual(mac.refreshed, 1, '沒有新東西就不重畫');
    ok('手機排的順序會到桌機，桌機的檢視狀態不被牽動');
  }

  // 3. 桌機沒先拉就改了別的設定 → 存檔時自動併入手機的順序
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk), phone = makeDevice(disk);
    await boot(mac); await boot(phone);
    phone.state.folderOrder = { '/': ['Project', 'inbox', 'Studio'] };
    await save(phone);
    mac.state.folderColors = { Studio: 'red', inbox: 'blue' };
    await save(mac);
    assert.deepStrictEqual(disk.data.folderOrder['/'], ['Project', 'inbox', 'Studio']);
    assert.deepStrictEqual(disk.data.folderColors, { Studio: 'red', inbox: 'blue' });
    assert.deepStrictEqual(mac.state.folderOrder['/'], ['Project', 'inbox', 'Studio'], '桌機記憶體也要跟上');
    assert.strictEqual(mac.refreshed, 1);
    // 手機再拉 → 拿到桌機的顏色
    await phone.pullExternalState();
    assert.deepStrictEqual(phone.state.folderColors, { Studio: 'red', inbox: 'blue' });
    ok('兩台各改不同設定 → 兩邊的變更都留下');
  }

  // 4. 套用外部變更時，物件不換參照（模組手上握著 state.linkcard）
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk), phone = makeDevice(disk);
    await boot(mac); await boot(phone);
    const held = mac.state.linkcard;
    phone.state.linkcard.threadsPasteInsert = false;
    await save(phone);
    await mac.pullExternalState();
    assert.strictEqual(mac.state.linkcard, held, '物件參照要保持同一個');
    assert.strictEqual(held.threadsPasteInsert, false);
    ok('合併進來的設定就地更新，模組握著的參照不失效');
  }

  // 5. data.json 裡舊的檢視狀態欄位保留原值（退回舊版時不會全變預設）
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk); await boot(mac);
    mac.state.lastPath = 'Studio'; mac.state.hiddenFolders = ['x'];
    await save(mac);
    assert.strictEqual(disk.data.lastPath, 'Project', 'data.json 的 lastPath 應維持升級前的值');
    assert.deepStrictEqual(disk.data.hiddenFolders, ['x']);
    ok('data.json 保留升級前的檢視狀態欄位');
  }

  // 6. 舊版 Obsidian（沒有本機儲存 API）→ 全部照舊寫進 data.json，但仍會先合併
  {
    const disk = makeDisk(initial);
    const old = makeDevice(disk, { localStore: false }), phone = makeDevice(disk);
    await boot(old); await boot(phone);
    phone.state.folderOrder = { '/': ['Project', 'inbox', 'Studio'] };
    await save(phone);
    old.state.lastPath = 'Studio';
    await save(old);
    assert.strictEqual(disk.data.lastPath, 'Studio');
    assert.deepStrictEqual(disk.data.folderOrder['/'], ['Project', 'inbox', 'Studio']);
    ok('沒有本機儲存 API 時退回舊行為，但不再整包蓋掉別台的變更');
  }

  // 7. 同一台裝置上「存檔」與「拉取」同時發生 → 排隊執行，不會互相踩到
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk), phone = makeDevice(disk);
    await boot(mac); await boot(phone);
    phone.state.folderOrder = { '/': ['Studio', 'inbox', 'Project'] };
    await save(phone);
    mac.state.folderColors = { Studio: 'green' };
    await Promise.all([save(mac), mac.pullExternalState(), mac.pullExternalState()]);
    await phone.pullExternalState();
    for (const d of [mac, phone]) {
      assert.deepStrictEqual(d.state.folderOrder['/'], ['Studio', 'inbox', 'Project']);
      assert.deepStrictEqual(d.state.folderColors, { Studio: 'green' });
    }
    assert.deepStrictEqual(disk.data.folderOrder['/'], ['Studio', 'inbox', 'Project']);
    assert.deepStrictEqual(disk.data.folderColors, { Studio: 'green' });
    ok('同一台的存檔與拉取排隊執行，結果正確');
  }

  // 8. 已知限制：兩台「同一瞬間」各自存檔（對方的檔還沒送到）→ 後寫的贏，但最後兩台一致
  {
    const disk = makeDisk(initial);
    const mac = makeDevice(disk), phone = makeDevice(disk);
    await boot(mac); await boot(phone);
    phone.state.folderOrder = { '/': ['Studio', 'inbox', 'Project'] };
    mac.state.folderColors = { Studio: 'green' };
    await Promise.all([save(phone), save(mac)]);
    for (let i = 0; i < 3; i++) {
      await Promise.all([mac.pullExternalState(), phone.pullExternalState()]);
      await Promise.all([mac.flushState(), phone.flushState()]);
    }
    assert.deepStrictEqual(mac.state.folderOrder, phone.state.folderOrder);
    assert.deepStrictEqual(mac.state.folderColors, phone.state.folderColors);
    assert.deepStrictEqual(disk.data.folderOrder, mac.state.folderOrder);
    const both = JSON.stringify(mac.state.folderOrder['/']) === JSON.stringify(['Studio', 'inbox', 'Project'])
      && mac.state.folderColors.Studio === 'green';
    console.log('    （同一瞬間各自存檔：' + (both ? '兩邊的變更都留下' : '只留下後寫那台的變更') + '，三邊最後一致）');
    ok('同一瞬間的衝突不會讓兩台狀態分岔');
  }

  console.log(`\n${n} 項全過`);
})().catch((e) => { console.error('✗ 失敗：', e.stack || e.message); process.exit(1); });
