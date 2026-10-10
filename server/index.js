const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const repository = require('./data/repository');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
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

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of sessions.entries()) {
    if (now > data.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

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
  return getSession(parseCookie(request.headers.cookie, 'session'));
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json'
};

function serveStatic(response, relPath) {
  const safePath = path.resolve(PUBLIC_DIR, '.' + path.sep + relPath);
  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    return sendJson(response, 403, { error: 'Access denied' });
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) return sendJson(response, 404, { error: 'File not found' });
    const ext = path.extname(safePath).toLowerCase();
    response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(safePath).pipe(response);
  });
}

async function handleLogin(request, response) {
  try {
    const { username, password } = await readJsonBody(request);
    const user = repository.one(
      'SELECT id, username, role FROM users WHERE username = ? AND password = ?',
      String(username || '').trim(),
      String(password || '')
    );
    if (!user) return sendJson(response, 401, { error: 'Invalid username or password.' });

    const token = createSession(user);
    const cookieFlags = [
      `session=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_TTL_MS / 1000}`,
      IS_PROD ? 'Secure' : ''
    ].filter(Boolean).join('; ');

    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookieFlags });
    return response.end(JSON.stringify(user));
  } catch (err) {
    return sendJson(response, 400, { error: err.message });
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
    const validLine = repository.one('SELECT id, name FROM lines WHERE id = ?', lineId);
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

    const today = new Date().toISOString().slice(0, 10);
    const statusVal = body.values.status || 'No Activity';
    const prodVal = body.values.product_name || '—';
    
    repository.run(
      `INSERT INTO daily_snapshots (snapshot_date, line_id, line_name, product_name, status, field_values)
       VALUES (?, ?, ?, ?, ?, ?)`,
      today,
      lineId,
      validLine.name,
      prodVal,
      statusVal,
      JSON.stringify(body.values)
    );

    repository.log(user.username, `updated line ${validLine.name} (ID: ${lineId})`);
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

  if (request.method === 'GET' && pathname === '/api/admin/history') {
    return sendJson(response, 200, repository.rows('SELECT * FROM daily_snapshots ORDER BY id DESC LIMIT 200'));
  }

  if (request.method === 'GET' && pathname === '/api/admin/operators') {
    return sendJson(response, 200, repository.rows('SELECT * FROM operators ORDER BY name ASC'));
  }

  if (request.method === 'GET' && pathname === '/api/admin/timetracking') {
    const logs = repository.rows(`
      SELECT t.*, o.name AS operator_name, o.department, l.name AS line_name
      FROM time_tracking t
      JOIN operators o ON t.operator_id = o.id
      JOIN lines l ON t.line_id = l.id
      ORDER BY t.work_date DESC, t.id DESC
    `);
    return sendJson(response, 200, logs);
  }

  try {
    const body = await readJsonBody(request);

    // Operator Add
    if (request.method === 'POST' && pathname === '/api/admin/operators') {
      if (!isSafeText(body.id, 20) || !isSafeText(body.name) || !isSafeText(body.department)) {
        return sendJson(response, 400, { error: 'Operator ID, Name, and Department are required.' });
      }
      repository.run(
        'INSERT INTO operators (id, name, department) VALUES (?, ?, ?)',
        body.id.trim(),
        body.name.trim(),
        body.department.trim()
      );
      repository.log(user.username, `added operator ${body.name} (${body.id})`);
      return sendJson(response, 201, { success: true });
    }

    // Operator Delete
    const opDelMatch = pathname.match(/^\/api\/admin\/operators\/([^/]+)$/);
    if (request.method === 'DELETE' && opDelMatch) {
      const opId = decodeURIComponent(opDelMatch[1]);
      repository.run('DELETE FROM operators WHERE id = ?', opId);
      repository.log(user.username, `deleted operator ID ${opId}`);
      return sendJson(response, 200, { success: true });
    }

    // Time Log Add
    if (request.method === 'POST' && pathname === '/api/admin/timetracking') {
      const { operator_id, line_id, work_date, hours_worked, extra_hours, notes } = body;
      if (!operator_id || !line_id || !work_date) {
        return sendJson(response, 400, { error: 'Operator, Line, and Work Date are required.' });
      }
      repository.run(
        `INSERT INTO time_tracking (operator_id, line_id, work_date, hours_worked, extra_hours, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        operator_id,
        Number(line_id),
        work_date,
        Number(hours_worked) || 0,
        Number(extra_hours) || 0,
        String(notes || '').trim()
      );
      repository.log(user.username, `logged hours for operator ${operator_id}`);
      return sendJson(response, 201, { success: true });
    }

    // Block Add
    if (request.method === 'POST' && pathname === '/api/admin/blocks') {
      if (!isSafeText(body.name)) return sendJson(response, 400, { error: 'Valid block name required.' });
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM blocks').pos;
      repository.run('INSERT INTO blocks(name, position) VALUES (?, ?)', body.name.trim(), pos);
      repository.log(user.username, `added block ${body.name}`);
      return sendJson(response, 201, repository.board());
    }

    // Line Add
    if (request.method === 'POST' && pathname === '/api/admin/lines') {
      const blockId = Number(body.blockId);
      if (!isSafeText(body.name) || !repository.one('SELECT id FROM blocks WHERE id = ?', blockId)) {
        return sendJson(response, 400, { error: 'Valid block ID and line name required.' });
      }
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM lines WHERE block_id = ?', blockId).pos;
      repository.run('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)', blockId, body.name.trim(), pos);
      repository.log(user.username, `added line ${body.name}`);
      return sendJson(response, 201, repository.board());
    }

    // Field Add
    if (request.method === 'POST' && pathname === '/api/admin/fields') {
      const fieldKey = String(body.key || body.label || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (!isSafeText(body.label) || !fieldKey || repository.one('SELECT id FROM fields WHERE field_key = ?', fieldKey)) {
        return sendJson(response, 400, { error: 'Unique column label and key required.' });
      }
      const pos = repository.one('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM fields').pos;
      repository.run('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)', body.label.trim(), fieldKey, pos);
      repository.log(user.username, `added column ${body.label}`);
      return sendJson(response, 201, repository.board());
    }

    // Rename Entity
    const putMatch = pathname.match(/^\/api\/admin\/(blocks|lines|fields)\/(\d+)$/);
    if (request.method === 'PUT' && putMatch) {
      const [, type, id] = putMatch;
      const name = String(body.name || body.label || '').trim();
      if (!isSafeText(name)) return sendJson(response, 400, { error: 'Valid name required.' });
      const col = type === 'fields' ? 'label' : 'name';
      repository.run(`UPDATE ${type} SET ${col} = ? WHERE id = ?`, name, Number(id));
      repository.log(user.username, `renamed ${type} ID ${id}`);
      return sendJson(response, 200, repository.board());
    }

    // Delete Block, Line, or Field
    const delMatch = pathname.match(/^\/api\/admin\/(blocks|lines|fields)\/(\d+)$/);
    if (request.method === 'DELETE' && delMatch) {
      const [, type, id] = delMatch;
      repository.run(`DELETE FROM ${type} WHERE id = ?`, Number(id));
      if (type === 'fields') {
        repository.run('DELETE FROM values_store WHERE field_id = ?', Number(id));
      }
      repository.log(user.username, `deleted ${type} ID ${id}`);
      return sendJson(response, 200, repository.board());
    }

    return sendJson(response, 404, { error: 'Route not found.' });
  } catch (err) {
    return sendJson(response, 400, { error: err.message });
  }
}

// Line Clearance Operations
async function handleClearance(request, response, pathname) {
  const user = requireUser(request, response);
  if (!user) return;

  // GET checkpoints list
  if (request.method === 'GET' && pathname === '/api/clearance/checkpoints') {
    return sendJson(response, 200, repository.rows('SELECT * FROM clearance_checkpoints ORDER BY position ASC'));
  }

  // GET recent clearance history
  if (request.method === 'GET' && pathname === '/api/clearance/records') {
    const records = repository.rows(`
      SELECT c.*, l.name AS line_name
      FROM line_clearance_records c
      JOIN lines l ON c.line_id = l.id
      ORDER BY c.id DESC LIMIT 100
    `);
    return sendJson(response, 200, records);
  }

  // POST new clearance execution
  if (request.method === 'POST' && pathname === '/api/clearance') {
    try {
      const body = await readJsonBody(request);
      const { line_id, batch_no, product_name, checklist, operator_id, operator_sig, qa_sig } = body;

      if (!line_id || !batch_no || !product_name || !operator_id || !operator_sig || !qa_sig) {
        return sendJson(response, 400, { error: 'All fields, checklist validations, and dual signatures are required.' });
      }

      repository.run(`
        INSERT INTO line_clearance_records (
          line_id, batch_no, product_name, cleaning_status, checklist_data, operator_id, operator_signature, qa_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, Number(line_id), batch_no, product_name, 'Passed', JSON.stringify(checklist || {}), operator_id, operator_sig, qa_sig);

      // Automatically transition line status to 'Under Packing'
      const statusField = repository.one("SELECT id FROM fields WHERE field_key = 'status'");
      if (statusField) {
        repository.run(`
          INSERT INTO values_store (line_id, field_id, value) VALUES (?, ?, ?)
          ON CONFLICT(line_id, field_id) DO UPDATE SET value = excluded.value
        `, Number(line_id), statusField.id, 'Under Packing');
      }

      repository.log(user.username, `executed GMP Line Clearance for Line ID ${line_id} (Batch: ${batch_no})`);
      return sendJson(response, 201, { success: true });
    } catch (err) {
      return sendJson(response, 400, { error: err.message });
    }
  }

  return sendJson(response, 404, { error: 'Not found' });
}

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return response.end();
  }

  if (request.method === 'POST' && pathname === '/api/login') return handleLogin(request, response);

  if (request.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookie(request.headers.cookie, 'session');
    if (token) sessions.delete(token);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
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

  if (pathname.startsWith('/api/clearance')) {
    return handleClearance(request, response, pathname);
  }

  if (pathname.startsWith('/api/admin/')) {
    return handleAdminRequest(request, response, pathname);
  }

  // SPA Route Serving
  if (request.method === 'GET') {
    if (
      pathname === '/' || 
      pathname === '/login' || 
      pathname === '/operator' || 
      pathname === '/display' || 
      pathname.startsWith('/display/line/')
    ) {
      return serveStatic(response, 'index.html');
    }
    return serveStatic(response, pathname);
  }

  return sendJson(response, 404, { error: 'Endpoint not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Packaging Lines Board & eBMR Gateway operational at http://${HOST}:${PORT}`);
});