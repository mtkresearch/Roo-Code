import * as vscode from "vscode"
import { startServer, stopServer } from "../integrations/httpInput/simpleHttpServer"

export function registerHttpServer(context: vscode.ExtensionContext) {
	// 啟動 HTTP 伺服器
	startServer(30005)
		.then(() => {
			console.log("HTTP server started successfully")
		})
		.catch((err) => {
			console.error("Failed to start HTTP server:", err)
		})

	// 在擴充功能停用時停止伺服器
	context.subscriptions.push({
		dispose: () => {
			stopServer()
				.then(() => {
					console.log("HTTP server stopped successfully")
				})
				.catch((err) => {
					console.error("Failed to stop HTTP server:", err)
				})
		},
	})
}
