const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const repository = require('./data/repository');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const publicDirectory = path.join(__dirname, '..', 'public');
const sessions = new Map();

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { reject(); }
    });
  });
}

function currentUser(request) {
  const token = (request.headers.cookie || '').match(/session=([^;]+)/)?.[1];
  return sessions.get(token);
}

function requireUser(request, response, requiredRole) {
  const user = currentUser(request);
  if (!user || (requiredRole && user.role !== requiredRole)) {
    sendJson(response, 401, { error: 'Sign in required.' });
    return null;
  }
  return user;
}

function isSafeText(value) {
  return typeof value === 'string' && value.trim().length <= 100;
}

function serveFile(response, filename, contentType) {
  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filename).pipe(response);
}

async function handleLogin(request, response) {
  try {
    const body = await readJsonBody(request);
    const user = repository.one('SELECT id, username, role FROM users WHERE username = ? AND password = ?', body.username, body.password);
    if (!user) return sendJson(response, 401, { error: 'Invalid username or password.' });

    const token = crypto.randomUUID();
    sessions.set(token, user);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/` });
    return response.end(JSON.stringify(user));
  } catch {
    return sendJson(response, 400, { error: 'Invalid request.' });
  }
}

function getDisplayLine(lineId) {
  const board = repository.board();
  for (const block of board.blocks) {
    const line = block.lines.find((item) => item.id === lineId);
    if (line) return { fields: board.fields, block: { id: block.id, name: block.name }, line };
  }
  return null;
}

async function updateLine(request, response, lineId) {
  const user = requireUser(request, response);
  if (!user) return;
  try {
    const body = await readJsonBody(request);
    const validLine = repository.one('SELECT id FROM lines WHERE id = ?', lineId);
    if (!validLine || !body.values || typeof body.values !== 'object') return sendJson(response, 400, { error: 'Invalid line update.' });

    for (const field of repository.rows('SELECT * FROM fields')) {
      if (!(field.field_key in body.values)) continue;
      const value = body.values[field.field_key];
      if (!isSafeText(value)) return sendJson(response, 400, { error: `Invalid ${field.label}.` });
      repository.run(
        `INSERT INTO values_store(line_id, field_id, value) VALUES (?, ?, ?)
         ON CONFLICT(line_id, field_id) DO UPDATE SET value = excluded.value`,
        lineId,
        field.id,
        value.trim()
      );
    }
    repository.log(user.username, `updated line ${lineId}`);
    return sendJson(response, 200, repository.board());
  } catch {
    return sendJson(response, 400, { error: 'Invalid request.' });
  }
}

async function handleAdminRequest(request, response, pathname) {
  const user = requireUser(request, response, 'admin');
  if (!user) return;
  if (request.method === 'GET' && pathname === '/api/admin/audit') return sendJson(response, 200, repository.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 100'));

  try {
    const body = await readJsonBody(request);
    if (request.method === 'POST' && pathname === '/api/admin/blocks') {
      if (!isSafeText(body.name)) return sendJson(response, 400, { error: 'Block name required.' });
      const position = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM blocks').position;
      repository.run('INSERT INTO blocks(name, position) VALUES (?, ?)', body.name, position);
      repository.log(user.username, 'added block');
      return sendJson(response, 201, repository.board());
    }
    if (request.method === 'POST' && pathname === '/api/admin/lines') {
      if (!isSafeText(body.name) || !repository.one('SELECT id FROM blocks WHERE id = ?', body.blockId)) return sendJson(response, 400, { error: 'Valid block and line name required.' });
      const position = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM lines WHERE block_id = ?', body.blockId).position;
      repository.run('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)', body.blockId, body.name, position);
      repository.log(user.username, 'added line');
      return sendJson(response, 201, repository.board());
    }
    if (request.method === 'POST' && pathname === '/api/admin/fields') {
      const fieldKey = String(body.key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!isSafeText(body.label) || !fieldKey || repository.one('SELECT id FROM fields WHERE field_key = ?', fieldKey)) return sendJson(response, 400, { error: 'Unique field label/key required.' });
      const position = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM fields').position;
      repository.run('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)', body.label.trim(), fieldKey, position);
      repository.log(user.username, 'added field');
      return sendJson(response, 201, repository.board());
    }
    const match = pathname.match(/^\/api\/admin\/(blocks|lines|fields)\/(\d+)$/);
    if (request.method === 'PUT' && match) {
      const [, type, id] = match;
      const name = body.name || body.label;
      if (!isSafeText(name)) return sendJson(response, 400, { error: 'Name required.' });
      repository.run(`UPDATE ${type} SET ${type === 'fields' ? 'label' : 'name'} = ? WHERE id = ?`, name.trim(), id);
      repository.log(user.username, `renamed ${type}`);
      return sendJson(response, 200, repository.board());
    }
    return sendJson(response, 404, { error: 'Not found.' });
  } catch {
    return sendJson(response, 400, { error: 'Invalid request.' });
  }
}

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && pathname === '/api/login') return handleLogin(request, response);
  if (request.method === 'POST' && pathname === '/api/logout') {
    sessions.delete((request.headers.cookie || '').match(/session=([^;]+)/)?.[1]);
    return sendJson(response, 200, {});
  }
  if (request.method === 'GET' && pathname === '/api/me') {
    const user = currentUser(request);
    return user ? sendJson(response, 200, user) : sendJson(response, 401, { error: 'Not signed in.' });
  }
  if (request.method === 'GET' && pathname === '/api/display/board') return sendJson(response, 200, repository.board());
  if (request.method === 'GET' && /^\/api\/display\/lines\/\d+$/.test(pathname)) {
    const display = getDisplayLine(Number(pathname.split('/').pop()));
    return display ? sendJson(response, 200, display) : sendJson(response, 404, { error: 'Display line not found.' });
  }
  if (request.method === 'GET' && pathname === '/api/board') {
    if (!requireUser(request, response)) return;
    return sendJson(response, 200, repository.board());
  }
  if (request.method === 'PUT' && /^\/api\/lines\/\d+$/.test(pathname)) return updateLine(request, response, Number(pathname.split('/').pop()));
  if (pathname.startsWith('/api/admin/')) return handleAdminRequest(request, response, pathname);
  if (request.method === 'GET' && (pathname === '/display' || /^\/display\/line\/\d+$/.test(pathname))) return serveFile(response, path.join(publicDirectory, 'index.html'), 'text/html');
  if (request.method === 'GET') {
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const fullPath = path.join(publicDirectory, filename);
    if (fullPath.startsWith(publicDirectory) && fs.existsSync(fullPath)) {
      const contentType = filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'application/javascript' : 'text/html';
      return serveFile(response, fullPath, contentType);
    }
  }
  return sendJson(response, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => console.log(`Production Board: http://${HOST}:${PORT}`));
