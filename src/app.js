const http = require('node:http');
const { handleRequest } = require('./routes/index');
const { db } = require('./config/database');

function isTrustedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return host === 'localhost' || 
            host === '127.0.0.1' || 
            host === 'sekeluarga.web.id' ||
            host.startsWith('192.168.') ||
            host.startsWith('10.') ||
            host.startsWith('172.');
    } catch (_) {
        return false;
    }
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const reqUrl = req.url || '';
    if (origin) {
        if (reqUrl.startsWith('/api/public/')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
        } else if (isTrustedOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    try {
        await handleRequest(req, res);
    } catch (err) {
        console.error('[HTTP Server Error]', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Internal Server Error' }));
        }
    }
});

function handleGracefulShutdown(signal) {
    console.log(`[Server] Menerima sinyal ${signal}. Menutup koneksi dan melakukan checkpoint database...`);
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        console.log('[SQLite] WAL Checkpoint selesai.');
    } catch (err) {
        console.error('[SQLite] Gagal checkpoint saat shutdown:', err.message);
    }
    server.close(() => {
        console.log('[Server] HTTP server berhasil dihentikan.');
        process.exit(0);
    });
    setTimeout(() => {
        console.warn('[Server] Memaksa penghentian proses setelah timeout.');
        process.exit(0);
    }, 5000).unref();
}

module.exports = {
    server,
    handleGracefulShutdown
};
