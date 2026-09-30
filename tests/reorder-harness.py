"""手機資料夾排序的離線測試：用真正的 treereorder.js 與建置出來的 styles.css，
在無頭 Chromium（模擬 iPhone 觸控）裡實際拖曳，不碰使用者的 Obsidian / Chrome。"""
import json, pathlib, sys, tempfile
from playwright.sync_api import sync_playwright

PLUGIN = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent
# 測試頁與截圖放暫存資料夾（外掛資料夾在 iCloud 裡，不要把截圖丟進來同步）
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(tempfile.mkdtemp(prefix='gn-reorder-'))
reorder_js = (PLUGIN / 'src' / 'treereorder.js').read_text(encoding='utf-8')
css = (PLUGIN / 'styles.css').read_text(encoding='utf-8')

HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* Obsidian 主題變數的替身（淺色） */
  body { margin:0; font-family:-apple-system,'PingFang TC',sans-serif;
    --background-primary:#fff; --background-secondary:#f4f4f2; --background-modifier-border:#ddd;
    --background-modifier-hover:rgba(0,0,0,.06); --interactive-accent:#7b6cd9; --text-on-accent:#fff;
    --text-normal:#222; --text-muted:#666; --text-faint:#aaa; background:#f4f4f2; }
  * { box-sizing: border-box; }   /* Obsidian 全域就是 border-box */
  #frame { height:100vh; }
</style>
<style>%%CSS%%</style></head>
<body class="is-mobile theme-light">
<div id="frame" class="gn-root"><div class="gn-split">
  <div class="gn-tree gn-tree-reorder"><div class="gn-tree-scroll"></div><div class="gn-tselbar gn-tselbar-solo"><div class="gn-tselbar-btn gn-tselbar-done" id="done">完成</div></div></div>
  <div class="gn-main"></div>
</div>
<!-- 手機的底部工具列：絕對定位釘在 gn-root 底部，會蓋住左欄最底下那一段 -->
<div class="gn-bar"><div class="gn-btn" style="width:44px;height:44px"></div><div class="gn-btn" style="width:44px;height:44px"></div><div class="gn-btn" style="width:44px;height:44px"></div></div>
</div>
<script>
const module = { exports: {} };
(function(module){ %%JS%% })(module);
const { startReorderDrag } = module.exports;

// 模型：父層 → 子資料夾順序；expanded＝展開中的資料夾
window.model = %%MODEL%%;
window.expanded = new Set(%%EXPANDED%%);
window.drops = [];
window.rowClicks = 0;
const scroller = document.querySelector('.gn-tree-scroll');
const MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
function build() {
  scroller.textContent = '';
  const level = (parent, depth) => {
    const kids = model[parent] || [];
    for (const p of kids) {
      const row = document.createElement('div');
      row.className = 'gn-tnode'; row.dataset.path = p; row.dataset.gnFolder = '1';
      row.style.setProperty('--gn-depth', depth);
      row.innerHTML = '<span class="gn-tslot"><span class="gn-tthumb gn-tthumb-folder">' + FOLDER + '</span><span class="gn-tcaret"></span></span>'
        + '<span class="gn-tname"></span><span class="gn-tcount">3</span>';
      row.querySelector('.gn-tname').textContent = p.split('/').pop();
      row.onclick = () => { window.rowClicks++; };
      // 可展開的列：跟真的一樣掛 gn-thaskids、箭頭有圖示與自己的 onclick
      if ((model[p] || []).length) {
        row.classList.add('gn-thaskids');
        if (expanded.has(p)) row.classList.add('gn-topen');
        const caret = row.querySelector('.gn-tcaret');
        caret.innerHTML = CHEVRON;
        caret.onclick = (e) => { e.stopPropagation(); expanded.has(p) ? expanded.delete(p) : expanded.add(p); build(); };
      }
      if (kids.length > 1) {
        const grip = document.createElement('span');
        grip.className = 'gn-tgrip'; grip.innerHTML = MENU;
        const stop = (e) => e.stopPropagation();
        grip.addEventListener('touchstart', stop, { passive: true });
        grip.addEventListener('touchmove', stop, { passive: true });
        grip.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
        grip.addEventListener('pointerdown', (e) => {
          if (e.button) return;
          e.preventDefault(); e.stopPropagation();
          startReorderDrag({ event: e, row, scroller,
            rows: () => scroller.querySelectorAll('.gn-tnode[data-gn-folder]'),
            onDrop: (dragged, target, zone) => {
              window.drops.push([dragged, target, zone]);
              // 同 reorderSibling 的算法
              const par = dragged.includes('/') ? dragged.slice(0, dragged.lastIndexOf('/')) : '/';
              let order = model[par].filter((x) => x !== dragged);
              let idx = order.indexOf(target); if (idx === -1) idx = order.length;
              if (zone === 'after') idx += 1;
              order.splice(idx, 0, dragged);
              model[par] = order;
              const top = scroller.scrollTop; build(); scroller.scrollTop = top;
            } });
        });
        row.appendChild(grip);
      }
      scroller.appendChild(row);
      if (expanded.has(p)) level(p, depth + 1);
    }
  };
  level('/', 1);
}
build();
window.touchMoves = 0; scroller.addEventListener('scroll', () => { window.scrolled = (window.scrolled || 0) + 1; });
</script></body></html>"""

def page_html(model, expanded):
    return (HTML.replace('%%CSS%%', css).replace('%%JS%%', reorder_js)
            .replace('%%MODEL%%', json.dumps(model, ensure_ascii=False))
            .replace('%%EXPANDED%%', json.dumps(expanded, ensure_ascii=False)))

ROOT = ['inbox', '每日筆記', 'Studio', 'Project', 'Learning', 'Library', 'img', 'Archived']
passed = 0
def ok(name):
    global passed
    passed += 1
    print('  ✓ ' + name)

def center(page, path, sel=''):
    box = page.evaluate("""([p, sel]) => { const r = [...document.querySelectorAll('.gn-tnode')].find(e => e.dataset.path === p);
        const el = sel ? r.querySelector(sel) : r; const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom, h: b.height, w: b.width, left: b.left, right: b.right }; }""", [path, sel])
    return box

def order(page, parent='/'):
    return page.evaluate('(p) => model[p]', parent)

class Touch:
    """用 CDP 送真的觸控事件（會走瀏覽器的 touch-action／捲動判定，和手指一樣）"""
    def __init__(self, page):
        self.cdp = page.context.new_cdp_session(page)
        self.page = page
    def _send(self, kind, x=None, y=None):
        pts = [] if x is None else [{'x': x, 'y': y, 'id': 1}]
        self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': pts})
    def drag(self, x, y0, y1, steps=12, hold_ms=0, shot=None):
        self._send('touchStart', x, y0)
        for i in range(1, steps + 1):
            self._send('touchMove', x, y0 + (y1 - y0) * i / steps)
            self.page.wait_for_timeout(16)
        if hold_ms: self.page.wait_for_timeout(hold_ms)
        if shot: self.page.screenshot(path=str(shot))
        self._send('touchEnd')
        self.page.wait_for_timeout(60)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 700}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: print('LOG', m.type, m.text) if m.type in ('error','warning') else None)

    def load(model, expanded=()):
        f = OUT / 'reorder-harness.html'
        f.write_text(page_html(model, list(expanded)), encoding='utf-8')
        page.goto('about:blank'); page.goto(f.as_uri())   # 每次都是全新的頁面（全域變數不殘留）
        try:
            page.wait_for_function("document.querySelectorAll('.gn-tnode').length > 0", timeout=3000)
        except Exception:
            print('DEBUG', errors, page.evaluate("[document.querySelectorAll('.gn-tnode').length, typeof model, document.readyState, location.href]"))
            raise
        return Touch(page)

    # ── 1. 把手尺寸與位置 ──
    t = load({'/': ROOT})
    g = center(page, 'inbox', '.gn-tgrip'); r = center(page, 'inbox')
    assert g['w'] >= 44 and g['h'] >= 44 - 0.5, f'把手觸控目標太小：{g["w"]}×{g["h"]}'
    assert abs(g['right'] - r['right']) < 1, '把手應貼齊列的右緣'
    assert abs(g['h'] - r['h']) < 1, f'把手應吃滿整列高度（把手 {g["h"]}、列 {r["h"]}）'
    row_h = r['h']
    ta = page.evaluate("getComputedStyle(document.querySelector('.gn-tgrip')).touchAction")
    assert ta == 'none', ta
    hit = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); return e.className; }", [g['x'], g['y']])
    assert hit == 'gn-tgrip', f'把手中心點實際點到的是 .{hit}（被別的元素蓋住了）'
    page.screenshot(path=str(OUT / 'reorder-1-mode.png'))
    # 「完成」按鈕與提示不能被底部工具列蓋住
    vis = page.evaluate('''(() => { const d = document.getElementById('done').getBoundingClientRect(), b = document.querySelector('.gn-bar').getBoundingClientRect(),
        sb = document.querySelector('.gn-tselbar').getBoundingClientRect();
        const hit = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2);
        return { hit: hit && hit.id, selBottom: sb.bottom, barTop: b.top, barH: b.height, vh: innerHeight }; })()''')
    assert vis['hit'] == 'done', f'「完成」按鈕被蓋住了：{vis}'
    assert vis['selBottom'] <= vis['barTop'], f'操作條（底 {vis["selBottom"]}）壓到工具列（頂 {vis["barTop"]}）'
    sb = page.evaluate("(() => { const r = document.querySelector('.gn-tselbar').getBoundingClientRect(), t = document.querySelector('.gn-tree').getBoundingClientRect(); return { w: r.width, right: r.right, treeRight: t.right, treeW: t.width }; })()")
    d = page.evaluate("(() => { const r = document.getElementById('done').getBoundingClientRect(); return { w: r.width, h: r.height }; })()")
    assert abs(sb['w'] - (sb['treeW'] - 16)) < 1, f'操作條應與左欄同寬（左右各留 8px），實際 {sb["w"]} / 左欄 {sb["treeW"]}'
    assert d['w'] > sb['w'] - 12 and d['h'] >= 44, f'「完成」應填滿整條、高度至少 44px，實際 {d}'
    ok(f'「完成」在工具列上方、沒被蓋住；按鈕 {d["w"]:.0f}×{d["h"]:.0f}px，寬度同左欄（左欄 {sb["treeW"]:.0f}px）')
    ok(f'把手 {g["w"]:.0f}×{g["h"]:.0f}px、貼齊右緣、吃滿列高（列高 {row_h:.0f}px，多了把手沒有變高）')

    # ── 2. 觸控：把第一個拖到第三、四個之間 ──
    g = center(page, 'inbox', '.gn-tgrip'); tgt = center(page, 'Project')
    t.drag(g['x'], g['y'], tgt['top'] + 4, hold_ms=250, shot=OUT / 'reorder-2-dragging.png')
    assert order(page) == ['每日筆記', 'Studio', 'inbox', 'Project', 'Learning', 'Library', 'img', 'Archived'], order(page)
    assert page.evaluate('drops.length') == 1
    assert page.evaluate('window.rowClicks') == 0, '拖曳不該被當成點擊'
    assert not page.evaluate('window.scrolled'), '拖把手時左欄不該跟著捲'
    ok('觸控拖把手：inbox 排到 Project 前面，沒有誤觸點擊、左欄沒有跟著捲')

    # ── 3. 拖到最後面 ──
    g = center(page, '每日筆記', '.gn-tgrip'); last = center(page, 'Archived')
    t.drag(g['x'], g['y'], last['bottom'] + 30)
    assert order(page)[-1] == '每日筆記', order(page)
    ok('拖到所有列下方 → 排到最後')

    # ── 4. 拖回最前面 ──
    g = center(page, '每日筆記', '.gn-tgrip'); first = center(page, order(page)[0])
    t.drag(g['x'], g['y'], first['top'] - 20)
    assert order(page)[0] == '每日筆記', order(page)
    ok('拖到最上方 → 排到最前')

    # ── 5. 原地放開、或只動一點點 → 不寫入 ──
    n = page.evaluate('drops.length')
    g = center(page, 'Studio', '.gn-tgrip')
    t.drag(g['x'], g['y'], g['y'] + 6)
    assert page.evaluate('drops.length') == n, '順序沒變不該觸發寫入'
    assert page.evaluate("document.querySelectorAll('.gn-tbefore,.gn-tafter,.gn-treorder-drag').length") == 0, '放開後不該留下提示線或拖曳樣式'
    assert page.evaluate("[...document.querySelectorAll('.gn-tnode')].every(e => !e.style.transform)"), '放開後位移要清掉'
    ok('順序沒變就不寫入，提示線與位移都會清乾淨')

    # ── 6. 把手以外的地方照常可以捲動（長清單）──
    many = [f'資料夾{i:02d}' for i in range(40)]
    t = load({'/': many})
    nm = center(page, '資料夾05', '.gn-tname')
    t.drag(nm['x'], nm['y'] + 200, nm['y'] - 100)
    sc = page.evaluate("document.querySelector('.gn-tree-scroll').scrollTop")
    assert sc > 100, f'在列名上滑動應該捲動左欄，實際 scrollTop={sc}'
    assert page.evaluate('drops.length') == 0
    ok(f'把手以外的地方照常捲動（捲了 {sc:.0f}px），不會誤觸排序')

    # ── 7. 拖到底緣停住 → 自動往下捲，可以一路排到看不到的位置 ──
    page.evaluate("document.querySelector('.gn-tree-scroll').scrollTop = 0"); page.wait_for_timeout(50)
    g = center(page, '資料夾01', '.gn-tgrip')
    box = page.evaluate("(() => { const b = document.querySelector('.gn-tree-scroll').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })()")
    t.drag(g['x'], g['y'], box['bottom'] - 12, hold_ms=1200, shot=OUT / 'reorder-3-autoscroll.png')
    sc = page.evaluate("document.querySelector('.gn-tree-scroll').scrollTop")
    o = order(page)
    idx = o.index('資料夾01')
    assert 300 < sc < 800, f'自動捲動速度不對：1.2 秒捲了 {sc}px（預期約每秒 480px）'
    assert idx > 14, f'應排到原本畫面外的位置，實際第 {idx} 個'
    ok(f'停在底緣會自動捲動（1.2 秒捲了 {sc:.0f}px），資料夾01 排到第 {idx + 1} 個')

    # ── 8. 巢狀：只在同一層內排序；展開的資料夾連同子列一起動 ──
    model = {'/': ['inbox', 'Project', 'Studio', 'Library'], 'Project': ['Project/work', 'Project/side', 'Project/archive'], 'Studio': ['Studio/a', 'Studio/b']}
    t = load(model, ['Project', 'Studio'])
    for pth in ['Project', 'Studio', 'inbox', 'Project/work']:
        gg = center(page, pth, '.gn-tgrip')
        hit = page.evaluate("([x, y]) => document.elementFromPoint(x, y).className", [gg['x'], gg['y']])
        assert hit == 'gn-tgrip', f'{pth} 的把手被 .{hit} 蓋住'
        assert abs(gg['right'] - center(page, pth)['right']) < 1, f'{pth} 的把手沒貼齊右緣'
    cg = center(page, 'Project', '.gn-tcaret'); gg = center(page, 'Project', '.gn-tgrip'); nm = center(page, 'Project', '.gn-tname')
    assert cg['right'] <= gg['left'] + 0.5, f'箭頭（右 {cg["right"]}）與把手（左 {gg["left"]}）重疊'
    assert nm['right'] <= cg['left'] + 0.5, f'名稱（右 {nm["right"]}）壓到箭頭（左 {cg["left"]}）'
    assert cg['w'] >= 34 and cg['h'] >= 34
    page.screenshot(path=str(OUT / 'reorder-5-nested-mode.png'))
    page.touchscreen.tap(cg['x'], cg['y']); page.wait_for_timeout(40)
    assert page.evaluate("!expanded.has('Project')"), '排序模式下點箭頭應該仍可收合'
    cg = center(page, 'Project', '.gn-tcaret')
    page.touchscreen.tap(cg['x'], cg['y']); page.wait_for_timeout(40)
    assert page.evaluate("expanded.has('Project')")
    assert page.evaluate('window.rowClicks') == 0
    ok('可展開的列：把手與展開箭頭並排不重疊，箭頭照常可以展開／收合')
    # 子層：work 拖到最下面（手指甚至拖過了下面的 Studio、Library）
    g = center(page, 'Project/work', '.gn-tgrip'); lib = center(page, 'Library')
    t.drag(g['x'], g['y'], lib['bottom'] + 10)
    assert order(page, 'Project') == ['Project/side', 'Project/archive', 'Project/work'], order(page, 'Project')
    assert order(page) == ['inbox', 'Project', 'Studio', 'Library'], '上一層的順序不該被動到'
    ok('子資料夾只在自己那一層排序，拖過頭也不會跑到別層')
    # 上層：拖展開中的 Project 到 Studio（也展開）後面；子列要跟著動
    g = center(page, 'Project', '.gn-tgrip'); sb = center(page, 'Studio/b')
    t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': g['x'], 'y': g['y'], 'id': 1}]})
    for i in range(1, 11):
        t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': g['x'], 'y': g['y'] + (sb['bottom'] - 2 - g['y']) * i / 10, 'id': 1}]})
        page.wait_for_timeout(16)
    page.wait_for_timeout(40)
    page.wait_for_timeout(250)   # 等讓位的過渡跑完再看
    moving = page.evaluate("[...document.querySelectorAll('.gn-treorder-drag')].map(e => e.dataset.path)")
    shifted = page.evaluate("[...document.querySelectorAll('.gn-tnode:not(.gn-treorder-drag)')].filter(e => e.style.transform).map(e => [e.dataset.path, e.style.transform])")
    overlap = page.evaluate('''(() => { const rs = [...document.querySelectorAll('.gn-tnode:not(.gn-treorder-drag)')].map(e => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
        let worst = 0; for (let i = 1; i < rs.length; i++) worst = Math.max(worst, rs[i - 1].bottom - rs[i].top); return worst; })()''')
    page.screenshot(path=str(OUT / 'reorder-4-nested.png'))
    t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(60)
    assert moving == ['Project', 'Project/side', 'Project/archive', 'Project/work'], moving
    assert [x[0] for x in shifted] == ['Studio', 'Studio/a', 'Studio/b'], shifted
    assert all(x[1] == shifted[0][1] and x[1].startswith('translateY(-') for x in shifted), shifted
    assert overlap < 1.5, f'讓位後列與列不該重疊（最大重疊 {overlap:.1f}px）'
    assert order(page) == ['inbox', 'Studio', 'Project', 'Library'], order(page)
    ok(f'展開的資料夾連同 3 個子列一起移動；被越過的 Studio 那一組（含子列）整組往上讓出 {shifted[0][1][11:-1]}，列與列沒有重疊')

    # ── 9. 這一層只有一個資料夾 → 沒有把手 ──
    t = load({'/': ['A', 'B'], 'A': ['A/only']}, ['A'])
    assert page.evaluate("[...document.querySelectorAll('.gn-tnode')].find(e => e.dataset.path === 'A/only').querySelector('.gn-tgrip')") is None
    ok('同層只有一個資料夾時不顯示把手')

    # ── 10. 系統中途取消觸控（來電、邊緣滑動）→ 不寫入、樣式清乾淨 ──
    t = load({'/': ROOT})
    g = center(page, 'inbox', '.gn-tgrip'); tgt = center(page, 'Learning')
    t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': g['x'], 'y': g['y'], 'id': 1}]})
    for i in range(1, 9):
        t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': g['x'], 'y': g['y'] + (tgt['y'] - g['y']) * i / 8, 'id': 1}]})
        page.wait_for_timeout(16)
    t.cdp.send('Input.dispatchTouchEvent', {'type': 'touchCancel', 'touchPoints': []})
    page.wait_for_timeout(60)
    assert order(page) == ROOT and page.evaluate('drops.length') == 0
    assert page.evaluate("document.querySelectorAll('.gn-tbefore,.gn-tafter,.gn-treorder-drag,.gn-treorder-active').length") == 0
    page.wait_for_timeout(300)   # 取消後列會滑回原位，等它停好
    back = [round(center(page, p_)['top']) for p_ in ROOT]
    assert back == sorted(back) and len(set(back)) == len(back), back
    ok('觸控被系統取消時不寫入、不留殘影，列滑回原位')

    # ── 11. 滑鼠也能拖（桌機上測試用）──
    g = center(page, 'inbox', '.gn-tgrip'); tgt = center(page, 'Studio')
    page.mouse.move(g['x'], g['y']); page.mouse.down()
    page.mouse.move(g['x'], tgt['bottom'] - 3, steps=8); page.wait_for_timeout(40); page.mouse.up(); page.wait_for_timeout(40)
    assert order(page)[:3] == ['每日筆記', 'Studio', 'inbox'], order(page)
    ok('滑鼠拖曳同樣可用')

    assert not errors, errors
    browser.close()
print(f'\n{passed} 項全過（截圖在 {OUT}）')
