const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.join(__dirname, 'production-board.db');
const db = new DatabaseSync(databasePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
  CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER);
  CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER);
  CREATE TABLE IF NOT EXISTS fields (id INTEGER PRIMARY KEY, label TEXT NOT NULL, field_key TEXT UNIQUE NOT NULL, position INTEGER);
  CREATE TABLE IF NOT EXISTS values_store (line_id INTEGER, field_id INTEGER, value TEXT NOT NULL DEFAULT '', PRIMARY KEY(line_id, field_id));
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, username TEXT, action TEXT, created_at TEXT);
`);

function seedDatabase() {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) return;

  db.exec(`
    INSERT INTO users(username, password, role) VALUES
      ('admin', 'admin123', 'admin'),
      ('operator', 'operator123', 'operator');
    INSERT INTO blocks(name, position) VALUES ('Block 1', 1), ('Block 2', 2);
    INSERT INTO fields(label, field_key, position) VALUES
      ('Status', 'status', 1),
      ('Product Name', 'product_name', 2),
      ('Batch No.', 'batch_no', 3),
      ('Batch Size', 'batch_size', 4),
      ('Pack Size', 'pack_size', 5),
      ('Customer/Livery', 'customer_livery', 6),
      ('Sign and Date', 'sign_date', 7);
  `);

  const addLine = db.prepare('INSERT INTO lines(block_id, name, position) VALUES (?, ?, ?)');
  for (let number = 1; number <= 7; number += 1) addLine.run(1, `Line ${number}`, number);
  for (let number = 1; number <= 5; number += 1) addLine.run(2, `Line ${number}`, number);
}

seedDatabase();

const rows = (query, ...params) => db.prepare(query).all(...params);
const one = (query, ...params) => db.prepare(query).get(...params);
const run = (query, ...params) => db.prepare(query).run(...params);

function board() {
  const fields = rows('SELECT * FROM fields ORDER BY position, id');
  const blocks = rows('SELECT * FROM blocks ORDER BY position, id').map((block) => ({
    ...block,
    lines: rows('SELECT * FROM lines WHERE block_id = ? ORDER BY position, id', block.id).map((line) => ({
      ...line,
      values: Object.fromEntries(
        rows(
          `SELECT f.field_key, v.value
           FROM fields f
           LEFT JOIN values_store v ON v.field_id = f.id AND v.line_id = ?
           ORDER BY f.position`,
          line.id
        ).map((item) => [item.field_key, item.value || ''])
      )
    }))
  }));
  return { fields, blocks };
}

function log(username, action) {
  run('INSERT INTO audit(username, action, created_at) VALUES (?, ?, ?)', username, action, new Date().toISOString());
}

module.exports = { db, rows, one, run, board, log };
