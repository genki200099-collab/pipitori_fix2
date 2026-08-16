'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const port = 45500 + (process.pid % 7000);
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let host;
let spectator;
let finished = false;
let cpuAdds = 0;
let started = false;
let leaveSent = false;
let replacementObserved = false;
let oldPlayerId = null;
let oldResumeToken = null;
let spectatorId = null;
let roomCode = null;
let stderr = '';
const startedAt = Date.now();
const deadline = setTimeout(() => complete(new Error('intentional-leave full-game timeout')), 300000);

server.stderr.on('data', (chunk) => { stderr += String(chunk); });

function send(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function cleanup() {
  clearTimeout(deadline);
  try { host?.close(); } catch {}
  try { spectator?.close(); } catch {}
  try { server.kill('SIGKILL'); } catch {}
}

function complete(error, result) {
  if (finished) return;
  finished = true;
  cleanup();
  if (error) {
    console.error(error.stack || error);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

function connectSpectator() {
  spectator = new WebSocket(`ws://127.0.0.1:${port}`);
  spectator.on('open', () => send(spectator, {
    type: 'join',
    code: roomCode,
    name: '完走監視員',
    participantRole: 'spectator',
  }));
  spectator.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'errorMsg') throw new Error(message.message);
      if (message.type === 'joined') spectatorId = message.playerId;
      if (message.type !== 'state') return;
      const state = message.state;
      if (state.phase !== 'lobby' && state.players?.[0]?.cpu) {
        replacementObserved = true;
        assert.strictEqual(state.players.length, 4);
        assert.strictEqual(state.hostId, spectatorId, 'spectator receives host after the only human player leaves');
      }
      if (state.phase === 'finished') {
        assert(replacementObserved, 'the departed human seat was replaced by a CPU');
        assert(state.players.every((player) => player.cpu), 'all four seats finish under CPU control');
        assert(state.players.every((player) => Number.isFinite(player.final?.total)));
        assert.strictEqual(state.spectatorCount, 1);
        complete(null, {
          result: 'passed',
          suite: 'intentional-leave-fullgame-v40',
          replacementObserved,
          elapsedMs: Date.now() - startedAt,
          totals: state.players.map((player) => player.final.total),
        });
      }
    } catch (error) {
      complete(error);
    }
  });
  spectator.on('error', complete);
}

function onHostState(state) {
  if (state.phase === 'lobby') {
    if (state.players.length < 4 && cpuAdds === state.players.length - 1) {
      cpuAdds += 1;
      send(host, { type: 'addCpu' });
      return;
    }
    if (state.players.length === 4 && state.spectatorCount === 1 && !started) {
      started = true;
      send(host, { type: 'start' });
    }
    return;
  }
  if (!leaveSent && ['playing', 'passing', 'initialPair'].includes(state.phase)) {
    leaveSent = true;
    send(host, { type: 'leaveRoom' });
  }
}

function connectHost() {
  host = new WebSocket(`ws://127.0.0.1:${port}`);
  host.on('open', () => send(host, {
    type: 'create',
    name: '途中離脱者',
    rounds: 1,
    enableMiddleRankPick: true,
    forceJokerPickCandidate: true,
    shootLoadFireMode: true,
    shootRequiresBabaMoved: true,
  }));
  host.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'errorMsg') throw new Error(message.message);
      if (message.type === 'created') {
        roomCode = message.code;
        oldPlayerId = message.playerId;
        oldResumeToken = message.resumeToken;
        connectSpectator();
      }
      if (message.type === 'leftRoom') {
        assert.strictEqual(message.code, roomCode);
        assert.strictEqual(message.reason, 'intentional');
        assert(oldResumeToken, 'a reconnect token existed before intentional leave');
      }
      if (message.type === 'state') onHostState(message.state);
    } catch (error) {
      complete(error);
    }
  });
  host.on('error', complete);
}

server.stdout.on('data', (chunk) => {
  if (String(chunk).includes('server listening') && !host) connectHost();
});
