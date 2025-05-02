# 攔截並印出 LLM 回應 Chunk Text 的計畫 (V4)

## 目標

攔截所有 LLM provider 回傳的 `ApiStreamChunk`，並在 VS Code 的 Debug Console/Output 中印出 `type` 為 `text` 或 `reasoning` 的 chunk 的 `text` 內容，主要用於除錯。

## 實作步驟

1.  **目標檔案:** `src/core/Cline.ts`
2.  **定位修改點:** 在 `recursivelyMakeClineRequests` 方法內部的 `for await (const chunk of stream)` 迴圈 (約在第 1775 行開始)。
3.  **加入輸出邏輯:**
    - 在 `case "reasoning":` 區塊 (第 1783 行之後) 加入以下程式碼：
        ```typescript
        if (vscode.workspace.getConfiguration("roo.debug").get("logApiStreamText")) {
        	console.log("API Stream Reasoning:", chunk.text)
        }
        ```
    - 在 `case "text":` 區塊 (第 1792 行之後) 加入以下程式碼：
        ```typescript
        if (vscode.workspace.getConfiguration("roo.debug").get("logApiStreamText")) {
        	console.log("API Stream Text:", chunk.text)
        }
        ```
4.  **新增 VS Code 設定:**
    - 在專案的 `package.json` 檔案中，於 `contributes.configuration.properties` 下新增以下設定：
        ```json
        "roo.debug.logApiStreamText": {
          "type": "boolean",
          "default": false,
          "description": "Log the text content of 'text' and 'reasoning' chunks from the API stream to the debug console."
        }
        ```
    - 確保在 `src/core/Cline.ts` 的開頭導入 `vscode` 模組：
        ```typescript
        import * as vscode from "vscode"
        ```

## Mermaid 圖示

```mermaid
graph TD
    A[開始: 取得所有 Provider 的 Chunk Text] --> B[確認目標檔案: src/core/Cline.ts];
    B --> C[定位修改點: ApiStream 消費迴圈 (recursivelyMakeClineRequests)];
    C --> D[取得 stream chunk];
    D --> E{chunk.type == 'text' or 'reasoning'?};
    E -- Yes --> F[檢查設定 roo.debug.logApiStreamText];
    F -- Enabled --> G[加入 console.log(chunk.text)];
    F -- Disabled --> H[繼續處理];
    E -- No --> H;
    G --> H;
    H --> I[完成修改];
    I --> J[新增 VS Code 設定 (package.json)];
    J --> K[實作完成];
```

## 下一步

在使用者確認此計畫後，切換到 "Code" 模式來實作這些修改。
