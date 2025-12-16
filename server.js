const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the root directory (not 'public')
app.use(express.static(path.join(__dirname)));

// Serve index.html at the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const players = {};
const powerups = [];
const obstacles = [];
const TRACK_LENGTH = 5000;
const LAPS_TO_WIN = 3;
const FINISH_LINE = TRACK_LENGTH;
let gameState = 'lobby'; // lobby, countdown, racing, finished
let countdownValue = 3;
let raceStartTime = null;
let leaderboard = []; // In-memory leaderboard (reset on server restart)

// Generate powerups and obstacles
function generateTrackElements() {
  powerups.length = 0;
  obstacles.length = 0;
  
  // Generate 15 powerups along the track
  for (let i = 0; i < 15; i++) {
    powerups.push({
      id: `powerup-${i}`,
      position: Math.random() * (TRACK_LENGTH - 500) + 200,
      active: true,
      type: 'boost' // boost, shield, etc
    });
  }
  
  // Generate 10 obstacles
  for (let i = 0; i < 10; i++) {
    obstacles.push({
      id: `obstacle-${i}`,
      position: Math.random() * (TRACK_LENGTH - 500) + 200,
      type: 'cone'
    });
  }
}

generateTrackElements();

io.on('connection', (socket) => {
  console.log('New player connected:', socket.id);
  
  // Handle player joining with username
  socket.on('joinGame', (username) => {
    players[socket.id] = {
      id: socket.id,
      name: username || `Player${Object.keys(players).length}`,
      position: 0,
      speed: 0,
      currentLap: 1,
      finished: false,
      finishTime: null,
      color: getRandomColor(),
      clicks: 0,
      hasPowerup: false,
      isInvincible: false,
      carType: 'default',
      totalRaces: 0,
      wins: 0,
      bestTime: null
    };

    // Send current game state to new player
    socket.emit('init', {
      playerId: socket.id,
      players: players,
      gameState: gameState,
      countdown: countdownValue,
      powerups: powerups,
      obstacles: obstacles,
      trackLength: TRACK_LENGTH,
      lapsToWin: LAPS_TO_WIN,
      leaderboard: leaderboard
    });

    // Broadcast new player to all other players
    io.emit('playerJoined', players[socket.id]);
    io.emit('updateLobby', Object.values(players).map(p => ({ name: p.name, ready: false })));
  });

  // Handle chat messages
  socket.on('chatMessage', (message) => {
    if (players[socket.id]) {
      io.emit('chatMessage', {
        player: players[socket.id].name,
        message: message,
        color: players[socket.id].color
      });
    }
  });

  // Handle car selection
  socket.on('selectCar', (carType) => {
    if (players[socket.id]) {
      players[socket.id].carType = carType;
      io.emit('playerUpdated', players[socket.id]);
    }
  });

  // Handle start race request
  socket.on('startRace', () => {
    if (gameState === 'lobby' && Object.keys(players).length > 0) {
      startCountdown();
    }
  });

  // Handle clicks (spam click mechanic)
  socket.on('click', () => {
    if (players[socket.id] && gameState === 'racing' && !players[socket.id].finished) {
      // Each click gives a speed boost
      const boostAmount = players[socket.id].hasPowerup ? 2.5 : 1.8;
      players[socket.id].speed = Math.min(players[socket.id].speed + boostAmount, 20);
      players[socket.id].clicks++;
    }
  });

  // Handle powerup usage
  socket.on('usePowerup', () => {
    if (players[socket.id] && players[socket.id].hasPowerup) {
      players[socket.id].speed = Math.min(players[socket.id].speed + 15, 30);
      players[socket.id].hasPowerup = false;
      players[socket.id].isInvincible = true;
      
      setTimeout(() => {
        if (players[socket.id]) {
          players[socket.id].isInvincible = false;
        }
      }, 3000);
      
      io.emit('playerUsedPowerup', socket.id);
    }
  });

  // Handle player reset
  socket.on('reset', () => {
    resetGame();
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const playerName = players[socket.id]?.name;
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id, name: playerName });
    
    // If no players left, reset game
    if (Object.keys(players).length === 0) {
      resetGame();
    }
  });
});

function startCountdown() {
  gameState = 'countdown';
  countdownValue = 3;
  generateTrackElements(); // Regenerate powerups and obstacles
  io.emit('gameStateChange', { state: gameState, countdown: countdownValue });
  io.emit('trackElements', { powerups, obstacles });
  
  const countdownInterval = setInterval(() => {
    countdownValue--;
    io.emit('countdown', countdownValue);
    
    if (countdownValue === 0) {
      clearInterval(countdownInterval);
      gameState = 'racing';
      raceStartTime = Date.now();
      io.emit('gameStateChange', { state: gameState });
      io.emit('raceStart');
    }
  }, 1000);
}

function resetGame() {
  gameState = 'lobby';
  countdownValue = 3;
  raceStartTime = null;
  
  for (let id in players) {
    players[id].position = 0;
    players[id].speed = 0;
    players[id].currentLap = 1;
    players[id].finished = false;
    players[id].finishTime = null;
    players[id].clicks = 0;
    players[id].hasPowerup = false;
    players[id].isInvincible = false;
  }
  
  generateTrackElements();
  io.emit('gameReset', { state: gameState, players: players, powerups, obstacles });
}

// Game loop - update positions and broadcast
setInterval(() => {
  if (gameState !== 'racing') return;
  
  let updates = false;
  let allFinished = true;
  
  for (let id in players) {
    if (!players[id].finished) {
      allFinished = false;
      
      // Update position based on speed
      players[id].position += players[id].speed;
      
      // Check for lap completion
      if (players[id].position >= TRACK_LENGTH * players[id].currentLap) {
        if (players[id].currentLap < LAPS_TO_WIN) {
          players[id].currentLap++;
          io.emit('lapComplete', { id, lap: players[id].currentLap, name: players[id].name });
        }
      }
      
      // Check powerup collection
      powerups.forEach(powerup => {
        if (powerup.active && Math.abs(players[id].position - powerup.position) < 50) {
          players[id].hasPowerup = true;
          powerup.active = false;
          io.emit('powerupCollected', { playerId: id, powerupId: powerup.id });
        }
      });
      
      // Check obstacle collision
      if (!players[id].isInvincible) {
        obstacles.forEach(obstacle => {
          if (Math.abs(players[id].position - obstacle.position) < 40) {
            players[id].speed = Math.max(0, players[id].speed - 5);
            io.emit('obstacleHit', { playerId: id, obstacleId: obstacle.id });
          }
        });
      }
      
      // Apply friction (car slows down if not clicking)
      if (players[id].speed > 0) {
        players[id].speed = Math.max(0, players[id].speed - 0.25);
      }
      
      // Check if finished (completed all laps)
      if (players[id].position >= TRACK_LENGTH * LAPS_TO_WIN) {
        players[id].position = TRACK_LENGTH * LAPS_TO_WIN;
        players[id].finished = true;
        const finishTime = Date.now() - raceStartTime;
        players[id].finishTime = finishTime;
        players[id].totalRaces++;
        
        // Update leaderboard
        const existingEntry = leaderboard.find(entry => entry.name === players[id].name);
        if (!existingEntry || finishTime < existingEntry.time) {
          if (existingEntry) {
            existingEntry.time = finishTime;
          } else {
            leaderboard.push({
              name: players[id].name,
              time: finishTime,
              clicks: players[id].clicks
            });
          }
          leaderboard.sort((a, b) => a.time - b.time);
          leaderboard = leaderboard.slice(0, 10); // Keep top 10
        }
        
        // Check if winner (first to finish)
        const finishedPlayers = Object.values(players).filter(p => p.finished);
        if (finishedPlayers.length === 1) {
          players[id].wins++;
        }
        
        io.emit('playerFinished', {
          id: id,
          name: players[id].name,
          time: finishTime,
          clicks: players[id].clicks,
          position: finishedPlayers.length
        });
        
        io.emit('leaderboardUpdate', leaderboard);
      }
      
      updates = true;
    }
  }
  
  // Check if all players finished
  if (allFinished && Object.keys(players).length > 0) {
    gameState = 'finished';
    io.emit('gameStateChange', { state: gameState });
  }
  
  // Broadcast updates if there were any changes
  if (updates) {
    io.emit('gameUpdate', players);
  }
}, 50); // 20 FPS

function getRandomColor() {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Use port 10000 to match your deployment configuration
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Racing game server running on port ${PORT}`);
});