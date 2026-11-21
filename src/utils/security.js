const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSettings, setSetting } = require('../config/database');
const { UPLOAD_DIR, MAX_BODY, APP_USER } = require('../config/env');

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function constantTimeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

// Autentikasi Admin Berbasis Token Kriptografis (HMAC-SHA256)
let JWT_SECRET = process.env.JWT_SECRET || getSettings().jwt_secret;
if (!JWT_SECRET) {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    setSetting('jwt_secret', JWT_SECRET);
}

// Rahasia Webhook WhatsApp Eksternal
let WA_WEBHOOK_SECRET = process.env.WA_WEBHOOK_SECRET || getSettings().wa_webhook_secret;
if (!WA_WEBHOOK_SECRET) {
    WA_WEBHOOK_SECRET = crypto.randomBytes(24).toString('hex');
    setSetting('wa_webhook_secret', WA_WEBHOOK_SECRET);
}

function verifyWebhookSecret(req) {
    let incomingSecret = null;
    if (req.headers && req.headers['x-webhook-secret']) {
        incomingSecret = String(req.headers['x-webhook-secret']).trim();
    }
    if (!incomingSecret && req.url) {
        try {
            const parsedUrl = new URL(req.url, 'http://localhost');
            incomingSecret = parsedUrl.searchParams.get('secret');
        } catch (_) {}
    }
    if (!incomingSecret) return false;
    const bIncoming = Buffer.from(incomingSecret);
    const bExpected = Buffer.from(WA_WEBHOOK_SECRET);
    if (bIncoming.length !== bExpected.length) return false;
    return crypto.timingSafeEqual(bIncoming, bExpected);
}

function getClientIp(req) {
    const remote = req.socket?.remoteAddress || '127.0.0.1';
    const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
    if (trustProxy && req.headers) {
        let isTrusted = false;
        if (process.env.TRUSTED_PROXY_IPS) {
            const list = process.env.TRUSTED_PROXY_IPS.split(',').map(s => s.trim()).filter(Boolean);
            isTrusted = list.includes(remote);
        } else {
            // Jika TRUSTED_PROXY_IPS tidak didefinisikan secara eksplisit,
            // hanya percayai loopback lokal (127.0.0.1, ::1) untuk mencegah bypass rate-limit
            // melalui gateway bridge Docker (misal 172.17.0.1) saat port dipublish ke publik.
            isTrusted = remote === '127.0.0.1' ||
                remote === '::1' ||
                remote === '::ffff:127.0.0.1';
        }

        if (isTrusted) {
            const xff = req.headers['x-forwarded-for'];
            if (xff) {
                const first = String(xff).split(',')[0].trim();
                if (first) return first;
            }
            const realIp = req.headers['x-real-ip'];
            if (realIp) return String(realIp).trim();
        }
    }
    return remote;
}

function createAuthToken(username, scope = 'admin', expiresInMs = (14 * 24 * 60 * 60 * 1000)) {
    const payload = JSON.stringify({
        u: username,
        scope: scope,
        exp: Date.now() + expiresInMs
    });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
}

const tokens = new Map();

function isAuthed(req, requiredScope = 'admin') {
    const authHeader = req.headers?.authorization;
    let token = null;
    let isFromQuery = false;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    }
    // Hanya izinkan token query param untuk scope non-admin (misal 'export')
    if (!token && requiredScope !== 'admin') {
        if (req.query && req.query.token) {
            token = req.query.token;
            isFromQuery = true;
        } else if (req.url) {
            try {
                const parsedUrl = new URL(req.url, 'http://localhost');
                token = parsedUrl.searchParams.get('token');
                if (token) isFromQuery = true;
            } catch (_) {}
        }
    }
    if (!token) return false;

    // 1. Cek HMAC Token Persisten
    if (token.includes('.')) {
        const parts = token.split('.');
        if (parts.length === 2) {
            const [b64, sig] = parts;
            const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
            const bSig = Buffer.from(sig);
            const bExp = Buffer.from(expectedSig);
            if (bSig.length === bExp.length && crypto.timingSafeEqual(bSig, bExp)) {
                try {
                    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
                    if (payload.exp && Date.now() < payload.exp) {
                        const tokenScope = payload.scope || (payload.u === APP_USER ? 'admin' : 'unknown');
                        if (requiredScope === 'admin') {
                            return tokenScope === 'admin' && payload.u === APP_USER;
                        }
                        if (requiredScope === 'export') {
                            if (isFromQuery) {
                                return tokenScope === 'export';
                            }
                            return tokenScope === 'export' || (tokenScope === 'admin' && payload.u === APP_USER);
                        }
                        return tokenScope === requiredScope;
                    }
                } catch (_) {}
            }
        }
    }

    // 2. Fallback Token InMemory
    if (requiredScope === 'admin' && tokens.has(token)) {
        if (Date.now() < tokens.get(token)) return true;
        tokens.delete(token);
    }
    return false;
}

// In-Memory Rate Limiter Sederhana & Aman
const rateLimitMap = new Map();
function checkRateLimit(ip, endpointKey, maxRequests, windowMs) {
    const key = `${ip || 'unknown'}:${endpointKey}`;
    const now = Date.now();
    let record = rateLimitMap.get(key);
    if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + windowMs };
        rateLimitMap.set(key, record);
        return true;
    }
    record.count++;
    if (record.count > maxRequests) {
        return false;
    }
    return true;
}

const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitMap.entries()) {
        if (now > v.resetTime) rateLimitMap.delete(k);
    }
}, 5 * 60 * 1000);
rateLimitCleanupTimer.unref();

// Helper Validasi dan Penyimpanan Gambar Base64 Aman
function saveBase64Image(dataUri, prefix) {
    if (!dataUri || typeof dataUri !== 'string') return null;
    const matches = dataUri.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
    if (!matches) return null;

    const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : matches[1].toLowerCase();
    const base64Data = matches[2];
    let buffer;
    try {
        buffer = Buffer.from(base64Data, 'base64');
    } catch (_) {
        return null;
    }

    if (buffer.length > 10 * 1024 * 1024) return null; // Maksimal 10MB

    const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isPng = buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isWebp = buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';

    if (!isJpeg && !isPng && !isWebp) return null;

    const safeId = crypto.randomBytes(8).toString('hex');
    const fileName = `${prefix}_${Date.now()}_${safeId}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return `/uploads/${fileName}`;
}

function maskTenantName(name) {
    if (!name || typeof name !== 'string') return 'Penghuni';
    const parts = name.trim().split(/\s+/);
    if (parts.length <= 1) return parts[0];
    return `${parts[0]} ***`;
}

function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
            req.destroy();
            return send(res, 413, { success: false, message: 'Payload terlalu besar (Maks 15MB)' });
        }
        body += chunk.toString();
    });
    req.on('end', () => cb(body));
    req.on('error', () => send(res, 400, { success: false, message: 'Bad Request' }));
}

function parseJsonBody(req, maxBytes = MAX_BODY) {
    return new Promise((resolve, reject) => {
        let raw = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                req.destroy();
                return reject(new Error('PAYLOAD_TOO_LARGE'));
            }
            raw += chunk.toString();
        });
        req.on('end', () => {
            try {
                const parsed = raw ? JSON.parse(raw) : {};
                resolve(parsed);
            } catch (_) {
                reject(new Error('INVALID_JSON'));
            }
        });
        req.on('error', reject);
    });
}

function serveStaticFile(res, filePath, contentType) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('File Not Found');
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Internal Server Error');
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

module.exports = {
    escapeHtml,
    constantTimeCompare,
    JWT_SECRET,
    WA_WEBHOOK_SECRET,
    verifyWebhookSecret,
    getClientIp,
    createAuthToken,
    tokens,
    isAuthed,
    checkRateLimit,
    saveBase64Image,
    maskTenantName,
    send,
    readBody,
    parseJsonBody,
    serveStaticFile
};
