/* Gallery Navigator —— 合併版入口
 *
 * 三個模組：
 *   1. Gallery（核心，永遠啟用）：資料夾／標籤導覽 + 卡片牆 + 全文搜尋（含 PDF）
 *                                 + 連結牆 + 待辦 + Pinterest 找相似 + 行事曆
 *   2. Image Peek（可關閉）      ：Quick Look 式圖片預覽（雙擊 / Space）
 *   3. Link Cards（可關閉）      ：裸網址 → Apple 風格連結卡片
 *
 * 狀態：三者共用 data.json 的 `state`
 *   • state.enablePeek / state.enableLinkCards → 模組開關
 *   • state.peek       → Image Peek 的設定
 *   • state.linkcard   → Link Cards 的設定
 *   • Link Cards 的網頁快取另存 linkcard-cache.json（Gallery 的 saveState 是高頻寫入，
 *     幾百 KB 的快取混進去會一直重寫，對 iCloud 很傷）
 *
 * 建置：npm run build（esbuild → main.js）。改 src/ 一定要重新 build。
 */
const { Notice } = require('obsidian');
const { t } = require('./i18n.js');
const { GalleryPlugin } = require('./gallery.js');
const { PeekModule, renderPeekSettings } = require('./peek.ts');
const { LinkCardModule, renderLinkCardSettings } = require('./linkcard.js');
const { CleanLinkModule, renderCleanLinkSettings } = require('./cleanlink.js');

module.exports = class GalleryNavigatorPlugin extends GalleryPlugin {
  async onload() {
    // 設定分頁要用到的渲染器（gallery.js 的設定分頁會去找這兩個）
    this.renderPeekSettings = renderPeekSettings;
    this.renderLinkCardSettings = renderLinkCardSettings;
    this.renderCleanLinkSettings = renderCleanLinkSettings;

    await super.onload();   // Gallery 核心（載入 this.state、註冊 view/指令/設定分頁）

    // 模組預設全開
    if (this.state.enablePeek === undefined) this.state.enablePeek = true;
    if (this.state.enableLinkCards === undefined) this.state.enableLinkCards = true;
    if (this.state.enableCleanLink === undefined) this.state.enableCleanLink = true;

    // 淨化連結：只註冊右鍵選單與指令，沒有背景成本，開關即時生效不必重載
    this.cleanlink = new CleanLinkModule(this);
    this.cleanlink.start();

    if (this.state.enablePeek) {
      this.peek = new PeekModule(this);
      await this.peek.start();
    }
    if (this.state.enableLinkCards) {
      await this.migrateFromOldPlugins();   // 舊的獨立外掛還在的話，把快取接收過來
      this.linkcard = new LinkCardModule(this);
      await this.linkcard.start();
    }
  }

  /* 從舊的獨立外掛接收資料（只做一次）：
     • link-card-preview/linkcard-cache 的網頁 meta 快取
     • link-card-preview/images/ 的圖片檔（353 張，不搬的話會整批重抓）
     • image-peek 的設定
     搬完只是「複製」，不刪舊外掛的檔案 —— 你確認沒問題後再自己停用/移除舊外掛。 */
  async migrateFromOldPlugins() {
    if (this.state._mergedFromOldPlugins) return;
    const a = this.app.vault.adapter;
    const base = this.manifest.dir.replace(/\/[^/]+$/, '');       // …/plugins
    const oldLcp = base + '/link-card-preview';
    const oldPeek = base + '/image-peek';
    let moved = 0;

    try {
      // ① 連結卡片的快取（舊版在 data.json 裡）
      const oldData = oldLcp + '/data.json';
      const newCache = this.manifest.dir + '/linkcard-cache.json';
      if (await a.exists(oldData) && !(await a.exists(newCache))) {
        const j = JSON.parse(await a.read(oldData)) || {};
        if (j.cache) {
          await a.write(newCache, JSON.stringify({ cache: j.cache }));
          moved += Object.keys(j.cache).length;
        }
        if (j.settings) this.state.linkcard = Object.assign({}, j.settings, this.state.linkcard);
      }

      // ② 連結卡片的圖片檔
      const oldImgs = oldLcp + '/images';
      const newImgs = this.manifest.dir + '/linkcard-images';
      if (await a.exists(oldImgs)) {
        if (!(await a.exists(newImgs))) await a.mkdir(newImgs);
        const list = await a.list(oldImgs);
        for (const f of (list.files || [])) {
          const name = f.split('/').pop();
          const dest = newImgs + '/' + name;
          if (await a.exists(dest)) continue;
          await a.writeBinary(dest, await a.readBinary(f));
        }
      }

      // ③ 圖片預覽的設定
      const oldPeekData = oldPeek + '/data.json';
      if (await a.exists(oldPeekData)) {
        const j = JSON.parse(await a.read(oldPeekData)) || {};
        this.state.peek = Object.assign({}, j, this.state.peek);
      }
    } catch (e) { console.warn('[Gallery Navigator] Old-plugin data migration failed (safe to ignore):', e.message); }

    this.state._mergedFromOldPlugins = true;
    this.saveState();
    if (moved) new Notice(t('Gallery Navigator: migrated {{n}} link card cache entries from the old plugin', { n: moved }), 6000);
  }

  onunload() {
    if (this.peek && this.peek.stop) { try { this.peek.stop(); } catch (e) {} }
    if (super.onunload) super.onunload();
  }
};
