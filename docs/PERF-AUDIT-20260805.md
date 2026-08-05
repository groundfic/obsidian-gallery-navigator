# Gallery Navigator 效能改善工單（2026-08-05 審查）

> 本報告由三個平行審查 agent 深讀全部 `src/`（約 15,600 行）產出，供執行 agent 逐項修復。
> 共 20 個主要問題 + 3 個資料夾層級問題，按嚴重度與建議施工順序排列。

---

## ⚠️ 施工前必讀（專案規約）

1. **只改 `src/` 來源檔，絕不直接改產物** `main.js`、`styles.css`。
   - 建置：`npm run build`（含 CSS）；CSS 單獨 watch：`npm run dev:css`。
   - CSS 來源分四段（`src/gallery.css`、`src/peek.css`、`src/linkcard.css`、`src/header.css`），由 `scripts/build-css.mjs` 合併。
2. **桌機改了，手機一定要一起確認**（歷史上同型錯誤犯過三次以上）：
   - 任何 `:hover` 視覺切換一律加 `body:not(.is-mobile)`（觸控的 hover 會黏住）。
   - 移除事件處理器時，檢查手機是否有平行實作（`contextmenu` ↔ `touchstart` 長按）。
   - 手機常有 `.is-mobile` 尺寸覆寫，注意特異度：`.a:hover .b`（0,4,0）會贏過 `.is-mobile .b`（0,3,0）。
3. **禁用 `:has()`**（上架審查要求，2026-07-31 已全數移除，不要加回來）。改用「JS 在條件成立處掛 state class」模式，參考 `.gn-icon-cover`、`.lcp-has-photo` 的做法。
4. **要覆寫既有樣式先算特異度**，不要假設寫在後面就會贏。
5. `gallery.js` 有兩個大 class：`GalleryView`（畫面）與 `GalleryPlugin`（全域）。**新方法放哪個 class 看呼叫端的 `this`**，放錯會 `is not a function` → render 全白。
6. 每完成一項就跑一次 `npm run build` 確認可建置；行號是審查當下的參考值，以描述的程式碼特徵為準定位。
7. vault 規模參考：img/ 有 4000+ 張高解析圖、數千筆記、跑在桌機 + iOS（iCloud 同步）。**手機是效能重災區，所有修復以手機為第一驗收平台。**

---

## 🥇 Phase 1：快贏（低風險、高收益，先做）

### #1 `linkcard.js:1520` — `this.register(cleanup)` 必炸 TypeError【高】
- **問題**：`LinkCardModule` 是普通 class，沒有 `register` 方法（也沒繼承 Component）。`attachToCanvas` 跑到這行必拋錯，導致：(a) 下一行 `processAll()` 永不執行，Canvas 首次渲染只能靠 MutationObserver；(b) 例外中斷 `syncCanvasObservers` 的 forEach（1451–1464），殭屍 observer 回收跑不到；(c) 外掛卸載時 observer 從未 disconnect，reload 累積殭屍 MutationObserver。
- **修法**：改 `this.plugin.register(cleanup)`。一行修正。
- **驗收**：開一個含連結節點的 Canvas，連結卡首次就渲染；reload 外掛數次後無殘留 observer 觸發。

### #2 `gallery.js:5487, 5539, 1220` — `vault.on('create')` 在 onload 註冊【中】
- **問題**：Obsidian 啟動時對每個既有檔案發 `create`，數千檔 = 數千次回呼 + 反覆清快取（`invalidateFolderCounts` + `refreshViews` 的 150ms debounce 被連續順延）。
- **修法**：三處 create 監聽包進 `this.app.workspace.onLayoutReady(() => …)` 再註冊。
- **驗收**：重啟 Obsidian，啟動期無大量回呼（可暫時加計數 console.log 驗證後移除）。

### #3 `i18n.js:11-17` — `t()` 每次呼叫同步讀 localStorage【低】
- **問題**：`t()` → `currentLang()` → `localStorage.getItem('language')`，在卡片建立、選單建構等渲染路徑被大量呼叫。
- **修法**：模組載入時讀一次快取成變數（語言變更本來就需重載外掛）。
- **驗收**：功能不變，i18n 正常。

### #4 `graph.js:274-278` — RAF 迴圈每幀 5 次 getComputedStyle【高，但改動小】
- **問題**：`draw()` 每幀跑 `this.css()` 五次取色票，收斂前數百幀持續強制 style resolution。
- **修法**：色票在 `mount()`/`resize()`/theme change 時取一次存到實例欄位，`draw()` 只讀快取。
- **驗收**：開關聯圖，顏色正確；切換深淺色主題後顏色跟上。

### #5 `dims.js:64-69, 87-90` — `cancel()` 重置 `busy=0`，in-flight 完成後 busy 變負【低~中】
- **問題**：換資料夾瞬間新舊工作交疊，實際併發變成 `CONCURRENCY + |負值|`，破壞「併發壓住記憶體」的前提。
- **修法**：`finish()` 先檢查 `my !== this.token` 就不動 `busy`；或 `cancel()` 不歸零、讓舊工作自然歸還。
- **驗收**：快速連續切換多個大資料夾，busy 值不為負（可暫時 assert）。

---

## 🥈 Phase 2：日常體感主戰場（gallery.js 渲染路徑）

### #6 小操作觸發整頁 `render()` 全拆全建【高，本工單最重要】
- **位置**：`renderInner()` gallery.js:2657–3196（`root.empty()` 在 2672）。呼叫端：`togglePin` 2108–2114、排序切換 1502–1507、同步定位開關 1601–1607、`toggleFolderPreview` 1982–1988、`setFolderHidden` 1945–1951、`reorderSibling` 2643、`newFile` 1403。
- **問題**：釘選一張卡、切排序等小操作都重建工具列＋左樹（每列重繞 10+ 監聽器、DOMParser 解析 SVG）＋卡片牆（全量資料準備）＋dock/ResizeObserver。4000+ 檔下每次數百 ms。
- **修法**：上述呼叫端降級為 `rerenderMain()`（只重畫右欄）或更細的就地更新（釘選＝把一張卡移到最前，可局部重排）。`render()` 保留給結構性變化（換資料夾/模式/版面設定）。
- **驗收**：在 img/（4000+ 檔）釘選/取消釘選一張卡、切換排序，肉眼無整頁閃爍、左樹捲動位置不跳。**手機也要測。**
- **風險**：注意各呼叫端是否依賴 render() 的副作用（dock 重掛、狀態 class）。逐一改、逐一測，不要一次全換。

### #7 `renderNoteWall()` 全量 `itemFromFile()`【高】
- **位置**：gallery.js:4312–4323；`itemFromFile` 793–805（每 md：regex ×3 + `getFirstLinkpathDest` + `getResourcePath`；每圖：`getResourcePath`）。
- **問題**：虛擬化只掛十幾張卡，但 item 清單先全量建好——4000 檔 = 4000 次封面解析＋排序，發生在每次 render、每次標籤篩選、搜尋牆每次 150ms 重繪。這是「點資料夾第一下卡頓」主因。
- **修法**：(a) `src`（封面）改惰性求值——makeCard 時才算，或物件用 getter + memo；(b) item 清單以 `folder.path + 檔案數 + max(mtime) + 排序鍵` 為 key 快取，vault 事件時失效。
- **驗收**：冷開 img/ 資料夾的首屏時間明顯下降；標籤篩選點擊即時響應；新增/刪除/改名檔案後清單正確更新。

### #8 搜尋前綴展開全表掃描 + modal 無去抖【高】
- **位置**：gallery.js:5404–5416（`for (const key of this.inv.keys())` 對約 29 萬 token 做 `startsWith`）；`GnSearchModal.getSuggestions` 5072–5080 無去抖。
- **修法**：(a) token key 維護排序陣列（增量插入或惰性重建 + dirty flag），前綴查詢二分找上下界 O(log n + k)；(b) modal 輸入加 150ms 去抖（畫廊內搜尋列已有，比照）。
- **驗收**：搜尋 modal 連續打字不卡；結果與改前一致（抽查中英文與前綴查詢）。

### #9 Masonry 任一張圖載入 → 全牆 O(N) 重量測【高】
- **位置**：`MasonryLayout.layout()` gallery.js:207–225（`this.items.map(el => el.offsetHeight)`）。觸發源：容器捕獲 `load`（177）、`loadPreview` → `relayoutWalls()`（2133）、`loadLinkPreview`（2279–2282，put 內、onload、onerror 連叫三次）。
- **問題**：非虛擬化路徑（<300 檔或使用者關虛擬化）下，每張晚到的預覽讓所有卡重新量測；rAF 只合併同幀，跨幀連續載入 = 連續滿版 reflow。
- **修法**：(a) 已定案的卡快取高度，`layout()` 只重測 dirty 的卡（load 回呼標記該卡，或 per-item ResizeObserver）；(b) `el.style.width` 在 colW 未變時跳過寫入（214 行現在同值也寫）；(c) `loadLinkPreview` 三連叫收斂成一次。
- **驗收**：開一個 100–200 檔混合資料夾（含連結卡、文字預覽），載入期間捲動不抖。

### #10 `refreshTree()` 整棵重建：每列 DOMParser + 10+ 監聽器【中】
- **位置**：gallery.js:2505–2514、`buildLevel` 3016–3186、`setSvg` 813–824（每列 `new DOMParser()`，呼叫於 3047、2036）、`wireContextMenu` 1411–1440（每列再 4 個 touch 監聽）。
- **修法**（分兩步，第一步必做，第二步視風險）：
  1. **SVG template 化**：模組層把資料夾/箭頭 SVG 各 parse 一次成 template，之後 `cloneNode(true)`。低風險。
  2. **事件委派**：click/contextmenu/drag 委派到 `treeScroll` 一層，每列監聽降到 0–2 個。中風險，注意 drag 五件套與手機長按計時器的委派語意。
- **驗收**：展開/收合大子樹（>100 列）不頓；拖曳排序、右鍵/長按選單、改色全部正常。**手機長按必測。**

### #11 `folderTags()` 無快取且一次 render 算兩次【中】
- **位置**：gallery.js:1445–1464；呼叫端 `mountDock → buildTagDock` 2394–2396（每次 render 必跑）、`openMorePopover` 1511。
- **修法**：以 `folder.path + flatten` 為 key 快取，與 `buildTagIndex` 共用 `_tagDirty` 失效旗標；同一次 render 兩個呼叫端共用結果。
- **驗收**：攤平模式下開根目錄，標籤 dock 秒出；改筆記 tag 後 dock 會更新。

### #12 `SwapImageModal` 每個 keystroke 全 vault 掃描＋排序【中】
- **位置**:gallery.js:274–277（input → `renderWall()`）、290–297（`candidates()`: `vault.getFiles()` → filter → 全量 sort → slice(0,300)）。
- **修法**：基底清單（getFiles + IMG_EXT filter + mtime sort）在 `onOpen` 算一次快取；input 加 150ms 去抖，keystroke 只做 filter。
- **驗收**：交換圖片 modal 打字流暢，結果正確。

### #13 輪詢與 mousemove 的強制 reflow【中】
- **位置**：(a) `restoreMainScroll()` gallery.js:3209–3227——每 50ms 寫 scrollTop＋讀 scrollHeight，最多 2 秒；(b) 分隔桿拖曳 2956–2976——每個 mousemove 讀 `getBoundingClientRect` ＋寫 flex/CSS 變數，無 rAF 節流（PinterestModal 387–404 同型）；(c) `syncToFile` 的 400ms 固定雙重定位 1327–1328、2050–2052。
- **修法**：(a)(c) 共用一個「內容穩定後定位」機制：ResizeObserver on grid，高度變化時補推 scrollTop，到位或逾時即解除；(b) rect 在 mousedown 讀一次快取，mousemove 只記 clientX、rAF 合併寫入。
- **驗收**：跨資料夾點連結能定位到卡片；拖分隔桿順滑；捲動位置恢復正常。

---

## 🥉 Phase 3：linkcard / peek 模組

### #14 linkcard-cache.json（390KB）整檔重寫過頻【高——iCloud 環境放大】
- **位置**：`saveCache()` linkcard.js:1330–1334（debounce 1350–1356 僅 1.5s、無 flush）。寫入觸發點：596（meta 抓完）、748/775（圖片尺寸）、763（下載圖後）、971（主色）。單張卡完整生命週期排程 3–4 次。
- **修法**：dirty flag + 間隔拉長到 10s + `onunload` flush（避免掉資料）。可選進階：依 key hash 分桶拆檔，只重寫變動桶。
- **驗收**：開含多連結的筆記，觀察 linkcard-cache.json 的 mtime 變化頻率大幅下降；重啟後快取完整。

### #15 失敗連結 15 分鐘 TTL → 開筆記就打網路＋重寫快取【高】
- **位置**：linkcard.js:24（`FAIL_TTL`）、594–597（`poor` 每次完成都更新 ts 並 save）。
- **問題**：含死連結的筆記/Canvas 每次開啟 = 每個死連結 2 輪 UA 請求（最長 12s × 佔並發位）＋整檔重寫。
- **修法**：失敗指數退避（15 分 → 1 小時 → 1 天，記 `failCount`）；meta 無實質變化（仍 poor）時跳過 `state.save()`。
- **驗收**：開含死連結的筆記兩次，第二次無網路請求（15 分內）；退避時間正確遞增。

### #16 Live Preview 每次按鍵/游標移動全文件掃描【高】
- **位置**：linkcard.js:1246–1266（`buildDecos` 逐行 regex + O(ranges) selection 比對）、1285–1295（StateField 在 `docChanged` **和** `tr.selection` 都整份重算）。
- **修法**：只在 `docChanged` 重算 RangeSet；selection 變更走增量路徑（`stripSelected` 已有雛形，用 `RangeSet.update` 只切換受影響行的 widget）。若複雜度過高，退而求其次：selection-only 的 update 加 rAF 合併。
- **驗收**：3000 行含多連結的筆記，按住方向鍵移動游標不卡；連結卡在游標進出該行時顯隱正確。

### #17 fetchGenericMeta：整份 HTML 主執行緒解析 ×2 輪 UA【中】
- **位置**：linkcard.js:355–385（兩輪 UA）、272（DOMParser 全文）、319（querySelectorAll('img') 掃 30 張）。
- **修法**：先只解析回應前 256KB（og/twitter meta 幾乎都在 `<head>`），抓不到再退整份；第二輪 UA 僅在第一輪完全沒有 title 時才發。
- **驗收**：常見站點（YouTube、新聞站、Threads）卡片 metadata 正確；大頁面貼上不卡 UI。

### #18 圖片管線 bytes→base64→dataURL→atob→bytes 四段轉換【中】
- **位置**：linkcard.js:221–229（`arrayBufferToBase64` 字串累加）、602–649、37–48（`dataUriToBytes`）。
- **修法**：改 `createImageBitmap(blob)` → canvas → `toBlob` → `arrayBuffer` → `adapter.writeBinary`，全程不經 base64。
- **驗收**：連結卡圖片下載、縮圖、寫檔正常；手機開大量連結卡不觸發記憶體警告。

### #19 Canvas MutationObserver 全 subtree + 每節點多次 querySelector【中】
- **位置**：linkcard.js:1508–1509（childList+subtree 蓋整個 canvas root）、1548–1597（每 link 節點 `querySelectorAll('iframe, webview')` + `querySelector('.lcp-card')`）。
- **修法**：已處理節點掛 flag（如 `node.dataset.lcpDone` 或 WeakSet）直接跳過；或 observer 只監聽 `.canvas-node` 增刪。
- **驗收**：大 Canvas 平移/縮放流暢；新增連結節點仍會渲染卡片。
- **依賴**：先修 #1（同一區的 register 炸掉會遮蔽這裡的行為）。

### #20 Pinterest：80 HEAD 探測 + gif 命中即全量下載【中】
- **位置**：peek-pinterest.ts:662–680（`renderPins` 對每 pin 立即 `probePinGif`，命中就 `im.src = gif`，離屏也下載並播放）；相關：78–99。
- **修法**：IntersectionObserver——pin 進入視野才探測、才換 gif；`page_size` 從 80 降到 ~30（fetchPage 每頁都重新上傳整張查詢圖，469–491，頁小一點單次負擔低）。順手：`gifCache`（peek-pinterest.ts:65）加上限（500 筆 FIFO）或 `close()` 清空。
- **驗收**：以圖搜圖結果頁捲動流暢，gif 只在可見時載入播放；iOS 流量明顯下降。

---

## 🎨 Phase 4：CSS / 合成層（全部低風險，注意規約 2、3、4）

### #21 peek.css 多層 backdrop-filter 疊加【高（iOS）】
- **位置**：peek.css:21（背幕 blur 10px）、156（標題列 blur 12px）、1006（桌機面板）、482（Pinterest 全螢幕 blur 8px）、822（面板）；手機膠囊 peek.css:405 與 gallery.css:1677 blur(20px)。
- **修法**：同一時間只留一層 blur；手機版全部改半透明實色（本來就黑底）；拖曳縮放中（`qp-grabbing`）暫時停用 blur。
- **注意**：2026-08-01 已為對齊原生 lightbox 移除背幕 blur——確認不要動到 `.lightbox` 覆寫區的讓位規則。
- **驗收**：iOS 開 Peek 縮放拖曳圖片流暢；視覺上與現行無明顯差異（截圖比對）。

### #22 卡片 hover 過渡 box-shadow【中】
- **位置**：gallery.css:488–494（hover 同時過渡 transform + box-shadow 18px）、497–499（active/selected 也用 box-shadow 當外框）。
- **修法**：陰影預繪在 `::after`（常駐兩層），hover 只過渡 `::after` 的 opacity + 本體 transform；選取/active 框改 `outline`。
- **注意**：`.gn-card-selected::after` 已存在（inset:0 那組），確認新 pseudo 不衝突；hover 規則維持 `body:not(.is-mobile)`。
- **驗收**：滑鼠快速掃過卡片牆無掉幀；選取框視覺不變。

### #23 virtual.js 寫 left/top 而非 transform【中】
- **位置**：virtual.js:302–305（repack 後寫 left/top/width）。
- **修法**：定位改 `transform: translate(Lpx, Tpx)`；`width` 只在 colW 變化時寫。位移變 compositor-only。
- **注意**：確認沒有其他程式讀取 `style.left/top` 反推位置；卡片內絕對定位子元素（釘選角標等）不受影響。
- **驗收**：4000 檔資料夾捲動 + 圖片陸續載入時 repack 不引發整 grid layout（DevTools Performance 驗證）。

### #24 其餘 CSS / virtual 小項【低，一起掃】
- linkcard.css:438–439 `transition: background-image` → 改 `<img>` + opacity 淡入或只過渡 background-color。
- linkcard.css:300–336 shimmer 用 background-position 無限動畫 → 改 pseudo-element + `transform: translateX`，並納入 `prefers-reduced-motion`。
- virtual.js:262–274 捲動每幀 O(n) 建 Set → `top[]` 近似遞增，二分找視窗上下界，只掃區間。
- virtual.js:307/419 每張圖 onload 全量 measure → `_scheduleMeasure` 改 ~50ms trailing debounce。
- gallery.css:9–12 root 漸層綁 `--gn-treew`，拖分隔桿整 root 重繪 → 交界線改獨立 1px 元素 transform 移動（可選，低優先）。

---

## 🧮 Phase 5：graph / thumbs（功能預設關或觸發面窄，最後做)

### #25 graph.js `inn()` 全 vault 掃描【高（開啟該功能時）】
- **位置**：graph.js:113（`Object.keys(resolved).filter(...)` 對 frontier 每節點掃 4000+ key，每層 depth 一輪，每次 `setFile` 觸發）。
- **修法**：啟用時建一次反向索引 `Map<path, inbound[]>`，掛 `metadataCache.on('resolved')` 重建；查詢 O(1)。
- **順手**：`build()` 節點數截斷（~150，按距中心層數）；`step()`:220 與 `draw()`:280 每幀 `new Map` → build 時把 link 存節點參照。

### #26 thumbs.js 全尺寸解碼原圖【高（記憶體）】
- **位置**：thumbs.js:147（`createImageBitmap(blob)` 無 resize：6000×4000 → ~96MB 點陣圖，桌機並發 2 = 峰值 ~192MB）。
- **修法**：先查 `plugin._dimIndex`（dims.js 已維護長寬），已知長邊 > THUMB_MAX 就 `createImageBitmap(blob, { resizeWidth 或 resizeHeight, resizeQuality: 'high' })`（只給一邊等比縮）；dims 未知才退回現行路徑。
- **順手**：thumbs.js:117–120 佇列改 LIFO（`queue.pop()`），讓可視卡片優先；VirtualWall destroy 時移除該卡 pending 項。

### #27 cleanlink.js 右鍵選單同步全文掃描 ×2【中】
- **位置**：cleanlink.js:396、413（`buildMenu` 同步跑 `cleanText(editor.getValue())` 與 `findShortUrls(editor.getValue())`）。
- **修法**：合併為單次掃描；或選單標題不預算數量（「淨化整篇連結」），點擊後才計算。
- **驗收**：幾千行筆記開右鍵選單無延遲。

---

## 📦 資料夾層級（不動程式碼，需使用者確認後執行）

1. **備份檔**：`_backup_main_20260713.js`（142KB）、`main.js.bak-20260713`、`main.js.bak-20260729`（合計 ~530KB）躺在 iCloud 同步範圍。→ **先問使用者**是否移出 vault 或刪除（git 已有歷史）。
2. **`og-cache/` 49MB、`linkcard-images/` 24MB** 在 iCloud 內持續吃同步頻寬。→ 評估：og-cache 加總量上限與 LRU 清理；或提供「清理快取」指令。**動手前先問使用者。**
3. `gallery.js` 記憶體快取無上限小項：`_tintCache`（3952）加 FIFO 上限；`_pinGifCache`（73）同；`saveDimIndex`（5864–5875）改「變更數門檻 + idle」再全量 stringify。

---

## ✅ 總驗收清單（全部完成後）

- [ ] `npm run build` 成功，無 console error。
- [ ] 桌機：開 img/（4000+ 檔）首屏 <1s；釘選/排序不整頁閃爍；搜尋打字不卡。
- [ ] **手機（iOS）**：同上全部重測；另測長按選單、雙欄平移、Peek 縮放拖曳。
- [ ] Canvas：連結卡首次即渲染、平移縮放流暢。
- [ ] reload 外掛 3 次無殭屍 observer / 監聽器累積。
- [ ] linkcard-cache.json 寫入頻率下降（開筆記後觀察 mtime）。
- [ ] 深淺色主題切換後關聯圖、卡片配色正常。
- [ ] 視覺迴歸：卡片 hover/選取、Peek 背幕、shimmer 骨架與現行截圖比對無明顯差異。

## 🚫 明確不要做

- 不要重新引入 `:has()`。
- 不要動 `.lightbox` 原生 class 對齊那套讓位規則（2026-08-01 的成果）。
- 不要改 `renderInChunks` 的 off-by-one 保護與 render 錯誤保護殼（Notice）。
- 不要動 `inbox/` 等 vault 內容檔案；本工單只動外掛程式碼。
- 資料夾層級的刪檔/搬移（備份檔、快取瘦身）一律先徵得使用者同意。

## 審查時確認過健康、不需動的部分

virtual.js 主幹（RAF 節流、批次讀寫、fling 跳過建卡、高度單向成長）、graph.js 動能停止條件、thumbs.js `bmp.close()` 與序列化併發、PDF 縮圖 LRU、墓碑式搜尋索引、`folderFileCount` / `buildBacklinkIndex` 快取、`treePlay` 讀寫分離、`syncDockBounds` 批次讀取、cleanlink URL 正則無回溯、linkcard inflight 去重＋併發 4＋12s 逾時、peek-pinterest `toJpeg` 的 revokeObjectURL、CSS 無 `transition: all`、will-change 無濫用。
