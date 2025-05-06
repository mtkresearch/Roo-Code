import express, { Express, Request, Response } from "express"
import { ClineProvider } from "../../core/webview/ClineProvider"

let app: Express | null = null
let server: any = null

/**
 * 啟動 Express 伺服器，監聽指定的埠號。
 * @param port 伺服器監聽的埠號，預設為 30005。
 * @returns Promise，當伺服器啟動成功時解析。
 */
export function startServer(port: number = 30005): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (app) {
			reject(new Error("Server is already running."))
			return
		}

		app = express()
		app.use(express.json()) // 解析 JSON 請求體

		// 處理 POST /prompt 請求
		app.post("/prompt", async (req: Request, res: Response) => {
			try {
				const prompt = req.body.prompt
				const continueConversation = req.body.continueConversation === true

				if (!prompt || typeof prompt !== "string") {
					res.status(400).send('Bad Request: "prompt" field is required and must be a string.')
					return
				}

				const clineProvider = await ClineProvider.getInstance()

				if (clineProvider) {
					if (continueConversation && clineProvider.getCurrentCline()) {
						// 將 prompt 添加到現有對話
						clineProvider.getCurrentCline()?.handleWebviewAskResponse("messageResponse", prompt, [])
						res.status(200).send("Prompt added to current conversation.")
					} else {
						// 開啟新任務
						await clineProvider.initClineWithTask(prompt)
						res.status(200).send("Prompt sent as new task to Roo.")
					}
				} else {
					res.status(404).send("Active Roo instance not found.")
				}
			} catch (error) {
				console.error("Error handling POST /prompt:", error)
				res.status(500).send("Internal Server Error")
			}
		})

		server = app.listen(port, () => {
			console.log(`HTTP server started on port ${port}`)
			resolve()
		})

		server.on("error", (err: Error) => {
			console.error(`Failed to start server on port ${port}:`, err)
			reject(err)
		})
	})
}

/**
 * 停止 Express 伺服器。
 * @returns Promise，當伺服器關閉時解析。
 */
export function stopServer(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (!server) {
			resolve()
			return
		}

		server.close((err: Error | undefined) => {
			if (err) {
				console.error("Error closing server:", err)
				reject(err)
			} else {
				console.log("HTTP server stopped")
				app = null
				server = null
				resolve()
			}
		})
	})
}
