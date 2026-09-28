const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Serve static frontend files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Default route to lobby
app.get('*', (req, res, next) => {
    if (req.url.includes('.')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 1. AVIATOR ENGINE (Continuous Self-Loop)
// ==========================================
let aviatorMult = 1.00;
let aviatorFlying = false;
let aviatorCrashPoint = 2.00;
let aviatorTimer = null;

function startAviatorRound() {
    aviatorMult = 1.00;
    aviatorFlying = true;

    // Crash point generation: 1.00x se lekar 20.00x tak random
    const rand = Math.random();
    if (rand < 0.10) {
        aviatorCrashPoint = 1.05; // 10% instant crash
    } else if (rand < 0.70) {
        aviatorCrashPoint = parseFloat((1.10 + Math.random() * 2.5).toFixed(2)); // Normal 1.1x - 3.6x
    } else {
        aviatorCrashPoint = parseFloat((3.5 + Math.random() * 15.0).toFixed(2)); // High 3.5x - 18.5x
    }

    console.log(`[Aviator] Round Started! Targets Crash: ${aviatorCrashPoint}x`);

    aviatorTimer = setInterval(() => {
        if (aviatorMult >= aviatorCrashPoint) {
            // Crash ho gaya
            clearInterval(aviatorTimer);
            aviatorFlying = false;
            console.log(`[Aviator] Crashed at: ${aviatorCrashPoint}x`);
            io.emit('aviator_crash', aviatorCrashPoint);

            // 4 seconds ke break ke baad agla round shuru
            setTimeout(() => {
                startAviatorRound();
            }, 4000);
        } else {
            // Har 100ms mein smooth multiplier increment
            aviatorMult = parseFloat((aviatorMult + 0.02 * Math.pow(aviatorMult, 0.4)).toFixed(2));
            io.emit('aviator_tick', aviatorMult);
        }
    }, 100);
}

// Server start hote hi Aviator loop chalu
startAviatorRound();

// ==========================================
// 2. WINGO 1MIN ENGINE
// ==========================================
let wingoTimer = 60;
let currentPeriod = "202609001";
let wingoHistory = [
    { period: "202609000", number: 7, color: "green", bigSmall: "big" }
];

setInterval(() => {
    wingoTimer--;
    if (wingoTimer <= 0) {
        const winningNumber = Math.floor(Math.random() * 10);
        const color = winningNumber === 0 ? "red-violet" : winningNumber === 5 ? "green-violet" : winningNumber % 2 === 0 ? "red" : "green";
        const bigSmall = winningNumber >= 5 ? "big" : "small";

        const roundResult = {
            period: currentPeriod,
            number: winningNumber,
            color: color,
            bigSmall: bigSmall
        };

        wingoHistory.unshift(roundResult);
        if (wingoHistory.length > 15) wingoHistory.pop();

        io.emit('wingo_round_result', roundResult);

        // Reset next period
        currentPeriod = (BigInt(currentPeriod) + 1n).toString();
        wingoTimer = 60;
    }

    io.emit('wingo_tick', {
        timer: wingoTimer,
        period: currentPeriod,
        isLocked: wingoTimer <= 10
    });
}, 1000);

// ==========================================
// 3. SOCKET CONNECTION
// ==========================================
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial data to user
    socket.emit('wingo_init', {
        timer: wingoTimer,
        period: currentPeriod,
        history: wingoHistory
    });

    if (aviatorFlying) {
        socket.emit('aviator_tick', aviatorMult);
    }
});

// Start Server
server.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);
});
