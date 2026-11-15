'use strict';

/* ===== i18n =====
   規則：
   - 程式裡一律寫英文原文：t('Search notes')。英文＝key 本身 → 永遠不會漏翻壞掉。
   - 語言偵測：預設跟隨 Obsidian 介面語言（localStorage 'language'；null = en）。
   - 設定頁可手動覆寫（''=自動 / 'en' / 'zh-TW' / 'zh-CN'），由 setLang() 注入。
   - 維護 zh-TW 與 zh-CN（簡體，2026-11 加入）兩份字典；加語言＝加一個字典 + LANGS 一個 entry。 */

/* ⚠️ 這裡的 localStorage 是**唯讀**，而且讀的是 Obsidian 自己的介面語言設定
      （key 'language' 由 Obsidian 寫入，不是本外掛的資料）。

   本外掛自己的設定一律走官方的 plugin data API（loadData/saveData → data.json），
   包含使用者在設定頁選的語言覆寫（state.lang）。這裡只是在「自動」模式下
   偵測該跟隨哪一種語言，never writes：整份程式碼沒有任何 localStorage.setItem。

   只在模組載入時讀一次：t() 會在卡片與選單的建構路徑上被大量呼叫，
   每次都同步讀 localStorage 太貴；改語言本來就需要重載外掛（或走 setLang）。 */
const OBSIDIAN_LANG = (() => {
  try { return window.localStorage.getItem('language') || 'en'; } catch (e) { return 'en'; }
})();

let forced = '';
let _lang = OBSIDIAN_LANG;   // 解析後的目前語言
let _dict = null;            // 解析後的字典（null = 用英文原文）
let _isZh = false;
// 只有 setLang()（載入時、設定頁切換時）會重算，t() 全程只讀快取

/* 語言代碼正規化：大小寫不敏感、底線視同連字號。zh 系列按文字分流——
   帶 tw / hk / mo / hant → 繁體，其餘 zh（含裸 'zh'、cn、sg、hans）→ 簡體。
   以前 LANGS 只有 'zh-cn' 這個小寫 key，永遠匹配不到 Obsidian 實際寫入的
   'zh-CN'，簡體使用者被無條件塞了繁體字典；現在 'zh-CN' 會命中 ZH_CN。 */
function normalizeLang(l) {
  const s = String(l || '').toLowerCase().replace(/_/g, '-');
  if (!s || s === 'en' || s.startsWith('en-')) return 'en';
  if (s.startsWith('zh')) return /(tw|hk|mo|hant|cht)/.test(s) ? 'zh-TW' : 'zh-CN';
  return s;
}
function resolveLang() {
  _lang = normalizeLang(forced || OBSIDIAN_LANG);
  _isZh = _lang.startsWith('zh');
  _dict = LANGS[_lang] || null;
}
function setLang(l) { forced = l || ''; resolveLang(); }
function currentLang() { return _lang; }
function isZh() { return _isZh; }

const ZH_TW = {
  // ── 指令 ──
  'Open Gallery Navigator': '開啟 Gallery Navigator',
  'Open in Gallery Navigator': '在 Gallery Navigator 開啟',
  'Search (popup)': '懸浮搜尋',
  'Search: extract all PDF text (Text Extractor)': '搜尋：擷取全部 PDF 內文（text-extractor）',
  'Search: rebuild index': '搜尋：強制重建索引',

  // ── 懸浮搜尋 ──
  'Search notes and PDFs (full-text)…': '搜尋筆記與 PDF（全文搜尋）…',
  'No matching notes': '找不到符合的筆記',
  'to navigate': '移動',
  'to open': '開啟',
  'to open in a new tab': '新分頁開啟',
  'show all results in gallery': '在畫廊顯示全部結果',

  // ── 工具列 ──
  'Close search': '關閉搜尋',
  'Search notes (full-text popup)': '搜尋筆記（懸浮全文搜尋）',
  'Current: tags (click to switch to folders)': '目前：標籤（點擊切回資料夾）',
  'Current: folders (click to switch to tags)': '目前：資料夾（點擊切到標籤）',
  'Follow active note': '定位目前筆記',
  'Hide hidden folders': '收起被隱藏的資料夾',
  'Show hidden folders': '顯示被隱藏的資料夾',
  'Create here (folder / note / canvas / base)': '在此新建（資料夾 / 筆記 / Canvas / Base）',
  'More (card layout / size / corners)': '更多（卡片版型 / 大小 / 圓角）',
  'Search full text…': '搜尋全文…',

  // ── 設定頁 ──
  'Language': '語言',
  'Interface language. Auto follows the Obsidian language setting.': '介面語言。「自動」跟隨 Obsidian 的介面語言設定。',
  'Auto': '自動',
  'Card wall': '卡片牆',
  'Image peek': '圖片預覽',
  'Link cards': '連結卡片',
  'Enable image peek': '啟用圖片預覽',
  'Enable link cards': '啟用連結卡片',
  'Mobile columns': '手機的卡片欄數',
  'Takes effect after reloading the plugin (or restarting Obsidian)': '重新載入外掛（或重啟 Obsidian）後生效',
  'Canvas has no built-in image viewer, so this fills that gap: double-click an image or press Space. Matches the look of the lightbox Obsidian shows in notes. Notes themselves are left to Obsidian.':
    'Canvas 沒有內建的圖片檢視，這裡補上：雙擊圖片或按 Space。外觀與 Obsidian 在筆記中的 lightbox 一致。筆記本身交給 Obsidian 原生處理。',
  'Enable image peek (Canvas)': 'Canvas 圖片檢視',
  'Bare URLs on their own line become rich preview cards (reading mode / Live Preview / Canvas).':
    '獨佔一行的裸網址 → Apple 風格圖文卡片（閱讀模式 / Live Preview / Canvas）。',

  // ── 通用 ──
  'Create': '建立',
  'Cancel': '取消',
  'Delete': '刪除',
  'Rename': '重新命名',
  'Move to…': '移動到…',
  'Open': '開啟',
  'Open in new tab': '新分頁開啟',
  'Folder': '資料夾',
  'Note': '筆記',
  'Canvas': 'Canvas 白板',
  'Base': 'Base 資料庫',
  // 2026-08-11 Mini Calendar 移除後仍共用的一條（原本在「月曆」群組）
  'Refresh': '重新整理',           // 工具列「⋯ 更多」的重新整理

  // ── 排序 ──
  'Newest first': '最新建立', 'Oldest first': '最舊建立', 'Recently modified': '最近修改',
  'Name A→Z': '名稱 A→Z', 'Name Z→A': '名稱 Z→A',
  // ── 色票 ──
  'Coral': '珊瑚紅', 'Orange': '橘', 'Yellow': '黃', 'Green': '綠', 'Teal': '湖水藍',
  'Blue': '藍', 'Pink': '粉紫', 'Sand': '米', 'Grey': '灰', 'Black': '黑', 'Red': '紅', 'None': '無',
  // ── 剪貼簿 ──
  'Copied: {{text}}': '已複製：{{text}}', 'Copy failed': '複製失敗',
  // ── 對話框 / 新建 ──
  'Move to which folder…': '移動到哪個資料夾…', 'vault root': '根目錄',
  'Untitled': '未命名',
  'Failed to create: {{msg}}': '建立失敗：{{msg}}',
  'Also delete {{n}} attachment(s) not referenced by any other note': '連同刪除 {{n}} 個未被其他筆記引用的附件',
  'Moved to trash: {{name}} (+{{n}} attachments)': '已移到垃圾桶：{{name}}（＋{{n}} 個附件）',
  // ── 更多面板 ──
  'Sort': '排序', 'Tags in this folder': '本資料夾的標籤', 'Clear': '清除', 'Card size': '卡片大小',
  '{{n}} columns': '{{n}} 欄',
  'Flatten: include all subfolders': '攤平：含所有子資料夾',
  // ── 資料夾操作 ──
  'New folder': '新增資料夾',
  // 資料夾多選（2026-08-18）
  'Select multiple': '選取多個',
  'Move {{n}} folders to…': '將 {{n}} 個資料夾移動到…',
  'Moved {{n}} items': '已移動 {{n}} 個項目',
  'Moved {{n}}, skipped {{k}}': '已移動 {{n}} 個，略過 {{k}} 個',
  'Nothing was moved': '沒有任何項目被移動',
  'Done': '完成',
  // 手機的資料夾排序模式（2026-09-30）
  'Reorder folders': '調整順序',
  'Drag to reorder': '拖曳排序',
  'A folder with that name already exists': '已有同名資料夾',
  'Failed to create folder: {{msg}}': '建立資料夾失敗：{{msg}}',
  'Name contains forbidden characters': '名稱含不允許的字元',
  'Rename failed: {{msg}}': '重新命名失敗：{{msg}}',
  'Cannot rename this folder': '無法重新命名此資料夾',
  'Cannot reveal in system explorer: {{msg}}': '無法在檔案總管顯示：{{msg}}',
  'Delete folder \"{{name}}\" and all its contents? (moves to trash)': '確定要刪除資料夾「{{name}}」及其所有內容嗎？（移到垃圾桶）',
  'Delete \"{{name}}\"? (moves to trash)': '確定要刪除「{{name}}」嗎？（移到垃圾桶）',
  'Moved to trash: {{name}}': '已移到垃圾桶：{{name}}',
  'Delete failed: {{msg}}': '刪除失敗：{{msg}}',
  'Cannot move a folder into itself': '不能把資料夾移進自己裡面',
  'Already in this folder': '已經在這個資料夾了',
  'Target already has an item with the same name — move cancelled': '目標已有同名項目，已取消移動',
  'Moved to {{dest}}': '已移動到 {{dest}}',
  'Move failed: {{msg}}': '移動失敗：{{msg}}',
  // ── 最愛 / 樹選單 ──
  'Favorites': '最愛', 'Remove from favorites': '從最愛移除', 'Add to favorites': '加入最愛',
  'Gallery render error: {{msg}}': '⚠️ Gallery render 錯誤：{{msg}}',
  'Expand folder pane': '展開資料夾面板', 'Collapse folder pane': '收合資料夾面板',
  'Collapse': '收合', 'Expand': '展開', 'Create here': '在此新建', 'Copy path': '複製路徑',
  'Color': '顏色', 'Auto (by name)': '自動（依名稱）', 'Show text preview': '顯示內文',
  'Unhide': '取消隱藏', 'Hide this folder': '隱藏這個資料夾', 'Reveal in Finder': '在 Finder 顯示',
  'Delete folder': '刪除資料夾',
  // ── 搜尋牆 / 索引 ──
  'Building index…': '建立索引中…',
  'Search \"{{q}}\" · {{n}} results': '搜尋「{{q}}」· {{n}} 筆',
  'Text Extractor plugin is not enabled': '沒有啟用 text-extractor 外掛',
  'Text Extractor plugin is required to extract PDF text': '需要啟用 text-extractor 外掛才能擷取 PDF 內文',
  'Extracting PDF text… (large files may take a while)': '擷取 PDF 內文中…（大檔可能要一陣子）',
  'Extracting PDF text… {{done}}/{{total}}': '擷取 PDF 內文中… {{done}}/{{total}}',
  '{{total}} PDFs — text extracted from {{withText}}': '✅ {{total}} 個 PDF，其中 {{withText}} 個抽到文字',
  'Rebuilding index…': '重建索引中…',
  'Rebuilding index… {{done}}/{{total}}': '重建索引中… {{done}}/{{total}}',
  '{{files}} files · {{tokens}} tokens · {{ms}}ms': '✅ {{files}} 篇 · {{tokens}} token · {{ms}}ms',
  // ── 待辦 ──
  'Pick a to-do note': '選擇待辦筆記', 'No to-dos': '沒有待辦事項',
  // ── 標籤 / 多選 ──
  'Untagged': '未標籤',
  'Added #{{tag}} to "{{name}}"': '已為「{{name}}」加上 #{{tag}}',
  '"{{name}}" already has #{{tag}}': '「{{name}}」已有 #{{tag}}',
  'Failed to add tag: {{msg}}': '加標籤失敗：{{msg}}',
  'Remove #{{tag}} from this note': '從此筆記移除 #{{tag}}',
  'Removed #{{tag}} from "{{name}}"': '已從「{{name}}」移除 #{{tag}}',
  '#{{tag}} is not in frontmatter (it may be an inline tag in the note body)': '#{{tag}} 不在 frontmatter（可能是寫在內文的行內標籤），未變更',
  'Failed to remove tag: {{msg}}': '移除標籤失敗：{{msg}}',
  'Rename tag': '重新命名標籤',
  'Delete tag': '刪除標籤',
  'Remove #{{tag}} (and its sub-tags) from all notes?': '確定要從所有筆記移除 #{{tag}}（含子標籤）嗎？',
  'Deleted #{{tag}} from {{n}} note(s)': '已從 {{n}} 筆筆記移除 #{{tag}}',
  'Renamed #{{old}} → #{{new}} in {{n}} note(s)': '已將 #{{old}} 改為 #{{new}}（{{n}} 筆筆記更新）',
  'Merge {{n}} tags into…': '合併 {{n}} 個標籤為…',
  'Merge tags into': '合併標籤為',
  'Merge': '合併',
  'Merged into #{{tag}} ({{n}} notes updated)': '已合併為 #{{tag}}（{{n}} 筆筆記更新）', 'Tags': '標籤', 'Pick a tag on the left': '從左側選一個標籤',
  '{{n}} selected': '{{n}} 已選', 'Select all': '全選',
  'Copy wiki links (one per line)': '複製 Wiki 連結清單（一行一個）',
  'Clear selection': '清除選取', 'Nothing to copy': '沒有可複製的項目',
  '{{n}} wiki links': '{{n}} 個 wiki 連結',
  'Delete the {{n}} selected items? (moves to trash)': '確定刪除選取的 {{n}} 個項目？（移到垃圾桶）',
  'Moved {{c}} items to trash (+{{n}} attachments)': '已移到垃圾桶：{{c}} 個項目（＋{{n}} 個附件）',
  'Moved {{c}} items to trash': '已移到垃圾桶：{{c}} 個項目',
  // ── 卡片 / 連結牆 ──
  'Unpin': '取消釘選', 'Pin to top': '釘選到頂部', 'Show linked notes': '顯示連結的筆記',
  'Card color': '卡片顏色', 'Copy wiki link': '複製 Wiki 連結',
  'Including subfolders': '含子資料夾', 'Clear tag filter': '清除標籤篩選', 'No notes': '沒有筆記',
  'Remove this filter': '移除此篩選',
  'Links': '連結', 'Backlinks': '反向連結',
  // ── 筆記內圖片選單 ──
  'Copy image': '複製圖片', 'Copy image URL': '複製圖片網址',
  'Reveal in system explorer': '在系統中顯示', 'Delete image': '刪除圖片',
  'Failed to load image': '圖片載入失敗', 'Image copied': '已複製圖片',
  'Failed to copy image: {{msg}}': '複製圖片失敗：{{msg}}',
  // ── 圖片卡版面 ──
  // ── 資料夾自訂圖示（2026-08-11）──
  'Change icon': '更換圖示',
  'Choose folder icon': '選擇資料夾圖示',
  'Search icons…': '搜尋圖示…',
  'Reset to default': '恢復預設',
  'No icons found': '找不到符合的圖示',
  '{{n}} icons': '{{n}} 個圖示',
  '{{n}} of {{total}}': '{{n}} / {{total}}',
  'Match the mobile drawer to the gallery': '手機：抽屜外觀與畫廊一致',
  'Mobile only. Paints the sidebar drawer with the gallery background and removes the blank strip above it, so the gallery blends into the drawer instead of sitting in it as a grey block. Only applies while the gallery is the active drawer tab; other tabs are untouched.':
    '僅手機。把側欄抽屜塗成畫廊的底色、並移除上方那條空白帶，讓畫廊融進抽屜，而不是像一塊灰色方塊卡在裡面。只在畫廊是作用中的抽屜分頁時生效，其他分頁不受影響。',
  'Card corners': '卡片圓角',
  'Image card layout': '圖片卡版面',
  /* 圖片卡版面用場景命名（2026-08-10）。刻意**中英文都用同一個英文名**：
     它們是三種版型的代號、不是描述，翻成中文反而失去「一看就懂是哪個場景」的效果。
     舊的描述式 key（Overlay text on image… 等）已移除。 */
  'Photo': 'Photo', 'Museum': 'Museum', 'Editor': 'Editor',
  'Follow global': '跟隨全域',
  'Auto card color from cover image': '依封面圖自動決定卡片底色',
  'Tints each card with the dominant color of its cover image. Cards you colored manually are left alone.': '用封面圖的主色染卡片底色。手動上色過的卡片不受影響。',
  'Peek image': '預覽圖片',
  'Skipped {{n}} note(s) — reopen them and try again': '有 {{n}} 則筆記因為索引不同步被跳過，重新開啟後再試一次',
  'Action failed: {{msg}}': '操作失敗：{{msg}}',
  'Image lightbox actions': '圖片放大檢視的動作膠囊',
  'Adds a floating action bar (copy, visual search, reveal in Finder) to the image lightbox Obsidian shows when you click an image. Turn this off if a future Obsidian update changes the lightbox and the bar misbehaves.':
    '在 Obsidian 點圖片放大時，於畫面底部加一條浮動動作列（複製、找相似、在 Finder 顯示）。Obsidian 沒有提供 lightbox 的擴充 API，日後改版若導致這條動作列異常，把它關掉即可。',

  // ── Canvas：圖片轉筆記（2026-08-05）──
  'Convert to note (embed image)': '轉成筆記（內嵌這張圖）',
  'Convert {{n}} images to notes': '把 {{n}} 張圖轉成筆記',
  'Note name': '筆記名稱',
  'Note name ({{i}}/{{n}})': '筆記名稱（第 {{i}} / {{n}} 張）',
  'Cannot locate the canvas file': '找不到這張 Canvas 的檔案',
  'Converted {{n}} image(s) to notes in {{folder}}': '已把 {{n}} 張圖轉成筆記，建在 {{folder}}',

  // ── 效能（2026-08-04）──
  'Virtualized card wall': '卡片牆虛擬化',
  'In large folders, keeps only the cards near the viewport in the DOM and recycles the rest. Greatly reduces memory and scrolling lag. Turn off if you see layout jumps while scrolling.':
    '大資料夾只在 DOM 裡保留視窗附近的卡片，其餘回收重用。大幅降低記憶體與捲動卡頓。若捲動時看到版面跳動，可以關掉。',
  'Image thumbnails': '圖片縮圖',
  'Large images are downscaled once and cached, so cards no longer decode full-resolution originals. This is what keeps big image folders from exhausting memory on mobile.':
    '大圖只縮小一次並快取，卡片不再解碼完整解析度的原圖。這是大型圖片資料夾在手機上不會把記憶體吃爆的關鍵。',
  'Clear thumbnail cache': '清除失效縮圖',
  'Removed {{n}} stale thumbnails': '已移除 {{n}} 張失效縮圖',

  'Swap image…': '交換圖片…',
  'Swap image': '交換圖片',
  'Filter by file name…': '搜尋檔名…',
  'No images found': '找不到圖片',
  'Swapped to {{name}}': '已換成 {{name}}',
  'Swap failed: {{msg}}': '交換失敗：{{msg}}',
  'Could not locate this image in the note': '在筆記中找不到這張圖的嵌入位置',
  'Open notes without focusing the editor': '開啟筆記時不聚焦編輯器',
  'Notes opened from the gallery start unfocused, so a first-line image embed stays rendered instead of expanding to markdown. Click into the note to edit as usual.':
    '從畫廊開啟的筆記先不聚焦——首行的嵌入圖片會維持顯示、不展開成 markdown 原始碼。點進內文即可照常編輯。',

  // ── 淨化連結 ──
  'Clean links': '淨化連結',
  'Clean this link': '淨化這個連結',
  'Clean links in selection ({{n}})': '淨化選取範圍的連結（{{n}}）',
  'Clean all links in this note ({{n}})': '淨化整篇筆記的連結（{{n}}）',
  'Clean tracking links in this note': '淨化整篇筆記的追蹤連結',
  'Cleaned {{n}} link(s)': '已淨化 {{n}} 條連結',
  'No tracking parameters found': '沒有找到追蹤參數',
  'Enable clean links': '啟用淨化連結',
  'Adds a right-click item in the editor that strips tracking parameters (utm_*, xmt, slof, fbclid, gclid…) from URLs. Everything else in the query string is kept.':
    '在編輯器右鍵選單加入「淨化連結」，把網址中的追蹤參數（utm_*、xmt、slof、fbclid、gclid…）拿掉，其餘 query 參數原樣保留。',
  'Extra parameters to remove': '額外要刪除的參數',
  'Comma separated. Added to the built-in blacklist, e.g. my_ref, src_id': '用逗號分隔，會加進內建黑名單，例如：my_ref, src_id',
  'Cleaned {{n}} link(s) on paste': '貼上時已淨化 {{n}} 條連結',
  'Restore original URL': '還原成原始網址',
  'Restore original URL (needs network)': '還原成原始網址（需連線）',
  'Restore all share links in this note ({{n}})': '還原整篇的分享連結（{{n}}）',
  'Restore share links in this note': '還原整篇筆記的分享連結',
  'Restored {{n}} share link(s)': '已還原 {{n}} 條分享連結',
  'No share links found': '沒有找到分享連結',
  'Could not resolve this share link': '無法還原這條分享連結（可能離線或已失效）',
  'Restore Threads / Instagram share links': '還原 Threads / Instagram 分享連結',
  'Share links like threads.com/share/XXXX hide the tracking code in the path, so it can only be removed by asking the site for the real post URL. This is the only part of clean links that uses the network.':
    'threads.com/share/XXXX 這類分享連結把追蹤碼藏在路徑裡，砍 query 參數完全無效，只能連網問出原始的貼文網址。這是「淨化連結」唯一會用到網路的部分。',
  'Copy cleaned link': '複製淨化後的連結',
  'Copied cleaned link': '已複製淨化後的連結',
  'Could not locate the source note': '找不到這張卡片的來源筆記',
  'Clean failed: {{msg}}': '淨化失敗：{{msg}}',
  'Clean links on paste': '貼上時自動淨化',
  'Strips tracking parameters the moment you paste, so they never enter the note. Pasting rich content copied from a web page is left alone.':
    '網址在貼進筆記的當下就已經去掉追蹤參數，不必事後再淨化。從網頁複製的排版內容不受影響（仍照常轉成 Markdown）。',
  'Parameters to always keep': '永遠保留的參數',
  'Comma separated. Never removed, even if blacklisted. Wins over everything else.': '用逗號分隔。列在這裡的參數絕不刪除，優先權最高。',
};

/* ══ ZH_CN —— 简体中文（2026-11 加入）══
   按大陆通用术语翻译，不是繁体的逐字转换：
     資料夾→文件夹 / 筆記→笔记 / 外掛→插件 / 分頁→标签页 / 快取→缓存 /
     垃圾桶→回收站 / 重新命名→重命名 / 搜尋→搜索 / 載入→加载 /
     捲動→滚动 / 記憶體→内存 / 解析度→分辨率 / 連結→链接 / 標籤→标签 /
     選取範圍→选区 / 淨化→净化 / 欄→列 / 最愛→收藏 / 釘選→置顶 /
     全域→全局 / 手機→移动端 / 桌機→桌面端 / 攤平→扁平化 / 拖曳→拖拽。
   覆盖 ZH_TW 全部 key，另补上 ZH_TW 漏收的 22 条（Image Peek / Link Cards
   设定），以及工具列「更多」面板动态拼接的 '1 column' / '2 columns' /
   '3 columns'（繁体字典同样没有，这边一并补齐）。
   key 的拼写与 ZH_TW 逐字一致——带引号转义的地方照抄，改了 key 就查不到了。 */
const ZH_CN = {
  // ── 指令 ──
  'Open Gallery Navigator': '打开 Gallery Navigator',
  'Open in Gallery Navigator': '在 Gallery Navigator 中打开',
  'Search (popup)': '悬浮搜索',
  'Search: extract all PDF text (Text Extractor)': '搜索：提取全部 PDF 文本（Text Extractor）',
  'Search: rebuild index': '搜索：强制重建索引',

  // ── 悬浮搜索 ──
  'Search notes and PDFs (full-text)…': '搜索笔记和 PDF（全文搜索）…',
  'No matching notes': '未找到匹配的笔记',
  'to navigate': '移动',
  'to open': '打开',
  'to open in a new tab': '在新标签页打开',
  'show all results in gallery': '在画廊中显示全部结果',

  // ── 工具列 ──
  'Close search': '关闭搜索',
  'Search notes (full-text popup)': '搜索笔记（悬浮全文搜索）',
  'Current: tags (click to switch to folders)': '当前：标签（点击切回文件夹）',
  'Current: folders (click to switch to tags)': '当前：文件夹（点击切换到标签）',
  'Follow active note': '定位当前笔记',
  'Hide hidden folders': '收起被隐藏的文件夹',
  'Show hidden folders': '显示被隐藏的文件夹',
  'Create here (folder / note / canvas / base)': '在此新建（文件夹 / 笔记 / Canvas / Base）',
  'More (card layout / size / corners)': '更多（卡片布局 / 大小 / 圆角）',
  'Search full text…': '全文搜索…',

  // ── 设置页 ──
  'Language': '语言',
  'Interface language. Auto follows the Obsidian language setting.': '界面语言。“自动”跟随 Obsidian 的界面语言设置。',
  'Auto': '自动',
  'Card wall': '卡片墙',
  'Image peek': '图片预览',
  'Link cards': '链接卡片',
  'Enable image peek': '启用图片预览',
  'Enable link cards': '启用链接卡片',
  'Mobile columns': '移动端卡片列数',
  'Takes effect after reloading the plugin (or restarting Obsidian)': '重新加载插件（或重启 Obsidian）后生效',
  'Canvas has no built-in image viewer, so this fills that gap: double-click an image or press Space. Matches the look of the lightbox Obsidian shows in notes. Notes themselves are left to Obsidian.':
    'Canvas 没有内置的图片查看器，这里补上：双击图片或按空格键。外观与 Obsidian 在笔记中的灯箱一致。笔记本身交给 Obsidian 原生处理。',
  'Enable image peek (Canvas)': 'Canvas 图片预览',
  'Bare URLs on their own line become rich preview cards (reading mode / Live Preview / Canvas).':
    '独占一行的裸网址 → Apple 风格图文卡片（阅读模式 / Live Preview / Canvas）。',

  // ── 通用 ──
  'Create': '创建',
  'Cancel': '取消',
  'Delete': '删除',
  'Rename': '重命名',
  'Move to…': '移动到…',
  'Open': '打开',
  'Open in new tab': '在新标签页打开',
  'Folder': '文件夹',
  'Note': '笔记',
  'Canvas': 'Canvas 白板',
  'Base': 'Base 数据库',
  'Refresh': '刷新',           // 工具列「⋯ 更多」的刷新

  // ── 排序 ──
  'Newest first': '最新创建', 'Oldest first': '最早创建', 'Recently modified': '最近修改',
  'Name A→Z': '名称 A→Z', 'Name Z→A': '名称 Z→A',
  // ── 色票 ──
  'Coral': '珊瑚红', 'Orange': '橙', 'Yellow': '黄', 'Green': '绿', 'Teal': '蓝绿',
  'Blue': '蓝', 'Pink': '粉', 'Sand': '米', 'Grey': '灰', 'Black': '黑', 'Red': '红', 'None': '无',
  // ── 剪贴板 ──
  'Copied: {{text}}': '已复制：{{text}}', 'Copy failed': '复制失败',
  // ── 对话框 / 新建 ──
  'Move to which folder…': '移动到哪个文件夹…', 'vault root': '根目录',
  'Untitled': '未命名',
  'Failed to create: {{msg}}': '创建失败：{{msg}}',
  'Also delete {{n}} attachment(s) not referenced by any other note': '同时删除 {{n}} 个未被其他笔记引用的附件',
  'Moved to trash: {{name}} (+{{n}} attachments)': '已移入回收站：{{name}}（另含 {{n}} 个附件）',
  // ── 更多面板 ──
  'Sort': '排序', 'Tags in this folder': '当前文件夹的标签', 'Clear': '清除', 'Card size': '卡片大小',
  '{{n}} columns': '{{n}} 列',
  // 工具列「更多」的手机列数走动态拼接 key（t(n + ' column(s)')），繁体字典没有，简体补齐
  '1 column': '1 列', '2 columns': '2 列', '3 columns': '3 列',
  'Flatten: include all subfolders': '扁平化：包含所有子文件夹',
  // ── 文件夹操作 ──
  'New folder': '新建文件夹',
  'Select multiple': '多选',
  'Move {{n}} folders to…': '将 {{n}} 个文件夹移动到…',
  'Moved {{n}} items': '已移动 {{n}} 个项目',
  'Moved {{n}}, skipped {{k}}': '已移动 {{n}} 个，跳过 {{k}} 个',
  'Nothing was moved': '未移动任何项目',
  'Done': '完成',
  'Reorder folders': '调整顺序',
  'Drag to reorder': '拖拽排序',
  'A folder with that name already exists': '已存在同名文件夹',
  'Failed to create folder: {{msg}}': '创建文件夹失败：{{msg}}',
  'Name contains forbidden characters': '名称包含非法字符',
  'Rename failed: {{msg}}': '重命名失败：{{msg}}',
  'Cannot rename this folder': '无法重命名此文件夹',
  'Cannot reveal in system explorer: {{msg}}': '无法在系统文件管理器中显示：{{msg}}',
  'Delete folder \"{{name}}\" and all its contents? (moves to trash)': '确定要删除文件夹“{{name}}”及其所有内容吗？（移入回收站）',
  'Delete \"{{name}}\"? (moves to trash)': '确定要删除“{{name}}”吗？（移入回收站）',
  'Moved to trash: {{name}}': '已移入回收站：{{name}}',
  'Delete failed: {{msg}}': '删除失败：{{msg}}',
  'Cannot move a folder into itself': '不能将文件夹移入其自身内部',
  'Already in this folder': '已在此文件夹中',
  'Target already has an item with the same name — move cancelled': '目标位置已有同名项目，已取消移动',
  'Moved to {{dest}}': '已移动到 {{dest}}',
  'Move failed: {{msg}}': '移动失败：{{msg}}',
  // ── 收藏 / 树菜单 ──
  'Favorites': '收藏', 'Remove from favorites': '从收藏中移除', 'Add to favorites': '加入收藏',
  'Gallery render error: {{msg}}': '⚠️ 画廊渲染错误：{{msg}}',
  'Expand folder pane': '展开文件夹面板', 'Collapse folder pane': '收起文件夹面板',
  'Collapse': '收起', 'Expand': '展开', 'Create here': '在此新建', 'Copy path': '复制路径',
  'Color': '颜色', 'Auto (by name)': '自动（按名称）', 'Show text preview': '显示正文',
  'Unhide': '取消隐藏', 'Hide this folder': '隐藏此文件夹', 'Reveal in Finder': '在 Finder 中显示',
  'Delete folder': '删除文件夹',
  // ── 搜索墙 / 索引 ──
  'Building index…': '正在建立索引…',
  'Search \"{{q}}\" · {{n}} results': '搜索“{{q}}” · {{n}} 条结果',
  'Text Extractor plugin is not enabled': '未启用 Text Extractor 插件',
  'Text Extractor plugin is required to extract PDF text': '需要启用 Text Extractor 插件才能提取 PDF 文本',
  'Extracting PDF text… (large files may take a while)': '正在提取 PDF 文本…（大文件可能需要一段时间）',
  'Extracting PDF text… {{done}}/{{total}}': '正在提取 PDF 文本… {{done}}/{{total}}',
  '{{total}} PDFs — text extracted from {{withText}}': '✅ {{total}} 个 PDF，其中 {{withText}} 个提取到文本',
  'Rebuilding index…': '正在重建索引…',
  'Rebuilding index… {{done}}/{{total}}': '正在重建索引… {{done}}/{{total}}',
  '{{files}} files · {{tokens}} tokens · {{ms}}ms': '✅ {{files}} 篇 · {{tokens}} token · {{ms}}ms',
  // ── 待办 ──
  'Pick a to-do note': '选择待办笔记', 'No to-dos': '没有待办事项',
  // ── 标签 / 多选 ──
  'Untagged': '无标签',
  'Added #{{tag}} to "{{name}}"': '已为“{{name}}”添加 #{{tag}}',
  '"{{name}}" already has #{{tag}}': '“{{name}}”已有 #{{tag}}',
  'Failed to add tag: {{msg}}': '添加标签失败：{{msg}}',
  'Remove #{{tag}} from this note': '从此笔记移除 #{{tag}}',
  'Removed #{{tag}} from "{{name}}"': '已从“{{name}}”移除 #{{tag}}',
  '#{{tag}} is not in frontmatter (it may be an inline tag in the note body)': '#{{tag}} 不在 frontmatter 中（可能是正文里的行内标签），未做更改',
  'Failed to remove tag: {{msg}}': '移除标签失败：{{msg}}',
  'Rename tag': '重命名标签',
  'Delete tag': '删除标签',
  'Remove #{{tag}} (and its sub-tags) from all notes?': '确定要从所有笔记中移除 #{{tag}}（含子标签）吗？',
  'Deleted #{{tag}} from {{n}} note(s)': '已从 {{n}} 篇笔记中移除 #{{tag}}',
  'Renamed #{{old}} → #{{new}} in {{n}} note(s)': '已将 #{{old}} 改为 #{{new}}（更新 {{n}} 篇笔记）',
  'Merge {{n}} tags into…': '将 {{n}} 个标签合并到…',
  'Merge tags into': '合并标签到',
  'Merge': '合并',
  'Merged into #{{tag}} ({{n}} notes updated)': '已合并到 #{{tag}}（更新 {{n}} 篇笔记）', 'Tags': '标签', 'Pick a tag on the left': '从左侧选择一个标签',
  '{{n}} selected': '已选 {{n}} 项', 'Select all': '全选',
  'Copy wiki links (one per line)': '复制 Wiki 链接列表（每行一个）',
  'Clear selection': '清除选择', 'Nothing to copy': '没有可复制的内容',
  '{{n}} wiki links': '{{n}} 个 Wiki 链接',
  'Delete the {{n}} selected items? (moves to trash)': '确定删除选中的 {{n}} 个项目吗？（移入回收站）',
  'Moved {{c}} items to trash (+{{n}} attachments)': '已移入回收站：{{c}} 个项目（另含 {{n}} 个附件）',
  'Moved {{c}} items to trash': '已移入回收站：{{c}} 个项目',
  // ── 卡片 / 链接墙 ──
  'Unpin': '取消置顶', 'Pin to top': '置顶', 'Show linked notes': '显示链接的笔记',
  'Card color': '卡片颜色', 'Copy wiki link': '复制 Wiki 链接',
  'Including subfolders': '包含子文件夹', 'Clear tag filter': '清除标签筛选', 'No notes': '没有笔记',
  'Remove this filter': '移除该筛选',
  'Links': '链接', 'Backlinks': '反向链接',
  // ── 笔记内图片菜单 ──
  'Copy image': '复制图片', 'Copy image URL': '复制图片网址',
  'Reveal in system explorer': '在系统文件管理器中显示', 'Delete image': '删除图片',
  'Failed to load image': '图片加载失败', 'Image copied': '已复制图片',
  'Failed to copy image: {{msg}}': '复制图片失败：{{msg}}',
  // ── 文件夹自定义图标 ──
  'Change icon': '更换图标',
  'Choose folder icon': '选择文件夹图标',
  'Search icons…': '搜索图标…',
  'Reset to default': '恢复默认',
  'No icons found': '未找到匹配的图标',
  '{{n}} icons': '{{n}} 个图标',
  '{{n}} of {{total}}': '{{n}} / {{total}}',
  'Match the mobile drawer to the gallery': '移动端：抽屉外观与画廊一致',
  'Mobile only. Paints the sidebar drawer with the gallery background and removes the blank strip above it, so the gallery blends into the drawer instead of sitting in it as a grey block. Only applies while the gallery is the active drawer tab; other tabs are untouched.':
    '仅移动端。将侧边栏抽屉染成画廊的背景色，并移除上方那条空白带，让画廊融入抽屉，而不是像一块灰色方块卡在里面。仅在画廊是当前活动的抽屉标签页时生效，其他标签页不受影响。',
  'Card corners': '卡片圆角',
  'Image card layout': '图片卡片布局',
  /* 图片卡片布局用场景命名。刻意中英文都用同一个英文名：
     它们是三种布局的代号、不是描述，翻成中文反而失去「一看就懂是哪个场景」的效果。 */
  'Photo': 'Photo', 'Museum': 'Museum', 'Editor': 'Editor',
  'Follow global': '跟随全局',
  'Auto card color from cover image': '根据封面图自动决定卡片底色',
  'Tints each card with the dominant color of its cover image. Cards you colored manually are left alone.': '用封面图的主色调渲染卡片底色。手动上过色的卡片不受影响。',
  'Peek image': '预览图片',
  'Skipped {{n}} note(s) — reopen them and try again': '有 {{n}} 篇笔记因索引不同步被跳过，请重新打开后再试一次',
  'Action failed: {{msg}}': '操作失败：{{msg}}',
  'Image lightbox actions': '图片放大查看的浮动操作栏',
  'Adds a floating action bar (copy, visual search, reveal in Finder) to the image lightbox Obsidian shows when you click an image. Turn this off if a future Obsidian update changes the lightbox and the bar misbehaves.':
    '在 Obsidian 中点击图片放大时，于画面底部添加一条浮动操作栏（复制、找相似、在 Finder 中显示）。Obsidian 未提供灯箱的扩展 API，日后若 Obsidian 改版导致此操作栏异常，将其关闭即可。',

  // ── Canvas：图片转笔记 ──
  'Convert to note (embed image)': '转为笔记（嵌入此图片）',
  'Convert {{n}} images to notes': '将 {{n}} 张图片转为笔记',
  'Note name': '笔记名称',
  'Note name ({{i}}/{{n}})': '笔记名称（第 {{i}} / {{n}} 张）',
  'Cannot locate the canvas file': '找不到此 Canvas 的文件',
  'Converted {{n}} image(s) to notes in {{folder}}': '已将 {{n}} 张图片转为笔记，创建于 {{folder}}',

  // ── 性能 ──
  'Virtualized card wall': '卡片墙虚拟化',
  'In large folders, keeps only the cards near the viewport in the DOM and recycles the rest. Greatly reduces memory and scrolling lag. Turn off if you see layout jumps while scrolling.':
    '大型文件夹中只在 DOM 里保留视口附近的卡片，其余回收复用。大幅降低内存占用与滚动卡顿。若滚动时看到布局跳动，可以关闭。',
  'Image thumbnails': '图片缩略图',
  'Large images are downscaled once and cached, so cards no longer decode full-resolution originals. This is what keeps big image folders from exhausting memory on mobile.':
    '大图只缩小一次并缓存，卡片不再解码完整分辨率的原图。这是大型图片文件夹在移动端不会耗尽内存的关键。',
  'Clear thumbnail cache': '清除失效缩略图',
  'Removed {{n}} stale thumbnails': '已移除 {{n}} 个失效缩略图',

  'Swap image…': '更换图片…',
  'Swap image': '更换图片',
  'Filter by file name…': '按文件名筛选…',
  'No images found': '未找到图片',
  'Swapped to {{name}}': '已更换为 {{name}}',
  'Swap failed: {{msg}}': '更换失败：{{msg}}',
  'Could not locate this image in the note': '在笔记中找不到该图片的嵌入位置',
  'Open notes without focusing the editor': '打开笔记时不聚焦编辑器',
  'Notes opened from the gallery start unfocused, so a first-line image embed stays rendered instead of expanding to markdown. Click into the note to edit as usual.':
    '从画廊打开的笔记默认不聚焦——首行的嵌入图片会保持显示、不展开成 markdown 源码。点击进入正文即可照常编辑。',

  // ── 链接净化 ──
  'Clean links': '链接净化',
  'Clean this link': '净化此链接',
  'Clean links in selection ({{n}})': '净化选区中的链接（{{n}}）',
  'Clean all links in this note ({{n}})': '净化整篇笔记的链接（{{n}}）',
  'Clean tracking links in this note': '净化整篇笔记的跟踪链接',
  'Cleaned {{n}} link(s)': '已净化 {{n}} 条链接',
  'No tracking parameters found': '未找到跟踪参数',
  'Enable clean links': '启用链接净化',
  'Adds a right-click item in the editor that strips tracking parameters (utm_*, xmt, slof, fbclid, gclid…) from URLs. Everything else in the query string is kept.':
    '在编辑器右键菜单中添加“净化链接”，移除网址中的跟踪参数（utm_*、xmt、slof、fbclid、gclid…），其余查询参数原样保留。',
  'Extra parameters to remove': '额外删除的参数',
  'Comma separated. Added to the built-in blacklist, e.g. my_ref, src_id': '以逗号分隔，会加入内置黑名单，例如：my_ref, src_id',
  'Cleaned {{n}} link(s) on paste': '粘贴时已净化 {{n}} 条链接',
  'Restore original URL': '还原为原始网址',
  'Restore original URL (needs network)': '还原为原始网址（需联网）',
  'Restore all share links in this note ({{n}})': '还原整篇笔记的分享链接（{{n}}）',
  'Restore share links in this note': '还原整篇笔记的分享链接',
  'Restored {{n}} share link(s)': '已还原 {{n}} 条分享链接',
  'No share links found': '未找到分享链接',
  'Could not resolve this share link': '无法还原该分享链接（可能离线或已失效）',
  'Restore Threads / Instagram share links': '还原 Threads / Instagram 分享链接',
  'Share links like threads.com/share/XXXX hide the tracking code in the path, so it can only be removed by asking the site for the real post URL. This is the only part of clean links that uses the network.':
    'threads.com/share/XXXX 这类分享链接把跟踪码藏在路径里，删除查询参数完全无效，只能联网查询出原始的帖子网址。这是“链接净化”中唯一会用到网络的部分。',
  'Copy cleaned link': '复制净化后的链接',
  'Copied cleaned link': '已复制净化后的链接',
  'Could not locate the source note': '找不到该卡片的来源笔记',
  'Clean failed: {{msg}}': '净化失败：{{msg}}',
  'Clean links on paste': '粘贴时自动净化',
  'Strips tracking parameters the moment you paste, so they never enter the note. Pasting rich content copied from a web page is left alone.':
    '网址在粘贴进笔记的当下就已移除跟踪参数，无需事后再净化。从网页复制的排版内容不受影响（仍照常转换为 Markdown）。',
  'Parameters to always keep': '始终保留的参数',
  'Comma separated. Never removed, even if blacklisted. Wins over everything else.': '以逗号分隔。列在此处的参数绝不删除，优先级最高。',

  // ── 补漏：ZH_TW 字典未收、但程式码里用到的 key（Image Peek / Link Cards）──
  'Link cards: moved {{n}} images from data.json to images/': '链接卡片：已从 data.json 迁移 {{n}} 张图片到 images/',
  'Insert post text when pasting Threads / Instagram links': '粘贴 Threads / Instagram 链接时插入帖子文本',
  'When off, only the bare link is kept': '关闭时只保留裸链接',
  'Keep native YouTube embeds on Canvas': 'Canvas 上保留 YouTube 原生嵌入',
  'On = playable iframe; off = link card. Reopen the Canvas after switching': '开＝可播放的 iframe；关＝链接卡片。切换后请重新打开 Canvas',
  'Takes effect after reopening the Canvas': '重新打开 Canvas 后生效',
  'Image': '图片',
  'PNG conversion failed': 'PNG 转换失败',
  'Image not loaded yet': '图片尚未加载完成',
  'Click an image to open the preview': '点击图片打开预览',
  'Desktop: double-click (single click keeps native behavior). Mobile: single tap in notes, double tap on Canvas':
    '桌面端：双击（单击保持原生行为）。移动端：笔记中单击，Canvas 上双击',
  'Press Space to open the preview': '按空格键打开预览',
  'Press Space while hovering an image (or with an image node selected on Canvas)': '鼠标悬停在图片上时按空格（或在 Canvas 上选中图片节点后按空格）',
  'Show action buttons': '显示操作按钮',
  'Copy / open-in-system buttons in the preview window': '预览窗口中的“复制 / 在系统中打开”按钮',
  'Background blur': '背景模糊',
  'Turn off on low-end devices for better performance': '低端设备建议关闭，以获得更好的性能',
  'Excluded images (CSS selectors)': '排除的图片（CSS 选择器）',
  'Images matching these selectors will not trigger the preview': '匹配这些选择器的图片不会触发预览',
  'MOC note for related images': '相关图片的 MOC 笔记',
  'Grouped by ## headings; the sidebar shows other images in the same group. Empty = sidebar off':
    '按 ## 标题分组；侧栏显示同组的其他图片。留空＝关闭侧栏',
  'Number of related images in the sidebar': '侧栏中相关图片的数量',
};

/* 正規化之後只剩兩個正規 key：'zh-TW' / 'zh-CN'（大小寫、底線、裸 'zh'
   都由 normalizeLang() 歸位）。舊寫法 'zh-cn': ZH_TW 是給繁体字典兜底的
   ——簡體加入後，zh（不分地區，除非明確是 TW/HK/MO/Hant）一律走 ZH_CN。 */
const LANGS = { 'zh-TW': ZH_TW, 'zh-CN': ZH_CN };

resolveLang();   // 字典就緒後先解析一次（setLang() 之前也能正確翻譯）

// t('key') / t('Calendar {{n}}', {n: 2}) → 目前語言字串；查無翻譯回傳英文原文
function t(key, vars) {
  const dict = _dict;
  let s = (dict && dict[key]) || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{{' + k + '}}').join(String(vars[k]));
  return s;
}

module.exports = { t, setLang, currentLang, isZh };
