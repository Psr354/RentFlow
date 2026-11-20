const path = require('node:path');
const fs = require('node:fs');

const PORT = parseInt(process.env.PORT, 10) || 5005;
const HOST = process.env.HOST || '0.0.0.0';
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASS || 'nekyuyun2026';

if (process.env.NODE_ENV === 'production' && (!process.env.APP_PASS || process.env.APP_PASS === 'nekyuyun2026')) {
    if (process.env.ALLOW_DEFAULT_PASS !== '1') {
        console.error('[FATAL SECURITY ERROR] Server berjalan dalam mode produksi dengan kata sandi bawaan! Segera konfigurasikan APP_PASS yang aman di environment variable.');
        process.exit(1);
    } else {
        console.warn('[SECURITY WARNING] Server berjalan dalam mode produksi dengan kata sandi bawaan karena ALLOW_DEFAULT_PASS=1!');
    }
}

const WA_WEBHOOK_SECRET = process.env.WA_WEBHOOK_SECRET || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync(path.join(__dirname, '../../data')) ? path.join(__dirname, '../../data') : path.join(__dirname, '../../'));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'kontrakan.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const WA_SESSION_DIR = path.join(DATA_DIR, 'wa_session');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, '../../public');

const MAX_BODY = 15 * 1024 * 1024; // 15MB
const BACKUP_RETENTION = 30;

module.exports = {
    PORT,
    HOST,
    APP_USER,
    APP_PASS,
    WA_WEBHOOK_SECRET,
    TRUST_PROXY,
    DATA_DIR,
    DB_PATH,
    UPLOAD_DIR,
    WA_SESSION_DIR,
    BACKUP_DIR,
    PUBLIC_DIR,
    MAX_BODY,
    BACKUP_RETENTION
};
