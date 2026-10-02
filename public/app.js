const app = document.querySelector('#app');
const STATUS_OPTIONS = ['No Activity', 'Under Packing', 'Under Cleaning', 'Under Setup', 'Under Maintenance', 'Machine Breakdown', 'On Hold'];
let currentUser;
let board;
let activeBlockId;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

const render = (markup) => { app.innerHTML = markup; };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

async function loadOperatorPanel() {
  try {
    currentUser = await api('/api/me');
    board = await api('/api/board');
    renderOperatorPanel();
  } catch { renderLogin(); }
}

function renderLogin() {
  render(`
    <section class="login">
      <h1>Production Board</h1><p>Sign in to continue</p>
      <form id="login-form">
        <label>Username<input name="username" required></label>
        <label>Password<input name="password" type="password" required></label>
        <button>Sign in</button>
        <small>Admin: admin / admin123 &nbsp; Operator: operator / operator123</small>
        <p id="login-message"></p>
      </form>
    </section>
  `);
  document.querySelector('#login-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      loadOperatorPanel();
    } catch (error) { document.querySelector('#login-message').textContent = error.message; }
  };
}

function displayValue(field, line) {
  const value = line.values[field.field_key];
  if (!value) return '—';
  if (field.field_key === 'sign_date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}-${month}-${year}`;
  }
  return escapeHtml(value);
}

function renderDisplayIndex(data) {
  render(`
    <main class="display-index">
      <header class="display-header"><div><b>PRODUCTION STATUS BOARD</b><small>Read-only live displays</small></div><a href="/">Operator sign-in</a></header>
      <section class="display-content">
        <h1>Select a line display</h1>
        ${data.blocks.map((block) => `<section class="display-block"><h2>${escapeHtml(block.name)}</h2><div>${block.lines.map((line) => `<a class="line-link" href="/display/line/${line.id}">${escapeHtml(line.name)} <span>Open display →</span></a>`).join('')}</div></section>`).join('')}
      </section>
    </main>
  `);
}

function renderSingleDisplay({ line, block, fields }) {
  render(`
    <main class="single-display">
      <header class="single-title"><small>${escapeHtml(block.name)}</small><h1>${escapeHtml(line.name)}</h1></header>
      <section class="display-details">${fields.map((field) => `<div class="display-row"><span>${escapeHtml(field.label)}:</span><strong>${displayValue(field, line)}</strong></div>`).join('')}</section>
      <footer>LIVE DISPLAY · Automatically refreshes every 3 seconds</footer>
    </main>
  `);
}

async function loadDisplay() {
  const match = location.pathname.match(/^\/display\/line\/(\d+)$/);
  try {
    if (match) {
      renderSingleDisplay(await api(`/api/display/lines/${match[1]}`));
      setTimeout(loadDisplay, 3000);
    } else renderDisplayIndex(await api('/api/display/board'));
  } catch (error) {
    render(`<main class="display-error"><h1>Display unavailable</h1><p>${escapeHtml(error.message)} Retrying automatically.</p></main>`);
    setTimeout(loadDisplay, 3000);
  }
}

function renderField(field, line) {
  const value = line.values[field.field_key] || '';
  if (field.field_key === 'status') {
    const selected = STATUS_OPTIONS.find((option) => option.toLowerCase() === value.toLowerCase()) || 'No Activity';
    return `<label>${escapeHtml(field.label)}<select data-line="${line.id}" data-key="${field.field_key}">${STATUS_OPTIONS.map((option) => `<option ${option === selected ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  const type = field.field_key === 'sign_date' ? 'date' : 'text';
  return `<label>${escapeHtml(field.label)}<input type="${type}" data-line="${line.id}" data-key="${field.field_key}" value="${escapeHtml(value)}"></label>`;
}

function renderLine(line) {
  return `<article class="line"><h3>${escapeHtml(line.name)}</h3>${board.fields.map((field) => renderField(field, line)).join('')}<button onclick="saveLine(${line.id})">Save changes</button></article>`;
}

function setBlock(id) {
  activeBlockId = Number(id);
  renderOperatorPanel();
}

function renderOperatorPanel() {
  if (!activeBlockId || !board.blocks.some((block) => block.id === activeBlockId)) activeBlockId = board.blocks[0]?.id;
  const activeBlock = board.blocks.find((block) => block.id === activeBlockId);
  render(`
    <header><div><b>PRODUCTION STATUS BOARD</b><small>Signed in as ${currentUser.username} (${currentUser.role})</small></div><nav>${currentUser.role === 'admin' ? '<button onclick="showAdmin()">Administration</button>' : ''}<button onclick="logout()">Sign out</button></nav></header>
    <section class="content">
      <div class="page-heading"><div><h1>Live Line Data</h1><p>Choose a block to enter or update its line information.</p></div><label class="block-picker">Select block<select onchange="setBlock(this.value)">${board.blocks.map((block) => `<option value="${block.id}" ${block.id === activeBlockId ? 'selected' : ''}>${escapeHtml(block.name)} (${block.lines.length} lines)</option>`).join('')}</select></label></div>
      ${activeBlock ? `<section class="block"><h2>${escapeHtml(activeBlock.name)}</h2><div class="lines">${activeBlock.lines.map(renderLine).join('')}</div></section>` : '<p>No blocks have been added yet.</p>'}
    </section>
  `);
}

async function saveLine(lineId) {
  const values = {};
  document.querySelectorAll(`[data-line="${lineId}"]`).forEach((input) => { values[input.dataset.key] = input.value; });
  try {
    board = await api(`/api/lines/${lineId}`, { method: 'PUT', body: JSON.stringify({ values }) });
    renderOperatorPanel();
  } catch (error) { alert(error.message); }
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  renderLogin();
}

async function showAdmin() {
  const auditEntries = await api('/api/admin/audit');
  render(`
    <header><b>ADMINISTRATION</b><nav><a class="header-link" href="/display">Display pages</a><button onclick="loadOperatorPanel()">Operator panel</button><button onclick="logout()">Sign out</button></nav></header>
    <section class="content">
      <h1>Board setup</h1>
      <div class="admin-grid">
        <form onsubmit="addItem(event, 'blocks')"><h2>Add block</h2><input name="name" placeholder="Block name" required><button>Add block</button></form>
        <form onsubmit="addItem(event, 'lines')"><h2>Add line</h2><select name="blockId">${board.blocks.map((block) => `<option value="${block.id}">${escapeHtml(block.name)}</option>`).join('')}</select><input name="name" placeholder="Line name" required><button>Add line</button></form>
        <form onsubmit="addItem(event, 'fields')"><h2>Add column</h2><input name="label" placeholder="Column name" required><input name="key" placeholder="Column key (optional)"><button>Add column</button></form>
      </div>
      <h2>Existing blocks, lines and columns</h2>
      ${board.blocks.map((block) => `<div class="manage"><input value="${escapeHtml(block.name)}" onchange="renameItem('blocks', ${block.id}, this.value)">${block.lines.map((line) => `<input value="${escapeHtml(line.name)}" onchange="renameItem('lines', ${line.id}, this.value)">`).join('')}</div>`).join('')}
      <div class="manage">${board.fields.map((field) => `<input value="${escapeHtml(field.label)}" onchange="renameItem('fields', ${field.id}, this.value)">`).join('')}</div>
      <h2>Operator activity</h2><ol>${auditEntries.map((entry) => `<li>${escapeHtml(entry.created_at)} — <b>${escapeHtml(entry.username)}</b> ${escapeHtml(entry.action)}</li>`).join('')}</ol>
    </section>
  `);
}

async function addItem(event, type) {
  event.preventDefault();
  try {
    board = await api(`/api/admin/${type}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    showAdmin();
  } catch (error) { alert(error.message); }
}

async function renameItem(type, id, value) {
  try {
    board = await api(`/api/admin/${type}/${id}`, { method: 'PUT', body: JSON.stringify(type === 'fields' ? { label: value } : { name: value }) });
  } catch (error) { alert(error.message); }
}

location.pathname.startsWith('/display') ? loadDisplay() : loadOperatorPanel();
