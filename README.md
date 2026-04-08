# LINE LIFF GPS 打卡系統

一個完整範例專案，包含 **LIFF 前端**（`public/liff.html`）與 **Express 後端**（`index.js`），支援：取得使用者定位、計算與公司座標距離、後端驗證 ID token、寫入 Google Sheets、LINE webhook 處理文字指令（上班 / 下班）、自動在 LINE client 發訊息並自動關閉 LIFF 視窗。

---

## 必要條件與前置作業
- **Node.js** v16 或以上  
- **npm** 或 **yarn**  
- Google Cloud 帳號與 **Cloud Run** 權限（若部署到 Cloud Run）  
- 已建立的 **LINE Messaging API Channel**（取得 Channel Secret、Channel Access Token、Channel ID）  
- 已建立的 **LIFF App**（取得 LIFF ID）  
- 已建立的 **Google Spreadsheet**，並分享給 Service Account（編輯權限）  
- 建議使用 **Secret Manager** 儲存敏感資訊

---

## 專案結構
```
project-root/
├─ public/
│  └─ liff.html
├─ index.js
├─ package.json
├─ Dockerfile
└─ README.md
```

---

## 環境變數
在部署平台或本機設定下列環境變數。**不要**把敏感金鑰硬編在程式碼中，建議使用 Secret Manager（或 Cloud Run 的 Secrets 功能）。

敏感（secret）值 — 請放到 Secret Manager / Cloud Run Secrets / CI secrets：

```
LINE_CHANNEL_SECRET=你的_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=你的_channel_access_token
SERVICE_ACCOUNT_KEY_JSON='{"type":"service_account", ... }'   # 完整 JSON 字串，放 Secret Manager
```

非敏感、可由 Cloud Run UI 設定的運行時參數（會被 `GET /config` 提供給前端）：

```
LIFF_ID=你的_liff_id                 # 可放在前端（LIFF ID 無法直接操作後端資源）
OFFICE_LAT=公司緯度                  # e.g. 25.040004
OFFICE_LNG=公司經度                  # e.g. 121.513060
MAX_DISTANCE=允許距離_公尺           # e.g. 100
AUTO_CLOSE_MS=自動關閉毫秒數         # e.g. 1000
SPREADSHEET_ID=你的_spreadsheet_id
SHEET_NAME=考勤表
```

說明：程式碼已改為由後端 `GET /config` 提供上述非敏感參數，前端在啟動時會向 `/config` 取得 `LIFF_ID`、`OFFICE_LAT` 等值，因此部署時請在 Cloud Run 的 Environment variables 設定這些值。

若在建置階段需要使用到私密值（例如私有 npm token），你需要在 Cloud Build 層級提供 secret（此情況可能需要 `cloudbuild.yaml`）。

---

## 使用 GCP Console 建立 Cloud Run（UI 步驟）

以下以 **GCP Console（網頁 UI）** 為主，逐步說明如何建立 Cloud Run 服務並部署專案。你可以選擇以 Container 映像或直接從原始碼部署，這裡提供兩種常見 UI 流程。

### 先決準備
1. 登入 Google Cloud Console。  
2. 選擇或建立 GCP 專案（Console 右上選單）。  
3. 啟用 API：在左側選單搜尋並啟用 **Cloud Run**, **Cloud Build**, **Artifact Registry**（或 Container Registry）, **Secret Manager**, **IAM & Admin**, **Cloud Logging**。

---

### 建立 Service Account 並上傳 Service Account JSON 到 Secret Manager
1. **建立 Service Account**
   - Console 左側選單 → IAM & Admin → Service Accounts → **Create Service Account**。  
   - 名稱例如 `liff-clock-sa`。  
   - 在 **Grant this service account access** 步驟，給予必要角色：`Cloud Run Invoker`（若需要）、`Secret Manager Secret Accessor`（若 Cloud Run 要讀 Secret）、`Cloud Build Service Account`（若使用 Cloud Build）、以及 `Editor` 或更精細的 Sheets 權限（建議只給必要權限）。  
   - 建立完成後記下 service account email。

2. **建立並上傳 Service Account JSON 到 Secret Manager**
   - Console 左側選單 → Security → Secret Manager → **Create Secret**。  
   - Secret name 例如 `service-account-key-json`。  
   - 在 Secret value 貼上你從 Google Cloud Console 下載的 service account JSON（完整內容）。  
   - 建立後在 Secret 的權限設定中，**授予 Cloud Run 執行服務的 service account** `Secret Accessor` 權限（IAM → Add Principal，選擇 Cloud Run 執行的 service account）。

---

### 部署方式 A：從 Container 映像部署（建議穩定流程）
1. **建置映像**
   - Console 左側選單 → Cloud Build → **Triggers**（或直接使用 Cloud Build → Build history → Run build）。  
   - 或在本機使用 `gcloud builds submit --tag gcr.io/PROJECT_ID/liff-clock`（若偏好 CLI）。  
   - 建置完成後映像會出現在 Artifact Registry 或 Container Registry。

2. **部署到 Cloud Run**
   - Console 左側選單 → Cloud Run → **Create Service**。  
   - 選擇 Region（例如 `asia-east1`）。  
   - 在 **Container image URL** 選擇剛剛建好的映像。  
   - **Service name**：例如 `liff-clock`。  
   - **Authentication**：若要公開給 LINE 與使用者，選擇 **Allow unauthenticated invocations**（或視需求設定）。  
   - **Runtime, CPU, Memory**：預設即可，若預期高流量可調整。  
   - **Environment variables**：在 UI 的 Environment variables 區塊，新增下列變數（不要把 service account JSON 放在 env，改用 Secret Manager）：
     - `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_ID`、`SPREADSHEET_ID`、`SHEET_NAME`。
   - **Secrets**：在 Container, Environment variables 區塊下方選擇 **Add secret**，選擇剛剛建立的 `service-account-key-json`，並把它掛載為環境變數（例如 `SERVICE_ACCOUNT_KEY_JSON`）。  
   - **Service account**：在 **Security** 區塊選擇剛建立的 `liff-clock-sa` 作為 Cloud Run 的執行 service account（這樣 Cloud Run 可以存取 Secret 並以該帳號執行）。  
   - **Ingress**：通常選擇 **Allow all traffic**。  
   - 點選 **Create** 完成部署。  
   - 部署完成後取得 Cloud Run 的 HTTPS URL（例如 `https://liff-clock-xxxxx.a.run.app`）。

---

### 部署方式 B：從原始碼直接部署（Cloud Run Source Deploy）
1. Console 左側選單 → Cloud Run → **Create Service** → 選擇 **Deploy from source**（若可用）。  
2. 選擇來源（Cloud Source Repositories、GitHub、Bitbucket），連結你的 repo。  
3. 選擇分支與建置設定（Cloud Build 會自動建置）。  
4. 在部署設定中同樣設定 Environment variables 與 Secrets（如上），並指定執行 service account。  
5. 點選 **Create** 完成部署。

---

### 部署後設定與驗證
1. 在 Cloud Run 服務頁面取得 HTTPS URL，將 LIFF Endpoint 設為：
```
https://<cloud-run-domain>/liff.html?type=clock_in
```
2. 在 LINE Developers 的 Channel 設定中把 webhook 指向：
```
https://<cloud-run-domain>/
```
並按 **Verify** 測試 webhook。  
3. 在 Cloud Run 日誌（Console → Cloud Run → Service → Logs）檢查啟動與請求日誌。

---

## LINE Console 與 LIFF 設定要點
1. **Provider 與 Channel**：在 LINE Developers 建立 Provider，建立 Messaging API Channel，取得 Channel Secret、Channel Access Token、Channel ID。  
2. **Webhook**：在 Channel 設定填入 Cloud Run webhook URL，啟用並 Verify。  
3. **LIFF**：建立 LIFF App，填入 Endpoint URL（Cloud Run 的 `liff.html`），設定 View size 為 `tall`。  
4. **Scopes**：至少選 `openid profile`（後端驗證 ID token 必需）。視需求加入 `chat_message.write` 或啟用 `shareTargetPicker`。  
5. **LIFF ID**：把 LIFF ID 填入 `public/liff.html` 的 `LIFF_ID` 常數或以部署時注入。

---

## Google Sheets 與 Service Account 設定
1. 在 Google Cloud Console 建立 Service Account，授予 Sheets API 權限（或在 IAM 中給予 `roles/editor` 以便測試）。  
2. 下載 Service Account JSON，將內容上傳到 Secret Manager（如上步驟）。  
3. 在 Google Sheets 中分享試算表給 service account 的 email（編輯權限）。  
4. 在專案環境變數或 Secret 中設定 `SPREADSHEET_ID` 與 `SHEET_NAME`。

---

## 測試流程與除錯要點
- 在 LINE App 中開啟 LIFF URL，允許定位。  
- LIFF 會取得定位並計算距離，距離通過時自動 POST `/liff-clock`。  
- 後端驗證 ID token、距離並寫入 Google Sheets，回傳結果。  
- 若在 LINE client 且有權限，前端會嘗試自動發訊息並自動關閉視窗。

**常見錯誤**
- `Invalid signature`：檢查 `LINE_CHANNEL_SECRET` 與 webhook raw body 驗證流程。  
- `SERVICE_ACCOUNT_KEY_JSON is not valid JSON`：確認 JSON 字串未被 shell 轉義或換行。  
- `403` 權限錯誤：確認試算表已分享給 service account 並授予編輯權限。  
- LIFF 在外部瀏覽器行為異常：某些 LIFF API（如 `sendMessages`）僅在 LINE client 有效。

---

## 安全與最佳實務
- 後端務必驗證 LIFF 傳來的 ID token（檢查 `aud` 與 `sub`）。  
- 後端再次計算距離並拒絕超出範圍的請求。  
- 使用 Secret Manager 儲存 Channel secret、access token、service account JSON。  
- 上線時把 `Access-Control-Allow-Origin` 限制為 LIFF domain。  
- 加入 rate limit 或短時間重複打卡檢查以防濫用。  
- 啟用 Cloud Run 與 Cloud Build 的日誌與監控。

---

## 快速檢查清單
- [ ] Cloud Run URL 可存取並回傳 200  
- [ ] LINE webhook Verify 成功  
- [ ] LIFF Endpoint 指向 Cloud Run 並填入 LIFF ID 至 `public/liff.html`  
- [ ] LIFF Scopes 包含 `openid profile`（必要）  
- [ ] Service account JSON 已上傳到 Secret Manager 並授權給 Cloud Run 執行帳號  
- [ ] 試算表已分享給 service account（編輯權限）  
- [ ] Cloud Run 日誌可存取（用於除錯）

---
