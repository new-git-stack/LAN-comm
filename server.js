/**
 * lan-comm server
 * Run: node server.js
 * Requires: npm install ws mdns-server bcrypt cookie
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execSync }        = require('child_process');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcrypt');
const cookie = require('cookie');

const PORT          = process.env.PORT || 8443;
const REDIRECT_PORT = process.env.REDIRECT_PORT || 80;
const HOSTNAME      = 'lan-comm.local';
const HTML_FILE     = path.join(__dirname, 'lan-comm-app.html');
const JS_FILE       = path.join(__dirname, 'app.js');
const CERT_FILE     = path.join(__dirname, 'cert.pem');
const KEY_FILE      = path.join(__dirname, 'key.pem');
const DB_FILE       = path.join(__dirname, 'users.db.json');
const BCRYPT_ROUNDS = 10;
const SESSION_TTL   = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// ── Simple in-memory rate limiter (per IP, per endpoint) ──
// Prevents bcrypt-hammering on /auth/login and /auth/register
const _rateBuckets = new Map(); // key: `${ip}:${endpoint}` -> { count, resetAt }
const RATE_LIMIT    = 10;        // max attempts
const RATE_WINDOW   = 60 * 1000; // per 60 seconds
function checkRateLimit(ip, endpoint) {
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  let bucket = _rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW };
    _rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > RATE_LIMIT;
}
// Sweep stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) if (now > v.resetAt) _rateBuckets.delete(k);
}, 5 * 60 * 1000);

// ── Detect LAN IP ──
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return '127.0.0.1';
}
const LAN_IP = getLanIp();

// ── JSON file database ──
// Structure: { users: {id: {id, email, display_name, password_hash, created_at}},
//              sessions: {token: {token, user_id, expires_at}} }
let db = { users: {}, sessions: {} };

// Debounced atomic write — coalesces rapid saves and never corrupts the file
// on a mid-write crash (write to .tmp then rename)
let _saveTimer = null;
function saveDb() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[db] save error:', e.message);
    }
  }, 500);
}

function initDb() {
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch { db = { users: {}, sessions: {} }; }
  }
  db.users    = db.users    || {};
  db.sessions = db.sessions || {};
  // Prune expired sessions on startup
  const now = Date.now();
  Object.keys(db.sessions).forEach(t => {
    if (db.sessions[t].expires_at < now) delete db.sessions[t];
  });
  saveDb();
  // Also prune periodically during runtime (every hour)
  setInterval(() => {
    const now = Date.now();
    let pruned = 0;
    Object.keys(db.sessions).forEach(t => {
      if (db.sessions[t].expires_at < now) { delete db.sessions[t]; pruned++; }
    });
    if (pruned > 0) { saveDb(); console.log(`[db] pruned ${pruned} expired session(s)`); }
  }, 60 * 60 * 1000);
}

const stmts = {
  getUserByEmail: (email) => {
    return Object.values(db.users).find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  },
  getUserById: (id) => db.users[id] || null,
  insertUser:  (id, email, display_name, password_hash, created_at) => {
    db.users[id] = { id, email, display_name, password_hash, created_at };
  },
  insertSession: (token, user_id, expires_at) => {
    db.sessions[token] = { token, user_id, expires_at };
  },
  getSession: (token, now) => {
    const s = db.sessions[token];
    return (s && s.expires_at > now) ? s : null;
  },
  deleteSession: (token) => { delete db.sessions[token]; },
};

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL;
  stmts.insertSession(token, userId, expiresAt); saveDb();
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const session = stmts.getSession(token, Date.now());
  if (!session) return null;
  return stmts.getUserById(session.user_id);
}

function sessionCookie(token) {
  return cookie.serialize('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL / 1000,
    path: '/',
  });
}

// ── TLS cert ──
function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return;
  console.log('  Generating self-signed TLS certificate...');
  try { execSync('openssl version', { stdio: 'ignore' }); }
  catch { console.error('  ERROR: openssl not found.'); process.exit(1); }
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
     -days 825 -nodes -subj "/CN=${HOSTNAME}" \
     -addext "subjectAltName=IP:127.0.0.1,IP:${LAN_IP},DNS:localhost,DNS:${HOSTNAME}"`,
    { stdio: 'ignore' }
  );
  console.log('  cert.pem + key.pem created.\n');
}
ensureCert();

// ── Request body parser ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Static file server ──
const MIME = { '.html': 'text/html', '.js': 'application/javascript' };
function serveFile(filePath, res, transform) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(`${path.basename(filePath)} not found`); return; }
    const body = transform ? transform(data.toString()) : data;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(body);
  });
}

// ── HTTPS server ──
const httpsServer = https.createServer(
  { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) },
  async (req, res) => {
    const url = req.url.split('?')[0];
    const cookies = cookie.parse(req.headers.cookie || '');
    // HSTS — tell browsers to always use HTTPS for this host from now on
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    // ── Auth endpoints ──
    if (url === '/auth/register' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (checkRateLimit(ip, 'register'))
        return jsonRes(res, 429, { error: 'too many attempts — try again in a minute' });
      const { email, displayName, password } = await readBody(req);
      if (!email || !displayName || !password)
        return jsonRes(res, 400, { error: 'missing fields' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return jsonRes(res, 400, { error: 'invalid email address' });
      if (displayName.length < 1 || displayName.length > 32)
        return jsonRes(res, 400, { error: 'display name must be 1–32 characters' });
      if (password.length < 6)
        return jsonRes(res, 400, { error: 'password must be at least 6 characters' });
      if (stmts.getUserByEmail(email))
        return jsonRes(res, 409, { error: 'an account with that email already exists' });
      const id = crypto.randomUUID();
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      stmts.insertUser(id, email, displayName, hash, Date.now()); saveDb();
      const token = createSession(id);
      res.setHeader('Set-Cookie', sessionCookie(token));
      return jsonRes(res, 201, { id, email, displayName });
    }

    if (url === '/auth/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (checkRateLimit(ip, 'login'))
        return jsonRes(res, 429, { error: 'too many attempts — try again in a minute' });
      const { email, password } = await readBody(req);
      if (!email || !password)
        return jsonRes(res, 400, { error: 'missing fields' });
      const user = stmts.getUserByEmail(email);
      if (!user) return jsonRes(res, 401, { error: 'invalid email or password' });
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return jsonRes(res, 401, { error: 'invalid email or password' });
      const token = createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(token));
      return jsonRes(res, 200, { id: user.id, email: user.email, displayName: user.display_name });
    }

    if (url === '/auth/logout' && req.method === 'POST') {
      if (cookies.session) { stmts.deleteSession(cookies.session); saveDb(); }
      res.setHeader('Set-Cookie', cookie.serialize('session', '', { maxAge: 0, path: '/' }));
      return jsonRes(res, 200, { ok: true });
    }

    if (url === '/auth/me' && req.method === 'GET') {
      const user = validateSession(cookies.session);
      if (!user) return jsonRes(res, 401, { error: 'not authenticated' });
      return jsonRes(res, 200, { id: user.id, email: user.email, displayName: user.display_name });
    }

    // ── Static files ──
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    if (url === '/' || url === '/index.html') {
      serveFile(HTML_FILE, res, html =>
        html.replace('/* __SERVER_IP__ */', `window.__SERVER_IP__ = '${LAN_IP}';`)
      );
    } else if (url === '/app.js') {
      serveFile(JS_FILE, res);
    } else {
      res.writeHead(404); res.end('not found');
    }
  }
);

// ── WebSocket signaling server ──
const wss     = new WebSocketServer({ server: httpsServer });
const clients = new Map(); // socketId -> { ws, userId, displayName }
const activeCalls = new Map(); // socketId -> partnerId (both sides stored)

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  clients.forEach((client, id) => {
    if (id !== excludeId && client.ws.readyState === 1) client.ws.send(msg);
  });
}

function sendTo(id, data) {
  const client = clients.get(id);
  if (client && client.ws.readyState === 1) client.ws.send(JSON.stringify(data));
}

wss.on('connection', (ws, req) => {
  const socketId = crypto.randomUUID();
  const cookies  = cookie.parse(req.headers.cookie || '');
  const user     = validateSession(cookies.session);

  if (!user) {
    ws.send(JSON.stringify({ type: 'error', message: 'not authenticated' }));
    ws.close();
    return;
  }

  clients.set(socketId, { ws, userId: user.id, displayName: user.display_name });
  console.log(`[+] ${user.display_name} (${socketId.slice(0,8)}) connected (${clients.size} total)`);

  // Send welcome with socket ID
  ws.send(JSON.stringify({ type: 'welcome', id: socketId }));

  // Send current peer list with display names
  const peerList = [...clients.entries()]
    .filter(([id]) => id !== socketId)
    .map(([id, c]) => ({ id, displayName: c.displayName }));
  ws.send(JSON.stringify({ type: 'peers', peers: peerList }));

  // Notify others of new peer (with display name)
  broadcast({ type: 'peer-joined', id: socketId, displayName: user.display_name }, socketId);

  ws.on('message', raw => {
    // Enforce message size cap — prevents relay of huge payloads
    if (raw.length > 65536) return; // 64 KB hard limit
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'auth') return; // already authenticated via cookie

    // Allowlist valid client-originating message types
    const ALLOWED_TYPES = new Set([
      'offer', 'answer', 'ice-candidate',
      'call-request', 'call-accepted', 'call-rejected', 'hangup',
      'chat', 'mute-state',
    ]);
    if (!ALLOWED_TYPES.has(msg.type)) return;

    msg.from = socketId;

    // ── Call-state gate: reject calls to/from busy users ──
    if (msg.type === 'call-request') {
      if (activeCalls.has(socketId)) {
        sendTo(socketId, { type: 'call-busy', from: msg.to, reason: 'You are already in a call' });
        return;
      }
      if (activeCalls.has(msg.to)) {
        sendTo(socketId, { type: 'call-busy', from: msg.to, reason: 'User is already in a call' });
        return;
      }
    }
    if (msg.type === 'call-accepted') {
      activeCalls.set(socketId, msg.to);
      activeCalls.set(msg.to, socketId);
    }
    if (msg.type === 'hangup' || msg.type === 'call-rejected') {
      const partner = activeCalls.get(socketId);
      activeCalls.delete(socketId);
      if (partner) activeCalls.delete(partner);
    }

    if (msg.to) sendTo(msg.to, msg);
    else broadcast(msg, socketId);
  });

  ws.on('close', () => {
    // Clean up call state when a user disconnects
    const partner = activeCalls.get(socketId);
    if (partner) {
      activeCalls.delete(partner);
      sendTo(partner, { type: 'hangup', from: socketId });
    }
    activeCalls.delete(socketId);
    clients.delete(socketId);
    broadcast({ type: 'peer-left', id: socketId });
    console.log(`[-] ${user.display_name} disconnected (${clients.size} remaining)`);
  });

  ws.on('error', err => console.error(`[!] ${user.display_name} error:`, err.message));
});

// ── HTTP → HTTPS redirect ──
// Allowlist prevents open-redirect abuse via a crafted Host header.
const REDIRECT_HOST_ALLOWLIST = new Set([LAN_IP, '127.0.0.1', 'localhost', HOSTNAME]);
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const httpServer = http.createServer((req, res) => {
  const rawHost = req.headers.host || LAN_IP;
  const host = rawHost.replace(/:\d+$/, '');
  // Reject unrecognised Host values — fall back to LAN IP so legitimate
  // browsers always get a working redirect even if the header is absent.
  const safeHost = REDIRECT_HOST_ALLOWLIST.has(host) ? host : LAN_IP;
  const location = `https://${safeHost}:${PORT}${req.url}`;
  // Use 307 (temporary) instead of 301 (permanent) so browsers don't cache
  // the redirect before the cert is trusted — avoids redirect loops on first visit
  res.writeHead(307, {
    'Location': location,
    'Content-Type': 'text/html',
  });
  const safeLocation = escHtml(location);
  res.end(`<html><body>Redirecting to <a href="${safeLocation}">${safeLocation}</a></body></html>`);
});

httpServer.listen(REDIRECT_PORT, '0.0.0.0', () => {
  console.log(`  Redirect: http://*:${REDIRECT_PORT} → https://*:${PORT}`);
}).on('error', err => {
  if (err.code === 'EACCES') {
    console.log(`  Note: port ${REDIRECT_PORT} needs admin rights.`);
    console.log(`  Run with: sudo node server.js  (or as Administrator on Windows)`);
    console.log(`  Without this, you need to type https:// manually on first visit.`);
  } else if (err.code === 'EADDRINUSE') {
    console.log(`  Note: port ${REDIRECT_PORT} already in use — redirect server skipped.`);
  }
});

// ── mDNS ──
function startMdns() {
  try {
    const MdnsServer = require('mdns-server');
    const mdns = new MdnsServer({ reuseAddr: true, loopback: true, noInit: false });
    mdns.on('ready', () => {
      mdns.respond({ answers: [{ name: HOSTNAME, type: 'A', ttl: 120, data: LAN_IP }] });
      console.log(`  mDNS: ${HOSTNAME} → ${LAN_IP}`);
    });
    mdns.on('query', query => {
      if (query.questions.some(q => q.name === HOSTNAME && (q.type === 'A' || q.type === 'ANY')))
        mdns.respond({ answers: [{ name: HOSTNAME, type: 'A', ttl: 120, data: LAN_IP }] });
    });
    mdns.on('error', () => {});
  } catch {
    console.log('  mDNS unavailable (npm install mdns-server to enable)');
  }
}

// ── Start ──
initDb();
httpsServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  lan-comm is running');
  console.log('');
  console.log(`  Local:   https://localhost:${PORT}`);
  console.log(`  By name: https://${HOSTNAME}:${PORT}`);
  console.log(`  By IP:   https://${LAN_IP}:${PORT}`);
  console.log('');
  startMdns();
});
