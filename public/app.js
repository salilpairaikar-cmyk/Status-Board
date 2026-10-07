const app = document.querySelector('#app');
const STATUS_OPTIONS = [
  'No Activity',
  'Under Packing',
  'Under Cleaning',
  'Under Setup',
  'Under Maintenance',
  'Machine Breakdown',
  'On Hold'
];

let currentUser = null;
let board = null;
let activeBlockId = null;
let displayPollTimer = null;
let searchQuery = '';
let statusFilter = 'ALL';

// Safe text escaping
function escapeHtml(val) {
  return String(val ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Unified API Caller
async function api(path, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options
  };
  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const render = (markup) => {
  app.innerHTML = markup;
};

function clearDisplayTimer() {
  if (displayPollTimer) {
    clearTimeout(displayPollTimer);
    displayPollTimer = null;
  }
}

function getStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('breakdown') || s.includes('hold')) return 'status-danger';
  if (/cleaning|setup|maintenance/.test(s)) return 'status-warning';
  return 'status-normal';
}

function displayValue(field, line) {
  const value = line.values?.[field.field_key];
  if (!value) return '—';
  if (field.field_key === 'sign_date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}-${m}-${y}`;
  }
  return escapeHtml(value);
}

// --- CSV SHIFT EXPORT ---

function exportShiftReport() {
  if (!board) return;
  const headers = ['Block', 'Line Name', ...board.fields.map((f) => f.label)];
  const rows = [];

  for (const block of board.blocks) {
    for (const line of block.lines) {
      const lineVals = board.fields.map((f) => `"${line.values?.[f.field_key] || ''}"`);
      rows.push([`"${block.name}"`, `"${line.name}"`, ...lineVals].join(','));
    }
  }

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
  const link = document.createElement('a');
  link.setAttribute('href', encodeURI(csvContent));
  link.setAttribute('download', `Shift_Report_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- AUTH VIEW ---

function renderLogin() {
  clearDisplayTimer();
  render(`
    <section class="login">
      <h1>Production Board</h1>
      <p>Sign in to configure line telemetry</p>
      <form id="login-form">
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button id="login-btn" class="btn-primary" type="submit">Sign in</button>
        <small style="color: var(--text-muted); display: block; margin-top: 14px; text-align: center;">
          Admin: <b>admin</b> / <b>admin123</b> &nbsp;·&nbsp; Op: <b>operator</b> / <b>operator123</b>
        </small>
        <p id="login-message" role="alert" style="color: #f87171; margin-top: 12px;"></p>
      </form>
    </section>
  `);

  const form = document.querySelector('#login-form');
  const btn = document.querySelector('#login-btn');
  const msg = document.querySelector('#login-message');

  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Authenticating...';
    msg.textContent = '';

    try {
      const payload = Object.fromEntries(new FormData(form));
      await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
      await loadOperatorPanel();
    } catch (err) {
      msg.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
}

async function logout() {
  clearDisplayTimer();
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    currentUser = null;
    board = null;
    renderLogin();
  }
}

// --- OPERATOR DASHBOARD ---

async function loadOperatorPanel() {
  clearDisplayTimer();
  try {
    const [me, boardData] = await Promise.all([api('/api/me'), api('/api/board')]);
    currentUser = me;
    board = boardData;
    renderOperatorPanel();
  } catch {
    renderLogin();
  }
}

function renderKpiMetrics(allLines) {
  const total = allLines.length;
  const breakdowns = allLines.filter((l) => (l.values?.status || '').toLowerCase().includes('breakdown')).length;
  const maintenance = allLines.filter((l) => /cleaning|setup|maintenance|hold/i.test(l.values?.status || '')).length;
  const running = total - breakdowns - maintenance;
  const availability = total ? Math.round((running / total) * 100) : 0;

  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">Plant Availability</span>
        <strong class="kpi-value ${availability >= 80 ? 'text-green' : 'text-amber'}">${availability}%</strong>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Active / Running</span>
        <strong class="kpi-value text-green">${running}</strong>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Setup & Maintenance</span>
        <strong class="kpi-value text-amber">${maintenance}</strong>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Down / Breakdown</span>
        <strong class="kpi-value text-red">${breakdowns}</strong>
      </div>
    </div>
  `;
}

function renderField(field, line) {
  const value = line.values?.[field.field_key] || '';
  if (field.field_key === 'status') {
    const selected = STATUS_OPTIONS.find((opt) => opt.toLowerCase() === value.toLowerCase()) || 'No Activity';
    return `
      <label>${escapeHtml(field.label)}
        <select data-line="${line.id}" data-key="${escapeHtml(field.field_key)}">
          ${STATUS_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${opt === selected ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
        </select>
      </label>
    `;
  }
  const type = field.field_key === 'sign_date' ? 'date' : 'text';
  return `
    <label>${escapeHtml(field.label)}
      <input type="${type}" data-line="${line.id}" data-key="${escapeHtml(field.field_key)}" value="${escapeHtml(value)}">
    </label>
  `;
}

function renderLineCard(line) {
  const currentStatus = line.values?.status || 'No Activity';
  const statusClass = getStatusClass(currentStatus);

  return `
    <article class="line" id="line-${line.id}">
      <h3>
        <span>${escapeHtml(line.name)}</span>
        <span class="status-badge ${statusClass}">${escapeHtml(currentStatus)}</span>
      </h3>
      ${board.fields.map((f) => renderField(f, line)).join('')}
      <button type="button" class="btn-save-line btn-primary" data-id="${line.id}">Save updates</button>
    </article>
  `;
}

function renderOperatorPanel() {
  if (!board.blocks?.length) {
    render('<div class="content"><p>No blocks available.</p></div>');
    return;
  }

  if (!activeBlockId || !board.blocks.some((b) => b.id === activeBlockId)) {
    activeBlockId = board.blocks[0]?.id;
  }

  const activeBlock = board.blocks.find((b) => b.id === activeBlockId);
  const allLines = board.blocks.flatMap((b) => b.lines);

  // Filter lines by search and status
  const visibleLines = (activeBlock?.lines || []).filter((l) => {
    const matchesName = l.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || (l.values?.status || 'No Activity').toLowerCase() === statusFilter.toLowerCase();
    return matchesName && matchesStatus;
  });

  render(`
    <header>
      <div>
        <b>PRODUCTION STATUS TELEMETRY</b>
        <small>Operator: ${escapeHtml(currentUser.username)} (${escapeHtml(currentUser.role)})</small>
      </div>
      <nav>
        <button type="button" id="btn-export-csv">Export CSV</button>
        ${currentUser.role === 'admin' ? '<button type="button" id="btn-admin">Administration</button>' : ''}
        <button type="button" id="btn-logout">Sign out</button>
      </nav>
    </header>

    <section class="content">
      ${renderKpiMetrics(allLines)}

      <div class="page-heading">
        <div>
          <h1>${escapeHtml(activeBlock.name)} Overview</h1>
          <p>Real-time line data, shift assignments, and telemetry controls.</p>
        </div>
        <label class="block-picker">Select Unit / Block
          <select id="block-select">
            ${board.blocks.map((b) => `<option value="${b.id}" ${b.id === activeBlockId ? 'selected' : ''}>${escapeHtml(b.name)} (${b.lines.length} lines)</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="toolbar">
        <div class="filters-group">
          <input type="search" id="line-search" placeholder="Search line name..." value="${escapeHtml(searchQuery)}" style="flex: 2;">
          <select id="status-filter" style="flex: 1;">
            <option value="ALL">All Statuses</option>
            ${STATUS_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${statusFilter === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="lines">
        ${visibleLines.length ? visibleLines.map(renderLineCard).join('') : '<p style="color: var(--text-muted);">No matching lines found.</p>'}
      </div>
    </section>
  `);

  // Event Listeners
  document.querySelector('#block-select')?.addEventListener('change', (e) => {
    activeBlockId = Number(e.target.value);
    renderOperatorPanel();
  });

  document.querySelector('#line-search')?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    const cards = activeBlock.lines.filter((l) => {
      const matchName = l.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchStat = statusFilter === 'ALL' || (l.values?.status || 'No Activity').toLowerCase() === statusFilter.toLowerCase();
      return matchName && matchStat;
    });
    document.querySelector('.lines').innerHTML = cards.length ? cards.map(renderLineCard).join('') : '<p style="color: var(--text-muted);">No matching lines found.</p>';
  });

  document.querySelector('#status-filter')?.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderOperatorPanel();
  });

  document.querySelector('#btn-export-csv')?.addEventListener('click', exportShiftReport);
  document.querySelector('#btn-admin')?.addEventListener('click', showAdmin);
  document.querySelector('#btn-logout')?.addEventListener('click', logout);

  // Auto-Save when inputs change (No jarring reload)
  document.querySelector('.lines')?.addEventListener('change', async (e) => {
    const input = e.target;
    const lineId = input.dataset.line;
    if (!lineId) return;
    await syncLineData(lineId);
  });

  // Explicit Save Button
  document.querySelector('.lines')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-save-line');
    if (!btn) return;
    await syncLineData(btn.dataset.id, btn);
  });
}

// In-place update to prevent resetting fields while operator is typing
async function syncLineData(lineId, triggerBtn = null) {
  const lineCard = document.querySelector(`#line-${lineId}`);
  if (!lineCard) return;

  const values = {};
  lineCard.querySelectorAll(`[data-line="${lineId}"]`).forEach((i) => {
    values[i.dataset.key] = i.value;
  });

  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Saving...';
  }

  try {
    const updatedBoard = await api(`/api/lines/${encodeURIComponent(lineId)}`, {
      method: 'PUT',
      body: JSON.stringify({ values })
    });
    board = updatedBoard;

    // Dynamically update status badge
    const badge = lineCard.querySelector('.status-badge');
    if (badge && values.status) {
      badge.textContent = values.status;
      badge.className = `status-badge ${getStatusClass(values.status)}`;
    }

    if (triggerBtn) {
      triggerBtn.textContent = 'Saved!';
      setTimeout(() => {
        triggerBtn.disabled = false;
        triggerBtn.textContent = 'Save updates';
      }, 1200);
    }
  } catch (err) {
    alert(err.message);
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = 'Save updates';
    }
  }
}

// --- ADMIN PANEL ---

async function showAdmin() {
  clearDisplayTimer();
  try {
    const auditEntries = await api('/api/admin/audit');
    render(`
      <header>
        <b>ADMINISTRATION CONSOLE</b>
        <nav>
          <a class="header-link" href="/display">Display index</a>
          <button type="button" id="btn-operator-panel">Operator panel</button>
          <button type="button" id="btn-admin-logout">Sign out</button>
        </nav>
      </header>

      <section class="content">
        <h1>Board Topology Configuration</h1>
        <div class="admin-grid">
          <form id="form-add-block">
            <h2>Add Block / Unit</h2>
            <input name="name" placeholder="Block name (e.g. Packaging B)" required>
            <button class="btn-primary" type="submit">Create block</button>
          </form>

          <form id="form-add-line">
            <h2>Add Line</h2>
            <select name="blockId">
              ${board.blocks.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}
            </select>
            <input name="name" placeholder="Line identifier" required>
            <button class="btn-primary" type="submit">Create line</button>
          </form>

          <form id="form-add-field">
            <h2>Add Column</h2>
            <input name="label" placeholder="Column label" required>
            <input name="key" placeholder="Column key (optional)">
            <button class="btn-primary" type="submit">Create column</button>
          </form>
        </div>

        <h2>Manage Names</h2>
        <div id="manage-entities">
          ${board.blocks.map((block) => `
            <div class="manage">
              <input value="${escapeHtml(block.name)}" data-type="blocks" data-id="${block.id}">
              ${block.lines.map((line) => `<input value="${escapeHtml(line.name)}" data-type="lines" data-id="${line.id}">`).join('')}
            </div>
          `).join('')}
          <div class="manage">
            ${board.fields.map((field) => `<input value="${escapeHtml(field.label)}" data-type="fields" data-id="${field.id}">`).join('')}
          </div>
        </div>

        <h2>Audit Activity</h2>
        <ol>
          ${auditEntries.map((e) => `<li>${escapeHtml(e.created_at)} — <b>${escapeHtml(e.username)}</b>${escapeHtml(e.action)}</li>`).join('')}
        </ol>
      </section>
    `);

    document.querySelector('#btn-operator-panel').onclick = loadOperatorPanel;
    document.querySelector('#btn-admin-logout').onclick = logout;

    // Delegated auto-rename
    document.querySelector('#manage-entities').addEventListener('change', async (e) => {
      const { type, id } = e.target.dataset;
      if (!type || !id) return;
      try {
        const payload = type === 'fields' ? { label: e.target.value } : { name: e.target.value };
        board = await api(`/api/admin/${type}/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } catch (err) {
        alert(err.message);
      }
    });

    bindAdminForm('#form-add-block', 'blocks');
    bindAdminForm('#form-add-line', 'lines');
    bindAdminForm('#form-add-field', 'fields');
  } catch (err) {
    alert(err.message);
  }
}

function bindAdminForm(selector, type) {
  const form = document.querySelector(selector);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(form));
      board = await api(`/api/admin/${type}`, { method: 'POST', body: JSON.stringify(payload) });
      showAdmin();
    } catch (err) {
      alert(err.message);
    }
  };
}

// --- DISPLAY VIEWS (REFRESH TIMER LEAK-FREE) ---

function renderDisplayIndex(data) {
  render(`
    <main class="display-index">
      <header>
        <div><b>PRODUCTION STATUS DISPLAY</b><small>Live Read-Only Monitors</small></div>
        <a class="header-link" href="/">Operator login</a>
      </header>
      <section class="display-content">
        <h1 style="margin-bottom: 24px;">Select line telemetry monitor</h1>
        ${data.blocks.map((block) => `
          <section class="display-block">
            <h2>${escapeHtml(block.name)}</h2>
            <div>
              ${block.lines.map((l) => `<a class="line-link" href="/display/line/${l.id}"><span>${escapeHtml(l.name)}</span><span>Open display →</span></a>`).join('')}
            </div>
          </section>
        `).join('')}
      </section>
    </main>
  `);
}

function renderSingleDisplay({ line, block, fields }) {
  render(`
    <main class="single-display">
      <header class="single-title">
        <small>${escapeHtml(block.name)}</small>
        <h1>${escapeHtml(line.name)}</h1>
      </header>
      <section class="display-details">
        ${fields.map((f) => `<div class="display-row"><span>${escapeHtml(f.label)}:</span><strong>${displayValue(f, line)}</strong></div>`).join('')}
      </section>
      <footer>LIVE TELEMETRY · REFRESHES EVERY 3 SECONDS</footer>
    </main>
  `);
}

async function loadDisplay() {
  clearDisplayTimer();
  const match = location.pathname.match(/^\/display\/line\/(\d+)$/);

  try {
    if (match) {
      const lineId = encodeURIComponent(match[1]);
      const data = await api(`/api/display/lines/${lineId}`);
      renderSingleDisplay(data);
      displayPollTimer = setTimeout(loadDisplay, 3000);
    } else {
      const data = await api('/api/display/board');
      renderDisplayIndex(data);
    }
  } catch (error) {
    render(`
      <main class="content" style="text-align: center; margin-top: 10vh;">
        <h1>Display Offline</h1>
        <p style="color: var(--text-muted);">${escapeHtml(error.message)}. Retrying...</p>
      </main>
    `);
    displayPollTimer = setTimeout(loadDisplay, 3000);
  }
}

// Router Initializer
window.addEventListener('popstate', () => {
  location.pathname.startsWith('/display') ? loadDisplay() : loadOperatorPanel();
});

location.pathname.startsWith('/display') ? loadDisplay() : loadOperatorPanel();