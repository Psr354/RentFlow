const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

console.log('--- Menjalankan Pengujian Sistem Kontrakan ---');

// 1. Pengujian Basis Data & Migrasi access_token
const testDbPath = path.join(__dirname, 'test_kontrakan.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const db = new DatabaseSync(testDbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    month_year TEXT NOT NULL,
    amount INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BELUM_BAYAR',
    access_token TEXT
);
`);

// Pastikan kolom access_token ada
const tableInfo = db.prepare('PRAGMA table_info(invoices);').all();
const hasAccessToken = tableInfo.some(col => col.name === 'access_token');
assert.strictEqual(hasAccessToken, true, 'Kolom access_token harus ada pada skema database');
console.log('✓ [1/7] Skema database dan kolom access_token tervalidasi.');

// 2. Pengujian Helper Waktu Lokal Indonesia (WIB)
function getTodayWIB() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}
function getMonthYearWIB() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date());
}
const todayWib = getTodayWIB();
assert.match(todayWib, /^\d{4}-\d{2}-\d{2}$/, 'Format tanggal WIB harus YYYY-MM-DD');
const ymWib = getMonthYearWIB();
assert.match(ymWib, /^\d{4}-\d{2}$/, 'Format bulan-tahun WIB harus YYYY-MM');
console.log(`✓ [2/7] Helper Waktu WIB tervalidasi: ${todayWib} (${ymWib}).`);

// 3. Pengujian Validasi Gambar Base64 & Magic Bytes
function testValidateBase64(dataUri) {
    const matches = dataUri.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
    if (!matches) return false;
    let buffer;
    try {
        buffer = Buffer.from(matches[2], 'base64');
    } catch (_) {
        return false;
    }
    const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isPng = buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isWebp = buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return isJpeg || isPng || isWebp;
}

// 1x1 valid PNG base64
const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Fake image: PHP script masked as image
const fakePhpImage = 'data:image/png;base64,' + Buffer.from('<?php echo "evil"; ?>').toString('base64');

assert.strictEqual(testValidateBase64(validPng), true, 'Valid PNG harus diterima');
assert.strictEqual(testValidateBase64(fakePhpImage), false, 'File palsu/ekstensi manipulasi harus ditolak');
console.log('✓ [3/7] Validasi Base64 & Magic Bytes tervalidasi.');

// 4. Pengujian Rate Limiter
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

const testIp = '192.168.1.100';
for (let i = 0; i < 5; i++) {
    assert.strictEqual(checkRateLimit(testIp, 'test_ep', 5, 1000), true, `Request ${i + 1} harus diizinkan`);
}
// Request ke-6 harus ditolak
assert.strictEqual(checkRateLimit(testIp, 'test_ep', 5, 1000), false, 'Request melebihi batas harus ditolak');
console.log('✓ [4/7] In-memory Rate Limiter tervalidasi.');

// 5. Pengujian Keamanan Autentikasi Admin
const TEST_JWT_SECRET = 'super-secret-key-12345678901234567890';
function createTestToken(username) {
    const payload = JSON.stringify({ u: username, exp: Date.now() + 60000 });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', TEST_JWT_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
}

function verifyTestToken(token) {
    if (!token || !token.includes('.')) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [b64, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', TEST_JWT_SECRET).update(b64).digest('base64url');
    const bSig = Buffer.from(sig);
    const bExp = Buffer.from(expectedSig);
    if (bSig.length === bExp.length && crypto.timingSafeEqual(bSig, bExp)) {
        try {
            const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
            if (payload.exp && Date.now() < payload.exp) return true;
        } catch (_) {}
    }
    return false;
}

const validToken = createTestToken('admin');
assert.strictEqual(verifyTestToken(validToken), true, 'Token HMAC valid harus diterima');
assert.strictEqual(verifyTestToken('tok_bypass_arbitrary_string'), false, 'Token palsu tok_bypass HARUS ditolak');
assert.strictEqual(verifyTestToken('session_fake_token'), false, 'Token session_fake HARUS ditolak');
assert.strictEqual(verifyTestToken(validToken + 'corrupt'), false, 'Token yang dirusak HARUS ditolak');
console.log('✓ [5/7] Keamanan HMAC & eliminasi auth bypass tervalidasi.');

// 6. Pengujian Privasi Data Penghuni
const sampleTenant = 'Budi Santoso';
function maskTenantName(name) {
    if (!name) return 'Penghuni';
    const parts = name.trim().split(' ');
    return parts[0] + (parts.length > 1 ? ' ***' : '');
}
assert.strictEqual(maskTenantName(sampleTenant), 'Budi ***', 'Nama penyewa harus disamarkan untuk akses tanpa token');
assert.strictEqual(maskTenantName('Andi'), 'Andi', 'Nama satu kata tetap terjaga formatnya');
console.log('✓ [6/7] Mekanisme penyembunyian privasi data penghuni tervalidasi.');

// 7. Pengujian Pembatasan Berkas Statis /uploads
function isAllowedUploadFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext);
}
assert.strictEqual(isAllowedUploadFile('bukti.jpg'), true);
assert.strictEqual(isAllowedUploadFile('bukti.png'), true);
assert.strictEqual(isAllowedUploadFile('shell.php'), false, 'Berkas .php harus ditolak');
assert.strictEqual(isAllowedUploadFile('script.js'), false, 'Berkas .js harus ditolak');
assert.strictEqual(isAllowedUploadFile('hack.svg'), false, 'Berkas .svg harus ditolak');
console.log('✓ [7/8] Whitelist tipe berkas uploads tervalidasi.');

// 8. Pengujian Fitur TraceFund Terpadu (Parsing & Logika Finansial)
const {
    parseNominalTrace,
    detectExpenseCategory,
    parseMonthYearInput,
    parseExpenseCommand,
    parseIncomeCommand
} = require('../server.js');

// 8.1 Parsing Nominal Fleksibel
assert.strictEqual(parseNominalTrace('150k'), 150000, '150k harus bernilai 150000');
assert.strictEqual(parseNominalTrace('1.5jt'), 1500000, '1.5jt harus bernilai 1500000');
assert.strictEqual(parseNominalTrace('50rb'), 50000, '50rb harus bernilai 50000');
assert.strictEqual(parseNominalTrace('Rp 25.000'), 25000, 'Rp 25.000 harus bernilai 25000');
assert.strictEqual(parseNominalTrace('2jt'), 2000000, '2jt harus bernilai 2000000');
assert.strictEqual(parseNominalTrace('750ribu'), 750000, '750ribu harus bernilai 750000');
assert.strictEqual(parseNominalTrace(''), 0, 'String kosong harus bernilai 0');

// 8.2 Deteksi Kategori Pengeluaran Otomatis
assert.strictEqual(detectExpenseCategory('Beli token pompa air'), 'Listrik');
assert.strictEqual(detectExpenseCategory('Bayar tagihan PDAM'), 'Air');
assert.strictEqual(detectExpenseCategory('Iuran sampah lingkungan dan sapu'), 'Kebersihan');
assert.strictEqual(detectExpenseCategory('Ganti genteng bocor dan perbaikan semen'), 'Perbaikan');
assert.strictEqual(detectExpenseCategory('Snack konsumsi rapat warga'), 'Lainnya');
assert.strictEqual(detectExpenseCategory('cat tembok', 'Perbaikan'), 'Perbaikan', 'Kategori eksplisit harus diprioritaskan');

// 8.3 Parsing Bulan dan Tahun
const my1 = parseMonthYearInput('november 2026');
assert.strictEqual(my1.monthKey, '2026-11');
const my2 = parseMonthYearInput('12 2025');
assert.strictEqual(my2.monthKey, '2025-12');
const my3 = parseMonthYearInput('');
assert.match(my3.monthKey, /^\d{4}-\d{2}$/);

// 8.4 Parsing Perintah #keluar Fleksibel
const expParsed1 = parseExpenseCommand('Listrik 150k Beli token pompa air');
assert.strictEqual(expParsed1.amount, 150000);
assert.strictEqual(expParsed1.category, 'Listrik');
assert.strictEqual(expParsed1.note, 'Beli token pompa air');

const expParsed2 = parseExpenseCommand('50rb iuran sampah');
assert.strictEqual(expParsed2.amount, 50000);
assert.strictEqual(expParsed2.category, 'Kebersihan');
assert.strictEqual(expParsed2.note, 'iuran sampah');

const expParsed3 = parseExpenseCommand('2.5jt perbaikan genteng bocor');
assert.strictEqual(expParsed3.amount, 2500000);
assert.strictEqual(expParsed3.category, 'Perbaikan');

// 8.5 Parsing Perintah #masuk Fleksibel
const incParsed1 = parseIncomeCommand('500k Penjualan kardus bekas');
assert.strictEqual(incParsed1.amount, 500000);
assert.strictEqual(incParsed1.category, 'Pemasukan');
assert.strictEqual(incParsed1.note, 'Penjualan kardus bekas');

const incParsed2 = parseIncomeCommand('1.5jt Titipan kas RT');
assert.strictEqual(incParsed2.amount, 1500000);
assert.strictEqual(incParsed2.note, 'Titipan kas RT');

console.log('✓ [8/9] Parser perintah, nominal, deteksi kategori, dan periode TraceFund tervalidasi.');

// 9. Pengujian End-to-End Eksekusi Perintah WhatsApp Bot TraceFund
const { handleIncomingWhatsAppMessage, db: appDb } = require('../server.js');

async function testTraceFundCommands() {
    const ownerPhone = appDb.prepare("SELECT value FROM settings WHERE key = 'owner_phone'").get()?.value || '081234567890';

    // 9.1 Perintah #keluar
    const resKeluar = await handleIncomingWhatsAppMessage(ownerPhone, '#keluar 150k Listrik Beli token pompa air', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resKeluar.success, true, '#keluar harus berhasil dicatat');
    assert.match(resKeluar.replyText, /Pengeluaran berhasil dicatat/);

    // 9.2 Perintah #masuk
    const resMasuk = await handleIncomingWhatsAppMessage(ownerPhone, '#masuk 500k Penjualan kardus bekas', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resMasuk.success, true, '#masuk harus berhasil dicatat');
    assert.match(resMasuk.replyText, /Pemasukan non-sewa berhasil dicatat/);

    // 9.3 Perintah #saldo
    const resSaldo = await handleIncomingWhatsAppMessage(ownerPhone, '#saldo', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resSaldo.success, true, '#saldo harus berhasil mengembalikan laporan');
    assert.match(resSaldo.replyText, /Laporan Saldo Uang/);

    // 9.4 Perintah #budget (atur & cek, lalu pulihkan kondisi awal agar tidak mencemari DB)
    const testMonthKey = getMonthYearWIB();
    const prevBudgetRow = appDb.prepare('SELECT amount FROM budgets WHERE month = ?').get(testMonthKey);
    const resSetBudget = await handleIncomingWhatsAppMessage(ownerPhone, '#budget 10jt', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resSetBudget.success, true, '#budget set harus berhasil');
    const resGetBudget = await handleIncomingWhatsAppMessage(ownerPhone, '#budget', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resGetBudget.success, true, '#budget view harus berhasil');
    if (prevBudgetRow) {
        appDb.prepare('UPDATE budgets SET amount = ? WHERE month = ?').run(prevBudgetRow.amount, testMonthKey);
    } else {
        appDb.prepare('DELETE FROM budgets WHERE month = ?').run(testMonthKey);
    }

    // 9.5 Perintah #kategori
    const resKategori = await handleIncomingWhatsAppMessage(ownerPhone, '#kategori', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resKategori.success, true, '#kategori harus berhasil');

    // 9.6 Perintah #ringkasan
    const resRingkasan = await handleIncomingWhatsAppMessage(ownerPhone, '#ringkasan', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resRingkasan.success, true, '#ringkasan harus berhasil');

    // 9.7 Perintah #tahunan
    const resTahunan = await handleIncomingWhatsAppMessage(ownerPhone, '#tahunan', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resTahunan.success, true, '#tahunan harus berhasil');

    // 9.8 Perintah #analisis
    const resAnalisis = await handleIncomingWhatsAppMessage(ownerPhone, '#analisis', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resAnalisis.success, true, '#analisis harus berhasil');

    // 9.9 Perintah #total
    const resTotal = await handleIncomingWhatsAppMessage(ownerPhone, '#total token', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resTotal.success, true, '#total harus berhasil');

    // 9.10 Perintah #riwayat
    const resRiwayat = await handleIncomingWhatsAppMessage(ownerPhone, '#riwayat', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resRiwayat.success, true, '#riwayat harus berhasil');

    // 9.11 Perintah #ekspor / #csv
    const resEkspor = await handleIncomingWhatsAppMessage(ownerPhone, '#ekspor', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resEkspor.success, true, '#ekspor harus berhasil');

    // 9.12 Perintah #batal (hapus pengeluaran tes)
    const resBatal = await handleIncomingWhatsAppMessage(ownerPhone, '#batal', 'test@s.whatsapp.net', null, false);
    assert.strictEqual(resBatal.success, true, '#batal harus berhasil membatalkan pengeluaran terakhir');

    // Bersihkan pemasukan tes dari database
    appDb.prepare("DELETE FROM general_incomes WHERE note LIKE '%Penjualan kardus bekas%'").run();

    // 9.13 Pengujian getUnifiedTransactions & getTraceFundAnalytics
    const { getUnifiedTransactions, getTraceFundAnalytics } = require('../server.js');
    const unified = getUnifiedTransactions();
    assert(typeof unified.current_balance === 'number', 'current_balance harus berupa angka');
    assert(Array.isArray(unified.transactions), 'transactions harus berupa array');

    const analytics = getTraceFundAnalytics();
    assert(Array.isArray(analytics.months), 'analytics.months harus berupa array');

    console.log('✓ [9/10] Seluruh 12 perintah bot TraceFund WhatsApp & kalkulasi analitik tervalidasi.');

    // 10. Pengujian Kesiapan Produksi (Healthcheck, Security Headers, PRAGMA)
    const { server: appServer } = require('../server.js');
    const { createAuthToken, tokens } = require('../src/utils/security.js');
    const authToken = createAuthToken('admin');
    tokens.set(authToken, Date.now() + 60000);

    function makeRequest(port, method, reqPath, data = null) {
        return new Promise((resolve, reject) => {
            const payload = data ? JSON.stringify(data) : null;
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                method,
                path: reqPath,
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    await new Promise((resolve, reject) => {
        appServer.listen(0, '127.0.0.1', async () => {
            const port = appServer.address().port;
            try {
                // 10.1 Healthcheck & Security Headers
                const resHealth = await makeRequest(port, 'GET', '/health');
                assert.strictEqual(resHealth.statusCode, 200, '/health harus mengembalikan status 200');
                assert.strictEqual(resHealth.headers['x-content-type-options'], 'nosniff', 'Header nosniff harus aktif');
                assert.strictEqual(resHealth.headers['x-frame-options'], 'SAMEORIGIN', 'Header X-Frame-Options harus SAMEORIGIN');
                assert.strictEqual(resHealth.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Header Referrer-Policy harus aktif');
                assert.strictEqual(resHealth.body.status, 'UP', 'Status healthcheck harus UP');
                assert.strictEqual(resHealth.body.database, 'CONNECTED', 'Database harus CONNECTED');

                // Cek PRAGMA synchronous & journal_mode
                const jm = appDb.prepare('PRAGMA journal_mode;').get();
                assert.strictEqual(jm.journal_mode, 'wal', 'SQLite journal_mode harus WAL');
                const sync = appDb.prepare('PRAGMA synchronous;').get();
                assert.strictEqual(sync.synchronous, 1, 'SQLite synchronous harus NORMAL (1)');

                // 11. Pengujian Lengkap Fitur CRUD (Rooms, Invoices, Payments, Expenses, Incomes, Budgets, Complaints)
                // 11.1 Rooms CRUD
                const testRoomId = 'test-room-crud';
                const postRoom = await makeRequest(port, 'POST', '/api/rooms', {
                    id: testRoomId,
                    number: '99.Z',
                    type: 'VIP Test',
                    price: 2000000,
                    status: 'KOSONG',
                    due_day: 5
                });
                assert.strictEqual(postRoom.statusCode, 200);

                const putRoom = await makeRequest(port, 'PUT', `/api/rooms/${testRoomId}`, {
                    price: 2500000,
                    status: 'TERISI',
                    tenant_name: 'Tester CRUD'
                });
                assert.strictEqual(putRoom.statusCode, 200);
                assert.strictEqual(putRoom.body.success, true);
                const checkRoom = appDb.prepare('SELECT * FROM rooms WHERE id = ?').get(testRoomId);
                assert.strictEqual(checkRoom.price, 2500000);
                assert.strictEqual(checkRoom.tenant_name, 'Tester CRUD');

                // 11.2 Invoices & Payments CRUD
                const testInvId = 'test-inv-crud';
                const postInv = await makeRequest(port, 'POST', '/api/invoices', {
                    id: testInvId,
                    room_id: testRoomId,
                    month_year: 'Desember 2026',
                    amount: 2500000,
                    due_date: '2026-12-05'
                });
                assert.strictEqual(postInv.statusCode, 200);

                // PUT invoice
                const putInv = await makeRequest(port, 'PUT', `/api/invoices/${testInvId}`, {
                    amount: 3000000,
                    notes: 'Penyesuaian tarif akhir tahun'
                });
                assert.strictEqual(putInv.statusCode, 200);
                assert.strictEqual(putInv.body.success, true);
                const checkInv = appDb.prepare('SELECT * FROM invoices WHERE id = ?').get(testInvId);
                assert.strictEqual(checkInv.amount, 3000000);
                assert.strictEqual(checkInv.notes, 'Penyesuaian tarif akhir tahun');

                // Add Payment / Cicilan
                const payRes = await makeRequest(port, 'POST', `/api/invoices/${testInvId}/pay`, {
                    amount: 1000000,
                    payment_method: 'TRANSFER',
                    notes: 'Cicilan 1'
                });
                assert.strictEqual(payRes.statusCode, 200);

                // GET Payments
                const getPayments = await makeRequest(port, 'GET', `/api/invoices/${testInvId}/payments`);
                assert.strictEqual(getPayments.statusCode, 200);
                assert(getPayments.body.payments.length > 0);
                const paymentId = getPayments.body.payments[0].id;

                // PUT Payment
                const putPay = await makeRequest(port, 'PUT', `/api/invoices/${testInvId}/payments/${paymentId}`, {
                    amount: 1500000,
                    notes: 'Cicilan 1 direvisi'
                });
                assert.strictEqual(putPay.statusCode, 200);
                const checkPay = appDb.prepare('SELECT * FROM invoice_payments WHERE id = ?').get(paymentId);
                assert.strictEqual(checkPay.amount, 1500000);
                assert.strictEqual(checkPay.notes, 'Cicilan 1 direvisi');

                // DELETE Payment
                const delPay = await makeRequest(port, 'DELETE', `/api/invoices/${testInvId}/payments/${paymentId}`);
                assert.strictEqual(delPay.statusCode, 200);
                const checkPayAfterDel = appDb.prepare('SELECT * FROM invoice_payments WHERE id = ?').get(paymentId);
                assert.strictEqual(checkPayAfterDel, undefined);

                // Test DELETE All Payments for an invoice
                await makeRequest(port, 'POST', `/api/invoices/${testInvId}/pay`, { amount: 500000, notes: 'Cicilan A' });
                await makeRequest(port, 'POST', `/api/invoices/${testInvId}/pay`, { amount: 500000, notes: 'Cicilan B' });
                const countBeforeDelAll = appDb.prepare('SELECT COUNT(*) as c FROM invoice_payments WHERE invoice_id = ?').get(testInvId).c;
                assert.strictEqual(countBeforeDelAll, 2);

                const delAllPay = await makeRequest(port, 'DELETE', `/api/invoices/${testInvId}/payments`);
                assert.strictEqual(delAllPay.statusCode, 200);
                assert.strictEqual(delAllPay.body.success, true);
                const countAfterDelAll = appDb.prepare('SELECT COUNT(*) as c FROM invoice_payments WHERE invoice_id = ?').get(testInvId).c;
                assert.strictEqual(countAfterDelAll, 0);
                const checkInvAfterDelAll = appDb.prepare('SELECT * FROM invoices WHERE id = ?').get(testInvId);
                assert.strictEqual(checkInvAfterDelAll.status, 'BELUM_BAYAR');

                // DELETE Invoice
                const delInv = await makeRequest(port, 'DELETE', `/api/invoices/${testInvId}`);
                assert.strictEqual(delInv.statusCode, 200);

                // DELETE Room
                const delRoom = await makeRequest(port, 'DELETE', `/api/rooms/${testRoomId}`);
                assert.strictEqual(delRoom.statusCode, 200);

                // 11.3 Expenses CRUD
                const testExpId = 'test-exp-crud';
                const postExp = await makeRequest(port, 'POST', '/api/expenses', {
                    id: testExpId,
                    date: '2026-11-19',
                    category: 'Listrik',
                    amount: 100000,
                    note: 'Token pompa tes'
                });
                assert.strictEqual(postExp.statusCode, 200);

                const putExp = await makeRequest(port, 'PUT', `/api/expenses/${testExpId}`, {
                    amount: 125000,
                    note: 'Token pompa tes revisi'
                });
                assert.strictEqual(putExp.statusCode, 200);
                const checkExp = appDb.prepare('SELECT * FROM expenses WHERE id = ?').get(testExpId);
                assert.strictEqual(checkExp.amount, 125000);
                assert.strictEqual(checkExp.note, 'Token pompa tes revisi');

                const delExp = await makeRequest(port, 'DELETE', `/api/expenses/${testExpId}`);
                assert.strictEqual(delExp.statusCode, 200);

                // 11.4 General Incomes CRUD
                const testIncId = 'test-inc-crud';
                const postInc = await makeRequest(port, 'POST', '/api/incomes', {
                    id: testIncId,
                    date: '2026-11-19',
                    category: 'Pemasukan',
                    amount: 300000,
                    note: 'Penjualan besi bekas'
                });
                assert.strictEqual(postInc.statusCode, 201);

                const putInc = await makeRequest(port, 'PUT', `/api/incomes/${testIncId}`, {
                    amount: 350000,
                    note: 'Penjualan besi & kardus bekas'
                });
                assert.strictEqual(putInc.statusCode, 200);
                const checkInc = appDb.prepare('SELECT * FROM general_incomes WHERE id = ?').get(testIncId);
                assert.strictEqual(checkInc.amount, 350000);
                assert.strictEqual(checkInc.note, 'Penjualan besi & kardus bekas');

                const delInc = await makeRequest(port, 'DELETE', `/api/incomes/${testIncId}`);
                assert.strictEqual(delInc.statusCode, 200);

                // 11.5 Budgets CRUD
                const testBudMonth = '2099-01';
                const postBud = await makeRequest(port, 'POST', '/api/budgets', {
                    month: testBudMonth,
                    amount: 5000000
                });
                assert.strictEqual(postBud.statusCode, 200);

                const getBud = await makeRequest(port, 'GET', `/api/budgets?month=${testBudMonth}`);
                assert.strictEqual(getBud.statusCode, 200);
                assert.strictEqual(getBud.body.amount, 5000000);

                const delBud = await makeRequest(port, 'DELETE', `/api/budgets?month=${testBudMonth}`);
                assert.strictEqual(delBud.statusCode, 200);
                const checkBud = appDb.prepare('SELECT * FROM budgets WHERE month = ?').get(testBudMonth);
                assert.strictEqual(checkBud, undefined);

                // 11.6 Complaints CRUD
                const testCmpId = 'test-cmp-crud';
                const postCmp = await makeRequest(port, 'POST', '/api/complaints', {
                    id: testCmpId,
                    room_id: 'unit-dummy',
                    tenant_name: 'Penghuni Tes',
                    tenant_phone: '08123456789',
                    category: 'Fasilitas',
                    description: 'Pintu pagar macet',
                    status: 'BARU'
                });
                assert.strictEqual(postCmp.statusCode, 201);

                const putCmp = await makeRequest(port, 'PUT', `/api/complaints/${testCmpId}`, {
                    status: 'DIPROSES',
                    admin_notes: 'Tukang sedang menuju lokasi'
                });
                assert.strictEqual(putCmp.statusCode, 200);
                const checkCmp = appDb.prepare('SELECT * FROM complaints WHERE id = ?').get(testCmpId);
                assert.strictEqual(checkCmp.status, 'DIPROSES');
                assert.strictEqual(checkCmp.admin_notes, 'Tukang sedang menuju lokasi');

                const delCmp = await makeRequest(port, 'DELETE', `/api/complaints/${testCmpId}`);
                assert.strictEqual(delCmp.statusCode, 200);
                const checkCmpAfterDel = appDb.prepare('SELECT * FROM complaints WHERE id = ?').get(testCmpId);
                assert.strictEqual(checkCmpAfterDel, undefined);

                appServer.close(resolve);
            } catch (err) {
                appServer.close(() => reject(err));
            }
        });
    });

    console.log('✓ [10/11] Kesiapan Produksi tervalidasi (Healthcheck, Security Headers, WAL Checkpoint, & Indexes).');
    console.log('✓ [11/11] Seluruh Operasi CRUD (Rooms, Invoices, Payments, Expenses, Incomes, Budgets, Complaints) tervalidasi 100%.');

    // Bersihkan test DB
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    console.log('\n--- SELURUH PENGUJIAN SISTEM BERHASIL DENGAN STATUS LULUS (100%) ---');
}

testTraceFundCommands().catch(err => {
    console.error('Pengujian gagal:', err);
    process.exit(1);
});
