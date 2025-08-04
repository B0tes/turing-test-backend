require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http'); // Import the http module
const { Server } = require("socket.io"); // Import the Server class from socket.io

// Import the chat controller
const chatController = require('./Controllers/chatController');

const app = express();
const server = http.createServer(app); // Create an HTTP server instance
const PORT = process.env.PORT || 3000;

// Initialize socket.io with the HTTP server
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' 
            ? process.env.FRONTEND_URL 
            : "http://localhost:3001",
        methods: ["GET", "POST"]
    }
});

// Middleware setup
app.use(cors());
app.use(bodyParser.json());

// Pass the socket.io instance to the controller
chatController.init(io);

// Define API routes
// The following routes are no longer used as we've moved to WebSockets
// app.post('/api/start-session', chatController.startSession);
// app.post('/api/chat', chatController.handleMessage);
// app.post('/api/guess', chatController.handleGuess);

// Define a new route for the root
app.get('/', (req, res) => {
    res.send('Turing Test Backend is running.');
});

// Start the server and listen for connections
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
