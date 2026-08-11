'use strict';

/* ===== i18n =====
   規則：
   - 程式裡一律寫英文原文：t('Search notes')。英文＝key 本身 → 永遠不會漏翻壞掉。
   - 語言偵測：預設跟隨 Obsidian 介面語言（localStorage 'language'；null = en）。
   - 設定頁可手動覆寫（''=自動 / 'en' / 'zh-TW'），由 setLang() 注入。
   - 目前只維護 zh-TW 字典；要加語言＝加一個字典 + LANGS 一個 entry。 */

/* localStorage 只在模組載入時讀一次：t() 在卡片/選單建構路徑被大量呼叫，
   每次都同步讀 localStorage 太貴；改語言本來就需要重載外掛（或走 setLang）。 */
const OBSIDIAN_LANG = (() => {
  try { return window.localStorage.getItem('language') || 'en'; } catch (e) { return 'en'; }
})();

let forced = '';
let _lang = OBSIDIAN_LANG;   // 解析後的目前語言
let _dict = null;            // 解析後的字典（null = 用英文原文）
let _isZh = false;
// 只有 setLang()（載入時、設定頁切換時）會重算，t() 全程只讀快取
function resolveLang() {
  _lang = forced || OBSIDIAN_LANG;
  _isZh = /^zh/i.test(_lang);
  _dict = LANGS[_lang] || (_isZh ? ZH_TW : null);
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
  'More (sort / card size / flatten)': '更多（排序 / 卡片大小 / 攤平）',
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

const LANGS = { 'zh-TW': ZH_TW, zh: ZH_TW, 'zh-cn': ZH_TW };

resolveLang();   // 字典就緒後先解析一次（setLang() 之前也能正確翻譯）

// t('key') / t('Calendar {{n}}', {n: 2}) → 目前語言字串；查無翻譯回傳英文原文
function t(key, vars) {
  const dict = _dict;
  let s = (dict && dict[key]) || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{{' + k + '}}').join(String(vars[k]));
  return s;
}

module.exports = { t, setLang, currentLang, isZh };
