// turing-test-backend/controllers/chatController.js


// A helper function to create a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs').promises;

let io;
const lobby = {
    tester: null,
    testedPerson: null
};
const waitingQueue = []; // Queue for humans who were displaced by AI matches
const activeGames = {};

const API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

let personas = [];
async function loadPersonas() {
    try {
        const data = await fs.readFile('./data/personas.json', 'utf8');
        personas = JSON.parse(data);
        console.log('Personas loaded successfully.');
    } catch (err) {
        console.error('Error loading personas:', err);
    }
}
loadPersonas();

exports.init = (socketIoInstance) => {
    io = socketIoInstance;
    console.log('Socket.IO instance passed to chatController.');

    io.on('connection', (socket) => {
        console.log(`New client connected: ${socket.id}`);

        socket.on('disconnect', () => {
            console.log(`Client disconnected: ${socket.id}`);
            if (lobby.tester && lobby.tester.socket.id === socket.id) {
                lobby.tester = null;
            }
            if (lobby.testedPerson && lobby.testedPerson.socket.id === socket.id) {
                lobby.testedPerson = null;
            }
            // Remove from waiting queue if present
            const queueIndex = waitingQueue.findIndex(player => player.socket.id === socket.id);
            if (queueIndex !== -1) {
                waitingQueue.splice(queueIndex, 1);
            }
        });

        socket.on('joinLobby', ({ role }) => {
            handleJoinLobby(socket, role);
        });
        
        // --- FIXED: The newGame event listener had a typo ---
        socket.on('newGame', ({ role }) => {
            handleJoinLobby(socket, role);
        });

        socket.on('sendMessage', ({ sessionId, message }) => {
            handleMessage(socket, sessionId, message);
        });

        socket.on('makeGuess', ({ sessionId, guess }) => {
            handleGuess(socket, sessionId, guess);
        });
    });
};

// ... in chatController.js

const handleJoinLobby = (socket, role) => {
    console.log(`User ${socket.id} joined as a ${role}.`);

    if (role === 'tester') {
        lobby.tester = { socket, id: socket.id };
    } else {
        // Check if there's someone in the waiting queue first
        if (waitingQueue.length > 0) {
            lobby.testedPerson = waitingQueue.shift(); // Take first person from queue
            console.log(`Moved player ${lobby.testedPerson.socket.id} from waiting queue to lobby.`);
        } else {
            lobby.testedPerson = { socket, id: socket.id };
        }
    }

    if (lobby.tester && lobby.testedPerson) {
        const isAI = Math.random() < 0.5;
        let aiPersona = null;
        if (isAI) {
            aiPersona = personas[Math.floor(Math.random() * personas.length)];
        }

        const sessionId = Date.now().toString();

        // --- NEW: Add a timer for the game ---
        const gameTimer = setTimeout(() => {
            handleTimerExpired(sessionId);
        }, 90000); // 90 seconds

        const testerSocket = lobby.tester.socket;
        const testedPersonSocket = lobby.testedPerson.socket;

        if (isAI) {
            // AI match: tester plays with AI, put human in waiting queue
            activeGames[sessionId] = {
                tester: lobby.tester,
                testedPerson: null, // No real human playing
                isAI: true,
                aiPersona,
                messages: [],
                chatCount: 0,
                timerId: gameTimer
            };

            // Add the displaced human to waiting queue
            waitingQueue.push(lobby.testedPerson);

            testerSocket.emit('matchFound', {
                sessionId,
                message: 'A partner has been found! You are speaking with an unknown entity.',
                role: 'tester'
            });

            testedPersonSocket.emit('watchingGame', {
                message: 'The tester is currently playing with an AI. You are next in the queue!',
                sessionId: sessionId
            });

            console.log(`AI Match found! Session ${sessionId} started. Player ${lobby.testedPerson.socket.id} moved to waiting queue.`);
        } else {
            // Human vs Human match
            activeGames[sessionId] = {
                tester: lobby.tester,
                testedPerson: lobby.testedPerson,
                isAI: false,
                aiPersona: null,
                messages: [],
                chatCount: 0,
                timerId: gameTimer
            };

            testerSocket.emit('matchFound', {
                sessionId,
                message: 'A partner has been found! You are speaking with an unknown entity.',
                role: 'tester'
            });

            testedPersonSocket.emit('matchFound', {
                sessionId,
                message: 'A partner has been found! You are speaking with an unknown entity.',
                role: 'tested person'
            });

            console.log(`Human Match found! Session ${sessionId} started. Both players are humans.`);
        }

        lobby.tester = null;
        lobby.testedPerson = null;
    } else {
        socket.emit('waitingForPartner', 'Waiting for a partner to join...');
    }
};

// --- NEW: A new function to handle when the timer expires ---
const handleTimerExpired = (sessionId) => {
    const game = activeGames[sessionId];
    if (game) {
        console.log(`Game timer expired for session ${sessionId}.`);

        // --- NEW: End the game with a "timeout" reason ---
        io.to(game.tester.socket.id).emit('gameEnd', { reason: 'timeout' });
        if (game.testedPerson) {
            io.to(game.testedPerson.socket.id).emit('gameEnd', { reason: 'timeout' });
        }
        
        // Notify waiting players that a game has ended
        notifyWaitingPlayers();
        
        delete activeGames[sessionId];
    }
};

// Notify players in waiting queue that they can try to match again
const notifyWaitingPlayers = () => {
    waitingQueue.forEach(player => {
        player.socket.emit('gameComplete', { message: 'A game has ended. Trying to find you a match...' });
    });
};
// ...

const handleMessage = async (socket, sessionId, message) => {
    const game = activeGames[sessionId];

    if (!game) {
        return socket.emit('error', 'Session not found. Please start a new session.');
    }

    const { tester, testedPerson, isAI, aiPersona } = game;
    const isTester = socket.id === tester.id;
    const isTestedPerson = testedPerson && socket.id === testedPerson.id;

    if (isTestedPerson && game.messages.length === 0) {
        return socket.emit('error', 'Please wait for the Tester to ask the first question.');
    }

    console.log(`Message received from ${isTester ? 'Tester' : 'Tested Person'} in session ${sessionId}: "${message}"`);
    game.messages.push({ sender: isTester ? 'tester' : 'tested_person', text: message });

    if (isTester) {
        if (isAI) {
            try {
                // --- Clear the game timer here ---
                const game = activeGames[sessionId];
                if (game.timerId) {
                    clearTimeout(game.timerId);
                }

                const randomDelay = Math.random() * 4000 + 3000; // 3-7 seconds delay
                await sleep(randomDelay);

                let contents = [];
                const firstMessage = game.messages[0];
                const personaInstruction = {
                    role: "user",
                    parts: [{ text: `${aiPersona.prompt}\n\n${firstMessage.text}` }]
                };
                contents.push(personaInstruction);
                
                for (let i = 1; i < game.messages.length; i++) {
                    const msg = game.messages[i];
                    contents.push({
                        role: msg.sender === 'tester' ? 'user' : 'model',
                        parts: [{ text: msg.text }]
                    });
                }

                const result = await model.generateContent({
                    contents: contents,
                    generationConfig: {
                        maxOutputTokens: 200,
                    }
                });

                const aiResponse = result.response.text();
                
                game.messages.push({ sender: 'ai', text: aiResponse });
                socket.emit('newMessage', { sender: 'ai', text: aiResponse });
                
                io.to(tester.socket.id).emit('gameEnd', { reason: 'readyToGuess', result: 'Time to make your guess!' });
                if (testedPerson) {
                    io.to(testedPerson.socket.id).emit('gameEnd', { reason: 'readyToGuess', result: 'The tester is making their guess...' });
                }

            } catch (error) {
                console.error('Error with Gemini API:', error.message);
                socket.emit('error', 'I am currently experiencing technical difficulties. Please try again later.');
            }
        } else {
            testedPerson.socket.emit('newMessage', { sender: 'tested_person', text: message });
        }
    } else if (isTestedPerson && testedPerson) {
        tester.socket.emit('newMessage', { sender: 'tested_person', text: message });

        const game = activeGames[sessionId];
        if (game.timerId) {
            clearTimeout(game.timerId);
        }

        io.to(tester.socket.id).emit('gameEnd', { reason: 'readyToGuess', result: 'Time to make your guess!' });
        if (testedPerson) {
            io.to(testedPerson.socket.id).emit('gameEnd', { reason: 'readyToGuess', result: 'The tester is making their guess...' });
        }
    } else if (!isTester && !isTestedPerson) {
        // This shouldn't happen in normal flow, but handle gracefully
        return socket.emit('error', 'You are not part of this game session.');
    }
};
// ... in chatController.js

const handleGuess = (socket, sessionId, guess) => {
    const game = activeGames[sessionId];

    if (!game) {
        return socket.emit('error', 'Session not found. Please start a new session.');
    }

    // --- NEW: Clear the game timer when a guess is made ---
    if (game.timerId) {
        clearTimeout(game.timerId);
    }
    
    const { tester, testedPerson, isAI, aiPersona } = game;
    const isTester = socket.id === tester.id;

    if (!isTester) {
        return socket.emit('error', 'Only the Tester can make a guess.');
    }

    console.log(`Tester ${socket.id} made a guess for session ${sessionId}: ${guess}`);
    
    const isCorrect = (guess === 'AI' && isAI) || (guess === 'human' && !isAI);
    
    // Create clean, friendly messages based on correctness
    const testerMessage = isCorrect 
        ? `Great job! The user was ${isAI ? 'an AI' : 'a Person'}!`
        : `Nice try! The user was actually ${isAI ? 'an AI' : 'a Person'}.`;
    const testedPersonMessage = `The tester guessed ${isCorrect ? 'correctly' : 'incorrectly'}!`;

    // --- NEW: Emit the test result with a "guess" reason ---
    tester.socket.emit('gameEnd', { reason: 'guess', result: testerMessage, isCorrect });
    if (testedPerson) {
        testedPerson.socket.emit('gameEnd', { reason: 'guess', result: testedPersonMessage, isCorrect });
    }

    // Notify waiting players that a game has ended
    notifyWaitingPlayers();

    delete activeGames[sessionId];
    console.log(`Session ${sessionId} ended and cleared.`);
};
// ...


exports.init = exports.init;
exports.startSession = (req, res) => { res.status(501).send('Not Implemented'); };
exports.handleMessage = (req, res) => { res.status(501).send('Not Implemented'); };
exports.handleGuess = (req, res) => { res.status(501).send('Not Implemented'); };