const http = require('node:http');
const net = require('node:net');
const { handleRequest } = require('./routes/index');
const { db } = require('./config/database');

function isPrivateIpv4(ip) {
    if (!net.isIPv4(ip)) return false;
    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    return false;
}

function isTrustedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === 'sekeluarga.web.id') return true;
        if (process.env.ALLOWED_ORIGINS) {
            const allowed = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase());
            if (allowed.includes(host)) return true;
        }
        return isPrivateIpv4(host);
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
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self' data:; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self'; frame-ancestors 'self';");

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
