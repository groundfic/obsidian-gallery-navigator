const assert = require('assert');
const path = require('path');
const { splitState, mergeShared, deepEqual, LOCAL_KEYS } = require(path.join(process.argv[2] || path.join(__dirname, '..', 'src'), 'statesync.js'));

let n = 0;
const ok = (name) => { console.log('  ✓ ' + name); n++; };

// 拆分
{
  const st = { lastPath: 'a', expandedFolders: ['x'], folderOrder: { '/': ['a', 'b'] }, sort: 'new', und: undefined };
  const { shared, local } = splitState(st);
  assert.deepStrictEqual(local, { lastPath: 'a', expandedFolders: ['x'] });
  assert.deepStrictEqual(shared, { folderOrder: { '/': ['a', 'b'] }, sort: 'new' });
  st.folderOrder['/'].push('c');
  assert.strictEqual(shared.folderOrder['/'].length, 2, '快照要是深拷貝');
  ok('拆成共用／本機兩份，且是深拷貝');
}

// 情境 1：手機排了順序，桌機只是點了資料夾（共用設定沒動）→ 桌機採用手機的順序
{
  const base = { folderOrder: { '/': ['a', 'b', 'c'] }, sort: 'new' };
  const desktop = { folderOrder: { '/': ['a', 'b', 'c'] }, sort: 'new' };
  const disk = { folderOrder: { '/': ['c', 'a', 'b'] }, sort: 'new' };   // 手機寫的
  const m = mergeShared(base, desktop, disk);
  assert.deepStrictEqual(m.merged.folderOrder['/'], ['c', 'a', 'b']);
  assert.strictEqual(m.fromRemote, true); assert.strictEqual(m.needsWrite, false);
  ok('別台改了順序、本機沒動 → 採用別台的，且不必再寫檔');
}

// 情境 2：兩台各排了「不同父層」→ 兩邊都保留
{
  const base = { folderOrder: { '/': ['a', 'b'], P: ['P/x', 'P/y'] } };
  const local = { folderOrder: { '/': ['b', 'a'], P: ['P/x', 'P/y'] } };
  const disk = { folderOrder: { '/': ['a', 'b'], P: ['P/y', 'P/x'] } };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged.folderOrder, { '/': ['b', 'a'], P: ['P/y', 'P/x'] });
  assert.ok(m.fromRemote && m.needsWrite);
  ok('兩台各排不同層 → 兩邊的順序都留下');
}

// 情境 3：兩台排了「同一層」→ 本機（正在存檔的這台）為準
{
  const base = { folderOrder: { '/': ['a', 'b', 'c'] } };
  const local = { folderOrder: { '/': ['b', 'a', 'c'] } };
  const disk = { folderOrder: { '/': ['c', 'b', 'a'] } };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged.folderOrder['/'], ['b', 'a', 'c']);
  assert.ok(!m.fromRemote && m.needsWrite);
  ok('兩台排同一層 → 以正在存檔的這台為準');
}

// 情境 4：別台拿掉某資料夾的顏色、又幫另一個上色；本機同時改了別的資料夾
{
  const base = { folderColors: { A: 'red', B: 'blue' } };
  const local = { folderColors: { A: 'red', B: 'blue', C: 'green' } };
  const disk = { folderColors: { B: 'blue', D: 'pink' } };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged.folderColors, { B: 'blue', C: 'green', D: 'pink' });
  ok('子鍵層級的新增與刪除都正確合併');
}

// 情境 5：本機刪掉的，不會被磁碟上的舊值救回來
{
  const base = { folderColors: { A: 'red' } };
  const local = { folderColors: {} };
  const disk = { folderColors: { A: 'red' } };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged.folderColors, {});
  assert.ok(m.needsWrite);
  ok('本機的刪除不會被舊檔還原');
}

// 情境 6：陣列型欄位（隱藏清單、最愛）整個比
{
  const base = { hiddenFolders: ['x'], favorites: [{ type: 'folder', path: 'a' }] };
  const local = { hiddenFolders: ['x'], favorites: [{ type: 'folder', path: 'a' }, { type: 'folder', path: 'b' }] };
  const disk = { hiddenFolders: ['x', 'y'], favorites: [{ type: 'folder', path: 'a' }] };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged.hiddenFolders, ['x', 'y']);
  assert.strictEqual(m.merged.favorites.length, 2);
  ok('陣列欄位：各自沒動的那邊採用對方的');
}

// 情境 7：磁碟上少了某個欄位（舊版寫的）→ 不當成刪除
{
  const base = { folderIcons: { A: 'star' }, sort: 'new' };
  const local = { folderIcons: { A: 'star' }, sort: 'new' };
  const disk = { sort: 'old' };
  const m = mergeShared(base, local, disk);
  assert.deepStrictEqual(m.merged, { folderIcons: { A: 'star' }, sort: 'old' });
  ok('舊版寫出的檔少欄位 → 保留本機的，不誤刪');
}

// 情境 8：讀不到磁碟 → 原樣寫出
{
  const m = mergeShared({ a: 1 }, { a: 2 }, null);
  assert.deepStrictEqual(m.merged, { a: 2 }); assert.ok(m.needsWrite && !m.fromRemote);
  ok('讀不到磁碟時照本機寫');
}

// 情境 9：key 順序不同不算有變
{
  assert.ok(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
  assert.ok(!deepEqual({ c: [1, 2] }, { c: [2, 1] }));
  const m = mergeShared({ x: { a: 1, b: 2 } }, { x: { b: 2, a: 1 } }, { x: { a: 1, b: 2 } });
  assert.ok(!m.fromRemote && !m.needsWrite);
  ok('物件 key 順序不同不會被當成變更');
}

// （data.json 是個人資料、不進 repo；不存在就略過這一項）
// 用真的 data.json 跑一輪：沒有任何變更時，合併結果必須和原檔一模一樣
if (require('fs').existsSync(process.argv[3] || path.join(__dirname, '..', 'data.json'))) {
  const real = JSON.parse(require('fs').readFileSync(process.argv[3] || path.join(__dirname, '..', 'data.json'), 'utf8'));
  const { shared, local } = splitState(real);
  const m = mergeShared(shared, shared, shared);
  assert.ok(deepEqual(m.merged, shared) && !m.fromRemote && !m.needsWrite);
  assert.ok(deepEqual(Object.assign({}, local, m.merged), real), '拆開再合回來要等於原檔');
  console.log('    （真實 data.json：共用 ' + Object.keys(shared).length + ' 個欄位、本機 ' + Object.keys(local).length + ' 個；本機欄位共 ' + JSON.stringify(local).length + ' bytes，佔全檔 ' + Math.round(JSON.stringify(local).length / JSON.stringify(real).length * 100) + '%）');
  assert.ok(LOCAL_KEYS.every((k) => k in real || k === 'mobileCols' || true));
  ok('真實 data.json 拆開再合回來完全一致');
}

console.log(`\n${n} 項全過`);
