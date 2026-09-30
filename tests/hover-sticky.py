"""觸控裝置上 hover 會不會「黏住」的測試（無頭 Chromium，不碰使用者的 Obsidian）。

檢查兩件事：
  1. 手機（body.is-mobile、觸控）：點一下再放開之後，元素的外觀要和點之前一樣。
  2. 桌機：滑鼠移上去，該有 hover 效果的元素外觀確實會變（沒有把 hover 整個弄丟）。

加 --before <舊的 styles.css>：另外比對桌機在新舊兩份樣式下的結果，hover 前後都必須完全相同
（用來確認「排除手機」的改法沒有動到桌機的規則先後順序）。

用法：python3 tests/hover-sticky.py [外掛資料夾] [--before 舊的styles.css]
"""
import pathlib, sys, tempfile
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith('--')]
before = None
if '--before' in sys.argv:
    before = pathlib.Path(sys.argv[sys.argv.index('--before') + 1])
    args = [a for a in args if a != str(before)]
PLUGIN = pathlib.Path(args[0]) if args else pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(tempfile.mkdtemp(prefix='gn-hover-'))

BOX = 'position:relative;display:block;width:220px;height:34px;margin:6px;inset:auto;'          # 受測元素：只固定版面，不碰外觀
WRAP = 'position:static;display:block;width:auto;height:auto;transform:none;opacity:1;overflow:visible;padding:0;visibility:visible;'  # 容器：攤平成一般區塊

# (id, 說明, 桌機 hover 時外觀應該會變)
ITEMS = [
    ('t1', '資料夾列', True), ('t2', '選取中的資料夾列', False), ('t3', '多選中的資料夾列', False),
    ('t4', '拖曳落點的資料夾列', False), ('t5', '隱藏的資料夾列', True), ('fav', '最愛標題列', True),
    ('sb', '多選動作列按鈕', True), ('sw', '多選動作列的刪除鈕', True), ('pin', '卡片釘選鈕', True),
    ('sc', '搜尋清除鈕', True), ('chip', '標籤晶片', True), ('chipon', '選中的標籤晶片', False),
    ('row', '更多面板的列', True), ('mclear', '更多面板的清除', True), ('htag', '表頭標籤', True),
    ('tclear', '標籤列的清除', True), ('lb', '原生看圖器上的動作鈕', True),
    ('lc', '連結卡', True), ('lct', '染色的連結卡', True), ('ob', '連結卡的開啟鈕', True),
    ('btn', '手機工具列按鈕', False), ('btnon', '手機工具列按鈕（開啟中）', False), ('qp', '自製預覽的按鈕', True),
]
PROPS = ['backgroundColor', 'color', 'opacity', 'transform', 'borderTopColor', 'boxShadow']

def html(css, mobile):
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>* {{ box-sizing: border-box; }}
body {{ margin:0; --background-primary:#fff; --background-secondary:#f4f4f2; --background-modifier-border:#ddd;
  --background-modifier-hover:rgba(0,0,0,.06); --background-modifier-error:rgba(220,60,60,.15); --interactive-accent:#7b6cd9;
  --text-on-accent:#fff; --text-normal:#222; --text-muted:#666; --text-faint:#aaa; --text-error:#c33; }}
/* 過渡與動畫關掉，量到的才是最終值 */
*, *::before, *::after {{ transition: none !important; animation: none !important; }}</style>
<style>{css}</style></head>
<body class="{'is-mobile' if mobile else ''} theme-light">
<div class="gn-root" style="{WRAP}"><div class="gn-split" style="{WRAP}"><div class="gn-tree" style="{WRAP}"><div class="gn-tree-scroll" style="{WRAP}">
  <div class="gn-tnode" id="t1" data-gn-folder="1" style="{BOX}"><span class="gn-tname">資料夾</span></div>
  <div class="gn-tnode gn-tsel" id="t2" data-gn-folder="1" style="{BOX}"><span class="gn-tname">選取</span></div>
  <div class="gn-tnode gn-tmulti" id="t3" data-gn-folder="1" style="{BOX}"><span class="gn-tname">多選</span></div>
  <div class="gn-tnode gn-tmove" id="t4" data-gn-folder="1" style="{BOX}"><span class="gn-tname">落點</span></div>
  <div class="gn-tnode gn-thidden" id="t5" data-gn-folder="1" style="{BOX}"><span class="gn-tname">隱藏</span></div>
  <div class="gn-fav-head" id="fav" style="{BOX}">最愛</div>
</div></div>
<div class="gn-main" style="{WRAP}">
  <div class="gn-selbar" style="{WRAP}"><div class="gn-selbar-btn" id="sb" style="{BOX}"></div><div class="gn-selbar-btn gn-selbar-warn" id="sw" style="{BOX}"></div></div>
  <div class="gn-card" style="{WRAP}"><div class="gn-card-pin" id="pin" style="{BOX}"></div></div>
  <div class="gn-search-clear" id="sc" style="{BOX}"></div>
  <div class="gn-more-chip" id="chip" style="{BOX}">#tag</div>
  <div class="gn-more-chip gn-more-chip-on" id="chipon" style="{BOX}">#tag</div>
  <div class="gn-more-row" id="row" style="{BOX}"></div>
  <div class="gn-more-clear" id="mclear" style="{BOX}">清除</div>
  <div class="gn-head-tag" id="htag" style="{BOX}">#tag</div>
  <div class="gn-tagbar-clear" id="tclear" style="{BOX}">清除</div>
</div></div>
<div class="gn-bar" style="{WRAP}"><div class="gn-btn" id="btn" style="{BOX}"></div><div class="gn-btn gn-btn-on" id="btnon" style="{BOX}"></div></div>
</div>
<div class="lightbox" style="{WRAP}"><div class="gn-lb-btn" id="lb" style="{BOX}"></div></div>
<div class="lcp-card lcp-card--compact" id="lc" style="{BOX}"></div>
<div class="lcp-card lcp-card--compact lcp-card--tinted" id="lct" style="{BOX}--lcp-tint: 200, 100, 50;"></div>
<div class="lcp-lp-inner" style="{WRAP}"><div class="lcp-open-btn" id="ob" style="{BOX}"></div></div>
<div class="image-peek-overlay" style="{WRAP}"><div class="qp-header" style="{WRAP}"><div class="qp-btn" id="qp" style="{BOX}"></div></div></div>
</body></html>"""

JS_STYLE = "(id) => { const c = getComputedStyle(document.getElementById(id)); return %s.map((p) => c[p]).join(' | '); }" % PROPS

def load(page, css, mobile, name):
    f = OUT / name
    f.write_text(html(css, mobile), encoding='utf-8')
    page.goto('about:blank'); page.goto(f.as_uri())

def center(page, id_):
    return page.evaluate("(id) => { const el = document.getElementById(id); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }", id_)

def desktop_snapshot(pw, css):
    b = pw.chromium.launch(); page = b.new_context(viewport={'width': 900, 'height': 900}).new_page()
    load(page, css, False, 'desktop.html')
    out = {}
    for id_, _, _ in ITEMS:
        page.mouse.move(880, 5)
        base = page.evaluate(JS_STYLE, id_)
        # 移兩次：有些元素要等外層先進入 hover 才接受指標（釘選鈕），第二次移動才點得到它
        x, y = center(page, id_); page.mouse.move(x, y); page.mouse.move(x + 1, y + 1)
        out[id_] = (base, page.evaluate(JS_STYLE, id_))
    b.close()
    return out

def mobile_sticky(pw, css):
    b = pw.chromium.launch(); page = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True).new_page()
    load(page, css, True, 'mobile.html')
    stuck, tested = [], 0
    for id_, label, _ in ITEMS:
        base = page.evaluate(JS_STYLE, id_)
        x, y = center(page, id_); page.touchscreen.tap(x, y)
        # 放開後 :active 還會留一小段時間（瀏覽器刻意讓按壓回饋看得見）→ 等它結束再量，
        # 這時元素仍處於 :hover（觸控沒有「移開」），量到的差異才是黏住的 hover
        page.wait_for_function("(id) => !document.getElementById(id).matches(':active')", arg=id_, timeout=3000)
        # 點不到的元素（例如平常不接受點擊的釘選鈕）不會進入 :hover，也就不會黏 → 不列入
        if not page.evaluate("(id) => document.getElementById(id).matches(':hover')", id_): continue
        tested += 1
        after = page.evaluate(JS_STYLE, id_)
        if after != base: stuck.append(label)
    b.close()
    return stuck, tested

with sync_playwright() as pw:
    css = (PLUGIN / 'styles.css').read_text(encoding='utf-8')
    n = 0
    stuck, tested = mobile_sticky(pw, css)
    assert not stuck, '手機點過之後外觀沒有還原：' + '、'.join(stuck)
    assert tested >= 20, f'實際測到的元素太少（{tested}），測試頁可能壞了'
    print(f'  ✓ 手機：{tested} 種元素點過之後（仍停在 hover 狀態）外觀都還原，沒有黏住'); n += 1

    now = desktop_snapshot(pw, css)
    dead = [label for id_, label, should in ITEMS if should and now[id_][0] == now[id_][1]]
    assert not dead, '桌機 hover 沒有效果：' + '、'.join(dead)
    print(f'  ✓ 桌機：{sum(1 for i in ITEMS if i[2])} 種元素的 hover 效果都還在'); n += 1

    if before:
        old_css = before.read_text(encoding='utf-8')
        old = desktop_snapshot(pw, old_css)
        diff = [label for id_, label, _ in ITEMS if old[id_] != now[id_]]
        assert not diff, '桌機的外觀和修改前不同：' + '、'.join(diff)
        print(f'  ✓ 桌機：{len(ITEMS)} 種元素在 hover 前後的外觀，與修改前逐項相同'); n += 1
        was, _ = mobile_sticky(pw, old_css)
        assert was, '舊樣式應該測得出黏住的 hover（測不出來代表這個測試沒在量對的東西）'
        print(f'  ✓ 對照：修改前手機有 {len(was)} 種元素會黏住（' + '、'.join(was) + '）'); n += 1
print(f'\n{n} 項全過')
