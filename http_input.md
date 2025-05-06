# 簡化版規劃：透過 HTTP POST 接收 Prompt (實驗性)

## 1. 功能目標

快速驗證透過 HTTP POST 請求將 prompt 字串發送到 Roo 擴充功能並觸發新任務或繼續現有對話的可行性。

## 2. 規劃步驟

### 2.1. 建立 Express 伺服器檔案

- **位置：** `src/integrations/httpInput/simpleHttpServer.ts`
- **依賴：** 引入 `express`。確保 `express` 和 `@types/express` 已安裝。
- **實作：** 建立一個基礎的 Express 應用實例。

### 2.2. 實作 POST 端點 (`/prompt`)

- **中介軟體：** 使用 `express.json()` 解析 JSON 請求 Body。
- **路由：** 建立 `POST /prompt` 的路由處理函式。
- **請求 Body 格式：** 預期為 `{"prompt": "用戶的 prompt 字串", "continueConversation": true/false}`。
- **解析：** 從 `req.body.prompt` 獲取 prompt 字串，並從 `req.body.continueConversation` 獲取是否繼續現有對話的標誌。

### 2.3. 與 Roo 擴充功能互動

- **引入：** 在 POST 處理函式中 `import { ClineProvider } from '../../core/webview/ClineProvider';`。
- **獲取實例：** 呼叫 `const clineProvider = await ClineProvider.getInstance();`。
- **檢查與發送：**
    - 如果 `clineProvider` 存在：
        - 如果 `req.body.continueConversation` 為 `true` 且當前有活動的對話：
            - 調用 `clineProvider.getCurrentCline()?.handleWebviewAskResponse(true, req.body.prompt, [])` 方法，將 prompt 添加到現有對話。
        - 否則：
            - 調用 `clineProvider.initClineWithTask(req.body.prompt)` 方法，開啟新任務。
        - 回傳 HTTP 200 OK (`res.status(200).send('Prompt sent.');`)。
    - 如果 `clineProvider` 不存在：
        - 回傳 HTTP 404 Not Found (`res.status(404).send('Active Roo instance not found.');`)。
- **基本錯誤處理：** 如果 `req.body.prompt` 不存在或不是字串，回傳 HTTP 400 Bad Request。

### 2.4. 伺服器啟動與停止

- **匯出函數：** 在 `simpleHttpServer.ts` 中匯出 `startServer(port: number)` 和 `stopServer()`。`startServer` 應返回伺服器實例，`stopServer` 則關閉該實例。
- **整合 (`activate`)：**
    - 在 `src/extension.ts` 或 `src/activate/index.ts` 中呼叫 `const serverInstance = startServer(30005);` (使用固定埠號 30005)。
    - 將關閉邏輯加入 `context.subscriptions`: `context.subscriptions.push({ dispose: () => stopServer(serverInstance) });` (或類似的註冊方式)。

## 3. Mermaid 流程圖

```mermaid
graph TD
    A[curl POST /prompt '{"prompt":"...", "continueConversation": true/false}'] --> B{Express Server (in Extension)};
    subgraph "Roo 擴充功能"
        B -- 解析 Body --> C[prompt 字串 & continueConversation 標誌];
        B -- 呼叫 --> D[ClineProvider.getInstance()];
        D -- 返回 Provider 實例或 undefined --> B;
        E[ClineProvider];
        F[Roo Webview];
    end
    alt 找到 Provider 實例
        B -- 檢查 continueConversation --> G{continueConversation?};
        G -- 是 --> H[handleWebviewAskResponse];
        G -- 否 --> I[initClineWithTask];
        H --> B;
        I --> B;
        B -- HTTP 200 OK --> A;
    else 未找到 Provider 實例
        B -- HTTP 404 Not Found --> A;
    end
    alt 請求格式錯誤
        B -- HTTP 400 Bad Request --> A;
    end
```

## 4. 注意事項

- 此為實驗性功能，未包含設定、進階錯誤處理或安全機制。
- 埠號 30005 為硬編碼。
- 支援將 prompt 添加到現有對話或開啟新任務，透過 `continueConversation` 參數控制。
- 目前僅支援純文字 prompt，未處理圖片。
