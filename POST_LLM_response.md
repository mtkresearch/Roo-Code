# 規劃：HTTP POST 接收 Prompt 並等待 LLM 回應後回傳

## 1. 功能目標

修改現有的 HTTP POST `/prompt` 端點功能，使其在接收到 prompt 後，不再立即回覆 HTTP 200 OK，而是等待 Roo 內部處理完成並獲得 LLM 的最終回應後，將該 LLM 回應作為 HTTP 回應的 Body 傳回給原始的 POST 請求客戶端。

## 2. 技術方案：事件驅動/回呼機制

為了處理 LLM 回應的非同步性和潛在延遲，我們將採用事件驅動的方法：

1.  **請求登記：** 當 `/prompt` 收到 POST 請求時，生成一個唯一請求 ID (`requestId`)，並將 HTTP 回應物件 (`res`) 與該 ID 關聯存儲起來，同時設定一個超時定時器。
2.  **觸發處理：** 將 `prompt` 和 `requestId` 傳遞給 Roo 的核心處理邏輯 (`ClineProvider`)。
3.  **等待與回呼：** Roo 核心邏輯在處理完畢並獲得最終 LLM 回應後，使用 `requestId` 和 LLM 回應內容呼叫 HTTP 伺服器提供的一個回呼函數。
4.  **完成回應：** HTTP 伺服器的回呼函數根據 `requestId` 找到對應的 `res` 物件，清除超時定時器，並將 LLM 回應發送給客戶端。

## 3. 規劃步驟

### 3.1. 安裝相依性

需要 `uuid` 套件來生成唯一的請求 ID。

```bash
npm install uuid
npm install --save-dev @types/uuid
```

### 3.2. 修改 `src/integrations/httpInput/simpleHttpServer.ts`

```typescript
import express, { Request, Response } from "express"
import http from "http"
import { v4 as uuidv4 } from "uuid" // 引入 uuid
import { ClineProvider } from "../../core/webview/ClineProvider"

const app = express()
let serverInstance: http.Server | null = null

// 用於存儲待處理的 HTTP 回應物件，鍵是 requestId，值是 Response 物件和超時定時器
const pendingResponses = new Map<string, { res: Response; timeoutId: NodeJS.Timeout }>()
const RESPONSE_TIMEOUT = 60000 // 設定超時時間，例如 60 秒

app.use(express.json())

// 新增：用於從 Roo 核心接收 LLM 回應並完成 HTTP 請求的函數
export function resolvePromptRequest(requestId: string, success: boolean, data: string | object) {
	if (pendingResponses.has(requestId)) {
		const { res, timeoutId } = pendingResponses.get(requestId)!
		clearTimeout(timeoutId) // 清除超時定時器

		if (success) {
			res.status(200).json({ response: data }) // 成功，回傳 LLM 回應
		} else {
			// 處理 Roo 核心回報的錯誤
			res.status(500).json({ error: "Error processing prompt in Roo", details: data })
		}
		pendingResponses.delete(requestId) // 從 Map 中移除
	} else {
		// 可能已經超時或 requestId 無效
		console.warn(`Request ID ${requestId} not found in pending responses, maybe it timed out.`)
	}
}

app.post("/prompt", async (req: Request, res: Response) => {
	const { prompt, continueConversation } = req.body

	if (!prompt || typeof prompt !== "string") {
		return res.status(400).send('Bad Request: "prompt" field is missing or not a string.')
	}

	const clineProvider = await ClineProvider.getInstance()

	if (!clineProvider) {
		return res.status(404).send("Active Roo instance not found.")
	}

	const requestId = uuidv4() // 生成唯一請求 ID

	// 設定超時處理
	const timeoutId = setTimeout(() => {
		if (pendingResponses.has(requestId)) {
			console.error(`Request ${requestId} timed out after ${RESPONSE_TIMEOUT}ms.`)
			pendingResponses.get(requestId)!.res.status(504).send("Gateway Timeout: LLM response took too long.")
			pendingResponses.delete(requestId)
		}
	}, RESPONSE_TIMEOUT)

	// 存儲 res 物件和超時 ID
	pendingResponses.set(requestId, { res, timeoutId })

	try {
		// *** 修改 ClineProvider 的方法，使其能接收 requestId ***
		// *** 並在內部處理 LLM 回應後呼叫 resolvePromptRequest ***
		// 這裡的呼叫方式需要根據 ClineProvider 的實際修改來調整
		if (continueConversation && clineProvider.getCurrentCline()) {
			// 假設 handleWebviewAskResponse 或其內部邏輯被修改以處理 requestId 和回呼
			await clineProvider.getCurrentCline()?.handleWebviewAskResponse(true, prompt, [], requestId) // 傳遞 requestId
		} else {
			// 假設 initClineWithTask 或其內部邏輯被修改以處理 requestId 和回呼
			await clineProvider.initClineWithTask(prompt, requestId) // 傳遞 requestId
		}

		// *** 注意：不再立即發送回應 ***
		// res.status(200).send('Prompt sent.'); // <--- 移除這行
	} catch (error) {
		console.error("Error handling prompt request:", error)
		// 如果在觸發 Roo 處理時就發生錯誤，需要立即回覆並清理
		clearTimeout(timeoutId)
		pendingResponses.delete(requestId)
		res.status(500).send("Internal Server Error while initiating prompt processing.")
	}
})

export function startServer(port: number): http.Server {
	if (serverInstance) {
		console.warn("Server already running.")
		return serverInstance
	}
	serverInstance = app.listen(port, () => {
		console.log(`HTTP Input Server listening on port ${port}`)
	})
	// 處理伺服器關閉時清理待處理的回應
	serverInstance.on("close", () => {
		console.log("HTTP Input Server closing. Clearing pending responses.")
		pendingResponses.forEach(({ res, timeoutId }) => {
			clearTimeout(timeoutId)
			if (!res.headersSent) {
				res.status(503).send("Service Unavailable: Server is shutting down.")
			}
		})
		pendingResponses.clear()
	})
	return serverInstance
}

export function stopServer() {
	if (serverInstance) {
		console.log("Stopping HTTP Input Server...")
		serverInstance.close(() => {
			console.log("HTTP Input Server stopped.")
			serverInstance = null
		})
	}
}
```

### 3.3. 修改 Roo 核心邏輯 (例如 `src/core/Cline.ts`)

需要修改處理 LLM 回應的相關邏輯，以便在獲得最終回應後，呼叫從 `simpleHttpServer.ts` 匯出的 `resolvePromptRequest` 函數。

1.  **接收 `requestId`：**

    - 修改 `handleWebviewAskResponse` 和 `initClineWithTask` (或它們內部調用的處理函數) 的簽名，增加一個可選的 `requestId?: string` 參數。
    - 將這個 `requestId` 儲存起來，與當前的對話或任務關聯。

2.  **獲取最終 LLM 回應：**

    - 找到處理 LLM API 回應流、累積最終文本 (`accumulatedText`) 的地方 (參考使用者提供的 `Cline.ts:1841-1869` 片段)。

3.  **呼叫回呼函數：**

    - 在確認 LLM 回應完全接收並處理完畢後，檢查是否存在關聯的 `requestId`。
    - 如果存在 `requestId`，則從 `simpleHttpServer` 導入 `resolvePromptRequest` 並呼叫它：

        ```typescript
        import { resolvePromptRequest } from '../integrations/httpInput/simpleHttpServer'; // 調整路徑

        // ... 在獲取到 accumulatedText 之後 ...

        const associatedRequestId = /* 獲取與此任務/對話關聯的 requestId */;
        if (associatedRequestId) {
            // 假設 accumulatedText 是最終的 LLM 回應
            resolvePromptRequest(associatedRequestId, true, accumulatedText);
            // 清除關聯的 requestId，避免重複呼叫
        } else {
             // 正常處理，非 HTTP 觸發的流程
        }

        // 如果在處理過程中發生錯誤，也需要呼叫 resolvePromptRequest
        // 例如：
        // if (errorOccurred && associatedRequestId) {
        //     resolvePromptRequest(associatedRequestId, false, { message: 'LLM processing failed', details: error });
        // }
        ```

### 3.4. 錯誤處理

- **請求超時：** `simpleHttpServer.ts` 中的 `setTimeout` 會處理 LLM 回應過慢的情況，回覆 HTTP 504。
- **Roo 內部錯誤：** 如果 Roo 在處理 prompt 過程中出錯，應捕獲錯誤，並呼叫 `resolvePromptRequest(requestId, false, errorDetails)`，回覆 HTTP 500。
- **`ClineProvider` 未找到：** 維持現狀，回覆 HTTP 404。
- **請求格式錯誤：** 維持現狀，回覆 HTTP 400。
- **伺服器關閉：** `stopServer` 時應通知所有待處理的請求。

## 4. Mermaid 流程圖 (更新後)

```mermaid
graph TD
    A[curl POST /prompt '{"prompt":"...", "continueConversation": true/false}'] --> B{Express Server};
    subgraph "Roo 擴充功能"
        B -- 解析 Body & 生成 requestId --> C[prompt, continueConversation, requestId];
        B -- 存儲 res & 設置超時 (requestId) --> P[Pending Responses Map];
        B -- 呼叫 (帶 requestId) --> D[ClineProvider.getInstance()];
        D -- 返回 Provider 實例或 undefined --> B;
        E[ClineProvider];
        F[Roo Webview / Core Logic];
        G[LLM API];
    end

    subgraph "非同步處理"
        E -- 觸發處理 (帶 requestId) --> F;
        F -- 與 LLM 互動 --> G;
        G -- 返回 LLM 回應 --> F;
        F -- 獲取最終回應 & associatedRequestId --> H{有 associatedRequestId?};
        H -- 是 --> I[resolvePromptRequest(requestId, true, llmResponse)];
        H -- 否 --> J[正常內部處理];
        I -- 呼叫 --> B;
        F -- 處理出錯 & associatedRequestId --> K[resolvePromptRequest(requestId, false, errorDetails)];
        K -- 呼叫 --> B;
    end

    subgraph "HTTP 回應"
        B -- 查找 res (requestId) & 清除超時 --> P;
        P -- 返回 res --> B;
        B -- HTTP 200 OK (含 LLM 回應) --> A;
        B -- HTTP 500 Internal Server Error --> A;
    end

    subgraph "錯誤/超時處理"
        P -- 超時觸發 --> L[回覆 HTTP 504 Gateway Timeout];
        L --> A;
        B -- Provider 未找到 --> M[回覆 HTTP 404 Not Found];
        M --> A;
        B -- 請求格式錯誤 --> N[回覆 HTTP 400 Bad Request];
        N --> A;
    end
```

## 5. 注意事項

- **核心邏輯修改：** 此方案需要對 `Cline.ts` 或相關核心處理邏輯進行修改，以接收 `requestId` 並在適當時機呼叫 `resolvePromptRequest`。這是實作此功能的關鍵。
- **超時設定：** `RESPONSE_TIMEOUT` 需要根據預期的 LLM 回應時間合理設定。過短可能導致正常請求失敗，過長則可能讓客戶端等待太久。
- **狀態管理：** `pendingResponses` Map 需要謹慎管理，確保請求完成或超時後能被正確清理，避免內存洩漏。
- **錯誤傳遞：** 需要確保 Roo 核心處理中的錯誤能被捕獲並透過 `resolvePromptRequest` 傳遞回 HTTP 客戶端。
- **測試：** 需要充分測試正常流程、錯誤流程和超時流程。
