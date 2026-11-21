const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { APP_USER, APP_PASS, UPLOAD_DIR, PUBLIC_DIR } = require('../config/env');
const { db, getSettings, setSetting } = require('../config/database');
const {
    isAuthed,
    createAuthToken,
    tokens,
    checkRateLimit,
    getClientIp,
    verifyWebhookSecret,
    saveBase64Image,
    send,
    readBody,
    parseJsonBody,
    serveStaticFile
} = require('../utils/security');
const {
    getTodayWIB,
    getOverdueDetails,
    getMonthsList,
    formatMonthsDisplay
} = require('../utils/time');
const {
    recalculateInvoiceStatus,
    allocatePaymentFIFO,
    generateMonthlyInvoices
} = require('../services/billing');
const {
    getUnifiedTransactions,
    getTraceFundAnalytics
} = require('../services/tracefund');
const {
    getWaStatus,
    initWhatsAppClient,
    logoutWhatsAppClient,
    sendUnifiedWhatsApp,
    handleIncomingWhatsAppMessage
} = require('../services/whatsapp');
const {
    logNotification,
    sendEmailNotification,
    buildEmailHtml,
    buildSystemNoticeEmailHtml,
    runReminderCheck
} = require('../services/scheduler');

function constantTimeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

const ALLOWED_SETTING_KEYS = new Set([
    'app_name',
    'owner_name',
    'owner_phone',
    'owner_address',
    'bank_name',
    'bank_account',
    'bank_holder',
    'monthly_fee',
    'due_day',
    'reminder_h3',
    'reminder_h1',
    'reminder_h0',
    'reminder_h_plus',
    'auto_billing',
    'base_url',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'wa_group_id',
    'wa_token',
    'qris_image'
]);

async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams);

    // 0. Healthcheck Endpoint
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
        let dbOk = false;
        try {
            const check = db.prepare('SELECT 1 as ok').get();
            if (check && check.ok === 1) dbOk = true;
        } catch (_) {}

        const waInfo = getWaStatus();
        return send(res, dbOk ? 200 : 503, {
            status: dbOk ? 'UP' : 'DOWN',
            timestamp: new Date().toISOString(),
            uptime_seconds: Math.floor(process.uptime()),
            database: dbOk ? 'CONNECTED' : 'DISCONNECTED',
            wa_status: waInfo.status
        });
    }

    // 1. Static Files (HTML & Uploads)
    if (pathname === '/' || pathname === '/index.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/tagihan' || pathname === '/tagihan.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'tagihan.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/keluhan' || pathname === '/keluhan.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'keluhan.html'), 'text/html; charset=utf-8');
    }
    if (pathname.startsWith('/uploads/')) {
        const filename = path.basename(pathname);
        const targetPath = path.join(UPLOAD_DIR, filename);
        let mime = null;
        if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) mime = 'image/jpeg';
        else if (filename.endsWith('.png')) mime = 'image/png';
        else if (filename.endsWith('.webp')) mime = 'image/webp';
        else if (filename.endsWith('.pdf')) mime = 'application/pdf';
        else {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Akses berkas tidak diizinkan.');
        }

        // Kontrol akses berkas bukti pembayaran sensitif (proof_*)
        if (filename.startsWith('proof_')) {
            const isAdmin = isAuthed(req, 'admin');
            let isAuthorized = isAdmin;
            if (!isAuthorized) {
                // Ekstraksi invoiceId: di antara 'proof_' dan '_<timestamp>_<safeId>.<ext>'
                const nameWithoutPrefix = filename.replace(/^proof_/, '');
                const lastUnder = nameWithoutPrefix.lastIndexOf('_');
                const prevUnder = lastUnder !== -1 ? nameWithoutPrefix.lastIndexOf('_', lastUnder - 1) : -1;
                const invoiceId = prevUnder !== -1 ? nameWithoutPrefix.slice(0, prevUnder) : null;
                const token = query.token || '';
                if (token && invoiceId) {
                    try {
                        const inv = db.prepare('SELECT access_token FROM invoices WHERE id = ?').get(invoiceId);
                        if (inv && inv.access_token && constantTimeCompare(token, inv.access_token)) {
                            isAuthorized = true;
                        }
                    } catch (_) {}
                }
            }

            if (!isAuthorized) {
                res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: false, message: 'Akses berkas bukti pembayaran memerlukan otorisasi.' }));
            }
        }

        res.setHeader('X-Content-Type-Options', 'nosniff');
        return serveStaticFile(res, targetPath, mime);
    }

    // 2. Auth API
    if (req.method === 'POST' && pathname === '/api/login') {
        const clientIp = getClientIp(req);
        if (!checkRateLimit(clientIp, 'admin_login', 10, 10 * 60 * 1000)) {
            return send(res, 429, { success: false, message: 'Terlalu banyak percobaan masuk yang gagal. Silakan tunggu 10 menit.' });
        }
        readBody(req, res, (body) => {
            try {
                const data = JSON.parse(body || '{}');
                const userValid = constantTimeCompare(data.username, APP_USER);
                const passValid = constantTimeCompare(data.password, APP_PASS);
                if (userValid && passValid) {
                    const token = createAuthToken(APP_USER);
                    tokens.set(token, Date.now() + (14 * 24 * 60 * 60 * 1000));
                    return send(res, 200, { success: true, token, user: { username: APP_USER, name: 'Administrator' } });
                }
                return send(res, 401, { success: false, message: 'Username atau password salah!' });
            } catch (e) {
                return send(res, 400, { success: false, message: 'Format data tidak valid' });
            }
        });
        return;
    }

    // 3. Webhook Eksternal WhatsApp (Kompatibel dengan Fonnte / Gateway lain)
    if (req.method === 'POST' && pathname === '/api/webhook/whatsapp') {
        if (!verifyWebhookSecret(req)) {
            return send(res, 401, { success: false, message: 'Unauthorized: Webhook secret tidak valid atau belum disertakan' });
        }
        readBody(req, res, async (body) => {
            try {
                const data = JSON.parse(body || '{}');
                const sender = data.sender || data.from || '';
                const message = data.message || data.text || '';
                const result = await handleIncomingWhatsAppMessage(sender, message, null, null);
                return send(res, 200, { success: true, result });
            } catch (err) {
                return send(res, 400, { success: false, error: err.message });
            }
        });
        return;
    }

    // 4. Public API: Portal Tagihan Penyewa
    if (pathname.startsWith('/api/public/invoice/')) {
        const invoiceId = decodeURIComponent(pathname.replace('/api/public/invoice/', '').trim());
        const clientIp = getClientIp(req);

        if (req.method === 'GET') {
            if (!checkRateLimit(clientIp, 'public_invoice_get', 60, 60 * 1000)) {
                return send(res, 429, { success: false, message: 'Terlalu banyak permintaan. Silakan tunggu sebentar.' });
            }
            const invoice = db.prepare(`
                SELECT i.*,
                       COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                       MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                       r.number as room_number, r.type as room_type, r.tenant_name, r.tenant_phone, r.tenant_email
                FROM invoices i
                JOIN rooms r ON i.room_id = r.id
                WHERE i.id = ?
            `).get(invoiceId);

            if (!invoice) return send(res, 404, { success: false, message: 'Tagihan tidak ditemukan' });

            const reqToken = query.token || '';
            const isAuthorized = isAuthed(req);
            const hasValidToken = Boolean(invoice.access_token && reqToken && constantTimeCompare(reqToken, invoice.access_token));

            // Lindungi privasi penghuni jika diakses tanpa token akses resmi
            if (!isAuthorized && !hasValidToken) {
                if (invoice.tenant_name) {
                    const parts = invoice.tenant_name.trim().split(' ');
                    invoice.tenant_name = parts[0] + (parts.length > 1 ? ' ***' : '');
                }
                invoice.notes = null;
                invoice.payment_proof = null;
            }

            // Jangan sertakan nomor HP dan email privat penghuni pada respon publik
            invoice.tenant_phone = null;
            invoice.tenant_email = null;

            // Selalu hapus access_token dari respons publik agar tidak bocor
            delete invoice.access_token;

            const monthsList = getMonthsList(invoice.month_year);
            invoice.months_list = monthsList;
            invoice.months_label = formatMonthsDisplay(monthsList);

            const payments = db.prepare('SELECT id, invoice_id, amount, payment_method, payment_date, notes, created_at FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date ASC, created_at ASC').all(invoiceId);

            // Lindungi privasi rincian catatan cicilan jika diakses tanpa token akses resmi
            if (!isAuthorized && !hasValidToken) {
                for (const p of payments) {
                    p.notes = null;
                    p.payment_proof = null;
                }
            }

            const rawSettings = getSettings();
            const publicSettings = {
                app_name: rawSettings.app_name || 'Kontrakan Nenek Yuyun',
                owner_name: rawSettings.owner_name || 'Nenek Yuyun',
                owner_phone: rawSettings.owner_phone || '',
                owner_address: rawSettings.owner_address || '',
                bank_name: rawSettings.bank_name || '',
                bank_account: rawSettings.bank_account || '',
                bank_holder: rawSettings.bank_holder || '',
                qris_image: rawSettings.qris_image || ''
            };

            return send(res, 200, { success: true, invoice, payments, settings: publicSettings });
        }

        if (req.method === 'POST') {
            if (!checkRateLimit(clientIp, 'public_invoice_post', 10, 10 * 60 * 1000)) {
                return send(res, 429, { success: false, message: 'Terlalu banyak konfirmasi pembayaran dikirim. Silakan tunggu.' });
            }
            readBody(req, res, async (body) => {
                try {
                    const { payment_method, proof_image, amount, notes, token } = JSON.parse(body || '{}');
                    const invoice = db.prepare(`
                        SELECT i.*,
                               COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                               MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                               r.number as room_number, r.tenant_name
                        FROM invoices i
                        JOIN rooms r ON i.room_id = r.id
                        WHERE i.id = ?
                    `).get(invoiceId);

                    if (!invoice) return send(res, 404, { success: false, message: 'Tagihan tidak ditemukan' });

                    // Validasi token tagihan jika bukan admin terotentikasi
                    const sentToken = token || query.token || '';
                    if (!isAuthed(req)) {
                        if (!invoice.access_token || !sentToken || !constantTimeCompare(sentToken, invoice.access_token)) {
                            return send(res, 403, { success: false, message: 'Akses ditolak: Token tagihan tidak valid' });
                        }
                    }

                    const payNominal = Number(amount) > 0 ? Number(amount) : invoice.remaining_amount;

                    let proofPath = invoice.payment_proof || null;
                    if (proof_image) {
                        const savedPath = saveBase64Image(proof_image, `proof_${invoiceId}`);
                        if (savedPath) {
                            if (invoice.payment_proof) {
                                const oldFile = path.join(UPLOAD_DIR, path.basename(invoice.payment_proof));
                                if (fs.existsSync(oldFile)) {
                                    try { fs.unlinkSync(oldFile); } catch (_) {}
                                }
                            }
                            proofPath = savedPath;
                        }
                    }

                    const combinedNotes = (notes ? `${notes} ` : '') + `[Konfirmasi: Rp ${payNominal.toLocaleString('id-ID')}]`;

                    db.prepare(`
                        UPDATE invoices
                        SET status = 'MENUNGGU_VERIFIKASI', payment_method = ?, payment_proof = ?, notes = ?
                        WHERE id = ?
                    `).run(payment_method || 'TRANSFER', proofPath, combinedNotes, invoiceId);

                    // Notifikasi Otomatis ke WhatsApp Pemilik
                    const settings = getSettings();
                    if (settings.owner_phone) {
                        const alertOwnerText = `*Konfirmasi Pembayaran Masuk!*\n\n` +
                            `Unit: *${invoice.room_number || '-'}*\n` +
                            `Penghuni: *${invoice.tenant_name || '-'}*\n` +
                            `Periode: *${invoice.month_year}*\n` +
                            `Nominal Konfirmasi: *Rp ${payNominal.toLocaleString('id-ID')}*\n` +
                            `Total Tagihan: Rp ${Number(invoice.amount).toLocaleString('id-ID')}\n` +
                            `Sisa Sebelum Bayar: Rp ${Number(invoice.remaining_amount).toLocaleString('id-ID')}\n` +
                            `Metode: *${payment_method || 'Transfer'}*\n` +
                            `Catatan: ${notes || '-'}\n\n` +
                            `Buka dashboard untuk verifikasi: ${(settings.base_url || 'https://sekeluarga.web.id')}`;

                        sendUnifiedWhatsApp(settings.owner_phone, alertOwnerText).catch(e => {
                            console.error('Gagal mengirim notif ke pemilik:', e.message);
                        });
                    }

                    return send(res, 200, {
                        success: true,
                        message: 'Konfirmasi pembayaran berhasil dikirim. Menunggu verifikasi pemilik.'
                    });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    // Public API: Layanan Keluhan Penghuni
    if (pathname === '/api/public/complaints') {
        const clientIp = getClientIp(req);

        if (req.method === 'GET') {
            if (!checkRateLimit(clientIp, 'public_complaints_get', 60, 60 * 1000)) {
                return send(res, 429, { success: false, message: 'Terlalu banyak permintaan. Silakan tunggu sebentar.' });
            }
            const rooms = db.prepare('SELECT id, number FROM rooms ORDER BY number ASC').all();
            const rawSettings = getSettings();
            const settings = {
                app_name: rawSettings.app_name || 'Kontrakan Nenek Yuyun',
                owner_name: rawSettings.owner_name || 'Nenek Yuyun',
                owner_phone: rawSettings.owner_phone || ''
            };
            return send(res, 200, { success: true, rooms, settings });
        }
        if (req.method === 'POST') {
            if (!checkRateLimit(clientIp, 'public_complaints_post', 10, 10 * 60 * 1000)) {
                return send(res, 429, { success: false, message: 'Terlalu banyak laporan dikirim. Silakan tunggu sebentar.' });
            }
            readBody(req, res, async (body) => {
                try {
                    const data = JSON.parse(body || '{}');
                    const { room_id, tenant_name, tenant_phone, category, description, photo_image } = data;
                    if (!room_id || !description || typeof description !== 'string' || description.trim().length < 3) {
                        return send(res, 400, { success: false, message: 'Unit dan deskripsi keluhan wajib diisi dengan jelas' });
                    }
                    if (description.trim().length > 3000) {
                        return send(res, 400, { success: false, message: 'Deskripsi keluhan melebihi batas maksimal 3000 karakter' });
                    }
                    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room_id);
                    if (!room) return send(res, 404, { success: false, message: 'Unit kontrakan tidak ditemukan' });

                    const id = `CMP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
                    let photoUrl = null;
                    if (photo_image) {
                        photoUrl = saveBase64Image(photo_image, `complaint_${id}`);
                    }

                    const tName = tenant_name || room.tenant_name || 'Penghuni';
                    const tPhone = tenant_phone || room.tenant_phone || '';
                    const tCat = category || 'Fasilitas';

                    db.prepare(`
                        INSERT INTO complaints (id, room_id, tenant_name, tenant_phone, category, description, photo_url, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'BARU', ?)
                    `).run(id, room_id, tName, tPhone, tCat, description.trim(), photoUrl, new Date().toISOString());

                    const settings = getSettings();
                    if (settings.owner_phone) {
                        const alertOwnerText = `*Laporan Keluhan Baru dari Penghuni!*\n\n` +
                            `Unit: *${room.number}*\n` +
                            `Penghuni: *${tName}*\n` +
                            (tPhone ? `No. WhatsApp: ${tPhone}\n` : '') +
                            `Kategori: *${tCat}*\n` +
                            `Keterangan Keluhan:\n"${description.trim()}"\n\n` +
                            (photoUrl ? `(Foto bukti kerusakan terlampir)\n` : '') +
                            `Buka dashboard: ${(settings.base_url || 'https://sekeluarga.web.id')}`;

                        sendUnifiedWhatsApp(settings.owner_phone, alertOwnerText).catch(e => {
                            console.error('Gagal mengirim notif keluhan ke pemilik:', e.message);
                        });
                    }

                    return send(res, 200, {
                        success: true,
                        message: 'Keluhan Anda berhasil dikirim ke pemilik kontrakan. Kami akan segera memeriksanya!'
                    });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    // Endpoint berikut memerlukan otentikasi Admin (kecuali ekspor CSV yang mengizinkan token scope export)
    if (pathname.startsWith('/api/')) {
        const isExportCsv = (pathname === '/api/tracefund/export-csv');
        if (!isAuthed(req, isExportCsv ? 'export' : 'admin')) {
            return send(res, 401, { success: false, message: 'Unauthorized (Sesi telah berakhir atau belum login)' });
        }
    }

    // Status WhatsApp Bot Mandiri (Hanya untuk Admin terotentikasi)
    if (pathname === '/api/wa/status' && req.method === 'GET') {
        const waInfo = getWaStatus();
        return send(res, 200, {
            status: waInfo.status,
            qr: waInfo.qr,
            user: waInfo.connected_user
        });
    }

    // Kontrol WhatsApp Socket (Restart & Logout)
    if (pathname === '/api/wa/restart' && req.method === 'POST') {
        initWhatsAppClient().catch(() => {});
        return send(res, 200, { success: true, message: 'Inisialisasi ulang WhatsApp client sedang berjalan' });
    }

    if (pathname === '/api/wa/logout' && req.method === 'POST') {
        await logoutWhatsAppClient();
        return send(res, 200, { success: true, message: 'Sesi WhatsApp berhasil diputuskan' });
    }

    // 5. Endpoint Statistik Dashboard
    if (req.method === 'GET' && pathname === '/api/stats') {
        try {
            const rooms = db.prepare('SELECT * FROM rooms').all();
            const expenses = db.prepare('SELECT * FROM expenses').all();

            const totalRooms = rooms.length;
            const occupiedRooms = rooms.filter(r => r.status === 'TERISI').length;
            const vacantRooms = totalRooms - occupiedRooms;

            const totalPaidFromPayments = db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM invoice_payments').get().s;
            const legacyPaid = db.prepare(`
                SELECT COALESCE(SUM(amount), 0) as s FROM invoices 
                WHERE status = 'LUNAS' AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = invoices.id)
            `).get().s;
            const totalPaid = totalPaidFromPayments + legacyPaid;

            const invBalances = db.prepare(`
                SELECT i.id, i.amount, i.status,
                       COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount
                FROM invoices i
            `).all();

            const totalUnpaid = invBalances
                .filter(i => i.status !== 'LUNAS')
                .reduce((acc, i) => acc + Math.max(i.amount - i.paid_amount, 0), 0);

            const totalPending = invBalances
                .filter(i => i.status === 'MENUNGGU_VERIFIKASI')
                .reduce((acc, i) => acc + Math.max(i.amount - i.paid_amount, 0), 0);

            const partialInvoicesCount = invBalances.filter(i => i.status === 'SEBAGIAN').length;

            const totalExpense = expenses.reduce((acc, e) => acc + Number(e.amount), 0);
            const netProfit = totalPaid - totalExpense;

            const today = getTodayWIB();
            const overdueListRaw = db.prepare(`
                SELECT i.*,
                       COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                       MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                       r.number as room_number, r.tenant_name, r.tenant_phone, r.tenant_email
                FROM invoices i
                JOIN rooms r ON i.room_id = r.id
                WHERE i.status IN ('BELUM_BAYAR', 'SEBAGIAN') AND i.due_date <= date(?, '+7 days')
                ORDER BY i.due_date ASC
            `).all(today);

            const overdueList = overdueListRaw.map(inv => {
                const ov = getOverdueDetails(inv.due_date, inv.month_year, today);
                const mList = getMonthsList(inv.month_year);
                return {
                    ...inv,
                    months_list: mList,
                    months_label: formatMonthsDisplay(mList),
                    overdue_info: ov
                };
            });

            const pendingList = db.prepare(`
                SELECT i.*,
                       COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                       MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                       r.number as room_number, r.tenant_name, r.tenant_phone
                FROM invoices i
                JOIN rooms r ON i.room_id = r.id
                WHERE i.status = 'MENUNGGU_VERIFIKASI'
                ORDER BY i.created_at DESC
            `).all();

            const activeComplaints = db.prepare("SELECT count(*) as c FROM complaints WHERE status != 'SELESAI'").get().c;

            return send(res, 200, {
                totalRooms,
                occupiedRooms,
                vacantRooms,
                totalPaid,
                totalUnpaid,
                totalPending,
                partialInvoicesCount,
                totalExpense,
                netProfit,
                overdueList,
                pendingList,
                activeComplaints
            });
        } catch (err) {
            return send(res, 500, { success: false, message: err.message });
        }
    }

    // 6. CRUD Rooms (Unit A - K)
    if (pathname === '/api/rooms') {
        if (req.method === 'GET') {
            const rows = db.prepare('SELECT * FROM rooms ORDER BY number ASC').all();
            return send(res, 200, rows);
        }

        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const r = JSON.parse(body || '{}');
                    const id = (r.id && /^[a-zA-Z0-9._-]+$/.test(String(r.id).trim()))
                        ? String(r.id).trim()
                        : `unit-${crypto.randomBytes(4).toString('hex')}`;
                    const stmt = db.prepare(`
                        INSERT INTO rooms (id, number, type, price, status, tenant_name, tenant_phone, tenant_email, due_day, entry_date, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            number = excluded.number,
                            type = excluded.type,
                            price = excluded.price,
                            status = excluded.status,
                            tenant_name = excluded.tenant_name,
                            tenant_phone = excluded.tenant_phone,
                            tenant_email = excluded.tenant_email,
                            due_day = excluded.due_day,
                            entry_date = excluded.entry_date
                    `);
                    stmt.run(
                        id,
                        r.number,
                        r.type || 'Standard',
                        Number(r.price || 0),
                        r.status || 'KOSONG',
                        r.tenant_name || '',
                        r.tenant_phone || '',
                        r.tenant_email || '',
                        Number(r.due_day || 1),
                        r.entry_date || '',
                        r.created_at || new Date().toISOString()
                    );
                    return send(res, 200, { success: true, message: 'Data unit berhasil disimpan' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    if (pathname.startsWith('/api/rooms/')) {
        const id = decodeURIComponent(pathname.replace('/api/rooms/', ''));
        if (req.method === 'PUT') {
            readBody(req, res, (body) => {
                try {
                    const r = JSON.parse(body || '{}');
                    const exist = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
                    if (!exist) return send(res, 404, { success: false, message: 'Unit tidak ditemukan' });

                    db.prepare(`
                        UPDATE rooms SET
                            number = COALESCE(?, number),
                            type = COALESCE(?, type),
                            price = COALESCE(?, price),
                            status = COALESCE(?, status),
                            tenant_name = COALESCE(?, tenant_name),
                            tenant_phone = COALESCE(?, tenant_phone),
                            tenant_email = COALESCE(?, tenant_email),
                            due_day = COALESCE(?, due_day),
                            entry_date = COALESCE(?, entry_date)
                        WHERE id = ?
                    `).run(
                        r.number || null,
                        r.type || null,
                        r.price !== undefined ? Number(r.price) : null,
                        r.status || null,
                        r.tenant_name !== undefined ? r.tenant_name : null,
                        r.tenant_phone !== undefined ? r.tenant_phone : null,
                        r.tenant_email !== undefined ? r.tenant_email : null,
                        r.due_day !== undefined ? Number(r.due_day) : null,
                        r.entry_date !== undefined ? r.entry_date : null,
                        id
                    );
                    return send(res, 200, { success: true, message: 'Data unit berhasil diperbarui' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }

        if (req.method === 'DELETE') {
            db.exec('BEGIN IMMEDIATE;');
            try {
                const invRows = db.prepare('SELECT id FROM invoices WHERE room_id = ?').all(id);
                for (const inv of invRows) {
                    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(inv.id);
                    db.prepare('DELETE FROM notification_logs WHERE invoice_id = ?').run(inv.id);
                }
                db.prepare('DELETE FROM invoices WHERE room_id = ?').run(id);
                db.prepare('DELETE FROM complaints WHERE room_id = ?').run(id);
                db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
                db.exec('COMMIT;');
                return send(res, 200, { success: true, message: 'Unit dan seluruh data terkait berhasil dihapus' });
            } catch (err) {
                db.exec('ROLLBACK;');
                return send(res, 500, { success: false, message: 'Gagal menghapus unit: ' + err.message });
            }
        }
    }

    // 7. CRUD Invoices & Mass Generate
    if (pathname === '/api/invoices') {
        if (req.method === 'GET') {
            const rows = db.prepare(`
                SELECT i.*,
                       COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                       MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                       (SELECT COUNT(id) FROM invoice_payments WHERE invoice_id = i.id) as payment_count,
                       r.number as room_number, r.tenant_name, r.tenant_phone, r.tenant_email
                FROM invoices i
                JOIN rooms r ON i.room_id = r.id
                ORDER BY i.due_date DESC, i.created_at DESC
            `).all();
            const rowsWithMonths = rows.map(inv => {
                const mList = getMonthsList(inv.month_year);
                return {
                    ...inv,
                    months_list: mList,
                    months_label: formatMonthsDisplay(mList)
                };
            });
            return send(res, 200, rowsWithMonths);
        }

        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const inv = JSON.parse(body || '{}');
                    const id = (inv.id && /^[a-zA-Z0-9._-]+$/.test(String(inv.id).trim()))
                        ? String(inv.id).trim()
                        : `INV-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
                    const token = inv.access_token || crypto.randomBytes(12).toString('hex');
                    const stmt = db.prepare(`
                        INSERT INTO invoices (id, room_id, month_year, amount, due_date, status, payment_method, notes, access_token, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            room_id = excluded.room_id,
                            month_year = excluded.month_year,
                            amount = excluded.amount,
                            due_date = excluded.due_date,
                            status = excluded.status,
                            payment_method = excluded.payment_method,
                            notes = excluded.notes
                    `);
                    stmt.run(
                        id,
                        inv.room_id,
                        inv.month_year,
                        Number(inv.amount),
                        inv.due_date,
                        inv.status || 'BELUM_BAYAR',
                        inv.payment_method || null,
                        inv.notes || '',
                        token,
                        inv.created_at || new Date().toISOString()
                    );
                    return send(res, 200, { success: true, message: 'Tagihan berhasil disimpan' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    if (req.method === 'GET' && pathname.endsWith('/payments') && pathname.startsWith('/api/invoices/')) {
        const id = decodeURIComponent(pathname.replace('/api/invoices/', '').replace('/payments', ''));
        const payments = db.prepare(`
            SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date DESC, created_at DESC
        `).all(id);
        return send(res, 200, { success: true, payments });
    }

    if (req.method === 'PUT' && pathname.includes('/payments/') && pathname.startsWith('/api/invoices/')) {
        const parts = pathname.replace('/api/invoices/', '').split('/payments/');
        const invId = decodeURIComponent(parts[0]);
        const payId = decodeURIComponent(parts[1]);
        readBody(req, res, (body) => {
            try {
                const data = JSON.parse(body || '{}');
                const exist = db.prepare('SELECT * FROM invoice_payments WHERE id = ? AND invoice_id = ?').get(payId, invId);
                if (!exist) return send(res, 404, { success: false, message: 'Catatan pembayaran tidak ditemukan' });

                db.prepare(`
                    UPDATE invoice_payments SET
                        amount = COALESCE(?, amount),
                        payment_method = COALESCE(?, payment_method),
                        payment_date = COALESCE(?, payment_date),
                        notes = COALESCE(?, notes)
                    WHERE id = ? AND invoice_id = ?
                `).run(
                    data.amount !== undefined ? Number(data.amount) : null,
                    data.payment_method || null,
                    data.payment_date || null,
                    data.notes !== undefined ? data.notes : null,
                    payId,
                    invId
                );

                const resStatus = recalculateInvoiceStatus(invId);
                return send(res, 200, { success: true, message: 'Catatan pembayaran cicilan berhasil diperbarui', ...resStatus });
            } catch (err) {
                return send(res, 500, { success: false, message: err.message });
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname.includes('/payments/') && pathname.startsWith('/api/invoices/')) {
        const parts = pathname.replace('/api/invoices/', '').split('/payments/');
        const invId = decodeURIComponent(parts[0]);
        const payId = decodeURIComponent(parts[1]);
        db.exec('BEGIN IMMEDIATE;');
        try {
            db.prepare('DELETE FROM invoice_payments WHERE id = ? AND invoice_id = ?').run(payId, invId);
            const resStatus = recalculateInvoiceStatus(invId);
            db.exec('COMMIT;');
            return send(res, 200, { success: true, message: 'Catatan pembayaran cicilan berhasil dihapus', ...resStatus });
        } catch (err) {
            db.exec('ROLLBACK;');
            return send(res, 500, { success: false, message: 'Gagal menghapus catatan cicilan: ' + err.message });
        }
    }

    if (req.method === 'DELETE' && pathname.endsWith('/payments') && pathname.startsWith('/api/invoices/')) {
        const invId = decodeURIComponent(pathname.replace('/api/invoices/', '').replace('/payments', ''));
        db.exec('BEGIN IMMEDIATE;');
        try {
            db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(invId);
            const resStatus = recalculateInvoiceStatus(invId, true);
            db.exec('COMMIT;');
            return send(res, 200, { success: true, message: 'Semua catatan pembayaran cicilan berhasil dihapus', ...resStatus });
        } catch (err) {
            db.exec('ROLLBACK;');
            return send(res, 500, { success: false, message: 'Gagal menghapus semua cicilan: ' + err.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/invoices/generate-monthly') {
        readBody(req, res, (body) => {
            try {
                const { month_year, due_month_year } = JSON.parse(body || '{}');
                if (!month_year) return send(res, 400, { success: false, message: 'Parameter bulan dan tahun diperlukan' });

                const result = generateMonthlyInvoices(month_year, due_month_year);
                if (!result.success && result.count === 0 && result.message.includes('Tidak ada unit')) {
                    return send(res, 400, result);
                }
                return send(res, 200, result);
            } catch (err) {
                return send(res, 500, { success: false, message: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname.endsWith('/pay') && pathname.startsWith('/api/invoices/')) {
        const id = decodeURIComponent(pathname.replace('/api/invoices/', '').replace('/pay', ''));
        readBody(req, res, (body) => {
            try {
                const { amount, payment_method, payment_date, notes } = JSON.parse(body || '{}');
                const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
                if (!inv) return send(res, 404, { success: false, message: 'Tagihan tidak ditemukan' });

                const result = allocatePaymentFIFO({
                    roomId: inv.room_id,
                    amount,
                    paymentMethod: payment_method,
                    paymentDate: payment_date,
                    notes: notes || 'Diverifikasi admin',
                    targetInvoiceId: id
                });

                if (!result.success) {
                    return send(res, 400, result);
                }

                const updatedInv = db.prepare(`
                    SELECT i.*,
                           COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                           MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount
                    FROM invoices i
                    WHERE i.id = ?
                `).get(id);

                return send(res, 200, {
                    ...result,
                    status: updatedInv ? updatedInv.status : 'LUNAS',
                    paid_amount: updatedInv ? updatedInv.paid_amount : 0,
                    remaining_amount: updatedInv ? updatedInv.remaining_amount : 0
                });
            } catch (err) {
                return send(res, 500, { success: false, message: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname.endsWith('/notify') && pathname.startsWith('/api/invoices/')) {
        const id = pathname.replace('/api/invoices/', '').replace('/notify', '');
        readBody(req, res, async (body) => {
            try {
                const { channel } = JSON.parse(body || '{}');
                const inv = db.prepare(`
                    SELECT i.*,
                           COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                           MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount,
                           r.number as room_number, r.tenant_name, r.tenant_phone, r.tenant_email
                    FROM invoices i
                    JOIN rooms r ON i.room_id = r.id
                    WHERE i.id = ?
                `).get(id);

                if (!inv) return send(res, 404, { success: false, message: 'Tagihan tidak ditemukan' });

                const settings = getSettings();
                const baseUrl = settings.base_url || 'https://sekeluarga.web.id';
                const tokenParam = inv.access_token ? `&token=${encodeURIComponent(inv.access_token)}` : '';
                const payUrl = `${baseUrl}/tagihan.html?id=${encodeURIComponent(inv.id)}${tokenParam}`;
                const remaining = Number(inv.remaining_amount !== undefined ? inv.remaining_amount : inv.amount);
                const paid = Number(inv.paid_amount || 0);
                const ov = getOverdueDetails(inv.due_date, inv.month_year);

                let statusTeks = '';
                if (ov.isOverdue) {
                    statusTeks = `*${ov.overdueLabel}* (Jatuh tempo: ${inv.due_date})`;
                } else if (ov.statusType === 'TODAY') {
                    statusTeks = `*Jatuh Tempo Hari Ini* (${inv.due_date})`;
                } else {
                    statusTeks = `*${ov.overdueLabel}* (Jatuh tempo: ${inv.due_date})`;
                }

                const waMessage = `Halo Kak ${inv.tenant_name || ''},\n\n` +
                    `Pemberitahuan tagihan sewa *${settings.app_name || 'Kontrakan Nenek Yuyun'}* untuk unit *${inv.room_number}*.\n\n` +
                    `*Rincian Tagihan Belum Lunas:*\n` +
                    `• Periode Sewa: *${inv.month_year}* (${ov.periodLabel})\n` +
                    `• Status Keterlambatan: ${statusTeks}\n` +
                    `• Total Tagihan Periode: *Rp ${Number(inv.amount).toLocaleString('id-ID')}*\n` +
                    (paid > 0 ? `• Sudah Masuk (Cicilan): *Rp ${paid.toLocaleString('id-ID')}*\n` : '') +
                    `• Sisa Wajib Dibayar: *Rp ${remaining.toLocaleString('id-ID')}*\n\n` +
                    `Mohon kerjasamanya untuk menyelesaikan pembayaran melalui tautan berikut:\n${payUrl}\n\n` +
                    `Terima kasih.`;

                let waRes = null;
                if ((channel === 'whatsapp' || channel === 'both') && inv.tenant_phone) {
                    waRes = await sendUnifiedWhatsApp(inv.tenant_phone, waMessage);
                    logNotification(inv.id, 'WHATSAPP', inv.tenant_phone, waRes.success ? 'SUCCESS' : 'FAILED', waRes.error || `Terkirim via ${waRes.method || 'Fonnte'}`);
                }

                let emRes = null;
                if ((channel === 'email' || channel === 'both') && inv.tenant_email) {
                    const html = buildEmailHtml(settings, inv, payUrl, 'Pengingat Pembayaran');
                    emRes = await sendEmailNotification(settings, inv.tenant_email, `[Tagihan Sewa] ${inv.room_number} - ${settings.app_name}`, html);
                    logNotification(inv.id, 'EMAIL', inv.tenant_email, emRes.success ? 'SUCCESS' : 'FAILED', emRes.error || 'Terkirim manual');
                }

                return send(res, 200, {
                    success: true,
                    message: 'Pengingat berhasil diproses',
                    whatsapp: waRes,
                    email: emRes,
                    waDirectUrl: `https://wa.me/${(inv.tenant_phone || '').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(waMessage)}`
                });
            } catch (err) {
                return send(res, 500, { success: false, message: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/invoices/notify-all-overdue') {
        if (!isAuthed(req)) return send(res, 401, { success: false, message: 'Unauthorized' });
        try {
            const results = await runReminderCheck(true);
            return send(res, 200, { success: true, count: results.length, results });
        } catch (err) {
            return send(res, 500, { success: false, message: err.message });
        }
    }

    if (pathname.startsWith('/api/invoices/') && !pathname.includes('/payments') && !pathname.includes('/pay') && !pathname.includes('/notify')) {
        const id = decodeURIComponent(pathname.replace('/api/invoices/', ''));
        if (req.method === 'PUT') {
            readBody(req, res, (body) => {
                try {
                    const inv = JSON.parse(body || '{}');
                    const exist = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
                    if (!exist) return send(res, 404, { success: false, message: 'Tagihan tidak ditemukan' });

                    db.prepare(`
                        UPDATE invoices SET
                            room_id = COALESCE(?, room_id),
                            month_year = COALESCE(?, month_year),
                            amount = COALESCE(?, amount),
                            due_date = COALESCE(?, due_date),
                            status = COALESCE(?, status),
                            payment_method = COALESCE(?, payment_method),
                            notes = COALESCE(?, notes)
                        WHERE id = ?
                    `).run(
                        inv.room_id || null,
                        inv.month_year || null,
                        inv.amount !== undefined ? Number(inv.amount) : null,
                        inv.due_date || null,
                        inv.status || null,
                        inv.payment_method !== undefined ? inv.payment_method : null,
                        inv.notes !== undefined ? inv.notes : null,
                        id
                    );

                    const updatedStatus = recalculateInvoiceStatus(id);
                    return send(res, 200, { success: true, message: 'Tagihan berhasil diperbarui', invoice: updatedStatus });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }

        if (req.method === 'DELETE') {
            db.exec('BEGIN IMMEDIATE;');
            try {
                db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(id);
                db.prepare('DELETE FROM notification_logs WHERE invoice_id = ?').run(id);
                db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
                db.exec('COMMIT;');
                return send(res, 200, { success: true, message: 'Tagihan dan seluruh riwayatnya berhasil dihapus' });
            } catch (err) {
                db.exec('ROLLBACK;');
                return send(res, 500, { success: false, message: 'Gagal menghapus tagihan: ' + err.message });
            }
        }
    }

    // 8. CRUD Expenses
    if (pathname === '/api/expenses') {
        if (req.method === 'GET') {
            const rows = db.prepare('SELECT * FROM expenses ORDER BY date DESC, created_at DESC').all();
            return send(res, 200, rows);
        }

        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const exp = JSON.parse(body || '{}');
                    const id = (exp.id && /^[a-zA-Z0-9._-]+$/.test(String(exp.id).trim()))
                        ? String(exp.id).trim()
                        : `EXP-${Date.now()}`;
                    const stmt = db.prepare(`
                        INSERT INTO expenses (id, date, category, amount, note, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            date = excluded.date,
                            category = excluded.category,
                            amount = excluded.amount,
                            note = excluded.note
                    `);
                    stmt.run(
                        id,
                        exp.date || getTodayWIB(),
                        exp.category || 'Lainnya',
                        Number(exp.amount || 0),
                        exp.note || '',
                        exp.created_at || new Date().toISOString()
                    );
                    return send(res, 200, { success: true, message: 'Pengeluaran berhasil dicatat' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    if (pathname.startsWith('/api/expenses/')) {
        const id = decodeURIComponent(pathname.replace('/api/expenses/', ''));
        if (req.method === 'PUT') {
            readBody(req, res, (body) => {
                try {
                    const exp = JSON.parse(body || '{}');
                    const exist = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
                    if (!exist) return send(res, 404, { success: false, message: 'Pengeluaran tidak ditemukan' });

                    db.prepare(`
                        UPDATE expenses SET
                            date = COALESCE(?, date),
                            category = COALESCE(?, category),
                            amount = COALESCE(?, amount),
                            note = COALESCE(?, note)
                        WHERE id = ?
                    `).run(
                        exp.date || null,
                        exp.category || null,
                        exp.amount !== undefined ? Number(exp.amount) : null,
                        exp.note !== undefined ? exp.note : null,
                        id
                    );
                    return send(res, 200, { success: true, message: 'Pengeluaran berhasil diperbarui' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }

        if (req.method === 'DELETE') {
            db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
            return send(res, 200, { success: true, message: 'Pengeluaran berhasil dihapus' });
        }
    }

    // 9. Admin Complaints API
    if (pathname === '/api/complaints') {
        if (req.method === 'GET') {
            const rows = db.prepare(`
                SELECT c.*, r.number as room_number
                FROM complaints c
                JOIN rooms r ON c.room_id = r.id
                ORDER BY c.created_at DESC
            `).all();
            return send(res, 200, rows);
        }

        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const data = JSON.parse(body || '{}');
                    const id = (data.id && /^[a-zA-Z0-9._-]+$/.test(String(data.id).trim()))
                        ? String(data.id).trim()
                        : `CMP-${Date.now()}`;
                    const room_id = data.room_id;
                    const tenant_name = data.tenant_name || '';
                    const tenant_phone = data.tenant_phone || '';
                    const category = data.category || 'Fasilitas';
                    const description = data.description || '';
                    const status = data.status || 'BARU';
                    const admin_notes = data.admin_notes || '';
                    if (!room_id || !description) {
                        return send(res, 400, { success: false, message: 'Unit dan deskripsi wajib diisi' });
                    }
                    db.prepare(`
                        INSERT INTO complaints (id, room_id, tenant_name, tenant_phone, category, description, status, admin_notes, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(id, room_id, tenant_name, tenant_phone, category, description, status, admin_notes, new Date().toISOString());
                    return send(res, 201, { success: true, id, message: 'Keluhan berhasil dicatat' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    if (pathname.startsWith('/api/complaints/') && pathname.endsWith('/status')) {
        const id = pathname.replace('/api/complaints/', '').replace('/status', '');
        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const { status, admin_notes } = JSON.parse(body || '{}');
                    const resolvedAt = status === 'SELESAI' ? new Date().toISOString() : null;
                    db.prepare(`
                        UPDATE complaints
                        SET status = ?, admin_notes = ?, resolved_at = COALESCE(?, resolved_at)
                        WHERE id = ?
                    `).run(status, admin_notes || '', resolvedAt, id);
                    return send(res, 200, { success: true, message: 'Status keluhan berhasil diperbarui' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }
    }

    if (pathname.startsWith('/api/complaints/') && !pathname.endsWith('/status')) {
        const id = decodeURIComponent(pathname.replace('/api/complaints/', ''));
        if (req.method === 'PUT') {
            readBody(req, res, (body) => {
                try {
                    const c = JSON.parse(body || '{}');
                    const exist = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
                    if (!exist) return send(res, 404, { success: false, message: 'Keluhan tidak ditemukan' });

                    const resolvedAt = c.status === 'SELESAI'
                        ? (exist.resolved_at || new Date().toISOString())
                        : (c.status && c.status !== 'SELESAI' ? null : exist.resolved_at);

                    db.prepare(`
                        UPDATE complaints SET
                            room_id = COALESCE(?, room_id),
                            tenant_name = COALESCE(?, tenant_name),
                            tenant_phone = COALESCE(?, tenant_phone),
                            category = COALESCE(?, category),
                            description = COALESCE(?, description),
                            status = COALESCE(?, status),
                            admin_notes = COALESCE(?, admin_notes),
                            resolved_at = ?
                        WHERE id = ?
                    `).run(
                        c.room_id || null,
                        c.tenant_name !== undefined ? c.tenant_name : null,
                        c.tenant_phone !== undefined ? c.tenant_phone : null,
                        c.category || null,
                        c.description || null,
                        c.status || null,
                        c.admin_notes !== undefined ? c.admin_notes : null,
                        resolvedAt,
                        id
                    );
                    return send(res, 200, { success: true, message: 'Data keluhan berhasil diperbarui' });
                } catch (err) {
                    return send(res, 500, { success: false, message: err.message });
                }
            });
            return;
        }

        if (req.method === 'DELETE') {
            db.prepare('DELETE FROM complaints WHERE id = ?').run(id);
            return send(res, 200, { success: true, message: 'Keluhan berhasil dihapus' });
        }
    }

    // 10. Settings API
    if (pathname === '/api/settings') {
        if (req.method === 'GET') {
            const raw = getSettings();
            const safe = { ...raw };
            delete safe.jwt_secret;
            delete safe.wa_webhook_secret;
            if (safe.smtp_pass) safe.smtp_pass = '********';
            return send(res, 200, safe);
        }

        if (req.method === 'POST') {
            readBody(req, res, (body) => {
                try {
                    const newSettings = JSON.parse(body || '{}');
                    // Cegah modifikasi kunci kriptografi rahasia via formulir web
                    delete newSettings.jwt_secret;
                    delete newSettings.wa_webhook_secret;

                    // Jika kata sandi smtp tidak diubah (berisi masker ********), pertahankan nilai lama
                    if (newSettings.smtp_pass === '********') {
                        delete newSettings.smtp_pass;
                    }

                    for (const [k, v] of Object.entries(newSettings)) {
                        if (ALLOWED_SETTING_KEYS.has(k)) {
                            setSetting(k, v);
                        }
                    }
                    return send(res, 200, { success: true, message: 'Pengaturan berhasil disimpan' });
                } catch (err) {
                    return send(res, 500, { success: false, message: 'Format data tidak valid' });
                }
            });
            return;
        }
    }

    // Test Kirim Email SMTP
    if (req.method === 'POST' && pathname === '/api/settings/test-email') {
        readBody(req, res, async (body) => {
            try {
                const { test_email } = JSON.parse(body || '{}');
                const settings = getSettings();
                if (!test_email || typeof test_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(test_email.trim())) {
                    return send(res, 400, { success: false, message: 'Format alamat email tujuan tidak valid' });
                }

                const resEm = await sendEmailNotification(
                    settings,
                    test_email,
                    `Pemberitahuan Resmi: Sistem Notifikasi Email Aktif - ${settings.app_name || 'Kontrakan Nenek Yuyun'}`,
                    buildSystemNoticeEmailHtml(settings)
                );

                if (resEm.success) {
                    return send(res, 200, { success: true, message: 'Email konfirmasi sistem berhasil dikirim!' });
                } else {
                    return send(res, 400, { success: false, message: resEm.error });
                }
            } catch (err) {
                return send(res, 500, { success: false, message: err.message });
            }
        });
        return;
    }

    // 11. Trigger Cron Manual
    if (req.method === 'POST' && pathname === '/api/cron/run') {
        try {
            const results = await runReminderCheck();
            return send(res, 200, { success: true, message: 'Pengecekan pengingat selesai', results });
        } catch (err) {
            return send(res, 500, { success: false, message: err.message });
        }
    }

    // 12. Notification Logs API
    if (req.method === 'GET' && pathname === '/api/notifications/logs') {
        const rows = db.prepare('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50').all();
        return send(res, 200, rows);
    }

    // 13. TRACEFUND API ENDPOINTS
    // 13.1 Analytics Lintas Bulan API
    if (req.method === 'GET' && pathname === '/api/tracefund/analytics') {
        return send(res, 200, getTraceFundAnalytics());
    }

    // 13.2 Unified Transactions dengan Saldo Berjalan API
    if (req.method === 'GET' && pathname === '/api/tracefund/transactions') {
        const result = getUnifiedTransactions({
            month: query.month,
            year: query.year,
            keyword: query.keyword,
            type: query.type
        });
        return send(res, 200, result);
    }

    // 13.3 Keyword Total Search (Fitur /total TraceFund)
    if (req.method === 'GET' && pathname === '/api/tracefund/total') {
        const kw = query.keyword || '';
        const result = getUnifiedTransactions({
            keyword: kw,
            month: query.month,
            year: query.year,
            type: 'keluar'
        });
        const sum = result.transactions.reduce((a, b) => a + b.amount, 0);
        return send(res, 200, {
            keyword: kw,
            count: result.transactions.length,
            total_amount: sum,
            transactions: result.transactions
        });
    }

    // 13.4 Export Transaksi CSV dengan Saldo Berjalan & UTF-8 BOM
    if (req.method === 'GET' && pathname === '/api/tracefund/export-csv') {
        const { transactions } = getUnifiedTransactions({
            month: query.month,
            year: query.year
        });

        let csv = '\uFEFF"ID Transaksi","Tanggal","Tipe","Kategori","Nominal","Deskripsi","Saldo Berjalan"\r\n';
        for (const t of transactions) {
            const idEsc = String(t.id).replace(/"/g, '""');
            const typeLabel = t.type === 'masuk' ? 'PEMASUKAN' : 'PENGELUARAN';
            const catEsc = String(t.category || '-').replace(/"/g, '""');
            const descEsc = String(t.description || '-').replace(/"/g, '""');
            csv += `"${idEsc}","${t.date}","${typeLabel}","${catEsc}",${t.amount},"${descEsc}",${t.running_balance}\r\n`;
        }

        const filename = query.month 
            ? `laporan-transaksi-kontrakan-${query.month}.csv` 
            : (query.year ? `laporan-transaksi-kontrakan-${query.year}.csv` : 'laporan-seluruh-transaksi-kontrakan.csv');

        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-cache'
        });
        return res.end(csv);
    }

    // 13.5 Budgets API (Kelola Batas Anggaran Bulanan)
    if (req.method === 'GET' && pathname === '/api/budgets') {
        const month = query.month;
        if (month) {
            const b = db.prepare('SELECT * FROM budgets WHERE month = ?').get(month);
            const exp = db.prepare('SELECT SUM(amount) as total FROM expenses WHERE substr(date, 1, 7) = ?').get(month)?.total || 0;
            return send(res, 200, {
                month,
                amount: b ? b.amount : 0,
                spent: exp,
                remaining: b ? Math.max(b.amount - exp, 0) : 0,
                percentage: b && b.amount > 0 ? Math.round((exp / b.amount) * 100) : 0
            });
        }
        const rows = db.prepare('SELECT * FROM budgets ORDER BY month DESC').all();
        return send(res, 200, rows);
    }

    if (req.method === 'POST' && pathname === '/api/budgets') {
        let body;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            return send(res, 400, { success: false, message: 'Format data JSON tidak valid atau melebihi batas ukuran.' });
        }
        if (!body || !body.month || body.amount === undefined) {
            return send(res, 400, { success: false, message: 'Field month (YYYY-MM) dan amount wajib diisi.' });
        }
        const month = String(body.month).trim();
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return send(res, 400, { success: false, message: 'Format bulan tidak valid. Gunakan format YYYY-MM.' });
        }
        const amount = parseInt(body.amount, 10);
        if (isNaN(amount) || amount < 0) {
            return send(res, 400, { success: false, message: 'Nominal anggaran harus berupa angka positif.' });
        }
        db.prepare(`
            INSERT INTO budgets (month, amount)
            VALUES (?, ?)
            ON CONFLICT(month) DO UPDATE SET amount = excluded.amount
        `).run(month, amount);
        return send(res, 200, { success: true, month, amount, message: 'Anggaran berhasil diperbarui.' });
    }

    if (pathname.startsWith('/api/budgets') && req.method === 'DELETE') {
        let month = query.month;
        if (!month && pathname.startsWith('/api/budgets/')) {
            month = decodeURIComponent(pathname.replace('/api/budgets/', '')).trim();
        }
        if (!month) {
            return send(res, 400, { success: false, message: 'Field month (YYYY-MM) wajib diisi untuk menghapus anggaran.' });
        }
        db.prepare('DELETE FROM budgets WHERE month = ?').run(month);
        return send(res, 200, { success: true, month, message: `Anggaran bulan ${month} berhasil dihapus.` });
    }

    // 13.6 General Incomes API (Pemasukan Non-Sewa)
    if (req.method === 'GET' && pathname === '/api/incomes') {
        const month = query.month;
        let rows;
        if (month) {
            rows = db.prepare('SELECT * FROM general_incomes WHERE substr(date, 1, 7) = ? ORDER BY date DESC, created_at DESC').all(month);
        } else {
            rows = db.prepare('SELECT * FROM general_incomes ORDER BY date DESC, created_at DESC LIMIT 100').all();
        }
        return send(res, 200, rows);
    }

    if (req.method === 'POST' && pathname === '/api/incomes') {
        let body;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            return send(res, 400, { success: false, message: 'Format data JSON tidak valid atau melebihi batas ukuran.' });
        }
        if (!body || !body.amount) {
            return send(res, 400, { success: false, message: 'Nominal pemasukan wajib diisi.' });
        }
        const amount = parseInt(body.amount, 10);
        if (isNaN(amount) || amount <= 0) {
            return send(res, 400, { success: false, message: 'Nominal pemasukan harus lebih besar dari 0.' });
        }
        const id = (body.id && /^[a-zA-Z0-9._-]+$/.test(String(body.id).trim()))
            ? String(body.id).trim()
            : `INC-${Date.now()}`;
        const date = body.date || getTodayWIB();
        const category = body.category || 'Pemasukan';
        const note = body.note || '';
        db.prepare(`
            INSERT INTO general_incomes (id, date, category, amount, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, date, category, amount, note, new Date().toISOString());
        return send(res, 201, { success: true, id, message: 'Pemasukan berhasil dicatat.' });
    }

    if (pathname.startsWith('/api/incomes/')) {
        const id = decodeURIComponent(pathname.replace('/api/incomes/', ''));

        if (req.method === 'PUT') {
            let body;
            try {
                body = await parseJsonBody(req);
            } catch (err) {
                return send(res, 400, { success: false, message: 'Format data JSON tidak valid atau melebihi batas ukuran.' });
            }
            const exist = db.prepare('SELECT * FROM general_incomes WHERE id = ?').get(id);
            if (!exist) return send(res, 404, { success: false, message: 'Pemasukan tidak ditemukan' });

            db.prepare(`
                UPDATE general_incomes SET
                    date = COALESCE(?, date),
                    category = COALESCE(?, category),
                    amount = COALESCE(?, amount),
                    note = COALESCE(?, note)
                WHERE id = ?
            `).run(
                body.date || null,
                body.category || null,
                body.amount !== undefined ? Number(body.amount) : null,
                body.note !== undefined ? body.note : null,
                id
            );
            return send(res, 200, { success: true, message: 'Pemasukan berhasil diperbarui' });
        }

        if (req.method === 'DELETE') {
            db.prepare('DELETE FROM general_incomes WHERE id = ?').run(id);
            return send(res, 200, { success: true, message: 'Pemasukan berhasil dihapus' });
        }
    }

    return send(res, 404, { message: 'Endpoint Not Found' });
}

module.exports = {
    handleRequest
};
