/* Gallery Navigator —— 合併版入口
 *
 * 三個模組：
 *   1. Gallery（核心，永遠啟用）：資料夾／標籤導覽 + 卡片牆 + 全文搜尋（含 PDF）+ 連結牆
 *      （Mini Calendar 與 Pinterest 找相似都於 2026-08-11 整套移除，已另行備份。
 *        Pinterest 用的是逆向的私有 API，過不了上架審查。）
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

    /* 圖片預覽：**無條件**啟動，開關由 PeekModule 內部的 enabled getter 即時判斷。
       以前是「關著就不 start」，於是啟動時若為關閉狀態，事後在設定頁打開仍然沒有
       任何 handler → 必須重載外掛才會生效（跟「關掉即時生效」互相矛盾）。
       start() 只是註冊幾個 handler 與一個指令，成本可忽略；handler 開頭就會
       檢查開關並提早 return。 */
    this.peek = new PeekModule(this);
    await this.peek.start();
    if (this.state.enableLinkCards) {
      this.linkcard = new LinkCardModule(this);
      await this.linkcard.start();
    }
  }

  onunload() {
    if (this.peek && this.peek.stop) { try { this.peek.stop(); } catch (e) {} }
    if (super.onunload) super.onunload();
  }
};
