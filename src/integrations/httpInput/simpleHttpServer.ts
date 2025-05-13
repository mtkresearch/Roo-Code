import express, { Request, Response } from "express"
import http from "http" // 引入 http
import { v4 as uuidv4 } from "uuid" // 引入 uuid
import { ClineProvider } from "../../core/webview/ClineProvider"

const app = express()
let serverInstance: http.Server | null = null

// 用於存儲待處理的 HTTP 回應物件，鍵是 requestId，值是 Response 物件和超時定時器
const pendingResponses = new Map<string, { res: Response; timeoutId: NodeJS.Timeout }>()
const RESPONSE_TIMEOUT = 180000 // 設定超時時間，增加到 180 秒 (3 分鐘) 以避免 LLM 回應過慢導致的錯誤

app.use(express.json())

// 新增：用於從 Roo 核心接收 LLM 回應並完成 HTTP 請求的函數
export function resolvePromptRequest(requestId: string, success: boolean, data: string | object) {
	if (pendingResponses.has(requestId)) {
		const { res, timeoutId } = pendingResponses.get(requestId)!
		clearTimeout(timeoutId) // 清除超時定時器

		if (!res.headersSent) {
			// 檢查是否已發送回應 (例如超時)
			if (success) {
				res.status(200).json({ response: data }) // 成功，回傳 LLM 回應
			} else {
				// 處理 Roo 核心回報的錯誤
				res.status(500).json({ error: "Error processing prompt in Roo", details: data })
			}
		} else {
			console.warn(`Headers already sent for request ID ${requestId}, likely due to timeout.`)
		}
		pendingResponses.delete(requestId) // 從 Map 中移除
	} else {
		// 可能已經超時或 requestId 無效
		console.warn(
			`Request ID ${requestId} not found in pending responses, maybe it timed out or was already resolved.`,
		)
	}
}

app.post("/prompt", async (req: Request, res: Response) => {
	const { prompt, continueConversation } = req.body

	if (!prompt || typeof prompt !== "string") {
		// 使用 return 避免繼續執行
		res.status(400).send('Bad Request: "prompt" field is missing or not a string.')
		return // 改為單獨的 return
	}

	let clineProvider: ClineProvider | undefined
	try {
		clineProvider = await ClineProvider.getInstance()
	} catch (error) {
		console.error("Error getting ClineProvider instance:", error)
		res.status(500).send("Internal Server Error: Could not get Roo instance.")
		return // 改為單獨的 return
	}

	if (!clineProvider) {
		res.status(404).send("Active Roo instance not found.")
		return // 改為單獨的 return
	}

	const requestId = uuidv4() // 生成唯一請求 ID

	// 設定超時處理
	const timeoutId = setTimeout(() => {
		if (pendingResponses.has(requestId)) {
			console.error(`Request ${requestId} timed out after ${RESPONSE_TIMEOUT}ms.`)
			const { res: timedOutRes } = pendingResponses.get(requestId)!
			if (!timedOutRes.headersSent) {
				timedOutRes.status(504).send("Gateway Timeout: LLM response took too long.")
			}
			pendingResponses.delete(requestId)
		}
	}, RESPONSE_TIMEOUT)

	// 存儲 res 物件和超時 ID
	pendingResponses.set(requestId, { res, timeoutId })

	try {
		// *** 假設 ClineProvider 的方法已被修改以接收 requestId ***
		// *** 並在內部處理 LLM 回應後呼叫 resolvePromptRequest ***
		if (continueConversation && clineProvider.getCurrentCline()) {
			// 假設 handleWebviewAskResponse 返回 Promise
			// Cline.ts 中的 handleWebviewAskResponse 已修改以接收 requestId
			await clineProvider.getCurrentCline()?.handleWebviewAskResponse("messageResponse", prompt, [], requestId) // Re-added requestId
		} else {
			// ClineProvider.ts 中的 initClineWithTask 已修改以接收 requestId
			// Passing undefined for images, parentTask, and empty object for options
			await clineProvider.initClineWithTask(prompt, undefined, undefined, {}, requestId) // Re-added requestId
		}

		// *** 注意：不再立即發送回應 ***
	} catch (error) {
		console.error("Error initiating prompt processing:", error)
		// 如果在觸發 Roo 處理時就發生錯誤，需要立即回覆並清理
		if (pendingResponses.has(requestId)) {
			clearTimeout(timeoutId)
			if (!res.headersSent) {
				res.status(500).send("Internal Server Error while initiating prompt processing.")
			}
			pendingResponses.delete(requestId)
		}
	}
})

// 修改 startServer 返回 http.Server
export function startServer(port: number = 30006): http.Server {
	if (serverInstance) {
		console.warn("Server is already running.")
		return serverInstance // 直接返回現有實例
	}

	serverInstance = app.listen(port, () => {
		console.log(`HTTP Input Server listening on port ${port}`)
	})

	serverInstance.on("error", (err: NodeJS.ErrnoException) => {
		console.error(`Failed to start server on port ${port}:`, err)
		// 根據錯誤類型決定是否需要退出進程或進行其他處理
		if (err.code === "EADDRINUSE") {
			console.error(`Port ${port} is already in use.`)
		}
		// 清理狀態，以便可以嘗試重新啟動
		serverInstance = null
		// 這裡可以選擇拋出錯誤或返回 null/undefined，取決於調用者的期望
		// throw err; // 或者返回一個標識錯誤的狀態
	})

	// 處理伺服器關閉時清理待處理的回應
	serverInstance.on("close", () => {
		console.log("HTTP Input Server closing. Clearing pending responses.")
		pendingResponses.forEach(({ res: pendingRes, timeoutId }, id) => {
			clearTimeout(timeoutId)
			if (!pendingRes.headersSent) {
				pendingRes.status(503).send("Service Unavailable: Server is shutting down.")
			}
			console.log(`Cleared pending request ${id} due to server shutdown.`)
		})
		pendingResponses.clear()
		serverInstance = null // 確保狀態被重置
		console.log("HTTP Input Server stopped and cleaned up.")
	})

	return serverInstance
}

// 修改 stopServer，使其能正確關閉 serverInstance
export function stopServer(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (!serverInstance) {
			console.log("Server not running or already stopped.")
			resolve()
			return
		}

		console.log("Stopping HTTP Input Server...")
		// 使用 serverInstance 進行關閉
		serverInstance.close((err?: Error) => {
			if (err) {
				console.error("Error closing server:", err)
				reject(err)
			} else {
				// close 事件處理器會處理清理工作
				resolve()
			}
		})
	})
}
