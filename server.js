const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const server = http.createServer(app);
// File/Image upload ke liye payload size limit 10MB rakhi hai
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7 
});

const ADMIN_SECRET_PIN = 'admin@777';

let players = new Map();
let authenticatedAdmins = new Set();

let activeMerchantUpi = 'payment@okaxis';
let activeQrImage = null; // Admin dwara upload ki gayi custom QR image
let pendingDeposits = [];

let adminNextCrash = null;
let adminNextColorNumber = null;

// ==================== AVIATOR LOGIC ====================
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let aviatorStatus = 'WAITING';
let aviatorHistory = [1.24, 2.15, 1.05, 4.30, 1.80, 12.50, 1.12, 3.45];

function generateCrashPoint() {
  if (adminNextCrash !== null) {
    const forced = adminNextCrash;
    adminNextCrash = null;
    io.emit('admin_state_update', { nextCrash: null, nextColor: adminNextColorNumber });
    return forced;
  }
  const rand = Math.random();
  const point = 1.01 + (1 / (1 - rand)) * 0.05;
  return Math.min(parseFloat(point.toFixed(2)), 20.00); 
}

function startAviatorLoop() {
  aviatorStatus = 'WAITING';
  currentMultiplier = 1.00;

  for (let [socketId, player] of players.entries()) {
    player.aviatorBets = { 1: null, 2: null };
  }

  io.emit('game_status', { status: 'WAITING', message: 'Round starting in 5s...' });

  setTimeout(() => {
    aviatorStatus = 'RUNNING';
    crashPoint = generateCrashPoint();
    io.emit('game_status', { status: 'RUNNING' });

    const interval = setInterval(() => {
      currentMultiplier = parseFloat((currentMultiplier + 0.02).toFixed(2));

      if (currentMultiplier >= crashPoint) {
        clearInterval(interval);
        aviatorStatus = 'CRASHED';

        aviatorHistory.unshift(currentMultiplier);
        if (aviatorHistory.length > 15) aviatorHistory.pop();

        io.emit('crash', { crashPoint: currentMultiplier });
        io.emit('history_update', aviatorHistory);

        setTimeout(startAviatorLoop, 3000);
      } else {
        io.emit('tick', { multiplier: currentMultiplier });
      }
    }, 100);
  }, 5000);
}

// ==================== COLOR PREDICTION LOGIC ====================
let colorTimer = 30;
let colorPeriod = 202609001;
let colorHistory = [
  { period: 202609000, number: 7, colors: ['green'] },
  { period: 202608999, number: 2, colors: ['red'] },
  { period: 202608998, number: 0, colors: ['red', 'violet'] }
];

function startColorLoop() {
  setInterval(() => {
    colorTimer--;

    io.emit('color_timer', {
      period: colorPeriod,
      timer: colorTimer,
      canBet: colorTimer > 5
    });

    if (colorTimer <= 0) {
      let winNumber;
      if (adminNextColorNumber !== null) {
        winNumber = adminNextColorNumber;
        adminNextColorNumber = null;
        io.emit('admin_state_update', { nextCrash: adminNextCrash, nextColor: null });
      } else {
        winNumber = Math.floor(Math.random() * 10);
      }

      let winColors = [];
      if (winNumber === 0) winColors = ['red', 'violet'];
      else if (winNumber === 5) winColors = ['green', 'violet'];
      else if (winNumber % 2 === 0) winColors = ['red'];
      else winColors = ['green'];

      for (let [socketId, player] of players.entries()) {
        if (player.colorBets && player.colorBets.length > 0) {
          let totalWon = 0;
          player.colorBets.forEach(bet => {
            let won = false;
            let mult = 0;

            if (bet.type === 'color' && winColors.includes(bet.choice)) {
              won = true;
              mult = bet.choice === 'violet' ? 4.5 : (winColors.includes('violet') ? 1.5 : 2.0);
            } else if (bet.type === 'number' && parseInt(bet.choice) === winNumber) {
              won = true;
              mult = 9.0;
            }

            if (won) totalWon += bet.amount * mult;
          });

          if (totalWon > 0) {
            player.balance = parseFloat((player.balance + totalWon).toFixed(2));
            io.to(socketId).emit('wallet_update', { balance: player.balance });
            io.to(socketId).emit('color_win', { amount: totalWon });
          }
          player.colorBets = [];
        }
      }

      const result = { period: colorPeriod, number: winNumber, colors: winColors };
      colorHistory.unshift(result);
      if (colorHistory.length > 10) colorHistory.pop();

      io.emit('color_result', result);
      io.emit('color_history', colorHistory);

      colorPeriod++;
      colorTimer = 30;
    }
  }, 1000);
}

// ==================== SOCKET CONNECTION ====================
io.on('connection', (socket) => {
  players.set(socket.id, {
    balance: 1000.00,
    aviatorBets: { 1: null, 2: null },
    colorBets: []
  });

  const player = players.get(socket.id);

  socket.emit('wallet_update', { balance: player.balance });
  socket.emit('merchant_payment_update', { upiId: activeMerchantUpi, qrImage: activeQrImage });
  socket.emit('history_update', aviatorHistory);
  socket.emit('game_status', { status: aviatorStatus, multiplier: currentMultiplier });
  socket.emit('color_history', colorHistory);
  socket.emit('color_timer', { period: colorPeriod, timer: colorTimer, canBet: colorTimer > 5 });

  // Deposit Request with UTR
  socket.on('request_deposit', (data) => {
    const amount = parseFloat(data.amount);
    const utr = (data.utr || '').trim();

    if (isNaN(amount) || amount < 50) {
      return socket.emit('wallet_alert', { success: false, message: 'Minimum deposit is ₹50!' });
    }
    if (utr.length < 6) {
      return socket.emit('wallet_alert', { success: false, message: 'Please enter a valid 12-digit UTR!' });
    }

    player.balance = parseFloat((player.balance + amount).toFixed(2));
    socket.emit('wallet_update', { balance: player.balance });
    socket.emit('wallet_alert', { success: true, message: `Deposit of ₹${amount} received! (UTR: ${utr})` });

    const record = {
      id: Date.now(),
      socketId: socket.id.substring(0, 5),
      amount: amount,
      utr: utr,
      time: new Date().toLocaleTimeString()
    };
    pendingDeposits.unshift(record);
    if (pendingDeposits.length > 15) pendingDeposits.pop();
    io.emit('admin_deposit_update', pendingDeposits);
  });

  // Withdraw Handler
  socket.on('request_withdraw', (data) => {
    const amount = parseFloat(data.amount);
    if (isNaN(amount) || amount <= 0) {
      return socket.emit('wallet_alert', { success: false, message: 'Invalid withdrawal amount!' });
    }
    if (amount > player.balance) {
      return socket.emit('wallet_alert', { success: false, message: 'Insufficient balance!' });
    }

    player.balance = parseFloat((player.balance - amount).toFixed(2));
    socket.emit('wallet_update', { balance: player.balance });
    socket.emit('wallet_alert', { success: true, message: `₹${amount} withdrawal requested to ${data.upiId}!` });
  });

  // Aviator Bets
  socket.on('place_bet', (data) => {
    const amount = parseFloat(data.amount);
    const panelId = data.panelId;

    if (aviatorStatus !== 'WAITING' || isNaN(amount) || amount <= 0 || player.balance < amount) {
      return socket.emit('bet_error', { panelId, message: 'Invalid Bet or Low Balance!' });
    }

    player.balance = parseFloat((player.balance - amount).toFixed(2));
    player.aviatorBets[panelId] = { amount, cashedOut: false };

    socket.emit('wallet_update', { balance: player.balance });
    socket.emit('bet_placed', { panelId, amount });
  });

  socket.on('cashout', (data) => {
    const panelId = data.panelId;
    if (aviatorStatus === 'RUNNING' && player.aviatorBets[panelId] && !player.aviatorBets[panelId].cashedOut) {
      player.aviatorBets[panelId].cashedOut = true;
      const winAmount = parseFloat((player.aviatorBets[panelId].amount * currentMultiplier).toFixed(2));
      player.balance = parseFloat((player.balance + winAmount).toFixed(2));

      socket.emit('wallet_update', { balance: player.balance });
      socket.emit('cashout_success', { panelId, winAmount, multiplier: currentMultiplier });
    }
  });

  // Color Bets
  socket.on('place_color_bet', (data) => {
    const amount = parseFloat(data.amount);
    if (colorTimer <= 5) return socket.emit('color_error', { message: 'Betting is closed!' });
    if (isNaN(amount) || amount <= 0 || player.balance < amount) {
      return socket.emit('color_error', { message: 'Low balance or invalid amount!' });
    }

    player.balance = parseFloat((player.balance - amount).toFixed(2));
    player.colorBets.push({ type: data.type, choice: data.choice, amount });

    socket.emit('wallet_update', { balance: player.balance });
    socket.emit('color_bet_confirmed', { choice: data.choice, amount });
  });

  // ================= ADMIN ACTIONS =================
  socket.on('admin_login', (data) => {
    if (data.pin === ADMIN_SECRET_PIN) {
      authenticatedAdmins.add(socket.id);
      socket.emit('admin_login_success');
      socket.emit('admin_state_update', { 
        nextCrash: adminNextCrash, 
        nextColor: adminNextColorNumber,
        currentUpi: activeMerchantUpi,
        currentQr: activeQrImage
      });
      socket.emit('admin_deposit_update', pendingDeposits);
    } else {
      socket.emit('admin_login_error', { message: 'Galat PIN! Access Denied.' });
    }
  });

  socket.on('admin_update_upi', (data) => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    const upi = (data.upiId || '').trim();
    if (upi.length > 3 && upi.includes('@')) {
      activeMerchantUpi = upi;
      io.emit('merchant_payment_update', { upiId: activeMerchantUpi, qrImage: activeQrImage });
      io.emit('admin_state_update', { 
        nextCrash: adminNextCrash, 
        nextColor: adminNextColorNumber,
        currentUpi: activeMerchantUpi,
        currentQr: activeQrImage
      });
      socket.emit('admin_alert', { message: 'UPI ID updated to: ' + activeMerchantUpi });
    }
  });

  // Admin Custom QR Image Upload
  socket.on('admin_upload_qr', (data) => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    activeQrImage = data.image; // Base64 image
    io.emit('merchant_payment_update', { upiId: activeMerchantUpi, qrImage: activeQrImage });
    io.emit('admin_state_update', { 
      nextCrash: adminNextCrash, 
      nextColor: adminNextColorNumber,
      currentUpi: activeMerchantUpi,
      currentQr: activeQrImage
    });
    socket.emit('admin_alert', { message: 'Custom QR Code uploaded successfully!' });
  });

  socket.on('admin_reset_qr', () => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    activeQrImage = null; // Revert to auto-generated QR
    io.emit('merchant_payment_update', { upiId: activeMerchantUpi, qrImage: null });
    io.emit('admin_state_update', { 
      nextCrash: adminNextCrash, 
      nextColor: adminNextColorNumber,
      currentUpi: activeMerchantUpi,
      currentQr: null
    });
    socket.emit('admin_alert', { message: 'Reset to Auto-Generated QR.' });
  });

  socket.on('admin_set_crash', (data) => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    const val = parseFloat(data.multiplier);
    if (!isNaN(val) && val >= 1.01) {
      adminNextCrash = parseFloat(val.toFixed(2));
      io.emit('admin_state_update', { 
        nextCrash: adminNextCrash, 
        nextColor: adminNextColorNumber,
        currentUpi: activeMerchantUpi,
        currentQr: activeQrImage
      });
    }
  });

  socket.on('admin_set_color', (data) => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    const num = parseInt(data.number);
    if (!isNaN(num) && num >= 0 && num <= 9) {
      adminNextColorNumber = num;
      io.emit('admin_state_update', { 
        nextCrash: adminNextCrash, 
        nextColor: adminNextColorNumber,
        currentUpi: activeMerchantUpi,
        currentQr: activeQrImage
      });
    }
  });

  socket.on('admin_clear_overrides', () => {
    if (!authenticatedAdmins.has(socket.id)) return socket.emit('admin_login_error', { message: 'Unauthorized!' });
    adminNextCrash = null;
    adminNextColorNumber = null;
    io.emit('admin_state_update', { 
      nextCrash: null, 
      nextColor: null,
      currentUpi: activeMerchantUpi,
      currentQr: activeQrImage
    });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    authenticatedAdmins.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  startAviatorLoop();
  startColorLoop();
});