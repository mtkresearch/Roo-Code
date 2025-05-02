# 收集完整 LLM 回應計畫 (V1)

## 目標

在 `recursivelyMakeClineRequests` 方法中，收集 `ApiStreamChunk` 中 `type` 為 `text` 或 `reasoning` 的所有 `text` 內容，並在 stream 結束後，根據 VS Code 設定，選擇性地在 Debug Console 中印出完整的累積文字內容。

## 實作步驟

1.  **目標檔案:** `src/core/Cline.ts`
2.  **定位修改點:** `recursivelyMakeClineRequests` 方法 (約 1591 行開始)。
3.  **加入累積邏輯:**
    - 在 `for await (const chunk of stream)` 迴圈 (約 1775 行) **之前**加入：
        ```typescript
        let accumulatedText = ""
        ```
    - 在 `case "reasoning":` 區塊 (約 1782 行之後) 的現有 `console.log` **之前或之後**加入：
        ```typescript
        accumulatedText += chunk.text
        ```
    - 在 `case "text":` 區塊 (約 1796 行之後) 的現有 `console.log` **之前或之後**加入：
        ```typescript
        accumulatedText += chunk.text
        ```
4.  **加入輸出完整回應的邏輯:**
    - 在 `for await (const chunk of stream)` 迴圈 **結束之後** (約在 1838 行之後) 加入以下程式碼：
        ```typescript
        if (vscode.workspace.getConfiguration("roo.debug").get("logFullApiResponse")) {
        	console.log("Full API Response:", accumulatedText)
        }
        ```
5.  **新增 VS Code 設定:**
    - 在專案的 `package.json` 檔案中，於 `contributes.configuration.properties` 下新增以下設定：
        ```json
        "roo.debug.logFullApiResponse": {
          "type": "boolean",
          "default": false,
          "description": "Log the full accumulated text content from the API stream to the debug console after the stream ends."
        }
        ```
    - (根據使用者提供的 `LLM_response.md`，`vscode` 模組應該已經在 `src/core/Cline.ts` 的開頭導入了，無需重複添加。)

## Mermaid 圖示

```mermaid
graph TD
    A[開始: 收集完整 LLM 回應] --> B(確認目標檔案: src/core/Cline.ts);
    B --> C(定位修改點: recursivelyMakeClineRequests);
    C --> D(在 stream 迴圈前宣告 accumulatedText = '');
    D --> E(進入 for await (chunk of stream) 迴圈);
    E --> F{chunk.type == 'text' or 'reasoning'?};
    F -- Yes --> G(accumulatedText += chunk.text);
    F -- No --> H(處理其他 chunk type);
    G --> I(繼續迴圈);
    H --> I;
    I -- 迴圈結束 --> J(檢查設定 roo.debug.logFullApiResponse);
    J -- Enabled --> K(console.log("Full API Response:", accumulatedText));
    J -- Disabled --> L(結束處理);
    K --> L;
    L --> M(新增 VS Code 設定 (package.json));
    M --> N(實作完成);
```
