const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, 'data', 'production-board.db');
const db = new Database(dbPath);

console.log('Seeding eBMR Line Clearance records into:', dbPath);

const insertClearance = db.prepare(`
  INSERT INTO line_clearance_records (
    line_id, batch_no, product_name, cleaning_status, checklist_data, operator_id, operator_signature, qa_signature, cleared_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertClearance.run(
  1,
  'HBAG056',
  'Methenamine hippurate 1g tablets',
  'Passed',
  JSON.stringify({ 1: true, 2: true, 3: true, 4: true, 5: true }),
  'OP-101',
  'John Doe (OP-101)',
  'Dr. A. Sharma (QA-Lead)',
  '2026-10-10 07:45:00'
);

insertClearance.run(
  2,
  'YJAG008',
  'CHOLESTYRAMINE FOR ORAL SUSPENSION',
  'Passed',
  JSON.stringify({ 1: true, 2: true, 3: true, 4: true, 5: true }),
  'OP-102',
  'Sarah Jenkins (OP-102)',
  'M. Fernandes (QA-Officer)',
  '2026-10-10 08:15:00'
);

insertClearance.run(
  3,
  'YRDG027',
  'Rosuvastatin 20mg Film-Coated Tablets',
  'Passed',
  JSON.stringify({ 1: true, 2: true, 3: true, 4: true, 5: true }),
  'OP-103',
  'Rajesh Kumar (OP-103)',
  'Dr. A. Sharma (QA-Lead)',
  '2026-10-09 14:30:00'
);

console.log('Clearance records successfully inserted!');