'use strict';

/* ===== i18n =====
   規則：
   - 程式裡一律寫英文原文：t('Search notes')。英文＝key 本身 → 永遠不會漏翻壞掉。
   - 語言偵測：預設跟隨 Obsidian 介面語言（localStorage 'language'；null = en）。
   - 設定頁可手動覆寫（''=自動 / 'en' / 'zh-TW'），由 setLang() 注入。
   - 目前只維護 zh-TW 字典；要加語言＝加一個字典 + LANGS 一個 entry。 */

function obsidianLang() {
  try { return window.localStorage.getItem('language') || 'en'; } catch (e) { return 'en'; }
}

let forced = '';
function setLang(l) { forced = l || ''; }
function currentLang() { return forced || obsidianLang(); }
function isZh() { return /^zh/i.test(currentLang()); }

const ZH_TW = {
  // ── 指令 ──
  'Open Gallery Navigator': '開啟 Gallery Navigator',
  'Open Mini Calendar': '開啟 Mini Calendar',
  'Search (popup)': '懸浮搜尋',
  'Search: extract all PDF text (Text Extractor)': '搜尋：擷取全部 PDF 內文（text-extractor）',
  'Search: rebuild index': '搜尋：強制重建索引',
  'Search: test query': '搜尋：測試查詢',
  'Diagnose: mobile pane switching': '診斷：手機欄位跳轉',

  // ── 懸浮搜尋 ──
  'Search notes and PDFs (full-text)…': '搜尋筆記與 PDF（全文搜尋）…',
  'No matching notes': '找不到符合的筆記',
  'to navigate': '移動',
  'to open': '開啟',
  'to open in a new tab': '新分頁開啟',
  'show all results in gallery': '在畫廊顯示全部結果',

  // ── 工具列 ──
  'To-dos': '待辦',
  'Close search': '關閉搜尋',
  'Search notes (full-text popup)': '搜尋筆記（懸浮全文搜尋）',
  'Current: tags (click to switch to folders)': '目前：標籤（點擊切回資料夾）',
  'Current: folders (click to switch to tags)': '目前：資料夾（點擊切到標籤）',
  'Follow active note': '同步定位（開啟筆記時跳到其資料夾）',
  'Follow active note: on (click to turn off)': '同步定位：開啟筆記時跳到其資料夾（點擊關閉）',
  'Follow active note: off (click to turn on)': '同步定位：關閉（點擊開啟）',
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
  'Calendar': '行事曆',
  'Enable image peek': '啟用圖片預覽',
  'Enable link cards': '啟用連結卡片',
  'Agenda days': 'Agenda 天數',
  'How many days ahead the agenda lists events': '清單往後顯示幾天的行程',
  'Daily note template': '每日筆記模板',
  'Applied when creating a daily note from the calendar. Supports {{title}}, {{date}}, {{time}}, {{weekday}}. Leave empty to use the template from the core Daily notes plugin.':
    '從行事曆建立每日筆記時套用這個模板。支援 {{title}}、{{date}}、{{time}}、{{weekday}}。留空＝自動沿用 Obsidian 核心「每日筆記」設定的模板。',
  'e.g. Templates/Daily.md': '例：模板/每日筆記.md',
  'Pick a template note from the vault': '從 vault 選擇模板筆記',
  'Pick a daily note template…': '選擇每日筆記模板…',
  'Calendar {{n}}': '行事曆 {{n}}',
  'Name': '名稱',
  'ICS URL (.ics)': 'ICS 網址（.ics）',
  'Remove': '移除',
  '+ Add calendar': '＋ 新增行事曆',
  'Reload calendars': '重新載入行事曆',
  'Reloading…': '重新載入中…',
  'Paste the secret iCal URL of your Google Calendar (Calendar settings → Integrate calendar → URL ending in .ics). Multiple calendars supported, one color each.':
    '貼上 Google 行事曆的「iCal 格式密件網址」（行事曆設定 → 整合日曆 → 以 .ics 結尾的私人網址）。可加多個，每個給一個顏色。',
  'Mobile columns': '手機的卡片欄數',
  'Mobile uses a fixed column count. On desktop, use the card size slider in the toolbar more panel.':
    '手機螢幕窄，改用固定欄數。桌機請用工具列「⋯ 更多」裡的卡片大小滑桿',
  '1 column': '1 欄',
  '2 columns': '2 欄',
  '3 columns': '3 欄',
  'Takes effect after reloading the plugin (or restarting Obsidian)': '重新載入外掛（或重啟 Obsidian）後生效',
  'Double-click an image or press Space for a Quick Look style preview; includes Pinterest visual search.':
    '雙擊圖片或按 Space，像 Finder 快速預覽一樣浮出大圖；含 Pinterest 以圖搜圖。',
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
  'Daily note template not found: {{path}} (created a blank note)': '找不到每日筆記模板：{{path}}（已建立空白筆記）',
  'Create daily note': '建立每日筆記',
  'Daily notes': '當日筆記',
  'Created that day ({{n}})': '當天建立（{{n}}）',
  'No calendars yet. Paste your Google Calendar ICS URL in Settings → Gallery Navigator.': '尚未設定行事曆。到「設定 → Gallery Navigator」貼上 Google 行事曆的 ICS 網址。',

  // ── 排序 ──
  'Newest first': '最新建立', 'Oldest first': '最舊建立', 'Recently modified': '最近修改',
  'Name A→Z': '名稱 A→Z', 'Name Z→A': '名稱 Z→A',
  // ── 色票 ──
  'Coral': '珊瑚紅', 'Orange': '橘', 'Yellow': '黃', 'Green': '綠', 'Teal': '湖水藍',
  'Blue': '藍', 'Pink': '粉紫', 'Sand': '米', 'Grey': '灰', 'Black': '黑', 'Red': '紅', 'None': '無',
  // ── 月曆 ──
  'Su': '日', 'Mo': '一', 'Tu': '二', 'We': '三', 'Th': '四', 'Fr': '五', 'Sa': '六',
  'Sun': '日', 'Mon': '一', 'Tue': '二', 'Wed': '三', 'Thu': '四', 'Fri': '五', 'Sat': '六',
  'Sunday': '星期日', 'Monday': '星期一', 'Tuesday': '星期二', 'Wednesday': '星期三',
  'Thursday': '星期四', 'Friday': '星期五', 'Saturday': '星期六',
  'January': '一月', 'February': '二月', 'March': '三月', 'April': '四月', 'May': '五月', 'June': '六月',
  'July': '七月', 'August': '八月', 'September': '九月', 'October': '十月', 'November': '十一月', 'December': '十二月',
  '{{m}}/{{d}}': '{{m}}月{{d}}日',
  '(untitled)': '（無標題）',
  'Previous month': '上個月', 'Today': '今天', 'Go to today': '回到今天', 'Next month': '下個月', 'Refresh': '重新整理',
  'Loading…': '載入中…', 'No timed events this day.': '這天沒有時間軸行程。',
  'ICS responded with status {{status}}': 'ICS 回應狀態 {{status}}', 'Fetch failed: {{msg}}': '抓取失敗：{{msg}}',
  // ── 剪貼簿 ──
  'Copied: {{text}}': '已複製：{{text}}', 'Copy failed': '複製失敗',
  // ── Pinterest ──
  'Pinterest visual search': 'Pinterest 找相似',
  'Could not read this image': '讀不到這張圖的內容',
  'Searching…': '搜尋中…',
  'Pinterest responded with status {{status}} (private API — image too large / unsupported format / rate limited)':
    'Pinterest 回應狀態 {{status}}（這是逆向的私有 API，可能是圖太大／格式不支援／被限流）',
  'No similar images found': '沒有找到相似的圖',
  'Similar results · broader as you scroll · hover to preview/download': '相似結果 · 越往下越發散 · hover 可預覽/下載',
  '— no more results —': '— 沒有更多了 —',
  'Search failed: {{msg}}': '搜尋失敗：{{msg}}',
  'Search "{{term}}" on Pinterest (broader)': '在 Pinterest 搜「{{term}}」（更廣）',
  'skipped {{n}} animated pins without a gif': '已略過 {{n}} 則無法取得 gif 的動態 pin',
  'Open on Pinterest': '在 Pinterest 開啟',
  'Download and create note': '下載並建立筆記',
  'No downloadable image URL': '沒有可下載的圖片網址',
  'Downloading…': '下載中…',
  'Created note: {{path}}': '已建立筆記：{{path}}',
  'Download failed: {{msg}}': '下載失敗：{{msg}}',
  // ── 對話框 / 新建 ──
  'Move to which folder…': '移動到哪個資料夾…', 'vault root': '根目錄',
  'Pick a to-do note…': '選擇待辦筆記…', 'Untitled': '未命名',
  'Failed to create: {{msg}}': '建立失敗：{{msg}}',
  'Also delete {{n}} attachment(s) not referenced by any other note': '連同刪除 {{n}} 個未被其他筆記引用的附件',
  'Moved to trash: {{name}} (+{{n}} attachments)': '已移到垃圾桶：{{name}}（＋{{n}} 個附件）',
  // ── 更多面板 ──
  'Sort': '排序', 'Tags in this folder': '本資料夾的標籤', 'Clear': '清除', 'Card size': '卡片大小',
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
  'First search — building index…': '首次搜尋，建立索引中…',
  'Building index… {{done}}/{{total}}': '建立索引中… {{done}}/{{total}}',
  'Search test (full ranking in console)': '搜尋測試（完整排名見 console）',
  '(no results)': '（無結果）', 'Search': '搜尋',
  'Open Gallery Navigator first': '請先開啟 Gallery Navigator',
  'Text Extractor plugin is required to extract PDF text': '需要啟用 text-extractor 外掛才能擷取 PDF 內文',
  'Extracting PDF text… (large files may take a while)': '擷取 PDF 內文中…（大檔可能要一陣子）',
  'Extracting PDF text… {{done}}/{{total}}': '擷取 PDF 內文中… {{done}}/{{total}}',
  '{{total}} PDFs — text extracted from {{withText}}': '✅ {{total}} 個 PDF，其中 {{withText}} 個抽到文字',
  'Rebuilding index…': '重建索引中…',
  'Rebuilding index… {{done}}/{{total}}': '重建索引中… {{done}}/{{total}}',
  '{{files}} files · {{tokens}} tokens · {{ms}}ms': '✅ {{files}} 篇 · {{tokens}} token · {{ms}}ms',
  // ── 待辦 ──
  'Failed to update task: {{msg}}': '更新任務失敗：{{msg}}',
  'Pick a to-do note': '選擇待辦筆記', 'No to-dos': '沒有待辦事項',
  'Mark as not done': '取消完成', 'Mark as done': '標記完成',
  'Cannot read the to-do note': '讀不到待辦筆記',
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
  // ── 卡片 / 連結牆 ──
  'Unpin': '取消釘選', 'Pin to top': '釘選到頂部', 'Show linked notes': '顯示連結的筆記',
  'Card color': '卡片顏色', 'Copy wiki link': '複製 Wiki 連結',
  'Including subfolders': '含子資料夾', 'Clear tag filter': '清除標籤篩選', 'No notes': '沒有筆記',
  'Back to card wall': '返回卡片牆', 'Open this note': '開啟此筆記',
  'Links': '連結', 'Backlinks': '反向連結',
  // ── 筆記內圖片選單 ──
  'Copy image': '複製圖片', 'Copy image URL': '複製圖片網址',
  'Reveal in system explorer': '在系統中顯示', 'Delete image': '刪除圖片',
  'Delete image \"{{name}}\"? (moves to trash)': '確定刪除圖片「{{name}}」？（移到垃圾桶）',
  'Deleted {{name}}': '已刪除 {{name}}',
  'Failed to load image': '圖片載入失敗', 'Image copied': '已複製圖片',
  'Failed to copy image: {{msg}}': '複製圖片失敗：{{msg}}',
  // ── Pinterest 開關 ──
  'Card style': '卡片樣式',
  'Auto (default)': '自動（預設）',
  'Plain card': '純卡片',
  'To-do list card': '待辦清單卡',
  'Video card': '影片卡',
  'Book card': '書籍卡',
  'Play video': '播放影片',
  'No to-dos in this note': '這則筆記沒有待辦',
  'Show completed': '顯示已完成',
  'Hide completed': '隱藏已完成',
  'All done 🎉': '全部完成 🎉',
  'No video link found in this note': '這則筆記裡找不到影片連結',
  'Open notes without focusing the editor': '開啟筆記時不聚焦編輯器',
  'Notes opened from the gallery start unfocused, so a first-line image embed stays rendered instead of expanding to markdown. Click into the note to edit as usual.':
    '從畫廊開啟的筆記先不聚焦——首行的嵌入圖片會維持顯示、不展開成 markdown 原始碼。點進內文即可照常編輯。',
  'Pinterest visual search (experimental)': 'Pinterest 找相似（實驗性）',
  'Adds a reverse-image search entry to image menus. Uses an unofficial Pinterest endpoint that may stop working at any time; the image you search with is uploaded to Pinterest.':
    '在圖片選單加入「找相似」（以圖搜圖）。使用 Pinterest 非官方端點，可能隨時失效；搜尋時該張圖片會上傳到 Pinterest。',
};

const LANGS = { 'zh-TW': ZH_TW, zh: ZH_TW, 'zh-cn': ZH_TW };

// t('key') / t('Calendar {{n}}', {n: 2}) → 目前語言字串；查無翻譯回傳英文原文
function t(key, vars) {
  const dict = LANGS[currentLang()] || (/^zh/i.test(currentLang()) ? ZH_TW : null);
  let s = (dict && dict[key]) || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{{' + k + '}}').join(String(vars[k]));
  return s;
}

module.exports = { t, setLang, currentLang, isZh };
