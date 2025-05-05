const express = require("express")
const app = express()
const port = 3000

// Middleware to parse JSON bodies
app.use(express.json())

// Endpoint to receive POST requests from Cline.ts
app.post("/log", (req, res) => {
	console.log("Received payload:", req.body)
	res.status(200).send("Payload received successfully")
})

// Start the server
app.listen(port, () => {
	console.log(`Server running on http://localhost:${port}`)
})
