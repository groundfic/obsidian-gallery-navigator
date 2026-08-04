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
import { transformSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 順序即最終輸出順序 —— 後面的規則可以覆蓋前面的，不要隨意調換 */
const PARTS = [
  'src/header.css',     // 檔頭註解
  'src/gallery.css',    // 1. Gallery  .gn-*
  'src/peek.css',       // 2. Image Peek  .qp-* .ip-pin-*
  'src/linkcard.css',   // 3. Link Cards  .lcp-*
];

/* 壓縮會把所有註解拿掉，留一行說明免得有人直接改 styles.css */
const BANNER = '/* Gallery Navigator — 自動產生，請勿直接編輯。'
  + '改 src/*.css 後執行 npm run build:css（--raw 可輸出未壓縮版） */\n';

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

  /* 壓縮後才出貨。
     src/*.css 有 36% 是中文註解（維護者要看的），但那些對使用者是純負擔 ——
     以前原封不動塞進 styles.css，141KB 裡有 51KB 是註解。
     壓縮只動輸出，src/ 一行註解都不用刪。
     用 --raw 可以輸出未壓縮版，排查樣式問題時比較好讀。 */
  const raw = process.argv.includes('--raw');
  let final = out;
  if (!raw) {
    try {
      const res = transformSync(out, { loader: 'css', minify: true });

      /* 健檢：所有 class 名稱都必須還在。
         ⚠️ 不要拿括號數當不變量 —— 壓縮器會把「相鄰且選擇器相同」或
            「相鄰且宣告完全相同」的規則合併掉，括號本來就會變少
            （本專案實測少 20 組），那是正確行為，不是資料遺失。
            真正該保證的是「沒有任何選擇器整個消失」。 */
      /* ⚠️ 比對前一定要先去掉註解：src/ 的中文註解裡寫了很多 `.gn-*`、`.qp-*`
            這類說明文字，會被當成選擇器抓出來。壓縮把註解拿掉是正常的，
            不先剝除的話每次都會誤報「少了 34 個選擇器」。 */
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const classesOf = (s) => new Set(strip(s).match(/\.[A-Za-z_-][\w-]*/g) || []);
      const before = classesOf(out);
      const after = classesOf(res.code);
      const lost = [...before].filter((c) => !after.has(c));
      if (lost.length) {
        console.error(`  ✗ 壓縮後少了 ${lost.length} 個選擇器（${lost.slice(0, 5).join(' ')}…）—— 改輸出未壓縮版`);
      } else {
        final = BANNER + res.code;
      }
    } catch (e) {
      console.error(`  ✗ CSS 壓縮失敗（${e.message}）—— 改輸出未壓縮版`);
    }
  }

  writeFileSync(join(root, 'styles.css'), final);
  if (!quiet) {
    const kb = (Buffer.byteLength(final) / 1024).toFixed(1);
    const src = (Buffer.byteLength(out) / 1024).toFixed(1);
    const tag = raw ? '未壓縮' : `壓縮自 ${src}kb`;
    console.log(`  styles.css  ${kb}kb（${tag}）  ←  ${PARTS.length} 個來源檔（括號 ${open} 配平）`);
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
