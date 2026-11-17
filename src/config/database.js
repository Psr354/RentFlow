const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, UPLOAD_DIR, WA_SESSION_DIR, BACKUP_DIR } = require('./env');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(WA_SESSION_DIR)) fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Inisialisasi Database SQLite dengan WAL & Foreign Keys
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Skema Basis Data Terpadu
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'Standard',
    price INTEGER NOT NULL DEFAULT 800000,
    status TEXT NOT NULL DEFAULT 'KOSONG',
    tenant_name TEXT,
    tenant_phone TEXT,
    tenant_email TEXT,
    due_day INTEGER DEFAULT 1,
    entry_date TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    month_year TEXT NOT NULL,
    amount INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BELUM_BAYAR',
    payment_method TEXT,
    payment_proof TEXT,
    paid_at TEXT,
    notified_h3 INTEGER DEFAULT 0,
    notified_h1 INTEGER DEFAULT 0,
    notified_h0 INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    payment_method TEXT NOT NULL DEFAULT 'TRANSFER',
    payment_date TEXT NOT NULL,
    payment_proof TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS notification_logs (
    id TEXT PRIMARY KEY,
    invoice_id TEXT,
    channel TEXT,
    recipient TEXT,
    status TEXT,
    message TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    tenant_name TEXT,
    tenant_phone TEXT,
    category TEXT NOT NULL DEFAULT 'Fasilitas',
    description TEXT NOT NULL,
    photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'BARU',
    admin_notes TEXT,
    created_at TEXT,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
    month TEXT PRIMARY KEY,
    amount INTEGER NOT NULL CHECK(amount > 0)
);

CREATE TABLE IF NOT EXISTS general_incomes (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Lainnya',
    amount INTEGER NOT NULL CHECK(amount > 0),
    note TEXT,
    created_at TEXT NOT NULL
);

-- Indeks Kinerja Kueri Produksi
CREATE INDEX IF NOT EXISTS idx_invoice_payments_inv ON invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_date ON invoice_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_general_incomes_date ON general_incomes(date);
CREATE INDEX IF NOT EXISTS idx_invoices_room_id ON invoices(room_id);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_access_token ON invoices(access_token);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_complaints_room_id ON complaints(room_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
`);

// Migrasi penambahan access_token pada tabel invoices jika belum ada
try {
    db.exec('ALTER TABLE invoices ADD COLUMN access_token TEXT;');
} catch (_) {}

function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
        result[row.key] = row.value;
    }
    return result;
}

function setSetting(key, value) {
    db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

// Inisialisasi pengaturan bawaan jika tabel settings kosong
const existingSettings = getSettings();
const defaultSettings = {
    app_name: 'Kontrakan Nenek Yuyun',
    owner_name: 'Ibu Hj. Yuyun',
    owner_phone: '08812552006',
    bank_name: 'BCA',
    bank_account: '1234567890',
    bank_holder: 'Nenek Yuyun',
    monthly_fee: '800000',
    due_day: '1',
    reminder_h3: '1',
    reminder_h1: '1',
    reminder_h0: '1',
    reminder_h_plus: '1',
    auto_billing: '1',
    wa_group_id: '',
    base_url: 'http://localhost:5005'
};

for (const [k, v] of Object.entries(defaultSettings)) {
    if (existingSettings[k] === undefined) {
        setSetting(k, v);
    }
}

module.exports = {
    db,
    getSettings,
    setSetting
};
