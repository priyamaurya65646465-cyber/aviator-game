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

// Body Parsers & Static Files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. ADMIN OVERRIDE & WITHDRAWAL DATA STORE
// ==========================================
let manualAviatorCrash = null; // Admin forced multiplier
let manualWingoNumber = null;  // Admin forced number (0-9)
let withdrawals = [];          // Centralized memory store for withdrawal requests

// Admin: Set Aviator Crash Multiplier
app.post('/api/admin/set-aviator', (req, res) => {
    const { crashPoint } = req.body;
    if (crashPoint && !isNaN(crashPoint) && parseFloat(crashPoint) >= 1.01) {
        manualAviatorCrash = parseFloat(crashPoint);
        console.log(`[Admin Control] Next Aviator crash forced to: ${manualAviatorCrash}x`);
        return res.json({ success: true, message: `Next Aviator crash set to ${manualAviatorCrash}x` });
    }
    res.status(400).json({ success: false, message: 'Invalid multiplier (minimum 1.01)' });
});

// Admin: Set Win Go Winning Number
app.post('/api/admin/set-wingo', (req, res) => {
    const { number } = req.body;
    if (number !== undefined && !isNaN(number) && parseInt(number) >= 0 && parseInt(number) <= 9) {
        manualWingoNumber = parseInt(number);
        console.log(`[Admin Control] Next Win Go number forced to: ${manualWingoNumber}`);
        return res.json({ success: true, message: `Next Win Go number set to ${manualWingoNumber}` });
    }
    res.status(400).json({ success: false, message: 'Number must be between 0 and 9' });
});

// Admin: Get Current Live System Status
app.get('/api/admin/status', (req, res) => {
    res.json({
        nextAviatorOverride: manualAviatorCrash,
        nextWingoOverride: manualWingoNumber,
        currentAviatorMult: aviatorMult,
        wingoTimer: wingoTimer,
        currentPeriod: periodNumber.toString()
    });
});

// ==========================================
// 2. WITHDRAWAL APIS (User & Admin Handshake)
// ==========================================

// User places a new withdrawal request
app.post('/api/withdraw/request', (req, res) => {
    const { phone, amount, type, details } = req.body;
    if (!phone || !amount || parseFloat(amount) < 110) {
        return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is ₹110' });
    }

    const newReq = {
        id: 'W' + Date.now(),
        phone: phone,
        amount: parseFloat(amount),
        type: type,
        details: details,
        status: 'Pending', // Default state until Admin approves
        date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    withdrawals.unshift(newReq);
    console.log(`[Withdrawal Placed] User: ${phone} | Amount: ₹${amount} | Status: Pending`);
    res.json({ success: true, request: newReq });
});

// User fetches their own withdrawal records
app.get('/api/withdraw/user/:phone', (req, res) => {
    const userReqs = withdrawals.filter(w => w.phone === req.params.phone);
    res.json({ success: true, history: userReqs });
});

// Admin fetches all requests
app.get('/api/admin/withdrawals', (req, res) => {
    res.json({ success: true, withdrawals });
});

// Admin approves or rejects a request
app.post('/api/admin/withdraw-action', (req, res) => {
    const { id, action } = req.body; // action: 'Approve' or 'Reject'
    const target = withdrawals.find(w => w.id === id);

    if (!target) {
        return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (action === 'Approve') {
        target.status = 'Success';
        console.log(`[Withdrawal Approved] ID: ${id} | User: ${target.phone} | Amount: ₹${target.amount}`);
    } else if (action === 'Reject') {
        target.status = 'Rejected';
        console.log(`[Withdrawal Rejected] ID: ${id} | User: ${target.phone}`);
    }

    res.json({ success: true, message: `Withdrawal marked as ${target.status}` });
});

// ==========================================
// 3. PAGE ROUTES
// ==========================================
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/withdraw', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'withdraw.html'));
});

app.get('/deposit', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deposit.html'));
});

// Catch-all route to Lobby
app.get('*', (req, res, next) => {
    if (req.url.includes('.')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 4. AVIATOR ENGINE (Real-time Flight & Crash)
// ==========================================
let aviatorMult = 1.00;
let aviatorFlying = false;
let aviatorCrashPoint = 2.00;
let aviatorTimer = null;

function startAviatorRound() {
    aviatorMult = 1.00;
    aviatorFlying = true;

    // Check if Admin has overridden next round
    if (manualAviatorCrash !== null) {
        aviatorCrashPoint = manualAviatorCrash;
        manualAviatorCrash = null; // Reset back to auto after applying
        console.log(`[Aviator Engine] Target overridden to: ${aviatorCrashPoint}x`);
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

    aviatorTimer = setInterval(() => {
        if (aviatorMult >= aviatorCrashPoint) {
            clearInterval(aviatorTimer);
            aviatorFlying = false;
            io.emit('aviator_crash', aviatorCrashPoint);

            // Wait 4 seconds before starting next round
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
// 5. WINGO 1MIN ENGINE (Lottery Countdown)
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

        // Check if Admin has overridden the number
        if (manualWingoNumber !== null) {
            winningNumber = manualWingoNumber;
            manualWingoNumber = null; // Reset back to auto
            console.log(`[Win Go Engine] Target overridden to: ${winningNumber}`);
        } else {
            winningNumber = Math.floor(Math.random() * 10);
        }

        const color = winningNumber === 0 
            ? "red-violet" 
            : winningNumber === 5 
                ? "green-violet" 
                : winningNumber % 2 === 0 
                    ? "red" 
                    : "green";
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
// 6. SOCKET.IO CONNECTION
// ==========================================
io.on('connection', (socket) => {
    // Send initial states upon connect
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
