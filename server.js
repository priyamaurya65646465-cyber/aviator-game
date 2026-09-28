const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- GLOBAL STATE ----------------
let adminConfig = {
    upiId: 'merchant@upi',
    qrCodeBase64: ''
};
let pendingDeposits = [];

// ---------------- 1. AVIATOR ENGINE ----------------
let aviatorMultiplier = 1.00;
let aviatorState = 'WAITING'; // WAITING, FLYING, CRASHED
let aviatorCrashPoint = 2.00;
let aviatorBets = [];

function generateCrashPoint() {
    const rand = Math.random();
    if (rand < 0.05) return 1.00; // 5% instant crash
    return parseFloat((0.99 / (1 - rand)).toFixed(2));
}

function startAviatorLoop() {
    aviatorState = 'WAITING';
    aviatorMultiplier = 1.00;
    aviatorCrashPoint = generateCrashPoint();
    aviatorBets = [];
    io.emit('aviator_state', { state: 'WAITING', multiplier: 1.00 });

    setTimeout(() => {
        aviatorState = 'FLYING';
        let startTime = Date.now();

        const interval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            aviatorMultiplier = parseFloat((1.00 * Math.pow(1.06, elapsed * 5)).toFixed(2));

            if (aviatorMultiplier >= aviatorCrashPoint) {
                clearInterval(interval);
                aviatorState = 'CRASHED';
                io.emit('aviator_state', { state: 'CRASHED', multiplier: aviatorMultiplier });
                setTimeout(startAviatorLoop, 4000);
            } else {
                io.emit('aviator_state', { state: 'FLYING', multiplier: aviatorMultiplier });
            }
        }, 100);
    }, 5000);
}
startAviatorLoop();

// ---------------- 2. COLOR PREDICTION (WINGO 60s) ENGINE ----------------
let wingoTimer = 60;
let wingoPeriod = Date.now().toString().slice(-10); // Unique Round ID
let wingoBets = [];
let wingoHistory = [
    { period: '20260901', number: 7, color: ['green'], bigSmall: 'big' },
    { period: '20260902', number: 2, color: ['red'], bigSmall: 'small' },
    { period: '20260903', number: 0, color: ['red', 'violet'], bigSmall: 'small' },
    { period: '20260904', number: 5, color: ['green', 'violet'], bigSmall: 'big' }
];

function calculateColorResult(number) {
    let colors = [];
    if (number === 0) colors = ['red', 'violet'];
    else if (number === 5) colors = ['green', 'violet'];
    else if ([1, 3, 7, 9].includes(number)) colors = ['green'];
    else colors = ['red'];

    let bigSmall = number >= 5 ? 'big' : 'small';
    return { number, colors, bigSmall };
}

function resolveWingoRound() {
    // 0 to 9 random result generate karein
    const winningNumber = Math.floor(Math.random() * 10);
    const { colors, bigSmall } = calculateColorResult(winningNumber);

    const roundResult = {
        period: wingoPeriod,
        number: winningNumber,
        color: colors,
        bigSmall: bigSmall
    };

    wingoHistory.unshift(roundResult);
    if (wingoHistory.length > 20) wingoHistory.pop();

    // Winners calculate karke payout emit karein
    wingoBets.forEach(bet => {
        let winMultiplier = 0;

        // Number bet (9x)
        if (bet.selectType === 'number' && parseInt(bet.selection) === winningNumber) {
            winMultiplier = 9;
        }
        // Big / Small bet (2x)
        else if (bet.selectType === 'bigSmall' && bet.selection === bigSmall) {
            winMultiplier = 2;
        }
        // Color bet
        else if (bet.selectType === 'color') {
            if (bet.selection === 'violet' && colors.includes('violet')) {
                winMultiplier = 4.5;
            } else if (bet.selection === 'green' && colors.includes('green')) {
                winMultiplier = winningNumber === 5 ? 1.5 : 2;
            } else if (bet.selection === 'red' && colors.includes('red')) {
                winMultiplier = winningNumber === 0 ? 1.5 : 2;
            }
        }

        const winAmount = bet.amount * winMultiplier;
        io.to(bet.socketId).emit('wingo_payout', {
            period: wingoPeriod,
            win: winAmount > 0,
            amount: winAmount,
            winningNumber: winningNumber,
            color: colors
        });
    });

    io.emit('wingo_round_result', roundResult);

    // Naya round start karein
    wingoPeriod = (parseInt(wingoPeriod) + 1).toString();
    wingoBets = [];
    wingoTimer = 60;
}

// 60-second background clock
setInterval(() => {
    wingoTimer--;

    io.emit('wingo_tick', {
        timer: wingoTimer,
        period: wingoPeriod,
        isLocked: wingoTimer <= 10 // Aakhri 10s me betting band
    });

    if (wingoTimer <= 0) {
        resolveWingoRound();
    }
}, 1000);

// ---------------- SOCKET COMMUNICATION ----------------
io.on('connection', (socket) => {
    // Initial color game state bhejein
    socket.emit('wingo_init', {
        timer: wingoTimer,
        period: wingoPeriod,
        history: wingoHistory,
        isLocked: wingoTimer <= 10
    });

    // Color Game Bet lagana
    socket.on('wingo_place_bet', (data) => {
        // data = { selectType: 'color'|'number'|'bigSmall', selection: 'green'|5|'big', amount: 100 }
        if (wingoTimer <= 10) {
            return socket.emit('wingo_bet_error', { message: 'Betting is locked for this round!' });
        }
        wingoBets.push({ socketId: socket.id, ...data });
        socket.emit('wingo_bet_success', { message: 'Bet placed successfully!', bet: data });
    });

    // Admin & Deposit events
    socket.on('get_admin_config', () => socket.emit('admin_config', adminConfig));
    socket.on('update_admin_config', (cfg) => {
        adminConfig = { ...adminConfig, ...cfg };
        io.emit('admin_config', adminConfig);
    });

    socket.on('submit_deposit', (dep) => {
        pendingDeposits.push({ id: Date.now(), ...dep, status: 'PENDING' });
        io.emit('pending_deposits', pendingDeposits);
    });

    socket.on('verify_deposit', ({ id, action }) => {
        pendingDeposits = pendingDeposits.map(d => d.id === id ? { ...d, status: action } : d);
        io.emit('pending_deposits', pendingDeposits);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game Server running on port ${PORT}`));