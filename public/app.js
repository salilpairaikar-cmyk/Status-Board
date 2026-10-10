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
let currentAdminTab = 'operator';
let isSidebarCollapsed = false;

function escapeHtml(val) {
  return String(val ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

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

function renderLogin() {
  clearDisplayTimer();
  render(`
    <section class="login">
      <h1>Production Board</h1>
      <p>Sign in to access workstation telemetry</p>
      <form id="login-form">
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button id="login-btn" class="btn-primary" type="submit">Sign in</button>
        <small style="color: var(--text-muted); display: block; margin-top: 14px; text-align: center;">
          Admin: <b>admin</b> / <b>admin123</b> &nbsp;·&nbsp; Op: <b>operator</b> / <b>operator123</b>
        </small>
        <p id="login-message" role="alert" style="color: #dc2626; margin-top: 12px;"></p>
        <p style="text-align: center; margin-top: 10px;">
          <a href="/" style="color: var(--primary); text-decoration: none; font-weight: 600;">&larr; Back to Public Monitor</a>
        </p>
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
      history.pushState(null, '', '/operator');
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
    history.pushState(null, '', '/login');
    renderLogin();
  }
}

async function loadOperatorPanel() {
  clearDisplayTimer();
  try {
    const [me, boardData] = await Promise.all([api('/api/me'), api('/api/board')]);
    currentUser = me;
    board = boardData;
    renderOperatorPanel();
  } catch {
    history.pushState(null, '', '/login');
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
      <div style="display: flex; gap: 8px; margin-top: 6px;">
        <button type="button" class="btn-save-line btn-primary" data-id="${line.id}" style="flex: 1;">Save</button>
        <button type="button" class="btn-clearance btn-sm" data-id="${line.id}" style="background: #0f172a; color: white;">Clearance (eBMR)</button>
      </div>
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

  const visibleLines = (activeBlock?.lines || []).filter((l) => {
    const matchesName = l.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || (l.values?.status || 'No Activity').toLowerCase() === statusFilter.toLowerCase();
    return matchesName && matchesStatus;
  });

  const isAdmin = currentUser.role === 'admin';

  render(`
    <header>
      <div style="display: flex; align-items: center; gap: 14px;">
        ${isAdmin ? `<button id="btn-toggle-sidebar" class="btn-icon" title="Toggle Admin Sidebar">☰</button>` : ''}
        <div>
          <b>PACKAGING LINES STATUS TELEMETRY</b>
          <small>Signed in as ${escapeHtml(currentUser.username)} (${escapeHtml(currentUser.role)})</small>
        </div>
      </div>
      <nav>
        <button type="button" id="btn-export-csv">Export CSV</button>
        <a class="header-link" href="/">Display pages</a>
        <button type="button" id="btn-logout">Sign out</button>
      </nav>
    </header>

    <div class="app-layout">
      ${isAdmin ? `
        <aside class="sidebar ${isSidebarCollapsed ? 'collapsed' : ''}" id="admin-sidebar">
          <div class="sidebar-title">Admin Management</div>
          <button class="sidebar-btn ${currentAdminTab === 'operator' ? 'active' : ''}" data-tab="operator">Packaging Lines</button>
          <button class="sidebar-btn ${currentAdminTab === 'operators' ? 'active' : ''}" data-tab="operators">Manage Operators</button>
          <button class="sidebar-btn ${currentAdminTab === 'timetracking' ? 'active' : ''}" data-tab="timetracking">Employee Time Tracker</button>
          <button class="sidebar-btn ${currentAdminTab === 'clearance' ? 'active' : ''}" data-tab="clearance">Line Clearance (eBMR)</button>
          <button class="sidebar-btn ${currentAdminTab === 'topology' ? 'active' : ''}" data-tab="topology">Blocks, Lines & Columns</button>
          <button class="sidebar-btn ${currentAdminTab === 'history' ? 'active' : ''}" data-tab="history">Daily Status & Changes</button>
        </aside>
      ` : ''}

      <main class="main-area">
        ${isAdmin && currentAdminTab !== 'operator' ? '<div id="admin-subview"></div>' : `
          <section class="content">
            ${renderKpiMetrics(allLines)}

            <div class="page-heading">
              <h1>${escapeHtml(activeBlock.name)} Packaging Lines</h1>
              <p>Real-time line data, product tracking, and telemetry controls.</p>
            </div>

            <div class="toolbar">
              <div class="filters-group">
                <input type="search" id="line-search" placeholder="Search line name..." value="${escapeHtml(searchQuery)}" style="flex: 2;">
                <select id="status-filter" style="flex: 1;">
                  <option value="ALL">All Statuses</option>
                  ${STATUS_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${statusFilter === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
                </select>
              </div>
              <label class="block-picker">Select Unit / Block
                <select id="block-select">
                  ${board.blocks.map((b) => `<option value="${b.id}" ${b.id === activeBlockId ? 'selected' : ''}>${escapeHtml(b.name)} (${b.lines.length} lines)</option>`).join('')}
                </select>
              </label>
            </div>

            <div class="lines">
              ${visibleLines.length ? visibleLines.map(renderLineCard).join('') : '<p style="color: var(--text-muted);">No matching lines found.</p>'}
            </div>
          </section>
        `}
      </main>
    </div>
    <div id="modal-container"></div>
  `);

  document.querySelector('#btn-toggle-sidebar')?.addEventListener('click', () => {
    isSidebarCollapsed = !isSidebarCollapsed;
    renderOperatorPanel();
  });

  document.querySelector('#admin-sidebar')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.sidebar-btn');
    if (!tabBtn) return;
    currentAdminTab = tabBtn.dataset.tab;
    renderOperatorPanel();
    if (currentAdminTab !== 'operator') loadAdminViewContent(currentAdminTab);
  });

  document.querySelector('#btn-export-csv')?.addEventListener('click', exportShiftReport);
  document.querySelector('#btn-logout')?.addEventListener('click', logout);

  if (!isAdmin || currentAdminTab === 'operator') {
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

    document.querySelector('.lines')?.addEventListener('change', async (e) => {
      const lineId = e.target.dataset.line;
      if (lineId) await syncLineData(lineId);
    });

    document.querySelector('.lines')?.addEventListener('click', async (e) => {
      const saveBtn = e.target.closest('.btn-save-line');
      if (saveBtn) await syncLineData(saveBtn.dataset.id, saveBtn);

      const clrBtn = e.target.closest('.btn-clearance');
      if (clrBtn) openClearanceModal(clrBtn.dataset.id);
    });
  } else {
    loadAdminViewContent(currentAdminTab);
  }
}

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

    const badge = lineCard.querySelector('.status-badge');
    if (badge && values.status) {
      badge.textContent = values.status;
      badge.className = `status-badge ${getStatusClass(values.status)}`;
    }

    if (triggerBtn) {
      triggerBtn.textContent = 'Saved!';
      setTimeout(() => {
        triggerBtn.disabled = false;
        triggerBtn.textContent = 'Save';
      }, 1000);
    }
  } catch (err) {
    alert(err.message);
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = 'Save';
    }
  }
}

// Line Clearance Modal Execution (eBMR)
async function openClearanceModal(lineId) {
  const modal = document.querySelector('#modal-container');
  const allLines = board.blocks.flatMap((b) => b.lines);
  const line = allLines.find((l) => l.id === Number(lineId));
  if (!line) return;

  const [checkpoints, operators] = await Promise.all([
    api('/api/clearance/checkpoints'),
    api('/api/admin/operators')
  ]);

  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
          <div>
            <h2>Digital Line Clearance (eBMR)</h2>
            <p style="margin: 4px 0 0; color: var(--text-muted); font-size: 0.85rem;">Mandatory GMP verification for <b>${escapeHtml(line.name)}</b></p>
          </div>
          <button id="modal-close" style="padding: 4px 10px;">✕</button>
        </div>

        <form id="form-clearance">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <label>Product Name
              <input name="product_name" value="${escapeHtml(line.values?.product_name || '')}" required>
            </label>
            <label>Batch Number
              <input name="batch_no" value="${escapeHtml(line.values?.batch_no || '')}" required>
            </label>
          </div>

          <h3 style="font-size: 0.95rem; margin-bottom: 10px;">GMP Clearance Checklist</h3>
          <div style="margin-bottom: 20px;">
            ${checkpoints.map((cp) => `
              <div class="checkpoint-item">
                <input type="checkbox" name="cp_${cp.id}" required>
                <div>
                  <strong style="display: block; font-size: 0.82rem; color: var(--primary);">${escapeHtml(cp.stage)}</strong>
                  <span style="font-size: 0.82rem; color: var(--text-main);">${escapeHtml(cp.description)}</span>
                </div>
              </div>
            `).join('')}
          </div>

          <div class="dual-signature-box">
            <div>
              <label>Line Operator
                <select name="operator_id" required>
                  <option value="">Select Operator</option>
                  ${operators.map((o) => `<option value="${o.id}">${escapeHtml(o.name)} (${o.id})</option>`).join('')}
                </select>
              </label>
              <label style="margin-top: 8px;">Operator Electronic Sign
                <input name="operator_sig" placeholder="Type full name to sign" required>
              </label>
            </div>
            <div>
              <label>QA Authorization
                <input value="QA Inspector" disabled style="background: #e2e8f0;">
              </label>
              <label style="margin-top: 8px;">QA Officer Electronic Sign
                <input name="qa_sig" placeholder="QA Officer verification" required>
              </label>
            </div>
          </div>

          <div style="margin-top: 24px; display: flex; justify-content: flex-end; gap: 10px;">
            <button type="button" id="btn-cancel-modal">Cancel</button>
            <button type="submit" class="btn-primary">Authorize & Release Line</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.querySelector('#modal-close').onclick = () => { modal.innerHTML = ''; };
  document.querySelector('#btn-cancel-modal').onclick = () => { modal.innerHTML = ''; };

  document.querySelector('#form-clearance').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const checklist = {};
    checkpoints.forEach((cp) => { checklist[cp.id] = fd.get(`cp_${cp.id}`) === 'on'; });

    try {
      await api('/api/clearance', {
        method: 'POST',
        body: JSON.stringify({
          line_id: line.id,
          product_name: fd.get('product_name'),
          batch_no: fd.get('batch_no'),
          operator_id: fd.get('operator_id'),
          operator_sig: fd.get('operator_sig'),
          qa_sig: fd.get('qa_sig'),
          checklist
        })
      });
      modal.innerHTML = '';
      alert('Line Clearance successfully verified! Line status updated to Under Packing.');
      await loadOperatorPanel();
    } catch (err) {
      alert(err.message);
    }
  };
}

async function loadAdminViewContent(tab) {
  const target = document.querySelector('#admin-subview');
  if (!target) return;

  if (tab === 'clearance') {
    const records = await api('/api/clearance/records');
    target.innerHTML = `
      <section class="content">
        <div class="page-heading">
          <h1>Digital Line Clearance & eBMR Records</h1>
          <p>Historical log of GMP line cleanings, material clearances, and dual authorization signatures.</p>
        </div>
        <div class="admin-card">
          <h2>Clearance Audit Trail (${records.length})</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th>Cleared At</th>
                <th>Line</th>
                <th>Product</th>
                <th>Batch No</th>
                <th>Status</th>
                <th>Operator Sign</th>
                <th>QA Sign</th>
              </tr>
            </thead>
            <tbody>
              ${records.map((r) => `
                <tr>
                  <td><b>${escapeHtml(r.cleared_at)}</b></td>
                  <td>${escapeHtml(r.line_name)}</td>
                  <td>${escapeHtml(r.product_name)}</td>
                  <td><code>${escapeHtml(r.batch_no)}</code></td>
                  <td><span class="status-badge status-normal">${escapeHtml(r.cleaning_status)}</span></td>
                  <td>${escapeHtml(r.operator_signature)} (${escapeHtml(r.operator_id)})</td>
                  <td>${escapeHtml(r.qa_signature)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  if (tab === 'operators') {
    const operators = await api('/api/admin/operators');
    target.innerHTML = `
      <section class="content">
        <div class="page-heading">
          <h1>Operators Directory</h1>
          <p>Register operators with their ID, name, and department.</p>
        </div>
        <div class="admin-card">
          <h2>Add New Operator</h2>
          <form id="form-add-op" style="display: flex; gap: 12px; flex-wrap: wrap;">
            <input name="id" placeholder="Operator ID (e.g. OP-105)" required style="flex: 1;">
            <input name="name" placeholder="Full Name" required style="flex: 2;">
            <input name="department" placeholder="Department (e.g. Packing)" required style="flex: 1.5;">
            <button class="btn-primary" type="submit">Add Operator</button>
          </form>
        </div>
        <div class="admin-card">
          <h2>Registered Operators (${operators.length})</h2>
          <table class="data-table">
            <thead><tr><th>Operator ID</th><th>Full Name</th><th>Department</th><th>Action</th></tr></thead>
            <tbody>
              ${operators.map((op) => `
                <tr>
                  <td><b>${escapeHtml(op.id)}</b></td>
                  <td>${escapeHtml(op.name)}</td>
                  <td>${escapeHtml(op.department)}</td>
                  <td><button class="btn-danger btn-sm btn-delete-op" data-id="${encodeURIComponent(op.id)}">Delete</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;

    document.querySelector('#form-add-op').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/operators', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
        loadAdminViewContent('operators');
      } catch (err) { alert(err.message); }
    };

    target.onclick = async (e) => {
      const delBtn = e.target.closest('.btn-delete-op');
      if (!delBtn) return;
      if (!confirm('Are you sure you want to delete this operator?')) return;
      try {
        await api(`/api/admin/operators/${delBtn.dataset.id}`, { method: 'DELETE' });
        loadAdminViewContent('operators');
      } catch (err) { alert(err.message); }
    };
  }

  if (tab === 'timetracking') {
    const [operators, logs] = await Promise.all([
      api('/api/admin/operators'),
      api('/api/admin/timetracking')
    ]);
    const allLines = board.blocks.flatMap((b) => b.lines);

    target.innerHTML = `
      <section class="content">
        <div class="page-heading">
          <h1>Packaging Lines Time Tracker</h1>
          <p>Record and monitor regular and extra overtime hours worked by operators on lines.</p>
        </div>
        <div class="admin-card">
          <h2>Log Employee Time</h2>
          <form id="form-add-time" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
            <label>Operator
              <select name="operator_id" required>
                <option value="">Select Operator</option>
                ${operators.map((o) => `<option value="${o.id}">${escapeHtml(o.name)} (${o.id} -${escapeHtml(o.department)})</option>`).join('')}
              </select>
            </label>
            <label>Line
              <select name="line_id" required>
                <option value="">Select Line</option>
                ${allLines.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
              </select>
            </label>
            <label>Work Date
              <input type="date" name="work_date" value="${new Date().toISOString().slice(0, 10)}" required>
            </label>
            <label>Hours Worked
              <input type="number" step="0.5" name="hours_worked" placeholder="e.g. 8.0" required>
            </label>
            <label>Extra Hours (Overtime)
              <input type="number" step="0.5" name="extra_hours" placeholder="e.g. 2.0" value="0">
            </label>
            <label style="grid-column: 1 / -1;">Shift Notes / Activity
              <input name="notes" placeholder="Batch or maintenance task notes">
            </label>
            <div style="grid-column: 1 / -1;">
              <button class="btn-primary" type="submit">Submit Time Entry</button>
            </div>
          </form>
        </div>

        <div class="admin-card">
          <h2>Logged Shift Hours</h2>
          <table class="data-table">
            <thead><tr><th>Date</th><th>Operator</th><th>Dept</th><th>Line</th><th>Worked Hours</th><th>Extra Hours</th><th>Notes</th></tr></thead>
            <tbody>
              ${logs.map((log) => `
                <tr>
                  <td><b>${escapeHtml(log.work_date)}</b></td>
                  <td>${escapeHtml(log.operator_name)} (${escapeHtml(log.operator_id)})</td>
                  <td>${escapeHtml(log.department)}</td>
                  <td>${escapeHtml(log.line_name)}</td>
                  <td><strong>${log.hours_worked} hrs</strong></td>
                  <td><strong style="color: ${log.extra_hours > 0 ? '#d97706' : 'inherit'};">${log.extra_hours} hrs</strong></td>
                  <td>${escapeHtml(log.notes || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;

    document.querySelector('#form-add-time').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/timetracking', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
        loadAdminViewContent('timetracking');
      } catch (err) { alert(err.message); }
    };
  }

  if (tab === 'topology') {
    target.innerHTML = `
      <section class="content">
        <div class="page-heading">
          <h1>Topology Configuration</h1>
          <p>Add and remove blocks, lines, and custom line fields.</p>
        </div>
        <div class="admin-grid-3">
          <form id="form-add-block" class="admin-card">
            <h2>Add Block</h2>
            <input name="name" placeholder="Block name" required>
            <button class="btn-primary" type="submit" style="margin-top: 10px;">Create Block</button>
          </form>
          <form id="form-add-line" class="admin-card">
            <h2>Add Line</h2>
            <select name="blockId">
              ${board.blocks.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}
            </select>
            <input name="name" placeholder="Line identifier" required style="margin-top: 8px;">
            <button class="btn-primary" type="submit" style="margin-top: 10px;">Create Line</button>
          </form>
          <form id="form-add-field" class="admin-card">
            <h2>Add Column</h2>
            <input name="label" placeholder="Column label" required>
            <input name="key" placeholder="Key (optional)" style="margin-top: 8px;">
            <button class="btn-primary" type="submit" style="margin-top: 10px;">Create Column</button>
          </form>
        </div>

        <div class="admin-card">
          <h2>Existing Blocks & Lines (Edit / Delete)</h2>
          ${board.blocks.map((b) => `
            <div style="margin-bottom: 20px;">
              <div class="manage-item" style="background: #e2e8f0; font-weight: bold;">
                <span>Block:</span>
                <input value="${escapeHtml(b.name)}" data-type="blocks" data-id="${b.id}">
                <button class="btn-danger btn-sm btn-delete-entity" data-type="blocks" data-id="${b.id}">Delete Block</button>
              </div>
              <div style="padding-left: 20px;">
                ${b.lines.map((l) => `
                  <div class="manage-item">
                    <span>Line:</span>
                    <input value="${escapeHtml(l.name)}" data-type="lines" data-id="${l.id}">
                    <button class="btn-danger btn-sm btn-delete-entity" data-type="lines" data-id="${l.id}">Delete Line</button>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>

        <div class="admin-card">
          <h2>Existing Columns (Edit / Delete)</h2>
          ${board.fields.map((f) => `
            <div class="manage-item">
              <span>Column:</span>
              <input value="${escapeHtml(f.label)}" data-type="fields" data-id="${f.id}">
              <button class="btn-danger btn-sm btn-delete-entity" data-type="fields" data-id="${f.id}">Delete Column</button>
            </div>
          `).join('')}
        </div>
      </section>
    `;

    bindTopologyForm('#form-add-block', 'blocks');
    bindTopologyForm('#form-add-line', 'lines');
    bindTopologyForm('#form-add-field', 'fields');

    target.onchange = async (e) => {
      const { type, id } = e.target.dataset;
      if (!type || !id) return;
      try {
        const payload = type === 'fields' ? { label: e.target.value } : { name: e.target.value };
        board = await api(`/api/admin/${type}/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } catch (err) { alert(err.message); }
    };

    target.onclick = async (e) => {
      const delBtn = e.target.closest('.btn-delete-entity');
      if (!delBtn) return;
      const { type, id } = delBtn.dataset;
      if (!confirm(`Are you sure you want to delete this ${type.slice(0, -1)}? All related data will be removed.`)) return;
      try {
        board = await api(`/api/admin/${type}/${id}`, { method: 'DELETE' });
        loadAdminViewContent('topology');
      } catch (err) { alert(err.message); }
    };
  }

  if (tab === 'history') {
    const [snapshots, audit] = await Promise.all([
      api('/api/admin/history'),
      api('/api/admin/audit')
    ]);

    target.innerHTML = `
      <section class="content">
        <div class="page-heading">
          <h1>Daily Production & Change Logs</h1>
          <p>Historical audit of which product was run on each line and all changes made.</p>
        </div>
        <div class="admin-card">
          <h2>Recorded Daily Status & Products</h2>
          <table class="data-table">
            <thead><tr><th>Date</th><th>Line</th><th>Product Name</th><th>Status</th><th>Timestamp</th></tr></thead>
            <tbody>
              ${snapshots.map((s) => `
                <tr>
                  <td><b>${escapeHtml(s.snapshot_date)}</b></td>
                  <td>${escapeHtml(s.line_name)}</td>
                  <td>${escapeHtml(s.product_name)}</td>
                  <td><span class="status-badge ${getStatusClass(s.status)}">${escapeHtml(s.status)}</span></td>
                  <td style="color: var(--text-dim); font-size: 0.8rem;">${escapeHtml(s.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="admin-card">
          <h2>System Changes & Audit Trail</h2>
          <table class="data-table">
            <thead><tr><th>Timestamp</th><th>User</th><th>Action Taken</th></tr></thead>
            <tbody>
              ${audit.map((a) => `
                <tr>
                  <td style="color: var(--text-dim); font-size: 0.8rem;">${escapeHtml(a.created_at)}</td>
                  <td><b>${escapeHtml(a.username)}</b></td>
                  <td>${escapeHtml(a.action)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }
}

function bindTopologyForm(selector, type) {
  const form = document.querySelector(selector);
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(form));
      board = await api(`/api/admin/${type}`, { method: 'POST', body: JSON.stringify(payload) });
      loadAdminViewContent('topology');
    } catch (err) { alert(err.message); }
  };
}

function renderDisplayIndex(data) {
  render(`
    <main class="display-index">
      <header>
        <div>
          <b>PACKAGING LINES STATUS MONITOR</b>
          <small>Plant Live Telemetry Overview</small>
        </div>
        <nav>
          <a class="header-link" href="/login">Operator Sign In</a>
        </nav>
      </header>
      <section class="content" style="padding-top: 28px; max-width: 1200px; margin: 0 auto;">
        <div class="page-heading">
          <h1>Plant Packaging Lines</h1>
          <p>Select any production packaging line below to open its real-time overhead monitor screen.</p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 32px;">
          ${data.blocks.map((block) => `
            <div class="display-block-section" style="background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 24px; box-shadow: var(--shadow-panel);">
              <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px;">
                <h2 style="margin: 0; font-size: 1.25rem; font-weight: 700; color: var(--text-main); display: flex; align-items: center; gap: 8px;">
                  <span style="display: inline-block; width: 8px; height: 8px; background: var(--primary); border-radius: 50%;"></span>
                  ${escapeHtml(block.name)} — Packaging Lines
                </h2>
                <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); background: var(--surface-raised); padding: 4px 10px; border-radius: 9999px;">
                  ${block.lines.length}${block.lines.length === 1 ? 'Line' : 'Lines'}
                </span>
              </div>
              <div class="lines-only-grid">
                ${block.lines.map((l) => `
                  <a class="line-card-link" href="/display/line/${l.id}">
                    <span>${escapeHtml(l.name)}</span>
                    <span>Open Display &rarr;</span>
                  </a>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    </main>
  `);
}

function renderSingleDisplay({ line, block, fields }) {
  render(`
    <main class="single-display">
      <header class="single-title">
        <small>${escapeHtml(block.name)} &middot; PACKAGING TELEMETRY</small>
        <h1>${escapeHtml(line.name)}</h1>
      </header>
      <section class="display-details">
        ${fields.map((f) => `<div class="display-row"><span>${escapeHtml(f.label)}:</span><strong>${displayValue(f, line)}</strong></div>`).join('')}
      </section>
      <footer>LIVE TELEMETRY &middot; REFRESHES EVERY 3 SECONDS</footer>
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

function route() {
  const p = location.pathname;
  if (p === '/login') {
    renderLogin();
  } else if (p === '/operator') {
    loadOperatorPanel();
  } else {
    loadDisplay();
  }
}

window.addEventListener('popstate', route);
route();