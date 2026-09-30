#!/bin/bash
# 離線測試，不需要開 Obsidian。
#   bash tests/run.sh
# 排序測試用的是建置出來的 styles.css，所以改過 CSS 要先 npm run build。
# 排序測試需要 Python 版的 Playwright（pip install playwright && playwright install chromium）；
# 沒裝的話前三組照跑，最後一組會失敗。
cd "$(dirname "$0")/.." || exit 1
set -e
echo "== 連結卡快取（過期先顯示、背景重抓、Threads／IG 請求數、淘汰順序）"
node --no-warnings tests/linkcard-cache.test.js
echo "== 設定合併（三方合併的純函式）"
node --no-warnings tests/statesync.test.js
echo "== 兩台裝置共用 data.json（用外掛真正的存檔／拉取方法）"
node --no-warnings tests/plugin-state.test.js
echo "== 手機資料夾排序（無頭瀏覽器模擬觸控）"
python3 tests/reorder-harness.py
