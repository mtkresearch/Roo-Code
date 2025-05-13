import * as vscode from "vscode"
import { startServer, stopServer } from "../integrations/httpInput/simpleHttpServer"

export function registerHttpServer(context: vscode.ExtensionContext) {
	// 啟動 HTTP 伺服器
	const server = startServer(30006)

	if (server) {
		server.on("listening", () => {
			console.log("HTTP server started successfully on port 30006")
		})
		server.on("error", (err: Error) => {
			// 為 err 加上型別
			console.error("Failed to start HTTP server:", err)
		})
	} else {
		console.error("Failed to initialize HTTP server instance.")
	}

	// 在擴充功能停用時停止伺服器
	context.subscriptions.push({
		dispose: () => {
			stopServer()
				.then(() => {
					console.log("HTTP server stopped successfully")
				})
				.catch((err: Error) => {
					// 為 err 加上型別
					console.error("Failed to stop HTTP server:", err)
				})
		},
	})
}
