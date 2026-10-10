const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, 'production-board.db');
const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS time_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id TEXT NOT NULL,
    line_id INTEGER NOT NULL,
    work_date DATE NOT NULL,
    hours_worked REAL NOT NULL DEFAULT 0,
    extra_hours REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    FOREIGN KEY(operator_id) REFERENCES operators(id) ON DELETE CASCADE,
    FOREIGN KEY(line_id) REFERENCES lines(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date DATE NOT NULL,
    line_id INTEGER NOT NULL,
    line_name TEXT NOT NULL,
    product_name TEXT DEFAULT '—',
    status TEXT DEFAULT 'No Activity',
    field_values TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    FOREIGN KEY(block_id) REFERENCES blocks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    field_key TEXT UNIQUE NOT NULL,
    position INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS values_store (
    line_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    value TEXT DEFAULT '',
    PRIMARY KEY(line_id, field_id)
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Pharma Line Clearance & eBMR Gateway Tables
  CREATE TABLE IF NOT EXISTS clearance_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    description TEXT NOT NULL,
    position INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS line_clearance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id INTEGER NOT NULL,
    batch_no TEXT NOT NULL,
    product_name TEXT NOT NULL,
    cleaning_status TEXT NOT NULL,
    checklist_data TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    operator_signature TEXT NOT NULL,
    qa_signature TEXT NOT NULL,
    cleared_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(line_id) REFERENCES lines(id) ON DELETE CASCADE
  );
`);

// Seed Default Users & Initial Topology
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (userCount === 0) {
  db.prepare('INSERT INTO users(username, password, role) VALUES (?, ?, ?)').run('admin', 'admin123', 'admin');
  db.prepare('INSERT INTO users(username, password, role) VALUES (?, ?, ?)').run('operator', 'operator123', 'operator');
  
  db.prepare('INSERT INTO blocks(name, position) VALUES (?, ?)').run('Block 1', 1);
  db.prepare('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)').run(1, 'Line 1', 1);
  db.prepare('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)').run(1, 'Line 2', 2);
  
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Status', 'status', 1);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Product Name', 'product_name', 2);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Batch No.', 'batch_no', 3);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Batch Size', 'batch_size', 4);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Pack Size', 'pack_size', 5);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Customer/Livery', 'customer', 6);
  db.prepare('INSERT INTO fields(label, field_key, position) VALUES (?, ?, ?)').run('Sign and Date', 'sign_date', 7);

  db.prepare('INSERT INTO operators(id, name, department) VALUES (?, ?, ?)').run('OP-101', 'John Doe', 'Primary Packaging');
}

// Seed Standard GMP Clearance Checkpoints
const checkCount = db.prepare('SELECT COUNT(*) AS count FROM clearance_checkpoints').get().count;
if (checkCount === 0) {
  const insertCP = db.prepare('INSERT INTO clearance_checkpoints (stage, description, position) VALUES (?, ?, ?)');
  insertCP.run('Physical Sanitation', 'All machinery, hoppers, and conveyors cleaned and free of past residues', 1);
  insertCP.run('Line Clearance', 'No remaining foils, blisters, labels, or cartons from the previous batch present', 2);
  insertCP.run('Environmental Compliance', 'Room temperature (20-25°C), RH (40-60%), and positive pressure within specs', 3);
  insertCP.run('Material Verification', 'New batch primary packaging foil, cartons, and labels verified against BMR', 4);
  insertCP.run('Instrument Calibration', 'Online checkweighers and camera vision inspection systems tested & calibrated', 5);
}

module.exports = {
  one(sql, ...params) {
    return db.prepare(sql).get(...params);
  },
  rows(sql, ...params) {
    return db.prepare(sql).all(...params);
  },
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
  log(username, action) {
    db.prepare('INSERT INTO audit(username, action) VALUES (?, ?)').run(username, action);
  },
  board() {
    const blocks = db.prepare('SELECT * FROM blocks ORDER BY position ASC, id ASC').all();
    const fields = db.prepare('SELECT * FROM fields ORDER BY position ASC, id ASC').all();
    const lines = db.prepare('SELECT * FROM lines ORDER BY position ASC, id ASC').all();
    const values = db.prepare('SELECT * FROM values_store').all();

    const valMap = {};
    for (const v of values) {
      if (!valMap[v.line_id]) valMap[v.line_id] = {};
      const f = fields.find((item) => item.id === v.field_id);
      if (f) valMap[v.line_id][f.field_key] = v.value;
    }

    return {
      fields,
      blocks: blocks.map((b) => ({
        ...b,
        lines: lines
          .filter((l) => l.block_id === b.id)
          .map((l) => ({ ...l, values: valMap[l.id] || {} }))
      }))
    };
  }
};