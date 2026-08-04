'use strict';

/* ===== Canvas：把圖片節點轉成「內嵌該圖的筆記」（2026-08-05）=====
 *
 * 情境：在 Canvas 貼上圖片，Obsidian 會把圖檔丟進附件資料夾（例如 img/），
 *   節點是一個指向該圖的 file node。圖片本身沒地方寫字，
 *   要加註解、標籤、來源就得自己另外開一則筆記再換掉節點。
 *   這支把那串手續變成一個右鍵選項。
 *
 * 行為：
 *   1. 跳出輸入框問筆記名稱（預設帶入圖片檔名，直接 Enter 就沿用）
 *   2. 在 **Canvas 所在資料夾** 建立筆記，內容是該圖的嵌入連結
 *   3. 把原本的圖片節點就地換成指向新筆記，位置與尺寸不變
 *
 * ⚠️ 換節點用 node.setData()，不要用 canvas.importData()。
 *    兩者最終都會走到同一個 setData（importData 內部就是逐節點呼叫它），
 *    但 importData 要傳整份資料、會走一遍所有節點與邊，
 *    而 setData 直接改這一顆：CanvasFileNode.setData → setFilePath →
 *    偵測到路徑不同 → initFile() 重新載入。視角與選取完全不受影響。
 *
 * ⚠️ 絕不覆蓋既有筆記：名稱撞到就自動加序號（見 uniquePath）。
 */

const { TFile, Notice } = require('obsidian');
const { t } = require('./i18n.js');

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
// Obsidian 檔名不允許的字元（跟著它的檔案總管走，避免建出開不了的檔）
const BAD_NAME = /[\\/:*?"<>|#^[\]]/g;

/* 這個節點是不是「指向圖片的 file node」→ 回傳該圖的 TFile，否則 null */
function nodeImage(app, node) {
  let d = null;
  try { d = node && typeof node.getData === 'function' ? node.getData() : null; } catch (e) { return null; }
  if (!d || d.type !== 'file' || !d.file || !IMG_EXT.test(d.file)) return null;
  const f = app.vault.getAbstractFileByPath(d.file);
  return f instanceof TFile ? f : null;
}

function sanitize(name) {
  return String(name || '').replace(BAD_NAME, '').replace(/\s+/g, ' ').trim();
}

/* 不覆蓋既有檔案：同名就往後加序號。回傳完整路徑。 */
function uniquePath(app, folder, base) {
  const dir = folder ? folder + '/' : '';
  let name = base, n = 1;
  while (app.vault.getAbstractFileByPath(dir + name + '.md')) {
    n++;
    name = base + ' ' + n;
  }
  return dir + name + '.md';
}

/* 問一個名稱。回傳 Promise<string|null>，null＝使用者取消（批次時代表中止） */
function askName(app, InputModal, initial, index, total) {
  return new Promise((resolve) => {
    const title = total > 1
      ? t('Note name ({{i}}/{{n}})', { i: index + 1, n: total })
      : t('Note name');
    new InputModal(app, title, initial, (v) => resolve(v), t('Create'), () => resolve(null)).open();
  });
}

async function convertNodes(plugin, canvas, nodes, InputModal) {
  const app = plugin.app;
  const canvasFile = canvas && canvas.view && canvas.view.file;
  if (!canvasFile) { new Notice(t('Cannot locate the canvas file')); return; }
  const folder = canvasFile.parent ? canvasFile.parent.path : '';

  // 先全部問完再一次動手：問到一半失敗才回頭清理很麻煩，也讓使用者可以中途反悔
  const plan = [];
  for (let i = 0; i < nodes.length; i++) {
    const img = nodeImage(app, nodes[i]);
    if (!img) continue;
    const name = await askName(app, InputModal, img.basename, plan.length, nodes.length);
    if (name === null) break;                      // 取消 → 不再問剩下的
    const clean = sanitize(name);
    if (!clean) continue;
    plan.push({ node: nodes[i], img, name: clean });
  }
  if (!plan.length) return;

  let made = 0;
  for (const p of plan) {
    try {
      const path = uniquePath(app, folder, p.name);
      /* 用 generateMarkdownLink 產連結，而不是自己拼 [[...]]：
         它會照使用者的設定決定 wikilink / markdown 連結、要不要用相對路徑，
         也會處理同名檔案需要完整路徑的情況。前面加 ! 就是嵌入。 */
      const link = app.fileManager.generateMarkdownLink(p.img, path);
      await app.vault.create(path, '!' + link + '\n');
      // 就地換檔：setData → setFilePath → initFile()，位置與尺寸都保留
      const d = p.node.getData();
      p.node.setData(Object.assign({}, d, { file: path }));
      made++;
    } catch (e) {
      new Notice(t('Failed to create: {{msg}}', { msg: e && e.message ? e.message : e }));
    }
  }
  if (made) {
    canvas.requestSave();
    new Notice(t('Converted {{n}} image(s) to notes in {{folder}}',
      { n: made, folder: folder || t('vault root') }));
  }
}

function setupCanvasImageToNote(plugin, InputModal) {
  const app = plugin.app;

  // 單一節點右鍵
  plugin.registerEvent(app.workspace.on('canvas:node-menu', (menu, node) => {
    if (!nodeImage(app, node)) return;
    menu.addItem((i) => i
      .setTitle(t('Convert to note (embed image)'))
      .setIcon('file-plus-2')
      .onClick(() => convertNodes(plugin, node.canvas, [node], InputModal)));
  }));

  /* 多選右鍵。
     ⚠️ 只在選了 2 個以上才加：單選時 Obsidian 兩個事件都會發，
        不擋的話選單會出現兩個一模一樣的項目。 */
  plugin.registerEvent(app.workspace.on('canvas:selection-menu', (menu, canvas) => {
    const sel = [...(canvas && canvas.selection ? canvas.selection : [])];
    if (sel.length < 2) return;
    const imgs = sel.filter((n) => nodeImage(app, n));
    if (!imgs.length) return;
    menu.addItem((i) => i
      .setTitle(t('Convert {{n}} images to notes', { n: imgs.length }))
      .setIcon('file-plus-2')
      .onClick(() => convertNodes(plugin, canvas, imgs, InputModal)));
  }));
}

module.exports = { setupCanvasImageToNote };
