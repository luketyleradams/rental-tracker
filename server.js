'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Paths (cross-platform) ───────────────────────────────────────────────────
const ROOT       = __dirname;
const DB_PATH    = path.join(ROOT, 'data', 'rental.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT       = 3000;

[path.join(ROOT, 'data'), BACKUP_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Database ─────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// WAL: better read concurrency, atomic writes, safe on crash
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout  = 5000');

// ─── Schema ───────────────────────────────────────────────────────────────────
// All IDs are short random strings. Dates are ISO strings (YYYY-MM-DD).
// Months are YYYY-MM strings. Amounts are REAL stored as cents-precision floats.
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id        TEXT PRIMARY KEY,
    building  TEXT NOT NULL,
    number    TEXT NOT NULL,
    base_rent REAL NOT NULL CHECK(base_rent > 0),
    created   TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(building, number)
  );

  -- One row per tenancy. No end_date = currently occupied.
  CREATE TABLE IF NOT EXISTS periods (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    rent       REAL NOT NULL CHECK(rent > 0),
    start_date TEXT NOT NULL,
    end_date   TEXT,
    created    TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK(end_date IS NULL OR end_date >= start_date)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id      TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    month   TEXT NOT NULL CHECK(month GLOB '????-??'),
    amount  REAL NOT NULL CHECK(amount > 0),
    notes   TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS staff (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    role     TEXT NOT NULL DEFAULT '',
    building TEXT NOT NULL DEFAULT 'both',
    pay      REAL NOT NULL CHECK(pay > 0),
    created  TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  -- category: utilities | insurance | miles | salaries | refund | misc | writeoff
  CREATE TABLE IF NOT EXISTS expenses (
    id          TEXT PRIMARY KEY,
    building    TEXT NOT NULL,
    category    TEXT NOT NULL,
    month       TEXT NOT NULL CHECK(month GLOB '????-??'),
    amount      REAL NOT NULL CHECK(amount > 0),
    miles       REAL,
    description TEXT NOT NULL DEFAULT '',
    staff_id    TEXT REFERENCES staff(id) ON DELETE SET NULL,
    created     TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  -- type: forgiven | writeoff | charge | refund
  CREATE TABLE IF NOT EXISTS adjustments (
    id        TEXT PRIMARY KEY,
    room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    period_id TEXT NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    type      TEXT NOT NULL CHECK(type IN ('forgiven','writeoff','charge','refund')),
    amount    REAL NOT NULL CHECK(amount > 0),
    note      TEXT NOT NULL DEFAULT '',
    date      TEXT NOT NULL,
    created   TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_periods_room   ON periods(room_id);
  CREATE INDEX IF NOT EXISTS idx_payments_room  ON payments(room_id);
  CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
  CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(month);
  CREATE INDEX IF NOT EXISTS idx_expenses_cat   ON expenses(category);
  CREATE INDEX IF NOT EXISTS idx_adj_room       ON adjustments(room_id);
  CREATE INDEX IF NOT EXISTS idx_adj_period     ON adjustments(period_id);

  CREATE TABLE IF NOT EXISTS other_income (
    id          TEXT PRIMARY KEY,
    building    TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'other',
    month       TEXT NOT NULL CHECK(month GLOB '????-??'),
    amount      REAL NOT NULL CHECK(amount > 0),
    description TEXT NOT NULL DEFAULT '',
    created     TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_other_income_month ON other_income(month);
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
// Safe to re-run: SQLite throws on duplicate ADD COLUMN, we just swallow it.
[
  'ALTER TABLE rooms    ADD COLUMN late_fee_type  TEXT',
  'ALTER TABLE rooms    ADD COLUMN late_fee_value REAL',
  'ALTER TABLE payments ADD COLUMN days_late INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE payments ADD COLUMN late_fee   REAL    NOT NULL DEFAULT 0',
  'ALTER TABLE staff    ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MILEAGE_RATE = 0.725;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Prorated rent for a period in a given YYYY-MM month.
 * Move-out day is inclusive. Returns null if no overlap.
 */
function proratedRent(period, month) {
  const [y, m]    = month.split('-').map(Number);
  const firstDay  = new Date(Date.UTC(y, m - 1, 1));
  const lastDay   = new Date(Date.UTC(y, m, 0));     // last day of month
  const start     = new Date(period.start_date);
  const end       = period.end_date ? new Date(period.end_date) : null;

  if (start > lastDay)          return null;
  if (end && end < firstDay)    return null;

  const overlapStart = start > firstDay ? start : firstDay;
  const overlapEnd   = end && end < lastDay ? end : lastDay;
  const days         = Math.round((overlapEnd - overlapStart) / 86_400_000) + 1;
  const totalDays    = lastDay.getUTCDate();
  const fullMonth    = days === totalDays;
  const prorated     = fullMonth ? period.rent : round2(period.rent / totalDays * days);

  return { rent: period.rent, days, totalDays, prorated, fullMonth };
}

/**
 * Active occupancy period for a room in a given month, or null if vacant.
 */
function activePeriod(roomId, month) {
  const [y, m]   = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(y, m - 1, 1));
  const lastDay  = new Date(Date.UTC(y, m, 0));
  return db.prepare('SELECT * FROM periods WHERE room_id=? ORDER BY start_date')
    .all(roomId)
    .find(p => {
      const s = new Date(p.start_date);
      const e = p.end_date ? new Date(p.end_date) : null;
      return s <= lastDay && (!e || e >= firstDay);
    }) ?? null;
}

/**
 * Running ledger balance for a room up through (and including) upToMonth.
 * Positive = credit (tenant overpaid). Negative = balance owed.
 *
 * Per occupied month:
 *   balance += payments_received + forgiven - charged - prorated_due
 * Write-offs add back to balance (they zero out the owed amount).
 */
function roomBalance(roomId, upToMonth) {
  const allPeriods = db.prepare('SELECT * FROM periods WHERE room_id=? ORDER BY start_date').all(roomId);
  let balance = 0;

  for (const period of allPeriods) {
    // Walk month-by-month through this period
    const [sy, sm]     = period.start_date.split('-').map(Number);
    const periodEndMo  = period.end_date ? period.end_date.slice(0, 7) : upToMonth;
    const stopMonth    = upToMonth < periodEndMo ? upToMonth : periodEndMo;

    let y = sy, m = sm;
    while (true) {
      const mo = `${y}-${String(m).padStart(2, '0')}`;
      if (mo > stopMonth) break;

      const pro = proratedRent(period, mo);
      if (pro) {
        const paid = db.prepare(
          'SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=?'
        ).get(roomId, mo).t;

        const forgiven = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
           WHERE room_id=? AND period_id=? AND type='forgiven' AND substr(date,1,7)=?`
        ).get(roomId, period.id, mo).t;

        const charged = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
           WHERE room_id=? AND period_id=? AND type='charge' AND substr(date,1,7)=?`
        ).get(roomId, period.id, mo).t;

        balance = balance + paid + forgiven - charged - pro.prorated;
      }

      if (++m > 12) { m = 1; y++; }
    }

    // Write-offs close the owed balance
    const writeoffs = db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
       WHERE room_id=? AND period_id=? AND type='writeoff'`
    ).get(roomId, period.id).t;
    balance += writeoffs;
  }

  return round2(balance);
}

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── Backup ───────────────────────────────────────────────────────────────────
const KEEP_BACKUPS = 60; // keep last 60

function runBackup(tag) {
  const stamp = tag || new Date().toISOString().slice(0, 10);
  const file  = path.join(BACKUP_DIR, `backup-${stamp}.json`);

  const data = {
    exported_at: new Date().toISOString(),
    rooms:       db.prepare('SELECT * FROM rooms').all(),
    periods:     db.prepare('SELECT * FROM periods').all(),
    payments:    db.prepare('SELECT * FROM payments').all(),
    staff:       db.prepare('SELECT * FROM staff').all(),
    expenses:    db.prepare('SELECT * FROM expenses').all(),
    adjustments: db.prepare('SELECT * FROM adjustments').all(),
  };

  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  // Rotate: keep newest N
  const all = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort();
  while (all.length > KEEP_BACKUPS) {
    fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
  }

  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`[backup] ${path.basename(file)} — ${kb} KB`);
  return path.basename(file);
}

// Schedule daily backup at midnight
function scheduleDailyBackup() {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 1, 0, 0);
  setTimeout(() => { runBackup(); scheduleDailyBackup(); }, next - now);
}

// ─── Express ──────────────────────────────────────────────────────────────────
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/now', (req, res) => {
  const now = new Date();
  res.json({
    year:  now.getFullYear(),
    month: now.getMonth() + 1,
    iso:   `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
  });
});

// Wrap route handlers — catches sync and async throws, returns clean JSON errors
function h(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          console.error('[api]', err.message);
          if (!res.headersSent) res.status(500).json({ error: err.message });
        });
      }
    } catch (err) {
      console.error('[api]', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  };
}

function notFound(res, what) { res.status(404).json({ error: `${what} not found` }); }
function badReq(res, msg)    { res.status(400).json({ error: msg }); }
function conflict(res, msg)  { res.status(409).json({ error: msg }); }

// ─── ROOMS ────────────────────────────────────────────────────────────────────

app.get('/api/rooms', h((req, res) => {
  const rooms   = db.prepare('SELECT * FROM rooms ORDER BY building, number').all();
  const periods = db.prepare('SELECT * FROM periods ORDER BY start_date').all();
  res.json(rooms.map(r => ({ ...r, periods: periods.filter(p => p.room_id === r.id) })));
}));

app.post('/api/rooms', h((req, res) => {
  const { building, number, base_rent, late_fee_type, late_fee_value } = req.body;
  if (!building?.trim() || !number?.trim() || !(base_rent > 0))
    return badReq(res, 'building, number, and base_rent (>0) are required');
  if (late_fee_type && !['fixed','percent'].includes(late_fee_type))
    return badReq(res, 'late_fee_type must be fixed or percent');
  const id = uid();
  try {
    db.prepare('INSERT INTO rooms (id,building,number,base_rent,late_fee_type,late_fee_value) VALUES (?,?,?,?,?,?)')
      .run(id, building.trim(), number.trim(), base_rent, late_fee_type || null, late_fee_value ?? null);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return conflict(res, 'Room already exists');
    throw e;
  }
  res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id=?').get(id));
}));

app.patch('/api/rooms/:id', h((req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!r) return notFound(res, 'Room');
  const { base_rent, late_fee_type, late_fee_value } = req.body;
  const newRent = base_rent ?? r.base_rent;
  if (!(newRent > 0)) return badReq(res, 'base_rent must be > 0');
  if (late_fee_type !== undefined && late_fee_type !== null && !['fixed','percent'].includes(late_fee_type))
    return badReq(res, 'late_fee_type must be fixed, percent, or null');
  const newType  = late_fee_type  !== undefined ? (late_fee_type  || null) : r.late_fee_type;
  const newValue = late_fee_value !== undefined ? (late_fee_value ?? null) : r.late_fee_value;
  db.prepare('UPDATE rooms SET base_rent=?,late_fee_type=?,late_fee_value=? WHERE id=?')
    .run(newRent, newType, newValue, req.params.id);
  res.json(db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id));
}));

app.delete('/api/rooms/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Room');
  res.json({ ok: true });
}));

// ─── PERIODS ──────────────────────────────────────────────────────────────────

app.post('/api/rooms/:roomId/periods', h((req, res) => {
  const { roomId } = req.params;
  const { rent, start_date } = req.body;
  if (!(rent > 0) || !start_date) return badReq(res, 'rent (>0) and start_date required');
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(roomId)) return notFound(res, 'Room');

  const open = db.prepare('SELECT id FROM periods WHERE room_id=? AND end_date IS NULL').get(roomId);
  if (open) return conflict(res, 'Room already has an open occupancy period. Close it first (move-out).');

  const id = uid();
  db.prepare('INSERT INTO periods (id,room_id,rent,start_date) VALUES (?,?,?,?)').run(id, roomId, rent, start_date);
  res.status(201).json(db.prepare('SELECT * FROM periods WHERE id=?').get(id));
}));

// Move-out: sets end_date, returns updated period + final balance
app.patch('/api/periods/:id/moveout', h((req, res) => {
  const { end_date } = req.body;
  if (!end_date) return badReq(res, 'end_date required');

  const period = db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id);
  if (!period)          return notFound(res, 'Period');
  if (period.end_date)  return conflict(res, 'Period already closed');
  if (end_date < period.start_date) return badReq(res, 'end_date cannot be before start_date');

  db.prepare('UPDATE periods SET end_date=? WHERE id=?').run(end_date, req.params.id);
  const updated = db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id);
  const balance = roomBalance(period.room_id, end_date.slice(0, 7));
  res.json({ period: updated, balance });
}));

app.patch('/api/periods/:id', h((req, res) => {
  const period = db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id);
  if (!period) return notFound(res, 'Period');
  const { start_date, end_date, rent } = req.body;
  const newStart = start_date ?? period.start_date;
  const newEnd   = end_date === null ? null : (end_date ?? period.end_date);
  const newRent  = rent ?? period.rent;
  if (!(newRent > 0)) return badReq(res, 'rent must be > 0');
  if (newEnd !== null && newEnd < newStart) return badReq(res, 'end_date cannot be before start_date');
  db.prepare('UPDATE periods SET start_date=?,end_date=?,rent=? WHERE id=?')
    .run(newStart, newEnd, newRent, req.params.id);
  res.json(db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id));
}));

app.delete('/api/periods/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM periods WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Period');
  res.json({ ok: true });
}));

// Balance for a room at a given month (query param)
app.get('/api/rooms/:id/balance', h((req, res) => {
  const { month } = req.query;
  if (!month) return badReq(res, 'month query param required (YYYY-MM)');
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id)) return notFound(res, 'Room');
  res.json({ balance: roomBalance(req.params.id, month) });
}));

// Payment preview — what's due for a room/month (for the UI payment form)
app.get('/api/rooms/:id/preview', h((req, res) => {
  const { month, days_late } = req.query;
  if (!month) return badReq(res, 'month required');
  const room   = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!room) return notFound(res, 'Room');
  const period = activePeriod(req.params.id, month);
  if (!period) return res.json({ vacant: true });
  const pro   = proratedRent(period, month);
  const carry = roomBalance(req.params.id, prevMonth(month));
  const paid  = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=?').get(req.params.id, month).t;

  const daysLate = Math.max(0, parseInt(days_late) || 0);
  let lateFee = 0;
  if (daysLate > 0 && room.late_fee_type && room.late_fee_value > 0) {
    lateFee = room.late_fee_type === 'fixed'
      ? round2(daysLate * room.late_fee_value)
      : round2(daysLate * (room.late_fee_value / 100) * room.base_rent);
  }

  res.json({
    period, pro, carry, paid,
    due: round2(pro.prorated - carry),
    lateFee, daysLate,
    lateFeeType: room.late_fee_type, lateFeeValue: room.late_fee_value,
  });
}));

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────

app.get('/api/payments', h((req, res) => {
  const { building, month, room_id } = req.query;
  let sql  = 'SELECT p.*, r.building, r.number FROM payments p JOIN rooms r ON r.id=p.room_id WHERE 1=1';
  const args = [];
  if (building) { sql += ' AND r.building=?'; args.push(building); }
  if (month)    { sql += ' AND p.month=?';    args.push(month); }
  if (room_id)  { sql += ' AND p.room_id=?';  args.push(room_id); }
  sql += ' ORDER BY p.created DESC';
  res.json(db.prepare(sql).all(...args));
}));

app.post('/api/payments', h((req, res) => {
  const { room_id, month, amount, notes, days_late, late_fee } = req.body;
  if (!room_id || !month || !(amount > 0)) return badReq(res, 'room_id, month, amount (>0) required');
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(room_id)) return notFound(res, 'Room');
  const daysLate = Math.max(0, parseInt(days_late) || 0);
  const lateFee  = round2(Math.max(0, parseFloat(late_fee) || 0));
  const id = uid();
  db.prepare('INSERT INTO payments (id,room_id,month,amount,notes,days_late,late_fee) VALUES (?,?,?,?,?,?,?)')
    .run(id, room_id, month, amount, notes || '', daysLate, lateFee);
  res.status(201).json(db.prepare('SELECT * FROM payments WHERE id=?').get(id));
}));

app.delete('/api/payments/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Payment');
  res.json({ ok: true });
}));

// ─── STAFF ────────────────────────────────────────────────────────────────────

app.get('/api/staff', h((req, res) => {
  res.json(db.prepare('SELECT * FROM staff WHERE deleted=0 ORDER BY name').all());
}));

app.post('/api/staff', h((req, res) => {
  const { name, role, building, pay } = req.body;
  if (!name?.trim() || !(pay > 0)) return badReq(res, 'name and pay (>0) required');
  const id = uid();
  db.prepare('INSERT INTO staff (id,name,role,building,pay) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), role || '', building || 'both', pay);
  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id=?').get(id));
}));

app.patch('/api/staff/:id', h((req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(req.params.id);
  if (!s) return notFound(res, 'Staff member');
  const { name, role, building, pay } = req.body;
  db.prepare('UPDATE staff SET name=?,role=?,building=?,pay=? WHERE id=?')
    .run(name ?? s.name, role ?? s.role, building ?? s.building, pay ?? s.pay, req.params.id);
  res.json(db.prepare('SELECT * FROM staff WHERE id=?').get(req.params.id));
}));

app.delete('/api/staff/:id', h((req, res) => {
  const info = db.prepare('UPDATE staff SET deleted=1 WHERE id=? AND deleted=0').run(req.params.id);
  if (!info.changes) return notFound(res, 'Staff member');
  res.json({ ok: true });
}));

// ─── EXPENSES ─────────────────────────────────────────────────────────────────

const VALID_CATS = new Set([
  'advertising','auto_travel','cleaning_maintenance','commissions',
  'insurance','legal_professional','management_fees','mortgage_interest',
  'other_interest','repairs','supplies','taxes','utilities',
  'depreciation','other_expenses',
  'miles','salaries','refund','misc','writeoff'
]);

app.get('/api/expenses', h((req, res) => {
  const { building, month, category } = req.query;
  let sql  = `SELECT e.*, s.name AS staff_name
              FROM expenses e LEFT JOIN staff s ON s.id=e.staff_id WHERE 1=1`;
  const args = [];
  if (building && building !== 'all') {
    sql += " AND (e.building=? OR e.building='both')"; args.push(building);
  }
  if (month)    { sql += ' AND e.month=?';    args.push(month); }
  if (category) { sql += ' AND e.category=?'; args.push(category); }
  sql += ' ORDER BY e.created DESC';
  res.json(db.prepare(sql).all(...args));
}));

app.post('/api/expenses', h((req, res) => {
  const { building, category, month, amount, miles, description, staff_id } = req.body;
  if (!building || !category || !month || !(amount > 0))
    return badReq(res, 'building, category, month, amount (>0) required');
  if (!VALID_CATS.has(category))
    return badReq(res, `category must be one of: ${[...VALID_CATS].join(', ')}`);

  const finalAmount = (category === 'miles' && miles > 0)
    ? round2(miles * MILEAGE_RATE)
    : amount;

  const id = uid();
  db.prepare(
    'INSERT INTO expenses (id,building,category,month,amount,miles,description,staff_id) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, building, category, month, finalAmount, miles ?? null, description || '', staff_id ?? null);
  res.status(201).json(db.prepare(
    'SELECT e.*, s.name AS staff_name FROM expenses e LEFT JOIN staff s ON s.id=e.staff_id WHERE e.id=?'
  ).get(id));
}));

app.delete('/api/expenses/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Expense');
  res.json({ ok: true });
}));

// Pay a single staff member
app.post('/api/salaries/pay-one', h((req, res) => {
  const { staff_id, month, amount } = req.body;
  if (!staff_id || !month) return badReq(res, 'staff_id and month required');
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(staff_id);
  if (!s) return notFound(res, 'Staff member');
  const already = db.prepare(
    "SELECT id FROM expenses WHERE category='salaries' AND month=? AND staff_id=?"
  ).get(month, staff_id);
  if (already) return conflict(res, `${s.name} is already paid for ${month}`);
  const pay = (amount && amount > 0) ? amount : s.pay;
  const id  = uid();
  db.prepare(
    'INSERT INTO expenses (id,building,category,month,amount,description,staff_id) VALUES (?,?,?,?,?,?,?)'
  ).run(id, s.building, 'salaries', month, pay, `${s.name} — ${s.role}`, staff_id);
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
}));

// Pay all unpaid staff in one transaction
app.post('/api/salaries/pay-all', h((req, res) => {
  const { month } = req.body;
  if (!month) return badReq(res, 'month required');
  const allStaff = db.prepare('SELECT * FROM staff ORDER BY name').all();
  const paidIds  = db.prepare(
    "SELECT staff_id FROM expenses WHERE category='salaries' AND month=? AND staff_id IS NOT NULL"
  ).all(month).map(r => r.staff_id);
  const unpaid = allStaff.filter(s => !paidIds.includes(s.id));
  if (!unpaid.length) return conflict(res, 'All staff already paid for this month');

  const insert = db.prepare(
    'INSERT INTO expenses (id,building,category,month,amount,description,staff_id) VALUES (?,?,?,?,?,?,?)'
  );
  const created = db.transaction(() =>
    unpaid.map(s => {
      const id = uid();
      insert.run(id, s.building, 'salaries', month, s.pay, `${s.name} — ${s.role}`, s.id);
      return db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
    })
  )();
  res.status(201).json(created);
}));

// Salary status for a month — which staff are paid/unpaid
app.get('/api/salaries/status', h((req, res) => {
  const { month } = req.query;
  if (!month) return badReq(res, 'month required');
  const activeStaff = db.prepare('SELECT * FROM staff WHERE deleted=0 ORDER BY name').all();
  const paidExpenses= db.prepare(
    "SELECT * FROM expenses WHERE category='salaries' AND month=? AND staff_id IS NOT NULL"
  ).all(month);
  const paidMap = {};
  paidExpenses.forEach(e => { paidMap[e.staff_id] = e; });
  // Include deleted staff only if they have a paid expense this month
  const deletedWithPay = db.prepare(
    "SELECT s.* FROM staff s INNER JOIN expenses e ON e.staff_id=s.id WHERE s.deleted=1 AND e.category='salaries' AND e.month=? ORDER BY s.name"
  ).all(month);
  const allStaff = [...activeStaff, ...deletedWithPay.filter(d => !activeStaff.find(a => a.id===d.id))];
  res.json(allStaff.map(s => ({ ...s, paid_expense: paidMap[s.id] || null })));
}));

// ─── ADJUSTMENTS ──────────────────────────────────────────────────────────────

app.get('/api/adjustments', h((req, res) => {
  const { room_id, month } = req.query;
  let sql  = `SELECT a.*, r.building, r.number
              FROM adjustments a JOIN rooms r ON r.id=a.room_id WHERE 1=1`;
  const args = [];
  if (room_id) { sql += ' AND a.room_id=?';           args.push(room_id); }
  if (month)   { sql += " AND substr(a.date,1,7)=?";  args.push(month); }
  sql += ' ORDER BY a.date DESC, a.created DESC';
  res.json(db.prepare(sql).all(...args));
}));

app.post('/api/adjustments', h((req, res) => {
  const { room_id, period_id, type, amount, note, date } = req.body;
  const VALID = ['forgiven','writeoff','charge','refund'];
  if (!room_id || !period_id || !VALID.includes(type) || !(amount > 0) || !date)
    return badReq(res, `room_id, period_id, type (${VALID.join('/')}), amount, date required`);

  const result = db.transaction(() => {
    const id = uid();
    db.prepare(
      'INSERT INTO adjustments (id,room_id,period_id,type,amount,note,date) VALUES (?,?,?,?,?,?,?)'
    ).run(id, room_id, period_id, type, amount, note || '', date);

    const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(room_id);
    const bld  = room?.building || 'both';
    const rmNo = room?.number || '?';
    const mo   = date.slice(0, 7);
    const desc_note = note ? `: ${note}` : '';

    // Write-offs also become a bad-debt expense in P&L
    if (type === 'writeoff') {
      db.prepare(
        'INSERT INTO expenses (id,building,category,month,amount,description) VALUES (?,?,?,?,?,?)'
      ).run(uid(), bld, 'writeoff', mo, amount, `Bad debt write-off — Rm ${rmNo}${desc_note}`);
    }
    // Refunds also become an expense (cash out)
    if (type === 'refund') {
      db.prepare(
        'INSERT INTO expenses (id,building,category,month,amount,description) VALUES (?,?,?,?,?,?)'
      ).run(uid(), bld, 'refund', mo, amount, `Tenant refund — Rm ${rmNo}${desc_note}`);
    }

    return db.prepare('SELECT * FROM adjustments WHERE id=?').get(id);
  })();

  res.status(201).json(result);
}));

app.patch('/api/adjustments/:id', h((req, res) => {
  const { amount, note } = req.body;
  if (!(amount > 0)) return badReq(res, 'amount required');
  const info = db.prepare('UPDATE adjustments SET amount=?, note=? WHERE id=?').run(amount, note || '', req.params.id);
  if (!info.changes) return notFound(res, 'Adjustment');
  res.json(db.prepare('SELECT * FROM adjustments WHERE id=?').get(req.params.id));
}));

app.delete('/api/adjustments/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM adjustments WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Adjustment');
  res.json({ ok: true });
}));

// ─── OTHER INCOME ─────────────────────────────────────────────────────────────

const OTHER_INCOME_CATS = new Set(['laundry','parking','storage','pet_fee','application_fee','misc','other']);

app.get('/api/other-income', h((req, res) => {
  const { month, building } = req.query;
  let sql = 'SELECT * FROM other_income WHERE 1=1';
  const args = [];
  if (month)    { sql += ' AND month=?';    args.push(month); }
  if (building && building !== 'all') { sql += ' AND (building=? OR building=\'both\')'; args.push(building); }
  sql += ' ORDER BY created DESC';
  res.json(db.prepare(sql).all(...args));
}));

app.post('/api/other-income', h((req, res) => {
  const { building, category, month, amount, description } = req.body;
  if (!building || !month || !(amount > 0)) return badReq(res, 'building, month, amount required');
  const cat = OTHER_INCOME_CATS.has(category) ? category : 'other';
  const id = uid();
  db.prepare('INSERT INTO other_income (id,building,category,month,amount,description) VALUES (?,?,?,?,?,?)')
    .run(id, building, cat, month, amount, description || '');
  res.status(201).json(db.prepare('SELECT * FROM other_income WHERE id=?').get(id));
}));

app.patch('/api/other-income/:id', h((req, res) => {
  const row = db.prepare('SELECT * FROM other_income WHERE id=?').get(req.params.id);
  if (!row) return notFound(res, 'Income entry');
  const { amount, description } = req.body;
  if (!(amount > 0)) return badReq(res, 'amount required');
  db.prepare('UPDATE other_income SET amount=?, description=? WHERE id=?').run(amount, description ?? row.description, req.params.id);
  res.json(db.prepare('SELECT * FROM other_income WHERE id=?').get(req.params.id));
}));

app.delete('/api/other-income/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM other_income WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Income entry');
  res.json({ ok: true });
}));

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

app.get('/api/dashboard/:month', h((req, res) => {
  const { month } = req.params;
  if (!/^\d{4}-\d{2}$/.test(month)) return badReq(res, 'month must be YYYY-MM');

  const rooms   = db.prepare('SELECT * FROM rooms ORDER BY building, number').all();
  const periods = db.prepare('SELECT * FROM periods ORDER BY start_date').all();
  const pm      = prevMonth(month);

  // Expected rent = sum of prorated amounts for all active periods this month
  let expectedRent = 0;
  periods.forEach(p => { const pro = proratedRent(p, month); if (pro) expectedRent += pro.prorated; });

  const rentIncome    = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE month=?").get(month).t;
  const otherIncome   = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM other_income WHERE month=?").get(month).t;
  const totalIncome   = round2(rentIncome + otherIncome);
  const totalExpenses = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE month=?").get(month).t;

  const [y, mo] = month.split('-').map(Number);
  const fom = new Date(Date.UTC(y, mo - 1, 1));
  const lom = new Date(Date.UTC(y, mo, 0));

  const roomStatus = rooms.map(room => {
    const period = periods.find(p => {
      if (p.room_id !== room.id) return false;
      const s = new Date(p.start_date), e = p.end_date ? new Date(p.end_date) : null;
      return s <= lom && (!e || e >= fom);
    });

    if (!period) {
      const lastPeriod = periods.filter(p => p.room_id === room.id)
        .sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
      const openBal = lastPeriod ? roomBalance(room.id, pm) : 0;
      return {
        room_id: room.id, building: room.building, number: room.number,
        base_rent: room.base_rent, status: 'vacant',
        period: null, pro: null, carry: 0, paid: 0, due: 0, diff: 0,
        arrears: openBal < -0.005 ? round2(-openBal) : 0,
        last_period_id: lastPeriod?.id ?? null
      };
    }

    const pro       = proratedRent(period, month);
    const carry     = roomBalance(room.id, pm);
    const paid      = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=?').get(room.id, month).t;
    const forgiven  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='forgiven' AND substr(date,1,7)=?`).get(room.id, period.id, month).t;
    const charged   = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='charge' AND substr(date,1,7)=?`).get(room.id, period.id, month).t;
    const writeoff  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='writeoff' AND substr(date,1,7)=?`).get(room.id, period.id, month).t;
    const due       = round2(pro.prorated - carry);
    const effective = round2(paid + forgiven + writeoff - charged);
    const diff      = round2(effective - due);

    const status = effective === 0 && due > 0.005 ? 'unpaid'
      : Math.abs(diff) < 0.01 ? 'paid'
      : diff > 0.005           ? 'overpaid'
      :                          'short';

    return {
      room_id: room.id, building: room.building, number: room.number,
      base_rent: room.base_rent, status, period, pro, carry, paid, due, diff,
      forgiven, charged, writeoff,
      arrears: 0, last_period_id: null
    };
  });

  res.json({
    month,
    expectedRent: round2(expectedRent),
    rentIncome:   round2(rentIncome),
    otherIncome:  round2(otherIncome),
    totalIncome:  round2(totalIncome),
    totalExpenses:round2(totalExpenses),
    net:          round2(totalIncome - totalExpenses),
    rooms: roomStatus
  });
}));

// ─── REPORT ───────────────────────────────────────────────────────────────────

app.get('/api/report', h((req, res) => {
  const { from, to, buildings } = req.query;
  if (!from || !to) return badReq(res, 'from and to (YYYY-MM) required');
  if (from > to)    return badReq(res, 'from must be <= to');

  const bldFilter = buildings ? buildings.split(',').map(s => s.trim()) : null;

  // Build month list
  const months = [];
  let [cy, cm] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (cy < ey || (cy === ey && cm <= em)) {
    months.push(`${cy}-${String(cm).padStart(2, '0')}`);
    if (++cm > 12) { cm = 1; cy++; }
  }

  const allRooms   = db.prepare('SELECT * FROM rooms').all()
    .filter(r => !bldFilter || bldFilter.includes(r.building));
  const allPeriods = db.prepare('SELECT * FROM periods').all();

  // Payments
  let paySQL  = `SELECT p.*, r.building, r.number
                 FROM payments p JOIN rooms r ON r.id=p.room_id
                 WHERE p.month>=? AND p.month<=?`;
  const payArgs = [from, to];
  if (bldFilter) { paySQL += ` AND r.building IN (${bldFilter.map(() => '?').join(',')})`; payArgs.push(...bldFilter); }
  const payments = db.prepare(paySQL).all(...payArgs);

  // Expenses (both + selected buildings)
  let expSQL  = `SELECT e.*, s.name AS staff_name
                 FROM expenses e LEFT JOIN staff s ON s.id=e.staff_id
                 WHERE e.month>=? AND e.month<=?`;
  const expArgs = [from, to];
  if (bldFilter) {
    expSQL += ` AND (e.building='both' OR e.building IN (${bldFilter.map(() => '?').join(',')}))`;
    expArgs.push(...bldFilter);
  }
  const expenses = db.prepare(expSQL).all(...expArgs);

  // Adjustments
  const allAdj = db.prepare(
    `SELECT a.*, r.building, r.number FROM adjustments a JOIN rooms r ON r.id=a.room_id`
  ).all().filter(a =>
    months.some(m => a.date.startsWith(m)) &&
    (!bldFilter || bldFilter.includes(a.building))
  );

  // Room summary
  const roomSummary = allRooms.map(room => {
    let due = 0, paid = 0;
    months.forEach(m => {
      const p = allPeriods.find(p2 => {
        if (p2.room_id !== room.id) return false;
        const [y2, m2] = m.split('-').map(Number);
        const fom2 = new Date(Date.UTC(y2, m2-1, 1)), lom2 = new Date(Date.UTC(y2, m2, 0));
        const s = new Date(p2.start_date), e = p2.end_date ? new Date(p2.end_date) : null;
        return s <= lom2 && (!e || e >= fom2);
      });
      if (p) { const pro = proratedRent(p, m); if (pro) due += pro.prorated; }
      paid += payments.filter(py => py.room_id === room.id && py.month === m).reduce((s, x) => s + x.amount, 0);
    });
    const forgiven = allAdj.filter(a => a.room_id === room.id && a.type === 'forgiven').reduce((s, a) => s + a.amount, 0);
    return {
      ...room,
      totalDue:     round2(due),
      totalPaid:    round2(paid),
      totalForgiven:round2(forgiven),
      diff:         round2(paid + forgiven - due)
    };
  });

  // Expense breakdown
  const expByCategory = {};
  expenses.forEach(e => { expByCategory[e.category] = round2((expByCategory[e.category] || 0) + e.amount); });

  // Other income
  let otherIncSQL = 'SELECT * FROM other_income WHERE month>=? AND month<=?';
  const otherIncArgs = [from, to];
  if (bldFilter) { otherIncSQL += ` AND (building='both' OR building IN (${bldFilter.map(()=>'?').join(',')}))`; otherIncArgs.push(...bldFilter); }
  const otherIncomeRows = db.prepare(otherIncSQL).all(...otherIncArgs);

  const rentTotal     = round2(payments.reduce((s, p) => s + p.amount, 0));
  const otherIncTotal = round2(otherIncomeRows.reduce((s, r) => s + r.amount, 0));
  const totalIncome   = round2(rentTotal + otherIncTotal);
  const totalExpenses = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const totalMiles    = round2(expenses.filter(e => e.category === 'miles').reduce((s, e) => s + (e.miles || 0), 0));
  let expectedRent = 0;
  months.forEach(m => {
    allPeriods.forEach(p => {
      if (!allRooms.find(r => r.id === p.room_id)) return;
      const pro = proratedRent(p, m); if (pro) expectedRent += pro.prorated;
    });
  });

  res.json({
    from, to, months, buildings: bldFilter || ['all'],
    totalIncome, totalExpenses, net: round2(totalIncome - totalExpenses),
    expectedRent: round2(expectedRent), totalMiles,
    expByCategory, roomSummary,
    payments, expenses, adjustments: allAdj,
    otherIncome: otherIncomeRows,
    salaries: expenses.filter(e => e.category === 'salaries')
  });
}));

// ─── BACKUP endpoints ─────────────────────────────────────────────────────────

app.post('/api/backup', h((req, res) => {
  const file = runBackup();
  const all  = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json')).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
  res.json({ ok: true, file, backups: all });
}));

app.get('/api/backup', h((req, res) => {
  const all = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json')).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size,
                 date: fs.statSync(path.join(BACKUP_DIR, f)).mtime }));
  res.json(all);
}));

app.get('/api/backup/:name', h((req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) return notFound(res, 'Backup');
  res.download(full);
}));

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), db: DB_PATH });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  const line = '─'.repeat(44);
  console.log(`\n  ┌${line}┐`);
  console.log(`  │  Rental Tracker                              │`);
  console.log(`  │  Open in your browser:                       │`);
  console.log(`  │  http://localhost:${PORT}                        │`);
  console.log(`  │                                              │`);
  console.log(`  │  Press Ctrl+C to stop                        │`);
  console.log(`  └${line}┘\n`);

  // Startup backup
  try { runBackup(`startup-${new Date().toISOString().slice(0, 10)}`); }
  catch (e) { console.error('[backup] startup backup failed:', e.message); }

  scheduleDailyBackup();
});

process.on('SIGINT',  () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
