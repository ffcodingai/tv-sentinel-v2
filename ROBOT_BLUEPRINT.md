# 🤖 哨兵機器人藍圖 — 一致行情轉折哨兵

## 基礎資訊
- **名稱:** 一致行情轉折哨兵
- **ID:** 1393bbaf-decd-4e52-84d4-43b1ade884c8
- **類型:** up_turn（上漲/下跌轉折偵測）
- **狀態:** active
- **範圍:** 全球 — 當前時區開盤市場
- **間隔:** 5分鐘
- **專案位置:** `~/tv-sentinel/`
- **後端:** `server.js` | **執行引擎:** `executor.js` | **前端:** `public/index.html`
- **DB:** `sentinel.db` (SQLite)

## 功能定義
**目標:** 在全部一致行情下，根據多重監控條件判定轉折點。
**雙向監控:**
- 📈 上漲趨勢 → 監控 上漲轉折點 → 折溢價擴大+事件信號預示轉跌
- 📉 下跌趨勢 → 監控 下跌轉折點 → 折溢價擴大+事件信號預示轉漲

## 監控條件（5 大類）
1. 🔧 技術事件 — 阻力/支撐突破、均線偏離、技術形態（頭肩頂底/三角/W底等）
2. 🪙 大宗商品 — 持續放量的黃金、白銀、原油等，價格行為+量能確認
3. 💱 匯率 — USD/CNH、EUR/USD、USD/JPY 等主要匯率技術形態
4. 🌍 地緣事件 — 戰爭、制裁、選舉、貿易協議、政策變動
5. 📊 金融數據公布 — 非農(NFP)、CPI、央行加息/降息、GDP、PMI

## 物料 (Data Sources)

| # | 物料 | 轉折哨兵 | 趨勢管理 | 來源 | 門檻 |
|---|---|---|---|---|---|
| ① | 📊 **商品放量** | ✅ 需要 | ✅ 需要 | `/tmp/volume-surge-segments.json` 金AU0/銀AG0/油IG:LCO,SC0,CL/BTC/ETH/匯率SD_IDX:* | ratio > 1.2 |
| ② | 🔥 **板塊放量** | ✅ 需要 | ❌ 不需要 | sector-rotation VolTrend — 板塊「預期轉多/空」信號變化 | 有 VolTrend status 變化 |
| ③ | 📈 tv-trend 板塊折溢價 | ✅ 一級+四級+差距 | ✅ 一級小+四級一致 | `8288/signal/data/list` | 一致≥60% / spread>0.30 |
| ④ | 📉 tv-index 方向 | ✅ composite + H35/H36段 | ✅ composite 方向 | `localhost:3334/api/data` | 最後3點判方向 |
| ⑤ | 🛰️ tv-intel 事件 | ✅ (待接入) | ✅ (待接入) | FF-Mac:3000/api/news | 一致性確認 |

## 參數設定
| 參數 | 值 | 說明 |
|---|---|---|
| 商品放量門檻 | ratio > 1.2 | VolumePercent20DaysHour |
| 板塊放量門檻 | VolTrend status 變化 | sector rotation 板塊成交量趨勢信號 |
| 一致性門檻 | ≥ 60% | 板塊同方向超過 60% |
| 折溢價門檻 | > 0.30 | 溢價群 vs 折價群差距 |
| 子版塊檢查 | true | IT 子類分歧/一致 |
| tv-index 方向 | localhost:3334/api/data | composite 最後 3 點判斷 |
| 事件檢查 | true | tv-intel (待接入) |

## 觸發條件

### ⚡ 一致行情轉折哨兵 (全部成立)
1. 🔥 **商品放量**: 金/銀/原油/BTC/ETH/匯率 任一 ratio > 1.2
2. 🔥 **板塊放量**: 當前開盤市場板塊出現 VolTrend 信號變化
3. ✅ 一致行情: 開盤市場全部同方向 (≥60%)
4. 🔴 折溢價擴大: 溢價群 vs 折價群差距 > 0.30
5. ⚠️ 四級分歧: IT 子類出現溢價/折價對立
6. 📊 tv-index 方向確認: composite 方向與板塊一致

### 🤖 一致行情趨勢管理機器人 (全部成立)
1. 🔥 **商品放量**: 金/銀/原油/BTC/ETH/匯率 任一 ratio > 1.2
2. 🟢 折溢價小: spread ≤ 0.30
3. ✅ 市場一致: 開盤市場全部同方向
4. ✅ 四級一致: IT 子類無溢價/折價對立
5. 📊 tv-index 方向確認: composite 方向與趨勢一致

## API
- `POST /api/sentinels/check` — 執行哨兵檢查
  - Body: `{ at: "YYYY-MM-DD HH:MM" }` (可選，不傳=當前時間)
  - Returns: 8 步驟結果 + 觸發狀態 + 市場數據

## 檔案結構
```
~/tv-sentinel/
├── server.js          — Express 後端 (port 3333)
├── executor.js        — 哨兵執行引擎 (8步判定邏輯)
├── database.js        — SQLite 資料庫
├── sentinel.db        — DB 檔案
├── package.json
└── public/
    └── index.html     — 前端頁面（機器人藍圖）
```

## 修改記錄
- 2026-06-13: 初始建立 — 一致行情轉折哨兵 (ID: 1393bbaf-...)
- 2026-06-13: 新增第二個 — 一致行情趨勢管理機器人 (ID: 6cee3021-...)
- 前端: 加入 TAB 切換，2 個機器人獨立頁面
- 後端: 2 個 executor（executor.js / executor-trend.js）各有獨立 API

## 修改記錄
- 2026-06-13: 初始建立
- 2026-06-15: 🔥 新增放量檢查 Step 3（金/銀/原油/BTC/ETH/匯率）
                         接入 tv-index 方向確認 Step 8
                         移除佔位的商品波幅 API 需求（放量數據取代）

## 待完成
- [ ] AI intel 事件真實接入
- [ ] 全部市場+股指期貨同向物料（由 it9 提供）
