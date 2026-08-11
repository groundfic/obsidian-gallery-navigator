/* 發版腳本 —— 用法：npm run release 0.2.1
 *
 * 版本號散在三個檔案裡，漏改任何一個都會出事：
 *   manifest.json  Obsidian 判斷「有沒有新版」的依據
 *   package.json   保持一致（CI 不檢查，但不同步很容易混淆）
 *   versions.json  版本 → 最低 Obsidian 版本的對照表，
 *                  舊版 Obsidian 的使用者靠它自動裝到相容的舊版外掛
 *
 * ⚠️ 外掛上架後，修好 bug **一定要發新版號**，不可以偷改既有 release 的資產：
 *    使用者的 Obsidian 是比對版本號來判斷有無更新的，偷改的話他們永遠收不到。
 *
 * 這支只做本機的準備（改版號 → build → commit → 打 tag），
 * 推不推由你決定；推上去之後 CI 會自動建置、簽章並建立 release。
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const die = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };

const version = (process.argv[2] || '').trim();

if (!version) die('請指定版本號，例如：npm run release 0.2.1');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  die(`版本號格式不對：${version}（要像 0.2.1；Obsidian 的 tag 不加 v 前綴）`);
}

// 1. 工作區必須乾淨 —— 否則會把無關的改動一起 commit 進版本提交
const dirty = sh('git status --porcelain');
if (dirty) die(`工作區有未提交的變更，請先處理：\n${dirty.split('\n').map((l) => '      ' + l).join('\n')}`);

// 2. tag 不可重複（已發布的版本絕不能覆蓋）
let tagExists = false;
try { execSync(`git rev-parse -q --verify refs/tags/${version}`, { stdio: 'ignore' }); tagExists = true; } catch (e) {}
if (tagExists) die(`tag ${version} 已存在。已發布的版本不可覆蓋，請改用新的版號。`);

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const prev = manifest.version;

// 3. 新版號必須比目前的大（避免手滑往回發）
const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => (isNaN(+n) ? n : +n));
  const pb = b.split(/[.-]/).map((n) => (isNaN(+n) ? n : +n));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
};
if (cmp(version, prev) <= 0) die(`新版號 ${version} 沒有大於目前的 ${prev}`);

console.log(`\n  發版 ${prev} → ${version}（minAppVersion ${manifest.minAppVersion}）\n`);

// 4. 同步三個檔案（保持 2 空格縮排與結尾換行，避免無謂的 diff 噪音）
manifest.version = version;
pkg.version = version;
versions[version] = manifest.minAppVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
console.log('  ✓ manifest.json / package.json / versions.json 已同步');

// 5. 重新建置，讓產物與這個版本一致
execSync('npm run build', { stdio: 'inherit' });

// 6. commit + 打 tag（不自動推，留一個反悔的機會）
execSync(`git add -A`, { stdio: 'inherit' });
execSync(`git commit -q -m "chore: release ${version}"`, { stdio: 'inherit' });
execSync(`git tag ${version}`, { stdio: 'inherit' });

console.log(`
  ✓ 已 commit 並打上 tag ${version}

  確認無誤後推上去，CI 會自動建置、簽章並建立 release：

      git push origin main && git push origin ${version}

  想反悔（推之前都還來得及）：

      git tag -d ${version} && git reset --hard HEAD~1
`);
