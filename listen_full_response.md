# 實作計畫：解決 Roocode HTTP 回應串流中斷問題 (更新版)

## 1. 問題概述 (與原計畫相同或類似)

目前 Roocode 的 HTTP 請求處理機制，在第一次 LLM 回應後會清除 `_httpRequestId` 並結束 HTTP 回應。這導致後續由前端自動核准功能觸發的 LLM 對話，其回應無法再傳送給原始的 HTTP 客戶端。

## 2. 核心目標 (更新)

修改現有邏輯，確保 `_httpRequestId` 在整個與特定 HTTP 請求相關的對話流程中保持有效。HTTP 回應（暫時仍為單一 JSON）應能包含所有 LLM 互動的結果，直到任務明確完成 (透過 `attempt_completion` 工具) 或被中止。

## 3. 核心原則 (新增)

1.  `_httpRequestId` 在與特定 HTTP 請求相關的整個對話流程中保持有效。
2.  只有在任務明確完成 (透過 `attempt_completion` 工具) 或被中止時，才清除 `_httpRequestId` 並結束 HTTP 回應。
3.  HTTP 回應的 Content-Type 暫時保持為 `application/json`。數據將在內部累積，最後統一發送。

## 4. 詳細修改步驟

### a. 步驟 1：修改 `src/integrations/httpInput/simpleHttpServer.ts` 中的 `resolvePromptRequest` 函式

**目的：** 使此函式能夠根據指示決定是否真正結束 HTTP 回應。

**修改詳情：**

- 增加一個新參數 `isFinalResponse: boolean`。
- 如果 `isFinalResponse` 為 `false`：不發送 HTTP 回應，不清除超時，不從 `pendingResponses` 中刪除。
- 如果 `isFinalResponse` 為 `true`：清除超時，發送 HTTP 回應，從 `pendingResponses` 中刪除。

```typescript
// 檔案：src/integrations/httpInput/simpleHttpServer.ts
// ... (其他 import 和程式碼) ...

export function resolvePromptRequest(
	requestId: string,
	success: boolean,
	data: any, // 當 isFinalResponse=true 時，這是最終的完整數據
	isFinalResponse: boolean, // 新增參數
) {
	if (pendingResponses.has(requestId)) {
		const entry = pendingResponses.get(requestId)!
		const { res, timeoutId } = entry

		if (isFinalResponse) {
			clearTimeout(timeoutId)

			if (!res.headersSent) {
				if (success) {
					res.status(200).json({ response: data })
				} else {
					res.status(500).json({ error: "Error processing prompt in Roo", details: data })
				}
			} else {
				console.warn(`Headers already sent for request ID ${requestId}, likely due to timeout.`)
			}
			pendingResponses.delete(requestId)
		} else {
			console.log(`Request ID ${requestId}: Intermediate data received, not sending HTTP response yet.`)
		}
	} else {
		console.warn(
			`Request ID ${requestId} not found in pending responses, maybe it timed out or was already resolved.`,
		)
	}
}

// ... 其餘程式碼 ...
```

### b. 步驟 2：修改 `src/core/Cline.ts`

#### i. 新增/修改成員變數

```typescript
// 檔案：src/core/Cline.ts
export class Cline extends EventEmitter<ClineEvents> {
	// ...
	private _httpRequestId?: string
	public _httpAccumulatedResponse: string = "" // 用於累積 HTTP 回應內容
	// ...

	constructor({
		// ...,
		requestId, // 已存在
	}: ClineOptions & { requestId?: string }) {
		// ...
		this._httpRequestId = requestId // 已存在
		this._httpAccumulatedResponse = "" // 確保初始化
		// ...
	}

	async handleWebviewAskResponse(
		askResponse: ClineAskResponse,
		text?: string,
		images?: string[],
		requestId?: string, // 已存在
	) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
		if (requestId) {
			// 已存在
			this._httpRequestId = requestId
			this._httpAccumulatedResponse = "" // 如果是新對話/請求，重置累積器
		}
	}
	// ...
}
```

#### ii. 修改 `recursivelyMakeClineRequests` 方法

**目的：** 呼叫 `resolvePromptRequest` 時不清除 `_httpRequestId`，並指示非最終回應。累積 LLM 文本。

```typescript
// 檔案：src/core/Cline.ts - 在 recursivelyMakeClineRequests 方法中

// 在 try { for await (const chunk of stream) { ... } } 循環內，處理 chunk.type === "text" 時：
// (約 L1838 之後)
if (this._httpRequestId && chunk.type === "text") {
	this._httpAccumulatedResponse += chunk.text
}

// 在 for await 循環之後，原 L1942 - L1946 的邏輯修改為：
if (this._httpRequestId) {
	// 呼叫修改後的 resolvePromptRequest，isFinalResponse 設為 false
	// 此處的 accumulatedText (或 assistantMessage) 只是標示一個內部 LLM 互動完成，
	// 真正的數據會在 attemptCompletionTool 或 abortStream 中發送。
	// data 參數可以傳 null，因為它不會被立即發送。
	resolvePromptRequest(this._httpRequestId, true, null, false)
	// 重要：不要在這裡清除 this._httpRequestId
}
```

#### iii. 修改 `abortStream` 方法

**目的：** 中止時，呼叫 `resolvePromptRequest` 發送錯誤，指示最終回應，並清除 ID 和累積器。

```typescript
// 檔案：src/core/Cline.ts - 在 abortStream 方法中 (約 L1773)
if (this._httpRequestId) {
	const errorReason =
		cancelReason === "streaming_failed" ? (streamingFailedMessage ?? "Streaming failed") : "User cancelled"
	// 指示這是最終回應
	resolvePromptRequest(this._httpRequestId, false, { reason: cancelReason, message: errorReason }, true)
	this._httpRequestId = undefined // 清除 ID
	this._httpAccumulatedResponse = "" // 清除累積的數據
}
```

### c. 步驟 3：修改 `src/core/tools/attemptCompletionTool.ts`

**目的：** 任務完成時，若有 HTTP 請求，則發送累積的完整回應，指示最終回應，並清除 ID 和累積器。

```typescript
// 檔案：src/core/tools/attemptCompletionTool.ts
// ... 其他 import ...
import { resolvePromptRequest } from "../../integrations/httpInput/simpleHttpServer" // 新增 import

export async function attemptCompletionTool(
	cline: Cline,
	block: ToolUse,
	// ... (其他參數)
) {
	const resultFromTool: string | undefined = block.params.result
	// ... (其他變數)

	try {
		// ... (現有的 partial 邏輯保持不變) ...

		if (block.partial) {
			// ... (現有 partial 邏輯)
			return
		} else {
			if (!resultFromTool) {
				// ... (現有錯誤處理)
				return
			}

			cline.consecutiveMistakeCount = 0

			if (cline._httpRequestId) {
				// 使用已累積的數據 cline._httpAccumulatedResponse 作為最終發送內容。
				// resultFromTool 是給 webview 的，可以選擇性附加到 HTTP 回應。
				// 例如: const httpResponseData = cline._httpAccumulatedResponse + `\nCompletion Summary: ${resultFromTool}`;
				const httpResponseData = cline._httpAccumulatedResponse

				resolvePromptRequest(cline._httpRequestId, true, httpResponseData, true) // isFinalResponse = true
				cline._httpRequestId = undefined
				cline._httpAccumulatedResponse = ""
			}

			// ... (現有的命令執行和 webview 訊息發送邏輯，例如：)
			// await cline.say("completion_result", resultFromTool, undefined, false);
			// ...
			// 確保 webview 也能看到結果，即使是 HTTP 請求
			if (block.params.command) {
				// 假設 command 參數存在時的處理
				// ... (原有的 command 處理邏輯) ...
				// 確保在 HTTP 請求後，webview 仍能正確顯示 completion_result 和 command 的 ask
				await cline.say("completion_result", resultFromTool, undefined, false)
				// ... (後續的 ask command 邏輯)
			} else {
				await cline.say("completion_result", resultFromTool, undefined, false)
			}
			// telemetryService.captureTaskCompleted(cline.taskId); // 這些應在 webview 相關邏輯中
			// cline.emit("taskCompleted", cline.taskId, cline.getTokenUsage(), cline.getToolUsage());
		}
	} catch (error) {
		// ... (現有錯誤處理) ...
		if (cline._httpRequestId) {
			const errorDetails = error instanceof Error ? error.message : String(error)
			resolvePromptRequest(
				cline._httpRequestId,
				false,
				{ error: "Error in attemptCompletionTool", details: errorDetails },
				true,
			)
			cline._httpRequestId = undefined
			cline._httpAccumulatedResponse = ""
		}
	}
}
```

## 5. 總結與注意事項 (更新)

1.  **數據累積點：** `Cline.ts` 的 `recursivelyMakeClineRequests` 中，當 LLM 產生文本時，附加到 `_httpAccumulatedResponse`。
2.  **最終發送點：**
    - 成功：`attemptCompletionTool` 讀取 `_httpAccumulatedResponse`，透過 `resolvePromptRequest` (設 `isFinalResponse=true`) 發送。
    - 中止/錯誤：`abortStream` 或其他錯誤處理路徑，透過 `resolvePromptRequest` (設 `isFinalResponse=true`) 發送。
3.  **Content-Type：** 暫時保持 `application/json`。長遠來看，應考慮 `application/x-ndjson` 或 `text/event-stream` 以實現真串流。
4.  **超時管理：** `simpleHttpServer.ts` 中的超時邏輯目前是從請求開始時計時。此計畫未修改此行為。
5.  **測試：** 全面測試各種成功、失敗、中止及多次互動的場景。

---
