const http = require('node:http');
const { handleRequest } = require('./routes/index');
const { db } = require('./config/database');

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
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
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Internal Server Error: ' + err.message }));
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
