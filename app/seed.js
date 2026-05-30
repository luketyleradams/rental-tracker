'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'data', 'rental.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // off during wipe so order doesn't matter

// ── Wipe ──────────────────────────────────────────────────────────────────────
db.exec(`
  DELETE FROM adjustments;
  DELETE FROM hours_log;
  DELETE FROM expenses;
  DELETE FROM payments;
  DELETE FROM periods;
  DELETE FROM other_income;
  DELETE FROM staff;
  DELETE FROM rooms;
  DELETE FROM buildings;
`);
db.pragma('foreign_keys = ON');

let _seq = 1;
function uid() { return 's' + String(_seq++).padStart(5, '0'); }

// ── Buildings ─────────────────────────────────────────────────────────────────
const insB = db.prepare('INSERT INTO buildings (name) VALUES (?)');
insB.run('Goodwin');
insB.run('Galaxy');

// ── Rooms ─────────────────────────────────────────────────────────────────────
const insR = db.prepare(
  'INSERT INTO rooms (id,building,number,base_rent,created,late_fee_type,late_fee_value) VALUES (?,?,?,?,?,?,?)'
);
const R = {};
const roomDefs = [
  ['gw1a','Goodwin','1A',1250], ['gw1b','Goodwin','1B',925],
  ['gw2a','Goodwin','2A',1100], ['gw2b','Goodwin','2B',1100],
  ['gw3a','Goodwin','3A',950],
  ['gx101','Galaxy','101',975], ['gx102','Galaxy','102',1025],
  ['gx103','Galaxy','103',1100],['gx201','Galaxy','201',950],
  ['gx202','Galaxy','202',925],
];
roomDefs.forEach(([k,bld,num,rent]) => {
  R[k] = uid();
  insR.run(R[k], bld, num, rent, '2025-06-01', 'fixed', 50);
});

// ── Staff ─────────────────────────────────────────────────────────────────────
const insS = db.prepare(
  'INSERT INTO staff (id,name,role,building,pay,pay_type,created) VALUES (?,?,?,?,?,?,?)'
);
const S = {};
S.rosa  = uid(); insS.run(S.rosa,  'Rosa Mendez',   'Property Manager', 'Goodwin',       2200,  'salary', '2026-01-01');
S.devon = uid(); insS.run(S.devon, 'Devon Hall',    'Maintenance',      'Galaxy',         1600,  'salary', '2026-01-01');
S.willy = uid(); insS.run(S.willy, 'Willy Torres',  'Maintenance',      'Galaxy,Goodwin', 16.50, 'hourly', '2026-01-01');

// ── Periods ───────────────────────────────────────────────────────────────────
const insP = db.prepare(
  'INSERT INTO periods (id,room_id,rent,start_date,end_date,created) VALUES (?,?,?,?,?,?)'
);
const P = {};
function period(key, room, rent, start, end=null) {
  P[key] = uid();
  insP.run(P[key], R[room], rent, start, end, start);
}

period('gw1a',   'gw1a',  1250, '2026-01-01');           // Jordan Lee — ongoing
period('gw1b_1', 'gw1b',   900, '2026-01-01','2026-03-31'); // Sam Ortiz — moved out Mar 31
period('gw1b_2', 'gw1b',   925, '2026-05-01');           // Priya Nair — moved in May 1
period('gw2a',   'gw2a',  1100, '2026-01-01');           // Marcus Webb — ongoing
period('gw2b',   'gw2b',  1100, '2026-01-01');           // Patricia Osei — ongoing
period('gw3a',   'gw3a',   950, '2026-02-01');           // Sandra Ruiz — moved in Feb 1
period('gx101',  'gx101',  975, '2026-01-01');           // Danny Torres — ongoing (habitually late)
period('gx102',  'gx102', 1025, '2026-01-01');           // Keisha Brown — ongoing
period('gx103',  'gx103', 1100, '2026-01-01');           // Tom Nguyen — ongoing
period('gx201_1','gx201',  925, '2026-01-01','2026-02-28'); // Mia Foster — moved out Feb 28
period('gx201_2','gx201',  950, '2026-04-01');           // Carlos Vega — moved in Apr 1
period('gx202',  'gx202',  925, '2026-01-01');           // Helen Park — ongoing

// ── Payments ──────────────────────────────────────────────────────────────────
const insPay = db.prepare(
  'INSERT INTO payments (id,room_id,month,amount,notes,created,days_late,late_fee) VALUES (?,?,?,?,?,?,?,?)'
);
function pay(room, month, amount, notes='', date, daysLate=0, lateFee=0) {
  insPay.run(uid(), R[room], month, amount, notes, date, daysLate, lateFee);
}

// January 2026
pay('gw1a','2026-01',1250,'','2026-01-03');
pay('gw1b','2026-01', 900,'','2026-01-04');
pay('gw2a','2026-01',1100,'','2026-01-03');
pay('gw2b','2026-01',1100,'','2026-01-22',19,50); // late — late fee
pay('gx101','2026-01', 975,'','2026-01-10',9,50);  // habitually late
pay('gx102','2026-01',1025,'','2026-01-03');
pay('gx103','2026-01',1100,'','2026-01-04');
pay('gx201','2026-01', 925,'','2026-01-03');
pay('gx202','2026-01', 925,'','2026-01-02');
// 3A vacant in Jan

// February 2026
pay('gw1a','2026-02',1250,'','2026-02-03');
pay('gw1b','2026-02', 900,'','2026-02-04');
pay('gw2a','2026-02',1100,'','2026-02-04');
pay('gw2b','2026-02',1100,'','2026-02-05');
pay('gw3a','2026-02', 950,'','2026-02-05');  // Sandra — first full month
pay('gx101','2026-02', 975,'','2026-02-13',12,50);
pay('gx102','2026-02',1025,'','2026-02-03');
pay('gx103','2026-02',1100,'','2026-02-04');
pay('gx201','2026-02', 925,'','2026-02-03');  // Mia — last month
pay('gx202','2026-02', 925,'','2026-02-03');

// March 2026 (201 vacant)
pay('gw1a','2026-03',1250,'','2026-03-04');
pay('gw1b','2026-03', 900,'','2026-03-05');  // Sam — last month
pay('gw2a','2026-03',1100,'','2026-03-04');
pay('gw2b','2026-03',1100,'','2026-03-05');
pay('gw3a','2026-03', 950,'','2026-03-05');
pay('gx101','2026-03', 975,'','2026-03-09',8,50);
pay('gx102','2026-03',1025,'','2026-03-04');
pay('gx103','2026-03',1100,'','2026-03-03');
pay('gx202','2026-03', 925,'','2026-03-04');

// April 2026 (1B and 201 vacant in Jan-Apr, 201 new tenant Apr 1)
pay('gw1a','2026-04',1250,'','2026-04-03');
// 1B vacant April
pay('gw2a','2026-04',1100,'','2026-04-03');
pay('gw2b','2026-04',1100,'','2026-04-05');
pay('gw3a','2026-04', 950,'','2026-04-04');
pay('gx101','2026-04', 975,'','2026-04-14',13,50);
pay('gx102','2026-04',1025,'','2026-04-03');
pay('gx103','2026-04',1100,'','2026-04-04');
pay('gx201','2026-04', 950,'','2026-04-03');  // Carlos — first month
pay('gx202','2026-04', 925,'','2026-04-04');

// May 2026
pay('gw1a','2026-05',1250,'','2026-05-02');
pay('gw1b','2026-05', 925,'','2026-05-03');  // Priya — first month
pay('gw2a','2026-05',1100,'','2026-05-03');
pay('gw2b','2026-05',1100,'','2026-05-05');
pay('gw3a','2026-05', 950,'','2026-05-05');
pay('gx101','2026-05', 975,'','2026-05-11',10,50);
pay('gx102','2026-05',1025,'','2026-05-04');
pay('gx103','2026-05', 600,'Partial — balance owed','2026-05-05'); // Tom partial
pay('gx201','2026-05', 950,'','2026-05-03');
pay('gx202','2026-05', 925,'','2026-05-04');

// ── Expenses ──────────────────────────────────────────────────────────────────
const insE = db.prepare(
  'INSERT INTO expenses (id,building,category,month,amount,miles,description,staff_id,created,hours) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
function exp(bld, cat, month, amount, desc, staffId=null, hours=null) {
  insE.run(uid(), bld, cat, month, amount, null, desc, staffId, month+'-01', hours);
}

const MONTHS = ['2026-01','2026-02','2026-03','2026-04','2026-05'];

// Recurring monthly
MONTHS.forEach(mo => {
  exp('Goodwin','insurance',       mo, 435, 'Building insurance');
  exp('Galaxy', 'insurance',       mo, 395, 'Building insurance');
  exp('Goodwin','management_fees', mo, 275, 'Management fee');
  exp('Galaxy', 'management_fees', mo, 275, 'Management fee');
  exp('Goodwin','utilities',       mo, 190, 'Water & trash');
  exp('Galaxy', 'utilities',       mo, 215, 'Water & trash');
  exp('Goodwin','salaries',        mo, 2200,'Rosa Mendez — Property Manager', S.rosa);
  exp('Galaxy', 'salaries',        mo, 1600,'Devon Hall — Maintenance',       S.devon);
});

// Willy — hourly pay recorded per month
// Jan 28 hrs × $16.50 = $462
exp('Galaxy,Goodwin','salaries','2026-01',462,  'Willy Torres — Maintenance', S.willy, 28);
// Feb 52 hrs × $16.50 = $858
exp('Galaxy,Goodwin','salaries','2026-02',858,  'Willy Torres — Maintenance', S.willy, 52);
// Mar 32 hrs × $16.50 = $528
exp('Galaxy,Goodwin','salaries','2026-03',528,  'Willy Torres — Maintenance', S.willy, 32);
// Apr 40 hrs × $16.50 = $660
exp('Galaxy,Goodwin','salaries','2026-04',660,  'Willy Torres — Maintenance', S.willy, 40);
// May partial — 15 hrs × $16.50 = $247.50 paid so far (9 hrs still owed)
exp('Galaxy,Goodwin','salaries','2026-05',247.50,'Willy Torres — Maintenance', S.willy, 15);

// Variable — January
exp('Galaxy', 'legal_professional','2026-01', 500,'Lease review — attorney');
exp('Goodwin','supplies',          '2026-01',  75,'Cleaning supplies');
// Variable — February
exp('Goodwin','repairs',           '2026-02', 840,'Boiler service — annual');
exp('Galaxy', 'repairs',           '2026-02',1150,'Burst pipe repair — Unit 103');
// Variable — March
exp('Galaxy', 'advertising',       '2026-03',  95,'Zillow listing — Unit 201 vacancy');
exp('Goodwin','repairs',           '2026-03', 320,'Drywall patch — Unit 2B');
// Variable — April
exp('Goodwin','advertising',       '2026-04',  80,'Facebook ad — Unit 1B vacancy');
exp('Goodwin','cleaning_maintenance','2026-04',310,'Unit 1B turnover clean');
exp('Galaxy', 'repairs',           '2026-04', 460,'Appliance replacement — Unit 201');
// Variable — May
exp('Galaxy', 'repairs',           '2026-05', 225,'Door lock replacement — Unit 102');
exp('Goodwin','supplies',          '2026-05',  85,'Paint & touch-up supplies');

// ── Other Income ──────────────────────────────────────────────────────────────
const insOI = db.prepare(
  'INSERT INTO other_income (id,building,category,month,amount,description,created) VALUES (?,?,?,?,?,?,?)'
);
MONTHS.forEach(mo => {
  insOI.run(uid(),'Galaxy', 'laundry', mo,  85,'Laundry machine income',         mo+'-01');
  insOI.run(uid(),'Goodwin','parking', mo, 150,'Parking — Units 1A & 2A tenants',mo+'-01');
});

// ── Hours Log — Willy ─────────────────────────────────────────────────────────
const insHL = db.prepare(
  'INSERT INTO hours_log (id,staff_id,month,date,hours,note,created) VALUES (?,?,?,?,?,?,?)'
);
function hrs(mo, date, h, note) {
  insHL.run(uid(), S.willy, mo, date, h, note, date+'T12:00:00Z');
}

// January — 28 hrs total
hrs('2026-01','2026-01-06', 8,'Plumbing check — Galaxy 201');
hrs('2026-01','2026-01-08', 6,'Common area repairs — Goodwin');
hrs('2026-01','2026-01-19', 8,'Exterior walkway fix — Galaxy');
hrs('2026-01','2026-01-27', 6,'General maintenance call-outs');
// February — 52 hrs total
hrs('2026-02','2026-02-04',10,'Emergency pipe repair — Galaxy 103');
hrs('2026-02','2026-02-05',12,'Pipe follow-up & water damage cleanup — Galaxy 103');
hrs('2026-02','2026-02-11', 8,'Boiler check assist — Goodwin');
hrs('2026-02','2026-02-24',10,'Move-out inspection — Galaxy 201');
hrs('2026-02','2026-02-26',12,'Unit prep — Galaxy 201');
// March — 32 hrs total
hrs('2026-03','2026-03-09', 8,'Drywall repair assist — Goodwin 2B');
hrs('2026-03','2026-03-16', 8,'Unit 201 deep clean prep — Galaxy');
hrs('2026-03','2026-03-23', 8,'Landscaping & groundwork — Goodwin');
hrs('2026-03','2026-03-30', 8,'General maintenance');
// April — 40 hrs total
hrs('2026-04','2026-04-07',10,'Unit 1B turnover — Goodwin');
hrs('2026-04','2026-04-09', 8,'New tenant prep — Galaxy 201');
hrs('2026-04','2026-04-21',10,'HVAC filter replacements — all units');
hrs('2026-04','2026-04-23',12,'Exterior power wash — Galaxy');
// May — 24 hrs logged so far (15 paid, 9 still owed)
hrs('2026-05','2026-05-05', 8,'Lock replacement assist — Galaxy 102');
hrs('2026-05','2026-05-12', 8,'Routine inspections — Goodwin');
hrs('2026-05','2026-05-19', 8,'Landscaping — both buildings');

// ── Adjustments ───────────────────────────────────────────────────────────────
const insAdj = db.prepare(
  'INSERT INTO adjustments (id,room_id,period_id,type,amount,note,date,created) VALUES (?,?,?,?,?,?,?,?)'
);

// Goodwin 1B — charge $200 for carpet damage at Sam Ortiz move-out
insAdj.run(uid(), R.gw1b, P.gw1b_1, 'charge', 200,
  'Carpet damage — security deposit deduction', '2026-03-31','2026-03-31T12:00:00Z');

// Galaxy 201 — writeoff $125 cleaning cost not recovered from Mia Foster's deposit
insAdj.run(uid(), R.gx201, P.gx201_1, 'writeoff', 125,
  'Cleaning damage — uncollectable after deposit', '2026-02-28','2026-02-28T12:00:00Z');

console.log('✓ Database seeded successfully.');
db.close();
