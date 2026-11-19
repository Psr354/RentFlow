const fs = require('node:fs');
const path = require('node:path');
const { db, getSettings, setSetting } = require('../config/database');
const { WA_SESSION_DIR } = require('../config/env');
const {
    getTodayWIB,
    formatMonthKey,
    getOverdueDetails,
    getMonthsList,
    formatMonthsDisplay
} = require('../utils/time');
const {
    parseNominalTrace,
    detectExpenseCategory,
    parseMonthYearInput,
    parseExpenseCommand,
    parseIncomeCommand,
    formatRupiahTrace
} = require('../utils/parser');
const { getUnifiedTransactions, getTraceFundAnalytics } = require('./tracefund');
const { allocatePaymentFIFO, findTargetInvoiceForRoom, findPaidInvoiceForRoom } = require('./billing');

let makeWASocket, useMultiFileAuthState, DisconnectReason;
let QRCode;
let pino;
try {
    const b = require('@whiskeysockets/baileys');
    makeWASocket = b.default || b.makeWASocket;
    useMultiFileAuthState = b.useMultiFileAuthState;
    DisconnectReason = b.DisconnectReason;
    QRCode = require('qrcode');
    pino = require('pino');
} catch (e) {
    console.warn('Baileys / QRCode tidak terpasang:', e.message);
}

let waSocket = null;
let waStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
let waQrDataUrl = null;
let waConnectedUser = null;
let waReconnectTimer = null;

async function initWhatsAppClient() {
    if (!makeWASocket || !useMultiFileAuthState) {
        console.warn('Baileys tidak tersedia. WhatsApp mandiri nonaktif.');
        return;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR);
        waSocket = makeWASocket({
            logger: pino ? pino({ level: 'silent' }) : undefined,
            auth: state,
            printQRInTerminal: false
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && QRCode) {
                try {
                    waQrDataUrl = await QRCode.toDataURL(qr);
                    waStatus = 'SCAN_QR';
                    console.log('WhatsApp QR Code diperbarui. Silakan scan melalui dashboard.');
                } catch (e) {
                    console.error('Gagal membuat QR data URL:', e.message);
                }
            }

            if (connection === 'open') {
                waStatus = 'CONNECTED';
                waQrDataUrl = null;
                waConnectedUser = waSocket.user?.id || 'Connected';
                console.log('WhatsApp Bot Mandiri TERHUBUNG!');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                waStatus = 'DISCONNECTED';
                waQrDataUrl = null;
                waConnectedUser = null;
                console.log(`Koneksi WhatsApp terputus. Alasan: ${statusCode}. Mencoba sambung ulang: ${shouldReconnect}`);

                if (shouldReconnect) {
                    clearTimeout(waReconnectTimer);
                    waReconnectTimer = setTimeout(() => {
                        initWhatsAppClient().catch(err => console.error('Gagal auto-reconnect WhatsApp:', err.message));
                    }, 5000);
                } else {
                    console.log('Sesi WhatsApp keluar (logged out). Menghapus kredensial lama...');
                    try {
                        fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true });
                        fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
                    } catch (_) {}
                    clearTimeout(waReconnectTimer);
                    waReconnectTimer = setTimeout(() => {
                        initWhatsAppClient().catch(() => {});
                    }, 3000);
                }
            }
        });

        // Event: Menerima Pesan WhatsApp (Inbound Messages)
        waSocket.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;
                const remoteJid = msg.key.remoteJid || '';
                const isGroup = remoteJid.endsWith('@g.us');

                // Unwrap pesan bersarang (ephemeral, viewOnce, caption, dsb.)
                let innerMsg = msg.message;
                while (innerMsg?.ephemeralMessage || innerMsg?.viewOnceMessage || innerMsg?.viewOnceMessageV2 || innerMsg?.documentWithCaptionMessage) {
                    innerMsg = innerMsg.ephemeralMessage?.message || innerMsg.viewOnceMessage?.message || innerMsg.viewOnceMessageV2?.message || innerMsg.documentWithCaptionMessage?.message;
                }

                const text = innerMsg?.conversation || innerMsg?.extendedTextMessage?.text || innerMsg?.imageMessage?.caption || innerMsg?.videoMessage?.caption || '';
                if (!text || !text.trim()) continue;
                const trimmed = text.trim();

                // Di dalam grup WhatsApp, tangani jika diawali '#' / '/' atau kata kunci perintah
                if (isGroup && !trimmed.startsWith('#') && !trimmed.startsWith('/') && !/^(keluar|masuk|saldo|budget|anggaran|kategori|batal|hapus|ekspor|csv|bantuan|menu|help|status|cek|keluhan|komplain|riwayat|lunas|bayar|list|daftar|rekap|tahunan|ringkasan|analisis|total)/i.test(trimmed)) {
                    continue;
                }

                const settings = getSettings();
                const authorizedOwners = getAuthorizedOwners(settings.owner_phone);
                const myJid = waSocket?.user?.id ? waSocket.user.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
                if (myJid && !authorizedOwners.includes(myJid)) {
                    authorizedOwners.push(myJid);
                }

                // Identifikasi pengirim pesan (bersihkan suffix device :1 dsb.)
                let participantJid = isGroup 
                    ? (msg.key.participant || msg.participant || '')
                    : remoteJid;

                if (msg.key.fromMe) {
                    participantJid = myJid || (authorizedOwners[0] ? authorizedOwners[0] + '@s.whatsapp.net' : '');
                }

                let senderPhone = participantJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                if (senderPhone.startsWith('0')) senderPhone = '62' + senderPhone.slice(1);

                const senderName = msg.pushName || (senderPhone ? `+${senderPhone}` : 'Keluarga');

                console.log(`[WA Inbound] Dari: ${remoteJid} (isGroup: ${isGroup}), Pengirim: ${participantJid} (${senderName}), Teks: "${trimmed}"`);

                // Jika pesan dari nomor bot sendiri (fromMe)
                if (msg.key.fromMe) {
                    if (!trimmed.startsWith('#') && !trimmed.startsWith('/') && !/^(keluar|masuk|saldo|budget|anggaran|kategori|batal|hapus|ekspor|csv|bantuan|menu|help|status)/i.test(trimmed)) continue;
                    if (!isGroup) {
                        const isSelf = authorizedOwners.some(o => remoteJid.includes(o)) || (myJid && remoteJid.includes(myJid));
                        if (!isSelf) continue;
                    }
                }

                await handleIncomingWhatsAppMessage(senderPhone, text, remoteJid, msg, isGroup, senderName);
            }
        });
    } catch (err) {
        console.error('Error saat inisialisasi WhatsApp client:', err.message);
        waStatus = 'DISCONNECTED';
    }
}

function getAuthorizedOwners(ownerPhoneSetting) {
    if (!ownerPhoneSetting) return [];
    return String(ownerPhoneSetting)
        .split(',')
        .map(p => {
            let clean = p.trim().replace(/[^0-9]/g, '');
            if (clean.startsWith('0')) clean = '62' + clean.slice(1);
            if (clean.startsWith('+62')) clean = clean.slice(1);
            return clean;
        })
        .filter(Boolean);
}

async function handleIncomingWhatsAppMessage(senderPhone, text, remoteJid, originalMsg, isGroup = false, senderName = '') {
    const settings = getSettings();
    const authorizedOwners = getAuthorizedOwners(settings.owner_phone);
    const myJid = waSocket?.user?.id ? waSocket.user.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    if (myJid && !authorizedOwners.includes(myJid)) authorizedOwners.push(myJid);

    let cleanSender = senderPhone ? String(senderPhone).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    if (cleanSender.startsWith('0')) cleanSender = '62' + cleanSender.slice(1);

    const isOwner = authorizedOwners.includes(cleanSender);
    let registeredGroupId = settings.wa_group_id || '';

    const trimmed = text.trim();

    const safeSend = async (replyMsg) => {
        if (!waSocket || !remoteJid) return;
        try {
            await waSocket.sendMessage(remoteJid, { text: replyMsg }, { quoted: originalMsg });
        } catch (err) {
            console.warn('[WA] Gagal kirim dengan quote, mencoba kirim langsung:', err.message);
            try {
                await waSocket.sendMessage(remoteJid, { text: replyMsg });
            } catch (err2) {
                console.error('[WA] Gagal total sendMessage:', err2.message);
            }
        }
    };

    // 1. Menu / Bantuan
    if (/^#?(menu|bantuan|help)$/i.test(trimmed)) {
        if (isGroup && !registeredGroupId) {
            setSetting('wa_group_id', remoteJid);
            registeredGroupId = remoteJid;
            console.log(`[WA] Grup keluarga otomatis didaftarkan via #bantuan: ${remoteJid}`);
        }

        const replyText = `*Daftar Perintah Bot Kontrakan (Fitur TraceFund Terpadu):*\n\n` +
            `1. *Pencatatan Keuangan:*\n` +
            `   • Catat Pengeluaran: #keluar [Nominal] [Kategori opsional] [Keterangan]\n` +
            `     Contoh: #keluar 150k Listrik Token pompa air, #keluar 50rb iuran sampah\n` +
            `   • Catat Pemasukan Non-Sewa: #masuk [Nominal] [Keterangan]\n` +
            `     Contoh: #masuk 500k Penjualan barang bekas\n` +
            `   • Batalkan Pengeluaran Terakhir: #batal atau #hapus\n` +
            `   • Cari Pengeluaran Barang: #total [Kata Kunci]\n` +
            `     Contoh: #total token, #total listrik, #total semen\n\n` +
            `2. *Saldo, Anggaran & Kategori:*\n` +
            `   • Cek Saldo & Arus Kas: #saldo\n` +
            `   • Cek / Atur Anggaran: #budget atau #budget [Nominal]\n` +
            `     Contoh: #budget, #budget 5jt, #budget 2026-11 5jt\n` +
            `   • Rincian Pengeluaran Kategori: #kategori [Bulan opsional]\n` +
            `     Contoh: #kategori, #kategori november\n\n` +
            `3. *Laporan & Analisis Finansial:*\n` +
            `   • Ringkasan Bulanan: #ringkasan [Bulan opsional] [Tahun opsional]\n` +
            `     Contoh: #ringkasan, #ringkasan november, #ringkasan 11 2026\n` +
            `   • Ringkasan Tahunan: #tahunan [Tahun opsional]\n` +
            `   • Analisis Lintas Bulan: #analisis\n` +
            `   • Riwayat 10 Transaksi Terakhir: #riwayat\n` +
            `   • Unduh Laporan Transaksi CSV: #ekspor atau #csv\n\n` +
            `4. *Operasional Kontrakan:*\n` +
            `   • Rekap Lunas & Nunggak: #list atau #daftar\n` +
            `   • Cek Status & Tagihan: #status atau #cek\n` +
            `   • Pembayaran Sewa Unit: #bayar [Nama Unit] [Nominal opsional] [Periode opsional]\n` +
            `     Contoh: #bayar 21-A 500k, #lunas 21-C, #bayar 21-C 500k Agustus 2026\n` +
            `   • Cek Keluhan Penghuni: #keluhan\n` +
            `   • Kelola Grup Keluarga: #daftargrup / #hapusgrup`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 2. Pendaftaran Grup Keluarga: #daftargrup atau #setgrup
    if (isGroup && /^#?(daftargrup|setgrup)$/i.test(trimmed)) {
        setSetting('wa_group_id', remoteJid);
        registeredGroupId = remoteJid;
        const replyText = `*Grup WhatsApp Keluarga Berhasil Didaftarkan!*\n\n` +
            `Grup ini telah terhubung resmi ke sistem *${settings.app_name || 'Kontrakan Nenek Yuyun'}*.\n\n` +
            `Seluruh anggota keluarga di grup ini sekarang dapat mencatat pengeluaran dan memantau kontrakan:\n` +
            `• *Catat Pengeluaran:* \`#keluar [Nominal] [Kategori opsional] [Keterangan]\`\n` +
            `• *Catat Pemasukan:* \`#masuk [Nominal] [Keterangan]\`\n` +
            `• *Cek Saldo Uang Saat Ini:* \`#saldo\`\n` +
            `• *Cek Status Kontrakan:* \`#status\`\n` +
            `• *Bantuan Lengkap:* \`#bantuan\``;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 3. Lepas Tautan Grup: #hapusgrup atau #putusgrup
    if (isGroup && /^#?(hapusgrup|putusgrup)$/i.test(trimmed)) {
        if (!isOwner) {
            await safeSend('Perintah melepas grup hanya dapat dijalankan oleh nomor pemilik terdaftar.');
            return { success: false, message: 'Bukan pemilik' };
        }
        setSetting('wa_group_id', '');
        const replyText = 'Tautan grup dengan sistem kontrakan telah dinonaktifkan.';
        await safeSend(replyText);
        return { success: true, replyText };
    }

    // Otomatis daftarkan grup jika sistem belum memiliki wa_group_id terdaftar
    if (isGroup && !registeredGroupId) {
        setSetting('wa_group_id', remoteJid);
        registeredGroupId = remoteJid;
        console.log(`[WA] Grup keluarga otomatis didaftarkan: ${remoteJid}`);
    }

    const isRegisteredGroup = isGroup && registeredGroupId && remoteJid === registeredGroupId;

    if (isGroup) {
        if (!isRegisteredGroup) {
            await safeSend('Grup ini belum terhubung ke sistem kontrakan. Ketik `#daftargrup` untuk menghubungkan grup ini.');
            return { success: false, message: 'Grup belum didaftarkan' };
        }
    } else {
        if (!isOwner) {
            return { success: false, message: 'Nomor pengirim bukan pemilik kontrakan terdaftar' };
        }
    }

    // 3. Catat Pengeluaran: #keluar [Nominal] [Kategori opsional] [Keterangan]
    const expenseMatch = trimmed.match(/^#?(?:keluar)(?:\s+(.+))?$/i);
    if (expenseMatch) {
        const rawArgs = expenseMatch[1] ? expenseMatch[1].trim() : '';
        const parsed = parseExpenseCommand(rawArgs);

        if (!parsed) {
            const errReply = `Format perintah catat pengeluaran tidak sesuai.\n` +
                `Gunakan: #keluar [Nominal] [Kategori opsional] [Keterangan]\n` +
                `Contoh:\n` +
                `• #keluar 150k Listrik Token pompa air\n` +
                `• #keluar 50rb iuran sampah\n` +
                `• #keluar 2.5jt perbaikan genteng bocor`;
            await safeSend(errReply);
            return { success: false, message: errReply };
        }

        const { amount, category, note } = parsed;
        const today = getTodayWIB();
        const expId = `EXP-${Date.now()}`;
        const reporterLabel = senderName || (cleanSender ? `+${cleanSender}` : 'Keluarga');
        const fullNote = isGroup ? `${note ? note + ' ' : ''}(oleh ${reporterLabel})` : (note || '');

        db.prepare(`
            INSERT INTO expenses (id, date, category, amount, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(expId, today, category, amount, fullNote, new Date().toISOString());

        const currentMonthStr = today.slice(0, 7);
        const totalMonthly = db.prepare(`
            SELECT SUM(amount) as total FROM expenses WHERE substr(date, 1, 7) = ?
        `).get(currentMonthStr)?.total || amount;

        const { current_balance } = getUnifiedTransactions();
        const bRow = db.prepare('SELECT amount FROM budgets WHERE month = ?').get(currentMonthStr);

        let replyText = `Pengeluaran berhasil dicatat:\n` +
            (isGroup ? `Pelapor: ${reporterLabel}\n` : '') +
            `Tanggal: ${today}\n` +
            `Kategori: ${category}\n` +
            `Nominal: Rp ${amount.toLocaleString('id-ID')}\n` +
            `Keterangan: ${note || '-'}\n` +
            `Total pengeluaran bulan ini: Rp ${Number(totalMonthly).toLocaleString('id-ID')}\n` +
            `Saldo uang saat ini: Rp ${Number(current_balance).toLocaleString('id-ID')}`;

        if (bRow && bRow.amount > 0) {
            const remaining = bRow.amount - totalMonthly;
            const pct = Math.round((totalMonthly / bRow.amount) * 100);
            replyText += `\nAnggaran bulan ini: Rp ${Number(bRow.amount).toLocaleString('id-ID')} (Terpakai ${pct}%, Sisa: Rp ${Number(Math.max(remaining, 0)).toLocaleString('id-ID')})`;
            if (totalMonthly > bRow.amount) {
                replyText += `\n[PERINGATAN] Pengeluaran telah melampaui batas anggaran sebesar Rp ${Number(totalMonthly - bRow.amount).toLocaleString('id-ID')}!`;
            }
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 4. Catat Pemasukan Non-Sewa: #masuk [Nominal] [Keterangan]
    const masukMatch = trimmed.match(/^#?(?:masuk)(?:\s+(.+))?$/i);
    if (masukMatch) {
        const rawArgs = masukMatch[1] ? masukMatch[1].trim() : '';
        const parsed = parseIncomeCommand(rawArgs);

        if (!parsed) {
            const errReply = `Format perintah catat pemasukan tidak sesuai.\n` +
                `Gunakan: #masuk [Nominal] [Keterangan]\n` +
                `Contoh:\n` +
                `• #masuk 500k Penjualan barang bekas\n` +
                `• #masuk 1.5jt Titipan dana kas RT`;
            await safeSend(errReply);
            return { success: false, message: errReply };
        }

        const { amount, category, note } = parsed;
        const today = getTodayWIB();
        const incId = `INC-${Date.now()}`;
        const reporterLabel = senderName || (cleanSender ? `+${cleanSender}` : 'Keluarga');
        const fullNote = isGroup ? `${note ? note + ' ' : ''}(oleh ${reporterLabel})` : (note || '');

        db.prepare(`
            INSERT INTO general_incomes (id, date, category, amount, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(incId, today, category, amount, fullNote, new Date().toISOString());

        const currentMonthStr = today.slice(0, 7);
        const { transactions, current_balance } = getUnifiedTransactions({ month: currentMonthStr, type: 'masuk' });
        const totalMonthlyIn = transactions.reduce((a, b) => a + b.amount, 0);

        let replyText = `Pemasukan non-sewa berhasil dicatat:\n` +
            (isGroup ? `Pelapor: ${reporterLabel}\n` : '') +
            `Tanggal: ${today}\n` +
            `Kategori: ${category}\n` +
            `Nominal: Rp ${amount.toLocaleString('id-ID')}\n` +
            `Keterangan: ${note || '-'}\n` +
            `Total pemasukan bulan ini: Rp ${Number(totalMonthlyIn).toLocaleString('id-ID')}\n` +
            `Saldo uang saat ini: Rp ${Number(current_balance).toLocaleString('id-ID')}`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 5. Batalkan Pengeluaran: #batal atau #hapus
    const batalMatch = trimmed.match(/^#?(?:batal|hapus)(?:\s+(.+))?$/i);
    if (batalMatch) {
        const targetQuery = batalMatch[1] ? batalMatch[1].trim() : '';
        let target = null;
        if (targetQuery && /^EXP-/i.test(targetQuery)) {
            target = db.prepare('SELECT * FROM expenses WHERE id = ?').get(targetQuery);
        } else {
            target = db.prepare('SELECT * FROM expenses ORDER BY created_at DESC LIMIT 1').get();
        }

        if (!target) {
            const errReply = 'Tidak ada catatan pengeluaran yang dapat dibatalkan.';
            await safeSend(errReply);
            return { success: false, message: errReply };
        }

        db.prepare('DELETE FROM expenses WHERE id = ?').run(target.id);
        const { current_balance } = getUnifiedTransactions();

        const replyText = `Catatan pengeluaran berhasil dibatalkan:\n` +
            `ID: ${target.id}\n` +
            `Tanggal: ${target.date}\n` +
            `Kategori: ${target.category}\n` +
            `Nominal: Rp ${Number(target.amount).toLocaleString('id-ID')}\n` +
            `Keterangan: ${target.note || '-'}\n` +
            `Saldo uang saat ini: Rp ${Number(current_balance).toLocaleString('id-ID')}`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 6. Cek Saldo & Arus Kas: #saldo
    if (/^#?saldo$/i.test(trimmed)) {
        const { transactions, current_balance } = getUnifiedTransactions();
        const currentMonth = getTodayWIB().slice(0, 7);
        const thisMonth = transactions.filter(t => t.date.startsWith(currentMonth));
        const inTotal = thisMonth.filter(t => t.type === 'masuk').reduce((a, b) => a + b.amount, 0);
        const outTotal = thisMonth.filter(t => t.type === 'keluar').reduce((a, b) => a + b.amount, 0);
        const diff = inTotal - outTotal;
        const bRow = db.prepare('SELECT amount FROM budgets WHERE month = ?').get(currentMonth);

        let replyText = `*Laporan Saldo Uang & Arus Kas Kontrakan*\n` +
            `Periode: ${formatMonthKey(currentMonth)}\n` +
            `*Saldo Uang Saat Ini: Rp ${Number(current_balance).toLocaleString('id-ID')}*\n\n` +
            `*Arus Kas Bulan Ini:*\n` +
            `• Total Pemasukan: Rp ${Number(inTotal).toLocaleString('id-ID')} (${thisMonth.filter(t => t.type === 'masuk').length} transaksi)\n` +
            `• Total Pengeluaran: Rp ${Number(outTotal).toLocaleString('id-ID')} (${thisMonth.filter(t => t.type === 'keluar').length} transaksi)\n` +
            `• Selisih Kas: Rp ${Number(diff).toLocaleString('id-ID')}`;

        if (bRow && bRow.amount > 0) {
            const rem = Math.max(bRow.amount - outTotal, 0);
            const pct = Math.round((outTotal / bRow.amount) * 100);
            replyText += `\n• Anggaran Pengeluaran: Rp ${Number(bRow.amount).toLocaleString('id-ID')} (Terpakai ${pct}%, Sisa: Rp ${Number(rem).toLocaleString('id-ID')})`;
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 7. Cek / Atur Anggaran: #budget atau #anggaran
    const budgetMatch = trimmed.match(/^#?(?:budget|anggaran)(?:\s+(.+))?$/i);
    if (budgetMatch) {
        const rawArg = budgetMatch[1] ? budgetMatch[1].trim() : '';
        const my = parseMonthYearInput(rawArg);
        const parsedAmt = parseNominalTrace(rawArg);

        if (parsedAmt > 0) {
            db.prepare(`
                INSERT INTO budgets (month, amount)
                VALUES (?, ?)
                ON CONFLICT(month) DO UPDATE SET amount = excluded.amount
            `).run(my.monthKey, parsedAmt);

            const expRow = db.prepare(`
                SELECT SUM(amount) as total FROM expenses WHERE substr(date, 1, 7) = ?
            `).get(my.monthKey)?.total || 0;
            const remaining = Math.max(parsedAmt - expRow, 0);
            const pct = Math.round((expRow / parsedAmt) * 100);

            const replyText = `*Anggaran Pengeluaran Berhasil Diatur:*\n` +
                `Periode: ${formatMonthKey(my.monthKey)}\n` +
                `Batas Anggaran: Rp ${parsedAmt.toLocaleString('id-ID')}\n` +
                `Realisasi Saat Ini: Rp ${Number(expRow).toLocaleString('id-ID')} (${pct}%)\n` +
                `Sisa Anggaran: Rp ${Number(remaining).toLocaleString('id-ID')}`;

            await safeSend(replyText);
            return { success: true, replyText };
        } else {
            const bRow = db.prepare('SELECT amount FROM budgets WHERE month = ?').get(my.monthKey);
            const expRow = db.prepare(`
                SELECT SUM(amount) as total FROM expenses WHERE substr(date, 1, 7) = ?
            `).get(my.monthKey)?.total || 0;

            let replyText = '';
            if (!bRow || !bRow.amount) {
                replyText = `Anggaran pengeluaran untuk periode ${formatMonthKey(my.monthKey)} belum diatur.\n` +
                    `Untuk mengatur anggaran, ketik: #budget [Nominal] (Contoh: #budget 5jt atau #budget 2026-11 5jt)`;
            } else {
                const remaining = Math.max(bRow.amount - expRow, 0);
                const pct = Math.round((expRow / bRow.amount) * 100);
                replyText = `*Status Anggaran Pengeluaran (${formatMonthKey(my.monthKey)}):*\n` +
                    `• Batas Anggaran: Rp ${Number(bRow.amount).toLocaleString('id-ID')}\n` +
                    `• Realisasi Pengeluaran: Rp ${Number(expRow).toLocaleString('id-ID')} (${pct}%)\n` +
                    `• Sisa Anggaran: Rp ${Number(remaining).toLocaleString('id-ID')}`;

                if (expRow > bRow.amount) {
                    replyText += `\n[PERINGATAN] Pengeluaran telah melampaui batas anggaran sebesar Rp ${Number(expRow - bRow.amount).toLocaleString('id-ID')}!`;
                }
            }

            await safeSend(replyText);
            return { success: true, replyText };
        }
    }

    // 8. Rincian Kategori: #kategori [Bulan opsional]
    const katMatch = trimmed.match(/^#?kategori(?:\s+(.+))?$/i);
    if (katMatch) {
        const my = parseMonthYearInput(katMatch[1]);
        const rows = db.prepare(`
            SELECT category, SUM(amount) as total, COUNT(*) as count
            FROM expenses
            WHERE substr(date, 1, 7) = ?
            GROUP BY category
            ORDER BY total DESC
        `).all(my.monthKey);

        let replyText = `*Rincian Pengeluaran per Kategori (${formatMonthKey(my.monthKey)}):*\n\n`;
        if (rows.length === 0) {
            replyText += `Belum ada pengeluaran tercatat pada periode ini.`;
        } else {
            const grandTotal = rows.reduce((a, b) => a + b.total, 0);
            replyText += `Total Pengeluaran: Rp ${Number(grandTotal).toLocaleString('id-ID')}\n\n`;
            rows.forEach((r, idx) => {
                const pct = grandTotal > 0 ? Math.round((r.total / grandTotal) * 100) : 0;
                replyText += `${idx + 1}. *${r.category}*: Rp ${Number(r.total).toLocaleString('id-ID')} (${pct}%) [${r.count} transaksi]\n`;
            });
            replyText += `\nKetik #ringkasan untuk melihat laporan lengkap.`;
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 9. Rekapitulasi Pembayaran: #list atau #daftar atau #rekap
    if (/^#?(list|daftar|rekap)$/i.test(trimmed)) {
        const rooms = db.prepare('SELECT * FROM rooms ORDER BY number ASC').all();
        const allInvoices = db.prepare(`
            SELECT i.*,
                   COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                   MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount
            FROM invoices i
            ORDER BY i.due_date ASC, i.created_at ASC
        `).all();

        const today = getTodayWIB();
        const nunggakList = [];
        const lunasList = [];
        const kosongList = [];
        let totalTunggakanSemua = 0;

        for (const room of rooms) {
            if (room.status !== 'TERISI') {
                kosongList.push(room);
                continue;
            }

            const roomInvoices = allInvoices.filter(i => i.room_id === room.id);
            const unpaidInvoices = roomInvoices.filter(i => i.status !== 'LUNAS');

            if (unpaidInvoices.length > 0) {
                let roomTotalRemaining = 0;
                const details = [];
                const allUnpaidMonths = [];

                for (const inv of unpaidInvoices) {
                    const rem = Number(inv.remaining_amount !== undefined ? inv.remaining_amount : inv.amount);
                    const paid = Number(inv.paid_amount || 0);
                    roomTotalRemaining += rem;
                    totalTunggakanSemua += rem;

                    const mList = getMonthsList(inv.month_year);
                    allUnpaidMonths.push(...mList);

                    const ov = getOverdueDetails(inv.due_date, inv.month_year, today);
                    const cicilInfo = paid > 0 ? ` (Masuk: Rp ${paid.toLocaleString('id-ID')})` : '';
                    const mListStr = mList.length > 1 ? ` [${mList.join(', ')}]` : '';
                    details.push(`   • ${inv.month_year}${mListStr}: Sisa Rp ${rem.toLocaleString('id-ID')}${cicilInfo} [${ov.overdueLabel}]`);
                }

                const monthsSummary = formatMonthsDisplay(allUnpaidMonths);
                nunggakList.push({
                    room,
                    totalRemaining: roomTotalRemaining,
                    monthsSummary,
                    monthsCount: allUnpaidMonths.length,
                    invoiceCount: unpaidInvoices.length,
                    details
                });
            } else {
                const lastInvoice = roomInvoices[roomInvoices.length - 1];
                lunasList.push({
                    room,
                    lastPeriod: lastInvoice ? lastInvoice.month_year : '-'
                });
            }
        }

        let replyText = `*REKAPITULASI PEMBAYARAN KONTRAKAN*\n` +
            `(${settings.app_name || 'Kontrakan Nenek Yuyun'})\n\n` +
            `*🔴 DAFTAR UNIT BELUM LUNAS / NUNGGAK (${nunggakList.length} Unit):*\n`;

        if (nunggakList.length === 0) {
            replyText += `Alhamdulillah, semua penghuni telah lunas!\n`;
        } else {
            nunggakList.forEach((item, idx) => {
                replyText += `${idx + 1}. *Unit ${item.room.number}* - ${item.room.tenant_name || '-'}\n` +
                    `   Total Sisa: *Rp ${item.totalRemaining.toLocaleString('id-ID')}* (${item.monthsCount} Bulan Sewa)\n` +
                    `   Bulan Nunggak: *${item.monthsSummary}*\n` +
                    item.details.join('\n') + '\n';
            });
        }

        replyText += `\n*🟢 DAFTAR UNIT SUDAH LUNAS (${lunasList.length} Unit):*\n`;
        if (lunasList.length === 0) {
            replyText += `Belum ada unit yang lunas.\n`;
        } else {
            lunasList.forEach((item, idx) => {
                replyText += `${idx + 1}. *Unit ${item.room.number}* - ${item.room.tenant_name || '-'}: *LUNAS* (${item.lastPeriod})\n`;
            });
        }

        if (kosongList.length > 0) {
            replyText += `\n*⚪ UNIT KOSONG (${kosongList.length} Unit):*\n` +
                kosongList.map(r => `• *Unit ${r.number}* (Tersedia)`).join(', ') + '\n';
        }

        replyText += `\n*Ringkasan:* \n` +
            `• Terisi: ${rooms.length - kosongList.length} Unit | Kosong: ${kosongList.length} Unit\n` +
            `• Lunas: ${lunasList.length} Unit | Nunggak/Cicil: ${nunggakList.length} Unit\n` +
            `• *Total Uang Tertunggak: Rp ${totalTunggakanSemua.toLocaleString('id-ID')}*`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 10. Cek Status: #status atau #cek
    if (/^#?(status|cek)$/i.test(trimmed)) {
        const rooms = db.prepare('SELECT * FROM rooms').all();
        const total = rooms.length;
        const occupied = rooms.filter(r => r.status === 'TERISI').length;
        const vacant = total - occupied;

        const unpaid = db.prepare(`
            SELECT i.*, r.number as room_number, r.tenant_name,
                   COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
                   MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount
            FROM invoices i
            JOIN rooms r ON i.room_id = r.id
            WHERE i.status != 'LUNAS'
            ORDER BY i.due_date ASC
        `).all();

        let replyText = `*Status Kontrakan Nenek Yuyun:*\n` +
            `Total Unit: ${total}\n` +
            `Terisi: ${occupied} unit | Kosong: ${vacant} unit\n\n` +
            `*Tagihan Belum Lunas (${unpaid.length} tagihan):*\n`;

        if (unpaid.length === 0) {
            replyText += `Semua unit telah lunas!`;
        } else {
            unpaid.forEach((u, idx) => {
                const sisa = Number(u.remaining_amount !== undefined ? u.remaining_amount : u.amount);
                const paid = Number(u.paid_amount || 0);
                const infoCicil = paid > 0 ? ` (Masuk: Rp ${paid.toLocaleString('id-ID')}, Sisa: Rp ${sisa.toLocaleString('id-ID')})` : ` Rp ${Number(u.amount).toLocaleString('id-ID')}`;
                const ov = getOverdueDetails(u.due_date, u.month_year);
                const mList = getMonthsList(u.month_year);
                const periodLabel = mList.length > 1 ? `*${u.month_year}* (Bulan: ${formatMonthsDisplay(mList)})` : `*${u.month_year}*`;
                replyText += `${idx + 1}. *${u.room_number}* (${u.tenant_name || '-'})\n` +
                             `   • Periode: ${periodLabel}\n` +
                             `   • Tagihan:${infoCicil}\n` +
                             `   • Keterlambatan: *${ov.overdueLabel}* (Jatuh tempo: ${u.due_date}) [${u.status}]\n`;
            });
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 11. Pelunasan / Cicilan Sewa: #lunas atau #bayar
    const lunasMatch = trimmed.match(/^#?(?:lunas|bayar)\s+([0-9a-zA-Z\.\-]+)(?:\s+(.+))?$/i);
    if (lunasMatch) {
        const queryUnit = lunasMatch[1].trim();
        const rawRest = lunasMatch[2] ? lunasMatch[2].trim() : '';
        let parsedAmount = null;
        let periodQuery = null;

        if (rawRest) {
            let workingText = rawRest;
            if (/^(full|semua|lunas)$/i.test(workingText)) {
                parsedAmount = 999999999;
            } else {
                const monthPattern = /(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agt|sep|okt|oct|nov|des|dec)(\s*[-–—]\s*(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agt|sep|okt|oct|nov|des|dec))?(\s+\d{2,4})?/i;
                const mMatch = workingText.match(monthPattern);
                if (mMatch) {
                    periodQuery = mMatch[0].trim();
                    workingText = workingText.replace(mMatch[0], ' ').trim();
                }

                if (workingText) {
                    const lower = workingText.toLowerCase().trim();
                    if (lower === 'full' || lower === 'semua' || lower === 'lunas') {
                        parsedAmount = 999999999;
                    } else {
                        parsedAmount = parseNominalTrace(lower);
                    }
                }
            }
        }

        const cleanQuery = queryUnit.replace(/[\.\-\s]/g, '').toLowerCase();
        const room = db.prepare(`
            SELECT * FROM rooms
            WHERE (REPLACE(REPLACE(REPLACE(LOWER(number), '.', ''), '-', ''), ' ', '') = ? 
               OR REPLACE(REPLACE(REPLACE(LOWER(id), '.', ''), '-', ''), ' ', '') = ?
               OR LOWER(number) = LOWER(?))
            LIMIT 1
        `).get(cleanQuery, cleanQuery, queryUnit);

        let replyText = '';
        if (room) {
            let targetInvoiceId = null;
            if (periodQuery) {
                const target = findTargetInvoiceForRoom(room.id, periodQuery);
                if (target) {
                    targetInvoiceId = target.id;
                } else {
                    const alreadyPaid = findPaidInvoiceForRoom(room.id, periodQuery);
                    if (alreadyPaid) {
                        replyText = `Tagihan Unit ${room.number} periode ${alreadyPaid.month_year} sudah berstatus LUNAS sebelumnya.`;
                        await safeSend(replyText);
                        return { success: true, replyText };
                    } else {
                        replyText = `Tidak ditemukan tagihan belum lunas untuk Unit ${room.number} dengan periode "${periodQuery}". Ketik #status atau #list untuk memeriksa daftar tagihan.`;
                        await safeSend(replyText);
                        return { success: false, replyText };
                    }
                }
            }

            const noteDesc = periodQuery 
                ? `Pembayaran periode ${periodQuery} via WA Bot`
                : 'Dicatat via WhatsApp Bot';

            const result = allocatePaymentFIFO({
                roomId: room.id,
                amount: parsedAmount,
                paymentMethod: 'CASH',
                paymentDate: getTodayWIB(),
                notes: noteDesc,
                targetInvoiceId
            });

            replyText = result.message;
        } else {
            replyText = `Unit kontrakan "${queryUnit}" tidak ditemukan. Contoh: #bayar 21-C 500k Agustus 2026 atau #lunas 21-A November 2026`;
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 12. Cek Keluhan: #keluhan atau #komplain
    if (/^#?(keluhan|komplain)$/i.test(trimmed)) {
        const rows = db.prepare(`
            SELECT c.*, r.number as room_number
            FROM complaints c
            JOIN rooms r ON c.room_id = r.id
            WHERE c.status != 'SELESAI'
            ORDER BY c.created_at DESC
        `).all();

        let replyText = '';
        if (rows.length === 0) {
            replyText = `*Daftar Keluhan Penghuni:*\n\nTidak ada keluhan aktif. Semua unit aman!`;
        } else {
            replyText = `*Daftar Keluhan Penghuni (${rows.length} belum selesai):*\n\n`;
            rows.forEach((c, idx) => {
                replyText += `${idx + 1}. *[${c.room_number}] ${c.tenant_name}*\n` +
                    `Kategori: ${c.category}\n` +
                    `Keluhan: "${c.description}"\n` +
                    `Status: *${c.status}*\n\n`;
            });
            replyText += `Buka dashboard untuk kelola: ${(settings.base_url || 'https://sekeluarga.web.id')}`;
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 13. Ringkasan Bulanan: #ringkasan
    const ringkasanMatch = trimmed.match(/^#?ringkasan(?:\s+(.+))?$/i);
    if (ringkasanMatch) {
        const my = parseMonthYearInput(ringkasanMatch[1]);
        const monthKey = my.monthKey;

        const { transactions, current_balance } = getUnifiedTransactions({ month: monthKey });
        const masukRows = transactions.filter(t => t.type === 'masuk');
        const keluarRows = transactions.filter(t => t.type === 'keluar');

        const masukTotal = masukRows.reduce((a, b) => a + b.amount, 0);
        const keluarTotal = keluarRows.reduce((a, b) => a + b.amount, 0);
        const selisih = masukTotal - keluarTotal;

        const bRow = db.prepare('SELECT amount FROM budgets WHERE month = ?').get(monthKey);

        const catMap = {};
        for (const k of keluarRows) {
            catMap[k.category] = (catMap[k.category] || 0) + k.amount;
        }
        const catSummary = Object.keys(catMap).map(c => `   • ${c}: Rp ${Number(catMap[c]).toLocaleString('id-ID')}`).join('\n');

        let replyText = `*Ringkasan Keuangan ${formatMonthKey(monthKey)}*\n` +
            `• Pemasukan (${masukRows.length}x): Rp ${Number(masukTotal).toLocaleString('id-ID')}\n` +
            `• Pengeluaran (${keluarRows.length}x): Rp ${Number(keluarTotal).toLocaleString('id-ID')}\n` +
            `• Selisih Periode: Rp ${Number(selisih).toLocaleString('id-ID')}\n` +
            `• Saldo Uang Saat Ini: Rp ${Number(current_balance).toLocaleString('id-ID')}`;

        if (catSummary) {
            replyText += `\n\n*Rincian Kategori Pengeluaran:*\n${catSummary}`;
        }

        if (bRow && bRow.amount > 0) {
            const pct = Math.round((keluarTotal / bRow.amount) * 100);
            const rem = Math.max(bRow.amount - keluarTotal, 0);
            replyText += `\n\n*Status Anggaran:*\n` +
                `Batas: Rp ${Number(bRow.amount).toLocaleString('id-ID')} | Terpakai: ${pct}% | Sisa: Rp ${Number(rem).toLocaleString('id-ID')}`;
            if (keluarTotal > bRow.amount) {
                replyText += `\n[PERINGATAN] Melebihi anggaran sebesar Rp ${Number(keluarTotal - bRow.amount).toLocaleString('id-ID')}!`;
            }
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 14. Ringkasan Tahunan: #tahunan
    const tahunanMatch = trimmed.match(/^#?tahunan(?:\s+(\d{4}))?$/i);
    if (tahunanMatch) {
        const tTahun = tahunanMatch[1] ? tahunanMatch[1] : getTodayWIB().slice(0, 4);

        const { transactions } = getUnifiedTransactions({ year: tTahun });
        const masukRows = transactions.filter(t => t.type === 'masuk');
        const keluarRows = transactions.filter(t => t.type === 'keluar');

        const masukTotal = masukRows.reduce((a, b) => a + b.amount, 0);
        const keluarTotal = keluarRows.reduce((a, b) => a + b.amount, 0);
        const avgMasuk = Math.round(masukTotal / 12);
        const avgKeluar = Math.round(keluarTotal / 12);

        const replyText = `*Ringkasan Tahunan ${tTahun}*\n` +
            `• Total Pemasukan (${masukRows.length} transaksi): Rp ${Number(masukTotal).toLocaleString('id-ID')}\n` +
            `• Total Pengeluaran (${keluarRows.length} transaksi): Rp ${Number(keluarTotal).toLocaleString('id-ID')}\n` +
            `• Laba Bersih Tahunan: Rp ${Number(masukTotal - keluarTotal).toLocaleString('id-ID')}\n` +
            `• Rata-rata Pemasukan / Bulan: Rp ${Number(avgMasuk).toLocaleString('id-ID')}\n` +
            `• Rata-rata Pengeluaran / Bulan: Rp ${Number(avgKeluar).toLocaleString('id-ID')}`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 15. Analisis Lintas Bulan: #analisis
    if (/^#?analisis$/i.test(trimmed)) {
        const a = getTraceFundAnalytics();
        if (a.months.length === 0) {
            const replyText = 'Belum ada data transaksi untuk dianalisis.';
            await safeSend(replyText);
            return { success: true, replyText };
        }

        let tableText = 'BULAN    | MASUK       | KELUAR      | SELISIH     | SALDO\n';
        tableText += '---------+-------------+-------------+-------------+-------------\n';
        for (const m of [...a.months].reverse()) {
            const bStr = m.month_short.padEnd(8);
            const mStr = formatRupiahTrace(m.income).padStart(11);
            const kStr = formatRupiahTrace(m.expense).padStart(11);
            const sStr = formatRupiahTrace(m.diff).padStart(11);
            const salStr = formatRupiahTrace(m.cumulative_balance).padStart(11);
            tableText += `${bStr} | ${mStr} | ${kStr} | ${sStr} | ${salStr}\n`;
        }

        const replyText = `*Analisis Keuangan Lintas Bulan*\n` +
            `Saldo uang saat ini: *${formatRupiahTrace(a.current_balance)}*\n` +
            `Pemasukan terbesar: *${a.highest_income ? formatMonthKey(a.highest_income.month) : '-'}* (${formatRupiahTrace(a.highest_income ? a.highest_income.income : 0)})\n` +
            `Pengeluaran terbesar: *${a.highest_expense ? formatMonthKey(a.highest_expense.month) : '-'}* (${formatRupiahTrace(a.highest_expense ? a.highest_expense.expense : 0)})\n` +
            `Selisih terbaik: *${a.best_diff ? formatMonthKey(a.best_diff.month) : '-'}* (${formatRupiahTrace(a.best_diff ? a.best_diff.diff : 0)})\n` +
            `Selisih terburuk: *${a.worst_diff ? formatMonthKey(a.worst_diff.month) : '-'}* (${formatRupiahTrace(a.worst_diff ? a.worst_diff.diff : 0)})\n\n` +
            `\`\`\`\n${tableText}\`\`\``;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 16. Total Pengeluaran: #total
    const totalMatch = trimmed.match(/^#?total(?:\s+(.+))?$/i);
    if (totalMatch) {
        const kw = totalMatch[1] ? totalMatch[1].trim() : '';
        const { transactions } = getUnifiedTransactions({ keyword: kw, type: 'keluar' });

        const count = transactions.length;
        const sum = transactions.reduce((a, b) => a + b.amount, 0);

        let replyText = `*Total Pengeluaran untuk "${kw || 'Semua Pengeluaran'}"*\n` +
            `${count} transaksi: *${formatRupiahTrace(sum)}*\n\n`;

        if (count === 0) {
            replyText += 'Tidak ada transaksi pengeluaran yang cocok.';
        } else {
            replyText += 'Daftar transaksi terakhir:\n';
            transactions.slice(-10).reverse().forEach((t, i) => {
                replyText += `${i + 1}. ${t.date} | ${formatRupiahTrace(t.amount)} | ${t.description}\n`;
            });
            if (count > 10) {
                replyText += `_...dan ${count - 10} transaksi lainnya (lihat dashboard/ekspor CSV)._`;
            }
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 17. Riwayat: #riwayat
    if (/^#?riwayat$/i.test(trimmed)) {
        const { transactions, current_balance } = getUnifiedTransactions();
        const recent = transactions.slice(-10).reverse();

        let replyText = `*10 Transaksi Terakhir (Saldo Uang Saat Ini: ${formatRupiahTrace(current_balance)}):*\n\n`;
        if (recent.length === 0) {
            replyText += 'Belum ada transaksi tercatat.';
        } else {
            recent.forEach((t, idx) => {
                const tanda = t.type === 'masuk' ? '(+)' : '(-)';
                replyText += `${idx + 1}. ${t.date} ${tanda} ${formatRupiahTrace(t.amount)}\n` +
                    `   ${t.description}\n` +
                    `   _Saldo: ${formatRupiahTrace(t.running_balance)}_\n`;
            });
        }

        await safeSend(replyText);
        return { success: true, replyText };
    }

    // 18. Ekspor CSV: #ekspor atau #csv
    const eksporMatch = trimmed.match(/^#?(?:ekspor|csv)(?:\s+(.+))?$/i);
    if (eksporMatch) {
        const rawArg = eksporMatch[1] ? eksporMatch[1].trim() : '';
        let exportUrl = `${settings.base_url || 'https://sekeluarga.web.id'}/api/tracefund/export-csv`;
        let periodLabel = 'Seluruh Periode';

        if (rawArg) {
            const my = parseMonthYearInput(rawArg);
            exportUrl += `?month=${my.monthKey}`;
            periodLabel = formatMonthKey(my.monthKey);
        }

        const replyText = `*Unduh Rekapitulasi Data Keuangan (CSV)*\n` +
            `Periode: ${periodLabel}\n\n` +
            `Silakan unduh laporan lengkap melalui tautan berikut:\n` +
            `${exportUrl}\n\n` +
            `File CSV dapat dibuka langsung menggunakan Microsoft Excel atau Google Sheets.`;

        await safeSend(replyText);
        return { success: true, replyText };
    }

    return { success: false, message: 'Format perintah tidak dikenali. Ketik #bantuan untuk melihat menu.' };
}

async function sendUnifiedWhatsApp(target, message) {
    let cleanPhone = target.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('+62')) cleanPhone = cleanPhone.slice(1);

    if (waSocket && waStatus === 'CONNECTED') {
        try {
            const jid = `${cleanPhone}@s.whatsapp.net`;
            await waSocket.sendMessage(jid, { text: message });
            return { success: true, method: 'BAILEYS' };
        } catch (e) {
            console.error('Gagal kirim via Baileys, mencoba fallback:', e.message);
        }
    }

    const settings = getSettings();
    if (settings.wa_token) {
        return await sendWhatsAppFonnte(settings.wa_token, cleanPhone, message);
    }

    return {
        success: false,
        error: 'WhatsApp Bot Mandiri belum terhubung dan token Fonnte belum diatur. Gunakan tombol link wa.me manual.'
    };
}

async function sendWhatsAppFonnte(token, target, message) {
    if (!token) return { success: false, error: 'Token WhatsApp Fonnte belum diatur' };
    try {
        const res = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target: target,
                message: message,
                countryCode: '62'
            })
        });
        const data = await res.json();
        return { success: Boolean(data.status), data };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function getWaStatus() {
    return {
        status: waStatus,
        qr: waQrDataUrl,
        connected_user: waConnectedUser
    };
}

async function logoutWhatsAppClient() {
    try {
        if (waSocket) {
            await waSocket.logout();
        }
    } catch (_) {}
    try {
        fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
    } catch (_) {}
    waStatus = 'DISCONNECTED';
    waQrDataUrl = null;
    waConnectedUser = null;
    initWhatsAppClient().catch(() => {});
}

module.exports = {
    initWhatsAppClient,
    getWaStatus,
    logoutWhatsAppClient,
    sendUnifiedWhatsApp,
    sendWhatsAppFonnte,
    handleIncomingWhatsAppMessage
};
