import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const db = new Database(path.join(__dirname, 'mka-planer.db'));
db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');

app.use(express.json());

/* =========================================================
   BAZA – FUNDAMENT MKA PLANER
   ========================================================= */

db.exec(`
CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_no TEXT DEFAULT '',
    name TEXT NOT NULL,
    night_allowed INTEGER DEFAULT 1,
    preference TEXT DEFAULT 'BEZ OGRANICZEŃ',
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    fixed_crew TEXT DEFAULT '',
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL,
    start_time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    kilometers REAL DEFAULT 0,
    vehicle_type TEXT DEFAULT 'BEZ OGRANICZENIA',
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL,
    service_number TEXT NOT NULL,
    driver TEXT DEFAULT '',
    vehicle TEXT DEFAULT '',
    status TEXT DEFAULT 'PLAN'
);

CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL,
    type TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    replacement_vehicle TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'OTWARTE'
);

CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT ''
);

/* STAŁA OBSADA – osobna tabela.
   Nie jest nadpisywana przez awarie/podmiany. */
CREATE TABLE IF NOT EXISTS crew_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    driver_id INTEGER NOT NULL,
    substitute_id INTEGER,
    valid_from TEXT DEFAULT '',
    valid_to TEXT DEFAULT '',
    active INTEGER DEFAULT 1
);

/* CZASOWE PODMIANY */
CREATE TABLE IF NOT EXISTS vehicle_replacements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL,
    vehicle_id INTEGER NOT NULL,
    replacement_vehicle_id INTEGER NOT NULL,
    service_number TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'AKTYWNA'
);

/* KONFIGURACJA PLANERA */
CREATE TABLE IF NOT EXISTS planner_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_days_week INTEGER DEFAULT 6,
    emergency_sixth_day INTEGER DEFAULT 1
);
`);

db.prepare(`
INSERT OR IGNORE INTO planner_settings
(id,max_days_week,emergency_sixth_day)
VALUES (1,6,1)
`).run();

/* =========================================================
   MIGRACJE DLA STAREJ BAZY
   ========================================================= */

function columnExists(table, column) {
    return db.prepare(`PRAGMA table_info(${table})`)
        .all()
        .some(x => x.name === column);
}

function addColumn(table, column, definition) {
    if (!columnExists(table, column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

addColumn('drivers', 'active', 'INTEGER DEFAULT 1');
addColumn('vehicles', 'active', 'INTEGER DEFAULT 1');
addColumn('services', 'active', 'INTEGER DEFAULT 1');
addColumn('assignments', 'status', "TEXT DEFAULT 'PLAN'");

/* =========================================================
   HISTORIA
   ========================================================= */

function audit(action, details = '') {
    db.prepare(`
        INSERT INTO audit(created_at,action,details)
        VALUES(datetime('now','localtime'),?,?)
    `).run(action, details);
}

/* =========================================================
   API – STAN
   ========================================================= */

app.get('/api/state', (req, res) => {
    const state = {
        drivers: db.prepare(`
            SELECT * FROM drivers
            ORDER BY active DESC, name
        `).all(),

        vehicles: db.prepare(`
            SELECT * FROM vehicles
            ORDER BY active DESC, number
        `).all(),

        services: db.prepare(`
            SELECT * FROM services
            ORDER BY active DESC, number
        `).all(),

        assignments: db.prepare(`
            SELECT * FROM assignments
            ORDER BY work_date DESC, service_number
        `).all(),

        incidents: db.prepare(`
            SELECT * FROM incidents
            ORDER BY work_date DESC, id DESC
        `).all(),

        crews: db.prepare(`
            SELECT
                c.*,
                v.number AS vehicle_number,
                v.type AS vehicle_type,
                d.name AS driver_name,
                s.name AS substitute_name
            FROM crew_assignments c
            JOIN vehicles v ON v.id = c.vehicle_id
            JOIN drivers d ON d.id = c.driver_id
            LEFT JOIN drivers s ON s.id = c.substitute_id
            ORDER BY c.active DESC, v.number
        `).all(),

        replacements: db.prepare(`
            SELECT
                r.*,
                v.number AS vehicle_number,
                rv.number AS replacement_vehicle_number
            FROM vehicle_replacements r
            JOIN vehicles v ON v.id = r.vehicle_id
            JOIN vehicles rv ON rv.id = r.replacement_vehicle_id
            ORDER BY r.work_date DESC, r.id DESC
        `).all(),

        audit: db.prepare(`
            SELECT * FROM audit
            ORDER BY id DESC
            LIMIT 500
        `).all(),

        settings: db.prepare(`
            SELECT * FROM planner_settings WHERE id=1
        `).get()
    };

    res.json(state);
});

/* =========================================================
   KIEROWCY
   ========================================================= */

app.post('/api/drivers', (req, res) => {
    const x = req.body;

    if (!x.name?.trim()) {
        return res.status(400).json({
            error: 'Podaj imię i nazwisko kierowcy'
        });
    }

    const result = db.prepare(`
        INSERT INTO drivers
        (employee_no,name,night_allowed,preference,active)
        VALUES (?,?,?,?,1)
    `).run(
        x.employee_no || '',
        x.name.trim(),
        x.night_allowed ? 1 : 0,
        x.preference || 'BEZ OGRANICZEŃ'
    );

    audit('DODANO KIEROWCĘ', x.name.trim());

    res.json({ ok: true, id: result.lastInsertRowid });
});

app.post('/api/drivers/:id/toggle', (req, res) => {
    const id = Number(req.params.id);

    const driver = db.prepare(`
        SELECT * FROM drivers WHERE id=?
    `).get(id);

    if (!driver) {
        return res.status(404).json({ error: 'Nie znaleziono kierowcy' });
    }

    const active = driver.active ? 0 : 1;

    db.prepare(`
        UPDATE drivers SET active=? WHERE id=?
    `).run(active, id);

    audit(
        active ? 'AKTYWOWANO KIEROWCĘ' : 'DEZAKTYWOWANO KIEROWCĘ',
        driver.name
    );

    res.json({ ok: true });
});

/* =========================================================
   TABOR
   ========================================================= */

app.post('/api/vehicles', (req, res) => {
    const x = req.body;

    if (!x.number?.trim()) {
        return res.status(400).json({
            error: 'Podaj numer wozu'
        });
    }

    try {
        const result = db.prepare(`
            INSERT INTO vehicles
            (number,type,fixed_crew,active)
            VALUES (?,?,?,1)
        `).run(
            x.number.trim(),
            x.type || 'D',
            x.fixed_crew || ''
        );

        audit(
            'DODANO WÓZ',
            `${x.number} / ${x.type || 'D'}`
        );

        res.json({
            ok: true,
            id: result.lastInsertRowid
        });

    } catch {
        res.status(400).json({
            error: 'Taki numer wozu już istnieje'
        });
    }
});

app.post('/api/vehicles/:id/toggle', (req, res) => {
    const id = Number(req.params.id);

    const vehicle = db.prepare(`
        SELECT * FROM vehicles WHERE id=?
    `).get(id);

    if (!vehicle) {
        return res.status(404).json({
            error: 'Nie znaleziono wozu'
        });
    }

    const active = vehicle.active ? 0 : 1;

    db.prepare(`
        UPDATE vehicles SET active=? WHERE id=?
    `).run(active, id);

    audit(
        active ? 'AKTYWOWANO WÓZ' : 'DEZAKTYWOWANO WÓZ',
        vehicle.number
    );

    res.json({ ok: true });
});

/* =========================================================
   SŁUŻBY
   ========================================================= */

app.post('/api/services', (req, res) => {
    const x = req.body;

    if (!x.number?.trim()) {
        return res.status(400).json({
            error: 'Podaj numer służby'
        });
    }

    const result = db.prepare(`
        INSERT INTO services
        (number,start_time,end_time,kilometers,vehicle_type,active)
        VALUES (?,?,?,?,?,1)
    `).run(
        x.number.trim(),
        x.start_time || '',
        x.end_time || '',
        Number(x.kilometers || 0),
        x.vehicle_type || 'BEZ OGRANICZENIA'
    );

    audit(
        'DODANO SŁUŻBĘ',
        x.number
    );

    res.json({
        ok: true,
        id: result.lastInsertRowid
    });
});

/* =========================================================
   STAŁA OBSADA
   ========================================================= */

app.post('/api/crews', (req, res) => {
    const x = req.body;

    if (!x.vehicle_id || !x.driver_id) {
        return res.status(400).json({
            error: 'Wybierz wóz i kierowcę'
        });
    }

    /* Jeden aktywny kierowca podstawowy na dany wóz */
    const existing = db.prepare(`
        SELECT id
        FROM crew_assignments
        WHERE vehicle_id=?
        AND active=1
    `).get(Number(x.vehicle_id));

    if (existing) {
        return res.status(400).json({
            error: 'Ten wóz ma już aktywną stałą obsadę'
        });
    }

    const result = db.prepare(`
        INSERT INTO crew_assignments
        (vehicle_id,driver_id,substitute_id,valid_from,valid_to,active)
        VALUES (?,?,?,?,?,1)
    `).run(
        Number(x.vehicle_id),
        Number(x.driver_id),
        x.substitute_id ? Number(x.substitute_id) : null,
        x.valid_from || '',
        x.valid_to || ''
    );

    const vehicle = db.prepare(`
        SELECT number FROM vehicles WHERE id=?
    `).get(Number(x.vehicle_id));

    audit(
        'DODANO STAŁĄ OBSADĘ',
        `Wóz ${vehicle?.number || ''}`
    );

    res.json({
        ok: true,
        id: result.lastInsertRowid
    });
});

app.post('/api/crews/:id/toggle', (req, res) => {
    const id = Number(req.params.id);

    const crew = db.prepare(`
        SELECT * FROM crew_assignments WHERE id=?
    `).get(id);

    if (!crew) {
        return res.status(404).json({
            error: 'Nie znaleziono obsady'
        });
    }

    const active = crew.active ? 0 : 1;

    db.prepare(`
        UPDATE crew_assignments SET active=? WHERE id=?
    `).run(active, id);

    audit(
        active
            ? 'AKTYWOWANO STAŁĄ OBSADĘ'
            : 'DEZAKTYWOWANO STAŁĄ OBSADĘ',
        `ID ${id}`
    );

    res.json({ ok: true });
});

/* =========================================================
   OBSADY DZIENNE
   ========================================================= */

app.post('/api/assignments', (req, res) => {
    const x = req.body;

    if (!x.work_date || !x.service_number) {
        return res.status(400).json({
            error: 'Data i numer służby są wymagane'
        });
    }

    const result = db.prepare(`
        INSERT INTO assignments
        (work_date,service_number,driver,vehicle,status)
        VALUES (?,?,?,?,?)
    `).run(
        x.work_date,
        x.service_number,
        x.driver || '',
        x.vehicle || '',
        x.status || 'PLAN'
    );

    audit(
        'ZAPISANO OBSADĘ DZIENNĄ',
        `${x.work_date} / ${x.service_number}`
    );

    res.json({
        ok: true,
        id: result.lastInsertRowid
    });
});

/* =========================================================
   PODMIANY WOZÓW
   ========================================================= */

app.post('/api/replacements', (req, res) => {
    const x = req.body;

    if (
        !x.work_date ||
        !x.vehicle_id ||
        !x.replacement_vehicle_id
    ) {
        return res.status(400).json({
            error: 'Data, wóz podstawowy i wóz zastępczy są wymagane'
        });
    }

    if (
        Number(x.vehicle_id) ===
        Number(x.replacement_vehicle_id)
    ) {
        return res.status(400).json({
            error: 'Wóz zastępczy musi być inny niż podstawowy'
        });
    }

    const result = db.prepare(`
        INSERT INTO vehicle_replacements
        (work_date,vehicle_id,replacement_vehicle_id,
         service_number,reason,status)
        VALUES (?,?,?,?,?,'AKTYWNA')
    `).run(
        x.work_date,
        Number(x.vehicle_id),
        Number(x.replacement_vehicle_id),
        x.service_number || '',
        x.reason || ''
    );

    audit(
        'CZASOWA PODMIANA WOZU',
        `${x.work_date} / ${x.vehicle_id} -> ${x.replacement_vehicle_id}`
    );

    res.json({
        ok: true,
        id: result.lastInsertRowid
    });
});

/* =========================================================
   AWARIE
   ========================================================= */

app.post('/api/incidents', (req, res) => {
    const x = req.body;

    if (!x.work_date || !x.vehicle) {
        return res.status(400).json({
            error: 'Data i numer wozu są wymagane'
        });
    }

    const result = db.prepare(`
        INSERT INTO incidents
        (work_date,type,vehicle,replacement_vehicle,
         description,status)
        VALUES (?,?,?,?,?,'OTWARTE')
    `).run(
        x.work_date,
        x.type || 'AWARIA',
        x.vehicle,
        x.replacement_vehicle || '',
        x.description || ''
    );

    audit(
        x.type || 'AWARIA',
        `${x.work_date} / wóz ${x.vehicle}`
    );

    res.json({
        ok: true,
        id: result.lastInsertRowid
    });
});

/* =========================================================
   USTAWIENIA PLANERA
   ========================================================= */

app.post('/api/settings', (req, res) => {
    const x = req.body;

    db.prepare(`
        UPDATE planner_settings
        SET max_days_week=?,
            emergency_sixth_day=?
        WHERE id=1
    `).run(
        Number(x.max_days_week || 6),
        x.emergency_sixth_day ? 1 : 0
    );

    audit(
        'ZMIENIONO USTAWIENIA PLANERA',
        `maks. dni: ${x.max_days_week}`
    );

    res.json({ ok: true });
});

/* =========================================================
   USUWANIE – TYLKO DANYCH OPERACYJNYCH
   Stałej historii kierowców/wozów nie kasujemy.
   ========================================================= */

app.patch('/api/drivers/:id', (req, res) => {
  const active = req.body.active ? 1 : 0;

  const result = db.prepare(
    'UPDATE drivers SET active=? WHERE id=?'
  ).run(active, req.params.id);

  if (!result.changes) {
    return res.status(404).json({
      error: 'Nie znaleziono kierowcy'
    });
  }

  audit(
    active ? 'AKTYWOWANO KIEROWCĘ' : 'DEZAKTYWOWANO KIEROWCĘ',
    'ID kierowcy: ' + req.params.id
  );

  res.json({ ok: true });
});
app.delete('/api/:table/:id', (req, res) => {
    const allowed = [
        'services',
        'assignments',
        'incidents',
        'vehicle_replacements'
    ];

    const table = req.params.table;

    if (!allowed.includes(table)) {
        return res.status(400).json({
            error: 'Ten rekord nie może być kasowany'
        });
    }

    db.prepare(`
        DELETE FROM ${table} WHERE id=?
    `).run(Number(req.params.id));

    audit(
        'USUNIĘTO REKORD',
        `${table} / ${req.params.id}`
    );

    res.json({ ok: true });
});

/* =========================================================
   INTERFEJS
   ========================================================= */

const page = String.raw`
<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>MKA PLANER</title>

<style>

*{
    box-sizing:border-box
}

body{
    margin:0;
    font-family:system-ui,-apple-system,sans-serif;
    background:#eef1f4;
    color:#18212b
}

header{
    background:#17212b;
    color:white;
    padding:16px;
    font-size:22px;
    font-weight:800
}

nav{
    background:white;
    padding:8px;
    display:flex;
    gap:6px;
    overflow:auto;
    position:sticky;
    top:0;
    z-index:5;
    border-bottom:1px solid #d7dde2
}

nav button{
    padding:11px 14px;
    border:0;
    border-radius:8px;
    font-weight:700;
    white-space:nowrap;
    background:#e7eaed
}

nav button.on{
    background:#1769aa;
    color:white
}

main{
    max-width:1250px;
    margin:auto;
    padding:12px
}

.card{
    background:white;
    border:1px solid #d7dde2;
    border-radius:12px;
    padding:15px;
    margin-bottom:12px
}

.grid{
    display:grid;
    grid-template-columns:
    repeat(auto-fit,minmax(180px,1fr));
    gap:10px
}

label{
    font-size:13px;
    font-weight:700;
    display:flex;
    flex-direction:column;
    gap:5px
}

input,select{
    padding:11px;
    border:1px solid #b8c2c9;
    border-radius:7px;
    font:inherit;
    width:100%
}

.act{
    margin-top:12px;
    padding:11px 15px;
    background:#1769aa;
    color:white;
    border:0;
    border-radius:8px;
    font-weight:800
}

.secondary{
    background:#4c5963
}

.danger{
    background:#b42318;
    color:white;
    border:0;
    border-radius:6px;
    padding:7px 9px
}

.ok{
    background:#16834b;
    color:white;
    border:0;
    border-radius:6px;
    padding:7px 9px
}

table{
    width:100%;
    border-collapse:collapse;
    overflow:auto;
    display:block;
    margin-top:14px
}

th,td{
    padding:8px;
    border-bottom:1px solid #e0e4e7;
    text-align:left;
    white-space:nowrap
}

th{
    background:#f1f3f5
}

.kpis{
    display:grid;
    grid-template-columns:
    repeat(auto-fit,minmax(140px,1fr));
    gap:10px
}

.kpi{
    background:white;
    border:1px solid #d7dde2;
    border-radius:10px;
    padding:14px
}

.kpi b{
    display:block;
    font-size:29px
}

.badge{
    display:inline-block;
    padding:4px 7px;
    border-radius:6px;
    background:#e7eaed;
    font-size:12px;
    font-weight:700
}

h1{
    margin-top:4px
}

.small{
    font-size:13px;
    color:#59636d
}

</style>
</head>

<body>

<header>🚌 MKA PLANER</header>

<nav id="nav"></nav>

<main id="app"></main>

<script>

const pages=[
    ['dashboard','🏠 Pulpit'],
    ['drivers','👤 Kierowcy'],
    ['vehicles','🚌 Tabor'],
    ['crews','👥 Stałe obsady'],
    ['services','📋 Służby'],
    ['assignments','📅 Grafik'],
    ['replacements','🔄 Podmiany'],
    ['incidents','🚨 Awarie'],
    ['audit','📖 Historia']
];

let S={};
let P='dashboard';

const E=x=>String(x??'')
.replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
}[c]));

async function api(url,options){
    const r=await fetch(url,options);
    const j=await r.json().catch(()=>({}));

    if(!r.ok){
        throw Error(j.error || 'Błąd');
    }

    return j;
}

async function load(){
    S=await api('/api/state');
    render();
}

function go(page){
    P=page;
    render();
}

function nav(){
    document.getElementById('nav').innerHTML=
        pages.map(x=>`
        <button
            class="${x[0]===P?'on':''}"
            onclick="go('${x[0]}')">
            ${x[1]}
        </button>
        `).join('');
}

function T(headers,rows){
    return `
    <table>
        <thead>
            <tr>
                ${headers.map(x=>`<th>${x}</th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>`;
}

function button(text,fn,cls='act'){
    return `<button class="${cls}" onclick="${fn}">${text}</button>`;
}

async function run(fn){
    try{
        await fn();
        await load();
    }catch(e){
        alert(e.message);
    }
}

/* =========================================================
   RENDER
   ========================================================= */

function render(){

    nav();

    const a=document.getElementById('app');

    /* PULPIT */

    if(P==='dashboard'){

        const activeDrivers=
            S.drivers?.filter(x=>x.active).length||0;

        const activeVehicles=
            S.vehicles?.filter(x=>x.active).length||0;

        const activeServices=
            S.services?.filter(x=>x.active).length||0;

        const activeCrews=
            S.crews?.filter(x=>x.active).length||0;

        a.innerHTML=`

        <div class="card">
            <h1>Pulpit operacyjny</h1>
            <p>
                Fundament MKA PLANER.
                Stała obsada jest oddzielona od czasowych podmian.
            </p>
        </div>

        <div class="kpis">

            <div class="kpi">
                <b>${activeDrivers}</b>
                Kierowców
            </div>

            <div class="kpi">
                <b>${activeVehicles}</b>
                Aktywnych wozów
            </div>

            <div class="kpi">
                <b>${activeServices}</b>
                Służb
            </div>

            <div class="kpi">
                <b>${activeCrews}</b>
                Stałych obsad
            </div>

            <div class="kpi">
                <b>${S.assignments?.length||0}</b>
                Zapisanych obsad
            </div>

        </div>

        <div class="card">
            <h2>⚙️ Zasady planera</h2>
            <p>
                Maksymalnie dni w tygodniu:
                <strong>${S.settings?.max_days_week||6}</strong>
            </p>
            <p>
                Szósty dzień:
                <strong>
                ${S.settings?.emergency_sixth_day?'AWARYJNY':'WYŁĄCZONY'}
                </strong>
            </p>
        </div>
        `;
    }

    /* KIEROWCY */

    if(P==='drivers'){

        a.innerHTML=`

        <div class="card">

        <h1>👤 Kierowcy</h1>

        <div class="grid">

            <label>
                Nr pracownika
                <input id="dn">
            </label>

            <label>
                Imię i nazwisko
                <input id="dname">
            </label>

            <label>
                Noc
                <select id="dnight">
                    <option value="1">TAK</option>
                    <option value="0">NIE</option>
                </select>
            </label>

            <label>
                Preferencja
                <select id="dpref">
                    <option>BEZ OGRANICZEŃ</option>
                    <option>RANO</option>
                    <option>POPOŁUDNIE</option>
                    <option>NOC</option>
                </select>
            </label>

        </div>

        ${button(
            'DODAJ KIEROWCĘ',
            'addDriver()'
        )}

        ${T(
            ['Nr','Kierowca','Noc','Preferencja','Status',''],
            (S.drivers||[]).map(x=>`
            <tr>
                <td>${E(x.employee_no)}</td>
                <td>${E(x.name)}</td>
                <td>${x.night_allowed?'TAK':'NIE'}</td>
                <td>${E(x.preference)}</td>
                <td>
                    <span class="badge">
                    ${x.active?'AKTYWNY':'NIEAKTYWNY'}
                    </span>
                </td>
                <td>
                    ${button(
                        x.active?'DEZAKTYWUJ':'AKTYWUJ',
                        `toggleDriver(${x.id})`,
                        x.active?'danger':'ok'
                    )}
                </td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* TABOR */

    if(P==='vehicles'){

        a.innerHTML=`

        <div class="card">

        <h1>🚌 Tabor</h1>

        <div class="grid">

            <label>
                Numer
                <input id="vn">
            </label>

            <label>
                Typ
                <select id="vt">
                    <option>E</option>
                    <option>P</option>
                    <option>C</option>
                    <option>D</option>
                    <option>HYBRYD</option>
                </select>
            </label>

            <label>
                Stała obsada – opis
                <input id="vc">
            </label>

        </div>

        ${button(
            'DODAJ WÓZ',
            'addVehicle()'
        )}

        ${T(
            ['Wóz','Typ','Opis','Status',''],
            (S.vehicles||[]).map(x=>`
            <tr>
                <td>${E(x.number)}</td>
                <td>${E(x.type)}</td>
                <td>${E(x.fixed_crew)}</td>
                <td>
                    <span class="badge">
                    ${x.active?'AKTYWNY':'NIEAKTYWNY'}
                    </span>
                </td>
                <td>
                    ${button(
                        x.active?'DEZAKTYWUJ':'AKTYWUJ',
                        `toggleVehicle(${x.id})`,
                        x.active?'danger':'ok'
                    )}
                </td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* STAŁE OBSADY */

    if(P==='crews'){

        const activeVehicles=
            (S.vehicles||[]).filter(x=>x.active);

        const activeDrivers=
            (S.drivers||[]).filter(x=>x.active);

        a.innerHTML=`

        <div class="card">

        <h1>👥 Stałe obsady</h1>

        <p class="small">
            To jest podstawowa obsada wozu.
            Awaria lub podmiana nie zmienia tej informacji.
        </p>

        <div class="grid">

            <label>
                Wóz
                <select id="cv">
                    <option value="">-- wybierz --</option>
                    ${activeVehicles.map(x=>`
                    <option value="${x.id}">
                        ${E(x.number)} – ${E(x.type)}
                    </option>
                    `).join('')}
                </select>
            </label>

            <label>
                Kierowca podstawowy
                <select id="cd">
                    <option value="">-- wybierz --</option>
                    ${activeDrivers.map(x=>`
                    <option value="${x.id}">
                        ${E(x.name)}
                    </option>
                    `).join('')}
                </select>
            </label>

            <label>
                Zmiennik
                <select id="cs">
                    <option value="">BRAK</option>
                    ${activeDrivers.map(x=>`
                    <option value="${x.id}">
                        ${E(x.name)}
                    </option>
                    `).join('')}
                </select>
            </label>

            <label>
                Od
                <input id="cfrom" type="date">
            </label>

            <label>
                Do
                <input id="cto" type="date">
            </label>

        </div>

        ${button(
            'DODAJ STAŁĄ OBSADĘ',
            'addCrew()'
        )}

        ${T(
            ['Wóz','Typ','Kierowca','Zmiennik','Od','Do','Status',''],
            (S.crews||[]).map(x=>`
            <tr>
                <td>${E(x.vehicle_number)}</td>
                <td>${E(x.vehicle_type)}</td>
                <td>${E(x.driver_name)}</td>
                <td>${E(x.substitute_name||'BRAK')}</td>
                <td>${E(x.valid_from)}</td>
                <td>${E(x.valid_to)}</td>
                <td>
                    <span class="badge">
                    ${x.active?'AKTYWNA':'NIEAKTYWNA'}
                    </span>
                </td>
                <td>
                    ${button(
                        x.active?'DEZAKTYWUJ':'AKTYWUJ',
                        `toggleCrew(${x.id})`,
                        x.active?'danger':'ok'
                    )}
                </td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* SŁUŻBY */

    if(P==='services'){

        a.innerHTML=`

        <div class="card">

        <h1>📋 Służby</h1>

        <div class="grid">

            <label>
                Nr służby
                <input id="sn">
            </label>

            <label>
                Od
                <input id="sf" type="time">
            </label>

            <label>
                Do
                <input id="st" type="time">
            </label>

            <label>
                Kilometry
                <input id="sk" type="number" step="0.1">
            </label>

            <label>
                Typ taboru
                <select id="sv">
                    <option>BEZ OGRANICZENIA</option>
                    <option>E</option>
                    <option>P</option>
                    <option>C</option>
                    <option>D</option>
                    <option>HYBRYD</option>
                </select>
            </label>

        </div>

        ${button(
            'DODAJ SŁUŻBĘ',
            'addService()'
        )}

        ${T(
            ['Służba','Od','Do','km','Typ'],
            (S.services||[]).map(x=>`
            <tr>
                <td>${E(x.number)}</td>
                <td>${E(x.start_time)}</td>
                <td>${E(x.end_time)}</td>
                <td>${E(x.kilometers)}</td>
                <td>${E(x.vehicle_type)}</td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* GRAFIK */

    if(P==='assignments'){

        a.innerHTML=`

        <div class="card">

        <h1>📅 Grafik dzienny</h1>

        <div class="grid">

            <label>
                Data
                <input id="ad" type="date">
            </label>

            <label>
                Nr służby
                <input id="as">
            </label>

            <label>
                Kierowca
                <input id="adr">
            </label>

            <label>
                Wóz
                <input id="av">
            </label>

        </div>

        ${button(
            'ZAPISZ OBSADĘ',
            'addAssignment()'
        )}

        ${T(
            ['Data','Służba','Kierowca','Wóz','Status',''],
            (S.assignments||[]).map(x=>`
            <tr>
                <td>${E(x.work_date)}</td>
                <td>${E(x.service_number)}</td>
                <td>${E(x.driver)}</td>
                <td>${E(x.vehicle)}</td>
                <td>${E(x.status)}</td>
                <td>
                    ${button(
                        'USUŃ',
                        `delRecord('assignments',${x.id})`,
                        'danger'
                    )}
                </td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* PODMIANY */

    if(P==='replacements'){

        const vehicles=
            (S.vehicles||[]).filter(x=>x.active);

        a.innerHTML=`

        <div class="card">

        <h1>🔄 Czasowe podmiany</h1>

        <p class="small">
            Podmiana jest zapisem operacyjnym.
            Nie zmienia stałej obsady wozu.
        </p>

        <div class="grid">

            <label>
                Data
                <input id="rd" type="date">
            </label>

            <label>
                Wóz podstawowy
                <select id="rv">
                    <option value="">-- wybierz --</option>
                    ${vehicles.map(x=>`
                    <option value="${x.id}">
                        ${E(x.number)}
                    </option>
                    `).join('')}
                </select>
            </label>

            <label>
                Wóz zastępczy
                <select id="rr">
                    <option value="">-- wybierz --</option>
                    ${vehicles.map(x=>`
                    <option value="${x.id}">
                        ${E(x.number)}
                    </option>
                    `).join('')}
                </select>
            </label>

            <label>
                Nr służby
                <input id="rs">
            </label>

            <label>
                Powód
                <input id="rx">
            </label>

        </div>

        ${button(
            'ZAPISZ PODMIANĘ',
            'addReplacement()'
        )}

        ${T(
            ['Data','Wóz','Zastępczy','Służba','Powód','Status'],
            (S.replacements||[]).map(x=>`
            <tr>
                <td>${E(x.work_date)}</td>
                <td>${E(x.vehicle_number)}</td>
                <td>${E(x.replacement_vehicle_number)}</td>
                <td>${E(x.service_number)}</td>
                <td>${E(x.reason)}</td>
                <td>${E(x.status)}</td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* AWARIE */

    if(P==='incidents'){

        a.innerHTML=`

        <div class="card">

        <h1>🚨 Awarie</h1>

        <div class="grid">

            <label>
                Data
                <input id="id" type="date">
            </label>

            <label>
                Typ
                <select id="it">
                    <option>AWARIA</option>
                    <option>USTERKA</option>
                    <option>ALERT</option>
                </select>
            </label>

            <label>
                Wóz
                <input id="iv">
            </label>

            <label>
                Wóz zastępczy
                <input id="ir">
            </label>

            <label>
                Opis
                <input id="ix">
            </label>

        </div>

        ${button(
            'ZAPISZ AWARIĘ',
            'addIncident()'
        )}

        ${T(
            ['Data','Typ','Wóz','Zastępczy','Opis','Status'],
            (S.incidents||[]).map(x=>`
            <tr>
                <td>${E(x.work_date)}</td>
                <td>${E(x.type)}</td>
                <td>${E(x.vehicle)}</td>
                <td>${E(x.replacement_vehicle)}</td>
                <td>${E(x.description)}</td>
                <td>${E(x.status)}</td>
            </tr>
            `).join('')
        )}

        </div>`;
    }

    /* HISTORIA */

    if(P==='audit'){

        a.innerHTML=`

        <div class="card">

        <h1>📖 Historia zmian</h1>

        ${T(
            ['Czas','Operacja','Szczegóły'],
            (S.audit||[]).map(x=>`
            <tr>
                <td>${E(x.created_at)}</td>
                <td>${E(x.action)}</td>
                <td>${E(x.details)}</td>
            </tr>
            `).join('')
        )}

        </div>`;
    }
}

/* =========================================================
   FUNKCJE FORMULARZY
   ========================================================= */

function addDriver(){

    run(()=>api('/api/drivers',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            employee_no:dn.value,
            name:dname.value,
            night_allowed:dnight.value==='1',
            preference:dpref.value
        })
    }));
}

function toggleDriver(id){

    run(()=>api('/api/drivers/'+id+'/toggle',{
        method:'POST'
    }));
}

function addVehicle(){

    run(()=>api('/api/vehicles',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            number:vn.value,
            type:vt.value,
            fixed_crew:vc.value
        })
    }));
}

function toggleVehicle(id){

    run(()=>api('/api/vehicles/'+id+'/toggle',{
        method:'POST'
    }));
}

function addCrew(){

    run(()=>api('/api/crews',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            vehicle_id:cv.value,
            driver_id:cd.value,
            substitute_id:cs.value,
            valid_from:cfrom.value,
            valid_to:cto.value
        })
    }));
}

function toggleCrew(id){

    run(()=>api('/api/crews/'+id+'/toggle',{
        method:'POST'
    }));
}

function addService(){

    run(()=>api('/api/services',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            number:sn.value,
            start_time:sf.value,
            end_time:st.value,
            kilometers:sk.value,
            vehicle_type:sv.value
        })
    }));
}

function addAssignment(){

    run(()=>api('/api/assignments',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            work_date:ad.value,
            service_number:as.value,
            driver:adr.value,
            vehicle:av.value
        })
    }));
}

function addReplacement(){

    run(()=>api('/api/replacements',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            work_date:rd.value,
            vehicle_id:rv.value,
            replacement_vehicle_id:rr.value,
            service_number:rs.value,
            reason:rx.value
        })
    }));
}

function addIncident(){

    run(()=>api('/api/incidents',{
        method:'POST',
        headers:{
            'Content-Type':'application/json'
        },
        body:JSON.stringify({
            work_date:id.value,
            type:it.value,
            vehicle:iv.value,
            replacement_vehicle:ir.value,
            description:ix.value
        })
    }));
}

function delRecord(table,id){

    run(()=>api(
        '/api/'+table+'/'+id,
        {method:'DELETE'}
    ));
}

/* START */

load();

</script>

</main>
</body>
</html>
`;

app.get('/', (req,res)=>{
    res.type('html').send(page);
});

app.listen(
    process.env.PORT || 3000,
    '0.0.0.0',
    ()=>{
        console.log('MKA PLANER ready');
    }
);
