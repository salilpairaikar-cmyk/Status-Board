const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const repository = require('./data/repository.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// --- SESSION STORE WITH TTL ---
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomUUID();
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of sessions.entries()) {
    if (now > data.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

// --- HELPERS ---

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

// Protected JSON body reader with 1MB DoS ceiling
function readJsonBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });

    request.on('error', reject);
  });
}

function parseCookie(header, name) {
  const match = (header || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function currentUser(request) {
  const token = parseCookie(request.headers.cookie, 'session');
  return getSession(token);
}

function requireUser(request, response, requiredRole) {
  const user = currentUser(request);
  if (!user || (requiredRole && user.role !== requiredRole)) {
    sendJson(response, 401, { error: 'Authentication required' });
    return null;
  }
  return user;
}

function isSafeText(value, maxLength = 100) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

// Static File Server with Path Traversal Protection
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

function serveStatic(response, relPath) {
  const safePath = path.resolve(PUBLIC_DIR, '.' + path.sep + relPath);

  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    return sendJson(response, 403, { error: 'Access denied' });
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return sendJson(response, 404, { error: 'File not found' });
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(response);
  });
}

// --- AUTH ROUTE ---

async function handleLogin(request, response) {
  try {
    const { username, password } = await readJsonBody(request);
    if (!username || !password) {
      return sendJson(response, 400, { error: 'Username and password required.' });
    }

    const user = repository.one(
      'SELECT id, username, role FROM users WHERE username = ? AND password = ?',
      String(username).trim(),
      String(password)
    );

    if (!user) {
      return sendJson(response, 401, { error: 'Invalid username or password.' });
    }

    const token = createSession(user);
    const cookieFlags = [
      `session=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_TTL_MS / 1000}`,
      IS_PROD ? 'Secure' : ''
    ].filter(Boolean).join('; ');

    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieFlags
    });
    return response.end(JSON.stringify(user));
  } catch (err) {
    return sendJson(response, 400, { error: err.message || 'Malformed request.' });
  }
}

// --- BUSINESS LOGIC ---

function getDisplayLine(lineId) {
  const board = repository.board();
  for (const block of board.blocks) {
    const line = block.lines.find((item) => item.id === lineId);
    if (line) return { fields: board.fields, block: 
    { id: block.id, name: block.name }, line };
  }
  return null;
}

async function updateLine(request, response, lineId) {
  const user = requireUser(request, response);
  if (!user) return;

  try {
    const body = await readJsonBody(request);
    const validLine = repository.one('SELECT id FROM lines WHERE id = ?', lineId);
    if (!validLine || !body.values || typeof body.values !== 'object') {
      return sendJson(response, 400, { error: 'Invalid line data provided.' });
    }

    const allFields = repository.rows('SELECT id, field_key, label FROM fields');
    
    for (const field of allFields) {
      if (!(field.field_key in body.values)) continue;
      const value = body.values[field.field_key];

      if (value !== '' && !isSafeText(value, 255)) {
        return sendJson(response, 400, { error: `Invalid entry for ${field.label}.` });
      }

      repository.run(
        `INSERT INTO values_store(line_id, field_id, value) VALUES (?, ?, ?)
         ON CONFLICT(line_id, field_id) DO UPDATE SET value = excluded.value`,
        lineId,
        field.id,
        String(value).trim()
      );
    }

    repository.log(user.username, `updated line ${lineId}`);
    return sendJson(response, 200, repository.board());
  } catch (err) {
    return sendJson(response, 400, { error: err.message || 'Update failed.' });
  }
}

async function handleAdminRequest(request, response, pathname) {
  const user = requireUser(request, response, 'admin');
  if (!user) return;

  if (request.method === 'GET' && pathname === '/api/admin/audit') {
    return sendJson(response, 200, repository.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 100'));
  }

  try {
    const body = await readJsonBody(request);

    if (request.method === 'POST' && pathname === '/api/admin/blocks') {
      if (!isSafeText(body.name)) return sendJson(response, 400, { error: 'Valid block name required.' });
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM blocks').pos;
      repository.run('INSERT INTO blocks(name, position) VALUES (?, ?)', body.name.trim(), pos);
      repository.log(user.username, 'added block');
      return sendJson(response, 201, repository.board());
    }

    if (request.method === 'POST' && pathname === '/api/admin/lines') {
      const blockId = Number(body.blockId);
      if (!isSafeText(body.name) || !repository.one('SELECT id FROM blocks WHERE id = ?', blockId)) {
        return sendJson(response, 400, { error: 'Valid block ID and line name required.' });
      }
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM lines WHERE block_id = ?', blockId).pos;
      repository.run('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)', blockId, body.name.trim(), pos);
      repository.log(user.username, 'added line');
      return sendJson(response, 201, repository.board());
    }

    if (request.method === 'POST' && pathname === '/api/admin/fields') {
      const fieldKey = String(body.key || body.label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_');

      if (!isSafeText(body.label) || !fieldKey || repository.one('SELECT id FROM fields WHERE field_key = ?', fieldKey)) {
        return sendJson(response, 400, { error: 'Unique column label and key required.' });
      }
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM fields').pos;
      repository.run('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)', body.label.trim(), fieldKey, pos);
      repository.log(user.username, 'added column');
      return sendJson(response, 201, repository.board());
    }

    const match = pathname.match(/^\/api\/admin\/(blocks|lines|fields)\/(\d+)$/);
    if (request.method === 'PUT' && match) {
      const [, type, id] = match;
      const name = String(body.name || body.label || '').trim();
      if (!isSafeText(name)) return sendJson(response, 400, { error: 'Valid name required.' });

      const col = type === 'fields' ? 'label' : 'name';
      repository.run(`UPDATE ${type} SET ${col} = ? WHERE id = ?`, name, Number(id));
      repository.log(user.username, `renamed ${type} ${id}`);
      return sendJson(response, 200, repository.board());
    }

    return sendJson(response, 404, { error: 'Admin route not found.' });
  } catch (err) {
    return sendJson(response, 400, { error: err.message || 'Operation failed.' });
  }
}

// --- SERVER & ROUTER ---

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return response.end();
  }

  // Endpoints
  if (request.method === 'POST' && pathname === '/api/login') return handleLogin(request, response);
  
  if (request.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookie(request.headers.cookie, 'session');
    if (token) sessions.delete(token);
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0'
    });
    return response.end(JSON.stringify({ ok: true }));
  }

  if (request.method === 'GET' && pathname === '/api/me') {
    const user = currentUser(request);
    return user ? sendJson(response, 200, user) : sendJson(response, 401, { error: 'Not signed in.' });
  }

  if (request.method === 'GET' && pathname === '/api/display/board') {
    return sendJson(response, 200, repository.board());
  }

  const displayMatch = pathname.match(/^\/api\/display\/lines\/(\d+)$/);
  if (request.method === 'GET' && displayMatch) {
    const display = getDisplayLine(Number(displayMatch[1]));
    return display ? sendJson(response, 200, display) : sendJson(response, 404, { error: 'Line not found.' });
  }

  if (request.method === 'GET' && pathname === '/api/board') {
    if (!requireUser(request, response)) return;
    return sendJson(response, 200, repository.board());
  }

  const lineMatch = pathname.match(/^\/api\/lines\/(\d+)$/);
  if (request.method === 'PUT' && lineMatch) {
    return updateLine(request, response, Number(lineMatch[1]));
  }

  if (pathname.startsWith('/api/admin/')) {
    return handleAdminRequest(request, response, pathname);
  }

  // SPA Route Serving
  if (request.method === 'GET') {
    if (pathname === '/' || pathname === '/display' || pathname.startsWith('/display/line/')) {
      return serveStatic(response, 'index.html');
    }
    return serveStatic(response, pathname);
  }

  return sendJson(response, 404, { error: 'Endpoint not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Production Board operational at http://${HOST}:${PORT}`);
});