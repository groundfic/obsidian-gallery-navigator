/* styles.css 的建置：把 src/ 的分段樣式拼成外掛根目錄的 styles.css
 *
 * 為什麼需要這個：Obsidian 只讀外掛根目錄的單一 styles.css，
 * 但 3000 行擠在一個檔案裡沒法維護。以前是「手動複製貼上」同步，
 * 結果改了 src/gallery.css 卻忘了同步，畫面沒反應要找很久。
 *
 * 用法：npm run build:css（npm run build 會自動一起做）
 */

import { readFileSync, writeFileSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 順序即最終輸出順序 —— 後面的規則可以覆蓋前面的，不要隨意調換 */
const PARTS = [
  'src/header.css',     // 檔頭註解
  'src/gallery.css',    // 1. Gallery  .gn-*
  'src/peek.css',       // 2. Image Peek  .qp-* .ip-pin-*
  'src/linkcard.css',   // 3. Link Cards  .lcp-*
];

function build({ quiet = false } = {}) {
  const chunks = PARTS.map((p) => readFileSync(join(root, p), 'utf8').replace(/\s*$/, ''));
  const out = chunks.join('\n\n') + '\n';

  /* 健檢：括號沒配平代表某一段被截斷了，這種錯在瀏覽器裡極難查。
     寧可中止也不要寫出壞掉的 styles.css —— 舊的至少還能用。 */
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open !== close) {
    console.error(`  ✗ CSS 括號不配平：{ ${open} / } ${close} —— 中止，保留原本的 styles.css`);
    return false;
  }

  writeFileSync(join(root, 'styles.css'), out);
  if (!quiet) {
    const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
    console.log(`  styles.css  ${out.split('\n').length} 行 / ${kb}kb  ←  ${PARTS.length} 個來源檔（括號 ${open} 配平）`);
  }
  return true;
}

if (!build()) process.exit(1);

if (process.argv.includes('--watch')) {
  console.log('  監看中… 改任何一個 src/*.css 就會重新拼接（Ctrl+C 結束）');
  let timer = null;
  for (const p of PARTS) {
    watch(join(root, p), () => {
      // 編輯器常會連續觸發多次事件（寫入 + 改 mtime），去彈跳一下
      clearTimeout(timer);
      timer = setTimeout(() => {
        const at = new Date().toTimeString().slice(0, 8);
        if (build({ quiet: true })) console.log(`  [${at}] styles.css 已更新`);
      }, 60);
    });
  }
}
