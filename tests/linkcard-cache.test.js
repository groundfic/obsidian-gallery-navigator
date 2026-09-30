/* linkcard.js 快取邏輯的離線測試：用假的 obsidian 模組與假的網路，直接呼叫內部函式。 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = process.argv[2] || require('path').join(__dirname, '..', 'src');
const requests = [];          // 每次 requestUrl 的網址
let responder = () => ({ status: 404, text: '', headers: {} });

const obsidianStub = {
  Plugin: class {}, MarkdownView: class {}, Menu: class {}, Notice: class {},
  PluginSettingTab: class {}, Setting: class {},
  Platform: { isMobile: false },
  editorLivePreviewField: null,
  requestUrl: async (req) => { requests.push(req.url); return responder(req); },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return 'obsidian';
  return origResolve.call(this, request, ...rest);
};
require.cache.obsidian = { id: 'obsidian', filename: 'obsidian', loaded: true, exports: obsidianStub };

// 極簡 DOMParser：只支援 parseMetadataFrom 用到的幾種選擇器
global.DOMParser = class {
  parseFromString(html) {
    const attr = (tag, name) => { const m = new RegExp(name + '=["\']([^"\']*)["\']', 'i').exec(tag); return m ? m[1] : null; };
    const find = (sel) => {
      let m = /^meta\[(property|name)="([^"]+)"\]$/.exec(sel);
      if (m) {
        const re = new RegExp('<meta[^>]*' + m[1] + '=["\']' + m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i');
        const tag = re.exec(html);
        return tag ? { getAttribute: (n) => attr(tag[0], n) } : null;
      }
      if (sel === 'title') { const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); return t ? { textContent: t[1] } : null; }
      return null;
    };
    return { querySelector: find, querySelectorAll: () => [], documentElement: { textContent: html }, body: { firstElementChild: null } };
  }
};
global.navigator = { language: 'zh-TW' };
global.window = global;
const _warn = console.warn; console.warn = () => {};

// 載入 linkcard.js，並把內部函式額外匯出給測試用
const file = path.join(SRC, 'linkcard.js');
const code = fs.readFileSync(file, 'utf8') +
  '\nmodule.exports.__t = { state, fetchMeta, pruneCache, makeSlots, entryTtl, metaDiffers, MAX_CACHE_ENTRIES, META_TTL, REFRESH_RETRY };';
const m = new Module(file, module);
m.filename = file;
m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(code, file);
const T = m.exports.__t;

const page = (title, img) => ({
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  arrayBuffer: new TextEncoder().encode(`<html><head><title>${title}</title><meta property="og:title" content="${title}">` +
    (img ? `<meta property="og:image" content="${img}">` : '') + '</head><body></body></html>').buffer,
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
let saves = 0;
const reset = () => { T.state.cache = {}; T.state.save = () => { saves++; }; requests.length = 0; saves = 0; };

(async () => {
  let n = 0;
  const ok = (name) => console.log('  ✓ ' + name) || n++;

  // 1. 快取還新鮮 → 完全不發請求
  reset();
  T.state.cache['https://a.test/x'] = { ts: Date.now() - DAY, meta: { title: 'A', image: 'https://a.test/i.jpg', hostname: 'a.test', dims: { w: 800, h: 400 } } };
  let meta = await T.fetchMeta('https://a.test/x');
  assert.strictEqual(meta.title, 'A'); assert.strictEqual(requests.length, 0);
  ok('新鮮快取不發請求');

  // 2. 過期 → 立刻拿到舊資料，背景重抓；圖片網址沒變時沿用尺寸與主色
  reset();
  T.state.cache['https://a.test/x'] = { ts: Date.now() - 30 * DAY, meta: { title: '舊標題', image: 'https://a.test/i.jpg', hostname: 'a.test', dims: { w: 800, h: 400 }, tint: [1, 2, 3] } };
  responder = () => page('新標題', 'https://a.test/i.jpg');
  let refreshed = null;
  const t0 = Date.now();
  meta = await T.fetchMeta('https://a.test/x', (f) => { refreshed = f; });
  assert.strictEqual(meta.title, '舊標題', '應先回傳舊資料');
  assert.ok(Date.now() - t0 < 15, '舊資料應該立刻回來');
  await tick();
  assert.strictEqual(requests.length, 1, '背景應重抓一次');
  assert.ok(refreshed && refreshed.title === '新標題', '內容有變應通知重畫');
  assert.deepStrictEqual(refreshed.dims, { w: 800, h: 400 }, '圖片網址沒變 → 沿用尺寸');
  assert.deepStrictEqual(refreshed.tint, [1, 2, 3], '圖片網址沒變 → 沿用主色');
  assert.strictEqual(T.state.cache['https://a.test/x'].meta.title, '新標題');
  ok('過期快取：先顯示舊的、背景重抓、沿用尺寸與主色');

  // 3. 過期、重抓內容沒變 → 不通知重畫
  reset();
  T.state.cache['https://a.test/x'] = { ts: Date.now() - 30 * DAY, meta: { title: '一樣', image: 'https://a.test/i.jpg', hostname: 'a.test', description: '' } };
  responder = () => page('一樣', 'https://a.test/i.jpg');
  refreshed = null;
  await T.fetchMeta('https://a.test/x', (f) => { refreshed = f; });
  await tick();
  assert.strictEqual(refreshed, null);
  ok('重抓內容沒變不重畫');

  // 4. 過期、重抓失敗 → 保留原本好的資料，一天後再試
  reset();
  const good = { title: '好標題', image: 'https://a.test/i.jpg', hostname: 'a.test' };
  T.state.cache['https://a.test/x'] = { ts: Date.now() - 30 * DAY, meta: good };
  responder = () => ({ status: 503, text: '', headers: {} });
  refreshed = null;
  await T.fetchMeta('https://a.test/x', (f) => { refreshed = f; });
  await tick();
  const e4 = T.state.cache['https://a.test/x'];
  assert.strictEqual(e4.meta, good, '不該被失敗結果蓋掉');
  assert.strictEqual(refreshed, null);
  const left = T.entryTtl(e4) - (Date.now() - e4.ts);
  assert.ok(left > 0.9 * DAY && left <= DAY, '應在約一天後才再過期，實際剩 ' + (left / 36e5).toFixed(1) + 'h');
  requests.length = 0;
  await T.fetchMeta('https://a.test/x'); await tick();
  assert.strictEqual(requests.length, 0, '一天內不該再重打');
  ok('重抓失敗不蓋掉好資料，且不會每次開都重打');

  // 5. 沒有快取、抓取失敗 → 照舊記成 poor
  reset();
  responder = () => ({ status: 503, text: '', headers: {} });
  meta = await T.fetchMeta('https://dead.test/');
  assert.strictEqual(meta.poor, true); assert.strictEqual(T.state.cache['https://dead.test/'].fail, 1);
  ok('全新連結抓不到仍記為失敗（退避機制不變）');

  // 6. 同一網址同時要三次 → 只發一次
  reset();
  responder = () => page('T', '');
  await Promise.all([T.fetchMeta('https://b.test/'), T.fetchMeta('https://b.test/'), T.fetchMeta('https://b.test/')]);
  assert.strictEqual(requests.length, 1);
  ok('同網址並行去重');

  // 7. Threads 不再打 oEmbed；Instagram 照打
  reset();
  responder = (req) => (/oembed/.test(req.url)
    ? { status: 200, headers: {}, text: JSON.stringify({ author_name: 'u', html: '<p>hi</p>', thumbnail_url: 'https://cdninstagram.test/t.jpg' }) }
    : page('Threads 上的 X（@x）', 'https://cdninstagram.test/a.jpg'));
  await T.fetchMeta('https://www.threads.com/@x/post/abc?xmt=1');
  assert.ok(!requests.some((u) => /oembed/.test(u)), 'Threads 不該打 oEmbed：' + requests.join(' | '));
  assert.strictEqual(requests.length, 1);
  requests.length = 0;
  await T.fetchMeta('https://www.instagram.com/p/abc/?igsh=1');
  assert.ok(/instagram\.com\/api\/v1\/oembed/.test(requests[0]));
  assert.strictEqual(requests.length, 1, 'IG oEmbed 拿到圖就不必再抓整頁');
  ok('Threads 跳過失效的 oEmbed（1 次請求），Instagram 維持 oEmbed');

  // 8. 淘汰看「最後使用時間」
  reset();
  const now = Date.now();
  for (let i = 0; i < T.MAX_CACHE_ENTRIES + 2; i++) T.state.cache['https://c.test/' + i] = { ts: now - 40 * DAY + i, meta: { title: 't' + i, hostname: 'c.test', img: 'f' + i + '.jpg' } };
  // 第 0 筆抓取時間最舊，但剛剛才被看過
  await T.fetchMeta('https://c.test/0');
  assert.ok(T.state.cache['https://c.test/0'].at, '命中應記下使用時間');
  T.pruneCache();
  assert.strictEqual(Object.keys(T.state.cache).length, T.MAX_CACHE_ENTRIES);
  assert.ok(T.state.cache['https://c.test/0'], '剛用過的不該被淘汰');
  assert.ok(!T.state.cache['https://c.test/1'] && !T.state.cache['https://c.test/2'], '最久沒用的兩筆應被淘汰');
  assert.strictEqual(saves, 0, '只是看卡片不該觸發寫檔');
  ok('上限 ' + T.MAX_CACHE_ENTRIES + '、淘汰最久沒用的、瀏覽不寫檔');

  // 9. 兩組名額互不阻塞
  const a = T.makeSlots(1), b = T.makeSlots(1);
  await a.acquire();
  let got = false; b.acquire().then(() => { got = true; });
  let waited = false; a.acquire().then(() => { waited = true; });
  await tick(5);
  assert.ok(got && !waited); a.release(); await tick(5); assert.ok(waited);
  ok('meta 與圖片名額各自獨立');

  console.warn = _warn;
  console.log(`\n${n} 項全過`);
})().catch((e) => { console.warn = _warn; console.error('✗ 失敗：', e.message); process.exit(1); });
