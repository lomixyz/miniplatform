const { io } = require('socket.io-client');
const fs = require('fs');

function parseCookies(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    let name = parts[5], value = parts[6];
    out.push(`${name}=${value}`);
  }
  return out.join('; ');
}

const cookieHeader = parseCookies('/tmp/cookies_x.txt');
console.log('cookie:', cookieHeader);

const socket = io('http://127.0.0.1:3000', {
  transportOptions: { polling: { extraHeaders: { Cookie: cookieHeader } } }
});

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('join_room', 1);
});

socket.on('system_message', (msg) => {
  console.log('SYSTEM MESSAGE:', JSON.stringify(msg));
});

socket.on('room_members', (payload) => {
  const members = payload.members || payload;
  const me = (members || []).find((m) => m.username === 'expirytest');
  console.log('expirytest member entry:', JSON.stringify(me));
  setTimeout(() => { socket.disconnect(); process.exit(0); }, 500);
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
