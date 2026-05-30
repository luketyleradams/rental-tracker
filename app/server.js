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
    building TEXT NOT NULL DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS buildings (
    name    TEXT PRIMARY KEY,
    created TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS hours_log (
    id       TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id),
    month    TEXT NOT NULL CHECK(month GLOB '????-??'),
    date     TEXT NOT NULL,
    hours    REAL NOT NULL CHECK(hours > 0),
    note     TEXT NOT NULL DEFAULT '',
    created  TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hours_log_staff_month ON hours_log(staff_id, month);
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
// Safe to re-run: SQLite throws on duplicate ADD COLUMN, we just swallow it.
[
  'ALTER TABLE rooms    ADD COLUMN late_fee_type  TEXT',
  'ALTER TABLE rooms    ADD COLUMN late_fee_value REAL',
  'ALTER TABLE payments ADD COLUMN days_late INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE payments ADD COLUMN late_fee   REAL    NOT NULL DEFAULT 0',
  'ALTER TABLE staff    ADD COLUMN deleted  INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE staff    ADD COLUMN pay_type TEXT    NOT NULL DEFAULT 'salary'",
  'ALTER TABLE expenses    ADD COLUMN hours     REAL',
  'ALTER TABLE payments    ADD COLUMN period_id TEXT',
  "ALTER TABLE adjustments ADD COLUMN status    TEXT NOT NULL DEFAULT 'active'",
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

  // Pre-aggregate payments by month once to avoid double-counting when two periods overlap the same month
  const payByMonth = {};
  db.prepare('SELECT month, COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? GROUP BY month')
    .all(roomId).forEach(r => { payByMonth[r.month] = r.t; });
  const creditedMonths = new Set(); // months whose payments have already been added to balance

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
        // Credit payments only once per month — if two periods share a month, the second period sees 0
        const paid = creditedMonths.has(mo) ? 0 : (payByMonth[mo] || 0);
        if (!creditedMonths.has(mo)) creditedMonths.add(mo);

        const forgiven = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
           WHERE room_id=? AND period_id=? AND type='forgiven' AND substr(date,1,7)=?`
        ).get(roomId, period.id, mo).t;

        const charged = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
           WHERE room_id=? AND period_id=? AND type='charge' AND status='active' AND substr(date,1,7)=?`
        ).get(roomId, period.id, mo).t;

        // Refunds reduce the tenant's credit (landlord pays cash back)
        const refunded = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
           WHERE room_id=? AND period_id=? AND type='refund' AND substr(date,1,7)=?`
        ).get(roomId, period.id, mo).t;

        balance = balance + paid + forgiven - charged - refunded - pro.prorated;
      }

      if (++m > 12) { m = 1; y++; }
    }

    // Write-offs close the owed balance — bounded to upToMonth so historical queries stay accurate
    const writeoffs = db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS t FROM adjustments
       WHERE room_id=? AND period_id=? AND type='writeoff' AND substr(date,1,7)<=?`
    ).get(roomId, period.id, upToMonth).t;
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
  setTimeout(() => {
    try { runBackup(); } catch (e) { console.error('[backup] scheduled backup failed:', e.message); }
    scheduleDailyBackup();
  }, next - now);
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
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        });
      }
    } catch (err) {
      console.error('[api]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function notFound(res, what) { res.status(404).json({ error: `${what} not found` }); }
function badReq(res, msg)    { res.status(400).json({ error: msg }); }
function conflict(res, msg)  { res.status(409).json({ error: msg }); }

// ─── ROOMS ────────────────────────────────────────────────────────────────────

// ─── HOURS LOG ────────────────────────────────────────────────────────────────

app.get('/api/hours-log', h((req, res) => {
  const { staff_id, month } = req.query;
  if (!staff_id || !month) return badReq(res, 'staff_id and month required');
  res.json(db.prepare('SELECT * FROM hours_log WHERE staff_id=? AND month=? ORDER BY date, created').all(staff_id, month));
}));

app.post('/api/hours-log', h((req, res) => {
  const { staff_id, month, date, hours, note } = req.body;
  if (!staff_id || !month || !date || !(hours > 0)) return badReq(res, 'staff_id, month, date, hours (>0) required');
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(staff_id);
  if (!s) return notFound(res, 'Staff member');
  if (s.pay_type !== 'hourly') return badReq(res, 'Hours log is only for hourly staff');
  const id = uid();
  db.prepare('INSERT INTO hours_log (id,staff_id,month,date,hours,note) VALUES (?,?,?,?,?,?)').run(id, staff_id, month, date, hours, note || '');
  res.status(201).json(db.prepare('SELECT * FROM hours_log WHERE id=?').get(id));
}));

app.patch('/api/hours-log/:id', h((req, res) => {
  const entry = db.prepare('SELECT * FROM hours_log WHERE id=?').get(req.params.id);
  if (!entry) return notFound(res, 'Hours entry');
  const { date, hours, note } = req.body;
  if (date !== undefined && !date) return badReq(res, 'date cannot be empty');
  if (hours !== undefined && !(hours > 0)) return badReq(res, 'hours must be > 0');
  db.prepare('UPDATE hours_log SET date=?,hours=?,note=? WHERE id=?')
    .run(date ?? entry.date, hours ?? entry.hours, note ?? entry.note, req.params.id);
  res.json(db.prepare('SELECT * FROM hours_log WHERE id=?').get(req.params.id));
}));

app.delete('/api/hours-log/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM hours_log WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Hours entry');
  res.json({ ok: true });
}));

// ─── BUILDINGS ────────────────────────────────────────────────────────────────

app.get('/api/buildings', h((req, res) => {
  const fromRooms = db.prepare('SELECT DISTINCT building AS name FROM rooms ORDER BY building').all().map(r => r.name);
  const stored    = db.prepare('SELECT name FROM buildings ORDER BY name').all().map(r => r.name);
  const all = [...new Set([...stored, ...fromRooms])].sort();
  res.json(all);
}));

app.post('/api/buildings', h((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return badReq(res, 'name required');
  const n = name.trim();
  try {
    db.prepare('INSERT INTO buildings (name) VALUES (?)').run(n);
  } catch (_) {
    return conflict(res, `${n} already exists`);
  }
  res.status(201).json({ name: n });
}));

app.delete('/api/buildings/:name', h((req, res) => {
  const name = decodeURIComponent(req.params.name);
  const inUse = db.prepare('SELECT 1 FROM rooms WHERE building=? LIMIT 1').get(name);
  if (inUse) return conflict(res, `Cannot remove — rooms exist in ${name}`);
  db.prepare('DELETE FROM buildings WHERE name=?').run(name);
  res.json({ ok: true });
}));

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
  const { force } = req.query;
  if (!force) {
    const hasPeriods  = db.prepare('SELECT 1 FROM periods  WHERE room_id=? LIMIT 1').get(req.params.id);
    const hasPayments = db.prepare('SELECT 1 FROM payments WHERE room_id=? LIMIT 1').get(req.params.id);
    if (hasPeriods || hasPayments)
      return res.status(409).json({ error: 'Room has rental history. Add ?force=1 to confirm permanent deletion.' });
  }
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

// Move-out: sets end_date, auto-writes off any outstanding balance as bad debt
app.patch('/api/periods/:id/moveout', h((req, res) => {
  const { end_date } = req.body;
  if (!end_date) return badReq(res, 'end_date required');

  const period = db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id);
  if (!period)          return notFound(res, 'Period');
  if (period.end_date)  return conflict(res, 'Period already closed');
  if (end_date < period.start_date) return badReq(res, 'end_date cannot be before start_date');

  const result = db.transaction(() => {
    db.prepare('UPDATE periods SET end_date=? WHERE id=?').run(end_date, req.params.id);
    const updated = db.prepare('SELECT * FROM periods WHERE id=?').get(req.params.id);
    const balance = roomBalance(period.room_id, end_date.slice(0, 7));

    if (balance < -0.005) {
      const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(period.room_id);
      const amount = round2(-balance);
      const mo = end_date.slice(0, 7);
      db.prepare(
        'INSERT INTO adjustments (id,room_id,period_id,type,amount,note,date) VALUES (?,?,?,?,?,?,?)'
      ).run(uid(), period.room_id, period.id, 'writeoff', amount, 'Auto write-off at move-out', end_date);
      db.prepare(
        'INSERT INTO expenses (id,building,category,month,amount,description) VALUES (?,?,?,?,?,?)'
      ).run(uid(), room.building, 'writeoff', mo, amount, `Bad debt write-off — Rm ${room.number}`);
    }

    return { period: updated, balance };
  })();

  res.json(result);
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
  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!room) return notFound(res, 'Room');

  // All periods that overlap this month (handles move-out + move-in same month)
  const [y, m] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(y, m - 1, 1));
  const lastDay  = new Date(Date.UTC(y, m, 0));
  const allPeriods = db.prepare('SELECT * FROM periods WHERE room_id=? ORDER BY start_date').all(req.params.id);
  const overlapping = allPeriods
    .filter(p => {
      const s = new Date(p.start_date);
      const e = p.end_date ? new Date(p.end_date) : null;
      return s <= lastDay && (!e || e >= firstDay);
    })
    .map(p => {
      const pro = proratedRent(p, month);
      const paidForPeriod = db.prepare(
        'SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=? AND period_id=?'
      ).get(req.params.id, month, p.id).t;
      return { period: p, pro, paidForPeriod };
    })
    .filter(x => x.pro);

  if (!overlapping.length) return res.json({ vacant: true });

  const totalProrated = round2(overlapping.reduce((s, x) => s + x.pro.prorated, 0));
  const carry = roomBalance(req.params.id, prevMonth(month));
  const paid  = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=?').get(req.params.id, month).t;

  const daysLate = Math.max(0, parseInt(days_late) || 0);
  let lateFee = 0;
  if (daysLate > 0 && room.late_fee_type && room.late_fee_value > 0) {
    lateFee = room.late_fee_type === 'fixed'
      ? round2(daysLate * room.late_fee_value)
      : round2(daysLate * (room.late_fee_value / 100) * totalProrated);
  }

  const multiTenant = overlapping.length > 1;
  // pro: combined summary (single-tenant shape preserved for compat)
  const pro = multiTenant
    ? { prorated: totalProrated, fullMonth: false, multiTenant: true }
    : overlapping[0].pro;

  res.json({
    periods: overlapping, pro, carry, paid,
    due: round2(totalProrated - carry),
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
  const { room_id, month, amount, notes, days_late, late_fee, period_id } = req.body;
  if (!room_id || !month || !(amount > 0)) return badReq(res, 'room_id, month, amount (>0) required');
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(room_id)) return notFound(res, 'Room');
  const daysLate = Math.max(0, parseInt(days_late) || 0);
  const lateFee  = round2(Math.max(0, parseFloat(late_fee) || 0));
  const id = uid();
  db.prepare('INSERT INTO payments (id,room_id,month,amount,notes,days_late,late_fee,period_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, room_id, month, amount, notes || '', daysLate, lateFee, period_id || null);
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
  const { name, role, building, pay, pay_type } = req.body;
  if (!name?.trim() || !(pay > 0)) return badReq(res, 'name and pay (>0) required');
  const type = pay_type === 'hourly' ? 'hourly' : 'salary';
  const id = uid();
  db.prepare('INSERT INTO staff (id,name,role,building,pay,pay_type) VALUES (?,?,?,?,?,?)')
    .run(id, name.trim(), role || '', building || '', pay, type);
  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id=?').get(id));
}));

app.patch('/api/staff/:id', h((req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(req.params.id);
  if (!s) return notFound(res, 'Staff member');
  const { name, role, building, pay, pay_type } = req.body;
  const type = pay_type != null ? (pay_type === 'hourly' ? 'hourly' : 'salary') : s.pay_type;
  db.prepare('UPDATE staff SET name=?,role=?,building=?,pay=?,pay_type=? WHERE id=?')
    .run(name ?? s.name, role ?? s.role, building ?? s.building, pay ?? s.pay, type, req.params.id);
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
    sql += " AND (e.building='both' OR (',' || e.building || ',') LIKE ('%,' || ? || ',%'))";
    args.push(building);
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

app.patch('/api/expenses/:id', h((req, res) => {
  const { building, category, month, amount, miles, description } = req.body;
  const exp = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!exp) return notFound(res, 'Expense');
  if (exp.staff_id) {
    // Salary expenses: only amount is editable
    if (!(amount > 0)) return badReq(res, 'amount (>0) required');
    db.prepare('UPDATE expenses SET amount=? WHERE id=?').run(round2(amount), req.params.id);
    return res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
  }
  const newCat = category ?? exp.category;
  if (!VALID_CATS.has(newCat)) return badReq(res, `Invalid category`);
  const newMiles = miles != null ? miles : exp.miles;
  const newAmount = (newCat === 'miles' && newMiles > 0)
    ? round2(newMiles * MILEAGE_RATE)
    : (amount != null ? amount : exp.amount);
  db.prepare(
    'UPDATE expenses SET building=?,category=?,month=?,amount=?,miles=?,description=? WHERE id=?'
  ).run(building ?? exp.building, newCat, month ?? exp.month, newAmount, newMiles, description ?? exp.description, req.params.id);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
}));

app.delete('/api/expenses/:id', h((req, res) => {
  const info = db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  if (!info.changes) return notFound(res, 'Expense');
  res.json({ ok: true });
}));

// Pay a single staff member
app.post('/api/salaries/pay-one', h((req, res) => {
  const { staff_id, month, amount, hours } = req.body;
  if (!staff_id || !month) return badReq(res, 'staff_id and month required');
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(staff_id);
  if (!s) return notFound(res, 'Staff member');

  let pay, hoursVal = null;
  if (s.pay_type === 'hourly') {
    if (!(amount > 0)) return badReq(res, 'amount (>0) required');
    hoursVal = hours > 0 ? hours : null;
    pay = amount;
  } else {
    const totalPaid = db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE category='salaries' AND month=? AND staff_id=?"
    ).get(month, staff_id).t;
    const remaining = round2(s.pay - totalPaid);
    if (remaining <= 0.005) return conflict(res, `${s.name} is already fully paid for ${month}`);
    pay = (amount && amount > 0) ? Math.min(amount, remaining) : remaining;
  }

  const id = uid();
  db.prepare(
    'INSERT INTO expenses (id,building,category,month,amount,hours,description,staff_id) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, s.building, 'salaries', month, pay, hoursVal, `${s.name} — ${s.role}`, staff_id);
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
}));

// Pay all unpaid/partial staff in one transaction
app.post('/api/salaries/pay-all', h((req, res) => {
  const { month } = req.body;
  if (!month) return badReq(res, 'month required');
  const allStaff = db.prepare('SELECT * FROM staff ORDER BY name').all();
  const paidExpenses = db.prepare(
    "SELECT staff_id, SUM(amount) AS paid FROM expenses WHERE category='salaries' AND month=? AND staff_id IS NOT NULL GROUP BY staff_id"
  ).all(month);
  const paidMap = {};
  paidExpenses.forEach(r => { paidMap[r.staff_id] = r.paid; });
  // Only salary staff (hourly have no fixed amount — must be paid individually)
  const needsPay = allStaff
    .filter(s => s.pay_type !== 'hourly')
    .map(s => ({ ...s, remaining: round2(s.pay - (paidMap[s.id] || 0)) }))
    .filter(s => s.remaining > 0.005);
  if (!needsPay.length) return conflict(res, 'All staff already paid for this month');

  const insert = db.prepare(
    'INSERT INTO expenses (id,building,category,month,amount,description,staff_id) VALUES (?,?,?,?,?,?,?)'
  );
  const created = db.transaction(() =>
    needsPay.map(s => {
      const id = uid();
      insert.run(id, s.building, 'salaries', month, s.remaining, `${s.name} — ${s.role}`, s.id);
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
  const paidExpenses = db.prepare(
    "SELECT * FROM expenses WHERE category='salaries' AND month=? AND staff_id IS NOT NULL ORDER BY created"
  ).all(month);
  const paidMap = {};
  paidExpenses.forEach(e => {
    if (!paidMap[e.staff_id]) paidMap[e.staff_id] = { expenses: [], total: 0 };
    paidMap[e.staff_id].expenses.push(e);
    paidMap[e.staff_id].total = round2(paidMap[e.staff_id].total + e.amount);
  });
  // Include deleted staff only if they have a paid expense this month (GROUP BY prevents duplicates from multiple expenses)
  const deletedWithPay = db.prepare(
    "SELECT s.* FROM staff s WHERE s.deleted=1 AND EXISTS (SELECT 1 FROM expenses e WHERE e.staff_id=s.id AND e.category='salaries' AND e.month=?) ORDER BY s.name"
  ).all(month);
  // Hours log totals for hourly staff
  const hoursRows = db.prepare(
    'SELECT staff_id, SUM(hours) AS total_hours FROM hours_log WHERE month=? GROUP BY staff_id'
  ).all(month);
  const hoursMap = {};
  hoursRows.forEach(r => { hoursMap[r.staff_id] = r.total_hours; });

  const allStaff = [...activeStaff, ...deletedWithPay.filter(d => !activeStaff.find(a => a.id===d.id))];
  res.json(allStaff.map(s => ({
    ...s,
    paid_expense: paidMap[s.id] ? paidMap[s.id].expenses[0] : null,
    paid_total: paidMap[s.id] ? paidMap[s.id].total : 0,
    paid_expenses: paidMap[s.id] ? paidMap[s.id].expenses : [],
    logged_hours: hoursMap[s.id] || 0,
  })));
}));

// ─── ADJUSTMENTS ──────────────────────────────────────────────────────────────

app.get('/api/adjustments', h((req, res) => {
  const { room_id, month, type, status } = req.query;
  let sql  = `SELECT a.*, r.building, r.number
              FROM adjustments a JOIN rooms r ON r.id=a.room_id WHERE 1=1`;
  const args = [];
  if (room_id) { sql += ' AND a.room_id=?';          args.push(room_id); }
  if (month)   { sql += ' AND substr(a.date,1,7)=?'; args.push(month); }
  if (type)    { sql += ' AND a.type=?';             args.push(type); }
  if (status)  { sql += ' AND a.status=?';           args.push(status); }
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
    const bld  = room?.building || '';
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
  const adj = db.prepare('SELECT * FROM adjustments WHERE id=?').get(req.params.id);
  if (!adj) return notFound(res, 'Adjustment');
  const { amount, note, status } = req.body;
  if (status !== undefined) {
    if (!['active','forgiven'].includes(status)) return badReq(res, 'status must be active or forgiven');
    db.prepare('UPDATE adjustments SET status=? WHERE id=?').run(status, req.params.id);
  } else {
    if (!(amount > 0)) return badReq(res, 'amount required');
    db.prepare('UPDATE adjustments SET amount=?, note=? WHERE id=?').run(amount, note ?? adj.note, req.params.id);
  }
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
  if (building && building !== 'all') { sql += " AND (building='both' OR (',' || building || ',') LIKE ('%,' || ? || ',%'))"; args.push(building); }
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
    // All periods overlapping this month
    const overlapping = periods.filter(p => {
      if (p.room_id !== room.id) return false;
      const s = new Date(p.start_date), e = p.end_date ? new Date(p.end_date) : null;
      return s <= lom && (!e || e >= fom);
    });

    if (!overlapping.length) {
      const lastPeriod = periods.filter(p => p.room_id === room.id)
        .sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
      const openBal = lastPeriod ? roomBalance(room.id, pm) : 0;
      return {
        room_id: room.id, building: room.building, number: room.number,
        base_rent: room.base_rent, status: 'vacant',
        period: null, periods: [], pro: null, carry: 0, paid: 0, due: 0, diff: 0,
        arrears: openBal < -0.005 ? round2(-openBal) : 0,
        last_period_id: lastPeriod?.id ?? null,
        last_period_end_date: lastPeriod?.end_date ?? null
      };
    }

    // Per-period detail: prorated rent, adjustments, per-period paid (via period_id)
    const periodDetails = overlapping.map(p => {
      const pro = proratedRent(p, month);
      if (!pro) return null;
      const forgiven  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND (type='forgiven' OR (type='charge' AND status='forgiven')) AND substr(date,1,7)=?`).get(room.id, p.id, month).t;
      const charged   = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='charge' AND status='active' AND substr(date,1,7)=?`).get(room.id, p.id, month).t;
      const writeoff  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='writeoff'  AND substr(date,1,7)=?`).get(room.id, p.id, month).t;
      const refunded  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM adjustments WHERE room_id=? AND period_id=? AND type='refund'    AND substr(date,1,7)=?`).get(room.id, p.id, month).t;
      const paidForPeriod = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=? AND period_id=?`).get(room.id, month, p.id).t;
      return { period: p, pro, forgiven, charged, writeoff, refunded, paidForPeriod };
    }).filter(Boolean);

    const totalProrated = round2(periodDetails.reduce((s, x) => s + x.pro.prorated, 0));
    const totalForgiven = round2(periodDetails.reduce((s, x) => s + x.forgiven, 0));
    const totalCharged  = round2(periodDetails.reduce((s, x) => s + x.charged, 0));
    const totalWriteoff = round2(periodDetails.reduce((s, x) => s + x.writeoff, 0));
    const totalRefunded = round2(periodDetails.reduce((s, x) => s + x.refunded, 0));

    const carry = roomBalance(room.id, pm);
    const paid  = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE room_id=? AND month=?').get(room.id, month).t;

    // due = net obligation: rent + charges − forgiven − writeoffs − refunds issued this month − carry credit
    // This makes "Total Due" meaningful: if due=$1100 and paid=$900, "Short $200" makes sense.
    const due  = round2(totalProrated - carry + totalCharged - totalForgiven - totalWriteoff - totalRefunded);
    const diff = round2(paid - due);

    const status = paid < 0.005 && due > 0.005 ? 'unpaid'
      : Math.abs(diff) < 0.01 ? 'paid'
      : diff > 0.005           ? 'overpaid'
      :                          'short';

    const multiTenant = periodDetails.length > 1;
    const pro = multiTenant
      ? { prorated: totalProrated, fullMonth: false, multiTenant: true }
      : periodDetails[0].pro;

    return {
      room_id: room.id, building: room.building, number: room.number,
      base_rent: room.base_rent, status,
      period: overlapping[0], periods: periodDetails, pro, carry, paid, due, diff,
      forgiven: totalForgiven, charged: totalCharged, writeoff: totalWriteoff,
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

  let expSQL  = `SELECT e.*, s.name AS staff_name
                 FROM expenses e LEFT JOIN staff s ON s.id=e.staff_id
                 WHERE e.month>=? AND e.month<=?`;
  const expArgs = [from, to];
  if (bldFilter) {
    const expBldClauses = bldFilter.map(() => "(',' || e.building || ',') LIKE ('%,' || ? || ',%')").join(' OR ');
    expSQL += ` AND (e.building='both' OR ${expBldClauses})`;
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
      const [y2, m2] = m.split('-').map(Number);
      const fom2 = new Date(Date.UTC(y2, m2-1, 1)), lom2 = new Date(Date.UTC(y2, m2, 0));
      // All periods overlapping this month — handles two tenants in the same month
      allPeriods
        .filter(p2 => {
          if (p2.room_id !== room.id) return false;
          const s = new Date(p2.start_date), e = p2.end_date ? new Date(p2.end_date) : null;
          return s <= lom2 && (!e || e >= fom2);
        })
        .forEach(p => { const pro = proratedRent(p, m); if (pro) due += pro.prorated; });
      paid += payments.filter(py => py.room_id === room.id && py.month === m).reduce((s, x) => s + x.amount, 0);
    });
    const forgiven  = allAdj.filter(a => a.room_id === room.id && (a.type === 'forgiven' || (a.type === 'charge' && a.status === 'forgiven'))).reduce((s, a) => s + a.amount, 0);
    const writeoffs = allAdj.filter(a => a.room_id === room.id && a.type === 'writeoff').reduce((s, a) => s + a.amount, 0);
    const charged   = allAdj.filter(a => a.room_id === room.id && a.type === 'charge' && a.status !== 'forgiven').reduce((s, a) => s + a.amount, 0);
    const refunds   = allAdj.filter(a => a.room_id === room.id && a.type === 'refund').reduce((s, a) => s + a.amount, 0);
    // totalDue = net obligation: rent + charges − forgiven − writeoffs − refunds
    // Matches dashboard logic so report and ledger always agree
    const netDue = round2(due + charged - forgiven - writeoffs - refunds);
    return {
      ...room,
      totalDue:     netDue,
      totalPaid:    round2(paid),
      totalForgiven:round2(forgiven),
      totalWriteoff:round2(writeoffs),
      totalCharged: round2(charged),
      diff:         round2(paid - (netDue + forgiven + writeoffs))
    };
  });

  // Expense breakdown
  const expByCategory = {};
  expenses.forEach(e => { expByCategory[e.category] = round2((expByCategory[e.category] || 0) + e.amount); });

  // Other income
  let otherIncSQL = 'SELECT * FROM other_income WHERE month>=? AND month<=?';
  const otherIncArgs = [from, to];
  if (bldFilter) {
    const oiBldClauses = bldFilter.map(() => "(',' || building || ',') LIKE ('%,' || ? || ',%')").join(' OR ');
    otherIncSQL += ` AND (building='both' OR ${oiBldClauses})`;
    otherIncArgs.push(...bldFilter);
  }
  const otherIncomeRows = db.prepare(otherIncSQL).all(...otherIncArgs);

  const rentTotal     = round2(payments.reduce((s, p) => s + p.amount, 0));
  const otherIncTotal = round2(otherIncomeRows.reduce((s, r) => s + r.amount, 0));
  const totalIncome   = round2(rentTotal + otherIncTotal);
  const totalExpenses = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const totalMiles    = round2(expenses.filter(e => e.category === 'miles').reduce((s, e) => s + (e.miles || 0), 0));
  let expectedRent = 0;
  const monthlyExpectedRent = {};   // { month: totalExpected }
  const monthlyRoomExpected  = {};  // { month: { roomId: expected } }
  months.forEach(m => {
    const [y2, m2] = m.split('-').map(Number);
    const fom2 = new Date(Date.UTC(y2, m2-1, 1)), lom2 = new Date(Date.UTC(y2, m2, 0));
    let mer = 0;
    monthlyRoomExpected[m] = {};
    allRooms.forEach(room => {
      let roomDue = 0;
      allPeriods
        .filter(p => {
          if (p.room_id !== room.id) return false;
          const s = new Date(p.start_date), e = p.end_date ? new Date(p.end_date) : null;
          return s <= lom2 && (!e || e >= fom2);
        })
        .forEach(p => { const pro = proratedRent(p, m); if (pro) roomDue += pro.prorated; });
      if (roomDue > 0) {
        monthlyRoomExpected[m][room.id] = round2(roomDue);
        mer += roomDue;
      }
    });
    expectedRent += mer;
    monthlyExpectedRent[m] = round2(mer);
  });

  res.json({
    from, to, months, buildings: bldFilter || ['all'],
    totalIncome, totalExpenses, net: round2(totalIncome - totalExpenses),
    expectedRent: round2(expectedRent), monthlyExpectedRent, monthlyRoomExpected, totalMiles,
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
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
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
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use. Close the other instance and try again.\n`);
  } else {
    console.error('\n  ERROR starting server:', err.message, '\n');
  }
  process.exit(1);
});

process.on('SIGINT',  () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
