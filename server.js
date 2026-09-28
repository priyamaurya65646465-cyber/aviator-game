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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ADMIN CONTROL STATES
// ==========================================
let manualAviatorCrash = null; // Admin set karega
let manualWingoNumber = null;  // Admin set karega

// Admin API Routes
app.post('/api/admin/set-aviator', (req, res) => {
    const { crashPoint } = req.body;
    if (crashPoint && !isNaN(crashPoint) && crashPoint >= 1.01) {
        manualAviatorCrash = parseFloat(crashPoint);
        return res.json({ success: true, message: `Next Aviator crash set to ${manualAviatorCrash}x` });
    }
    res.status(400).json({ success: false, message: 'Invalid crash multiplier' });
});

app.post('/api/admin/set-wingo', (req, res) => {
    const { number } = req.body;
    if (number !== undefined && !isNaN(number) && number >= 0 && number <= 9) {
        manualWingoNumber = parseInt(number);
        return res.json({ success: true, message: `Next Win Go winning number set to ${manualWingoNumber}` });
    }
    res.status(400).json({ success: false, message: 'Number must be between 0 and 9' });
});

// Admin status read
app.get('/api/admin/status', (req, res) => {
    res.json({
        nextAviatorOverride: manualAviatorCrash,
        nextWingoOverride: manualWingoNumber,
        currentAviatorMult: aviatorMult,
        wingoTimer: wingoTimer,
        currentPeriod: periodNumber.toString()
    });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Catch-all route to lobby
app.get('*', (req, res, next) => {
    if (req.url.includes('.')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 1. AVIATOR ENGINE (With House Control)
// ==========================================
let aviatorMult = 1.00;
let aviatorFlying = false;
let aviatorCrashPoint = 2.00;
let aviatorTimer = null;

function startAviatorRound() {
    aviatorMult = 1.00;
    aviatorFlying = true;

    // Check if Admin has manually set the target
    if (manualAviatorCrash !== null) {
        aviatorCrashPoint = manualAviatorCrash;
        manualAviatorCrash = null; // Reset back to auto after setting
        console.log(`[Aviator Admin Override] Crash Point set to: ${aviatorCrashPoint}x`);
    } else {
        const rand = Math.random();
        if (rand < 0.12) {
            aviatorCrashPoint = 1.05;
        } else if (rand < 0.75) {
            aviatorCrashPoint = parseFloat((1.10 + Math.random() * 2.2).toFixed(2));
        } else {
            aviatorCrashPoint = parseFloat((3.2 + Math.random() * 12.0).toFixed(2));
        }
    }

    console.log(`[Aviator] Round Started! Targets Crash: ${aviatorCrashPoint}x`);

    aviatorTimer = setInterval(() => {
        if (aviatorMult >= aviatorCrashPoint) {
            clearInterval(aviatorTimer);
            aviatorFlying = false;
            console.log(`[Aviator] Crashed at: ${aviatorCrashPoint}x`);
            io.emit('aviator_crash', aviatorCrashPoint);

            setTimeout(() => {
                startAviatorRound();
            }, 4000);
        } else {
            aviatorMult = parseFloat((aviatorMult + 0.02 * Math.pow(aviatorMult, 0.45)).toFixed(2));
            io.emit('aviator_tick', aviatorMult);
        }
    }, 100);
}

startAviatorRound();

// ==========================================
// 2. WINGO ENGINE (With House Control)
// ==========================================
let wingoTimer = 60;
let periodNumber = 202609001;
let wingoHistory = [
    { period: "202609000", number: 7, color: "green", bigSmall: "big" }
];

setInterval(() => {
    wingoTimer--;
    if (wingoTimer <= 0) {
        let winningNumber;

        // Check if Admin has overridden next round
        if (manualWingoNumber !== null) {
            winningNumber = manualWingoNumber;
            manualWingoNumber = null; // Reset back to auto
            console.log(`[Win Go Admin Override] Winning number set to: ${winningNumber}`);
        } else {
            winningNumber = Math.floor(Math.random() * 10);
        }

        const color = winningNumber === 0 ? "red-violet" : winningNumber === 5 ? "green-violet" : winningNumber % 2 === 0 ? "red" : "green";
        const bigSmall = winningNumber >= 5 ? "big" : "small";

        const roundResult = {
            period: periodNumber.toString(),
            number: winningNumber,
            color: color,
            bigSmall: bigSmall
        };

        wingoHistory.unshift(roundResult);
        if (wingoHistory.length > 15) wingoHistory.pop();

        io.emit('wingo_round_result', roundResult);

        periodNumber++;
        wingoTimer = 60;
    }

    io.emit('wingo_tick', {
        timer: wingoTimer,
        period: periodNumber.toString(),
        isLocked: wingoTimer <= 10
    });
}, 1000);

// ==========================================
// 3. SOCKET
// ==========================================
io.on('connection', (socket) => {
    socket.emit('wingo_init', {
        timer: wingoTimer,
        period: periodNumber.toString(),
        history: wingoHistory
    });

    if (aviatorFlying) {
        socket.emit('aviator_tick', aviatorMult);
    }
});

server.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);
});
