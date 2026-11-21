const crypto = require('node:crypto');
const { db } = require('../config/database');
const { getTodayWIB, getMonthYearWIB, MONTH_NAMES_ID, getMonthsList } = require('../utils/time');

function recalculateInvoiceStatus(invoiceId, clearVerification = false) {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return null;

    const payments = db.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date ASC').all(invoiceId);
    const paid = payments.reduce((acc, p) => acc + p.amount, 0);

    // Proteksi: Jika tidak ada baris cicilan di invoice_payments tetapi invoice sudah berstatus LUNAS, pertahankan status LUNAS
    if (payments.length === 0 && invoice.status === 'LUNAS' && !clearVerification) {
        return {
            status: 'LUNAS',
            paid_amount: invoice.amount,
            remaining_amount: 0
        };
    }

    let newStatus = 'BELUM_BAYAR';
    let paidAt = null;
    let method = invoice.payment_method;

    const lastPayment = payments[payments.length - 1];

    if (paid >= invoice.amount) {
        newStatus = 'LUNAS';
        paidAt = lastPayment ? (lastPayment.payment_date + 'T12:00:00Z') : (invoice.paid_at || new Date().toISOString());
        method = lastPayment ? lastPayment.payment_method : (invoice.payment_method || 'TRANSFER');
    } else if (paid > 0) {
        newStatus = 'SEBAGIAN';
        method = lastPayment ? lastPayment.payment_method : 'TRANSFER';
    } else if (invoice.status === 'MENUNGGU_VERIFIKASI') {
        newStatus = clearVerification ? 'BELUM_BAYAR' : 'MENUNGGU_VERIFIKASI';
    }

    db.prepare(`
        UPDATE invoices
        SET status = ?, paid_at = ?, payment_method = COALESCE(?, payment_method)
        WHERE id = ?
    `).run(newStatus, paidAt, method, invoiceId);

    return {
        status: newStatus,
        paid_amount: paid,
        remaining_amount: Math.max(invoice.amount - paid, 0)
    };
}

function allocatePaymentFIFO({ roomId, amount, paymentMethod = 'TRANSFER', paymentDate = null, notes = '', targetInvoiceId = null }) {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
        return { success: false, message: 'Data unit kontrakan tidak ditemukan' };
    }

    // Ambil seluruh tagihan yang belum lunas untuk unit ini, urutkan dari yang paling lama jatuh tempo
    let unpaidInvoices = db.prepare(`
        SELECT i.*,
               COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0) as paid_amount,
               MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id), 0), 0) as remaining_amount
        FROM invoices i
        WHERE i.room_id = ? AND i.status != 'LUNAS'
        ORDER BY i.due_date ASC, i.created_at ASC
    `).all(roomId);

    if (unpaidInvoices.length === 0) {
        return {
            success: false,
            message: `Unit ${room.number} (${room.tenant_name || '-'}) tidak memiliki tagihan tertunggak.`
        };
    }

    // Jika ada targetInvoiceId spesifik, prioritaskan di urutan pertama
    if (targetInvoiceId) {
        const targetIdx = unpaidInvoices.findIndex(i => i.id === targetInvoiceId);
        if (targetIdx > 0) {
            const targetInv = unpaidInvoices.splice(targetIdx, 1)[0];
            unpaidInvoices.unshift(targetInv);
        }
    }

    const payDate = paymentDate || getTodayWIB();
    const payMethod = paymentMethod || 'TRANSFER';

    let remainingToAllocate = Number(amount);
    if (isNaN(remainingToAllocate) || remainingToAllocate <= 0) {
        if (targetInvoiceId) {
            const targetInv = unpaidInvoices.find(i => i.id === targetInvoiceId);
            if (targetInv && targetInv.remaining_amount > 0) {
                remainingToAllocate = targetInv.remaining_amount;
            } else {
                remainingToAllocate = unpaidInvoices[0].remaining_amount;
            }
        } else {
            remainingToAllocate = unpaidInvoices[0].remaining_amount;
        }
    }

    const totalOutstanding = unpaidInvoices.reduce((acc, inv) => acc + inv.remaining_amount, 0);
    const totalAllocated = Math.min(remainingToAllocate, totalOutstanding);
    let pool = totalAllocated;

    const allocations = [];
    const timestamp = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
        for (let idx = 0; idx < unpaidInvoices.length; idx++) {
            if (pool <= 0) break;
            const inv = unpaidInvoices[idx];
            const needed = inv.remaining_amount;
            if (needed <= 0) continue;

            const portion = Math.min(pool, needed);
            pool -= portion;

            const payId = `PAY-${Date.now()}-${idx + 1}`;
            const noteStr = notes 
                ? `${notes} (FIFO: ${inv.month_year})`
                : `Alokasi FIFO tunggakan terlama (${inv.month_year})`;

            db.prepare(`
                INSERT INTO invoice_payments (id, invoice_id, amount, payment_method, payment_date, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(payId, inv.id, portion, payMethod, payDate, noteStr, timestamp);

            const newStatus = recalculateInvoiceStatus(inv.id);
            allocations.push({
                invoice_id: inv.id,
                month_year: inv.month_year,
                allocated_amount: portion,
                new_status: newStatus.status,
                remaining_amount: newStatus.remaining_amount
            });
        }

        if (targetInvoiceId) {
            const target = db.prepare('SELECT status FROM invoices WHERE id = ?').get(targetInvoiceId);
            if (target && target.status === 'MENUNGGU_VERIFIKASI') {
                recalculateInvoiceStatus(targetInvoiceId, true);
            }
        }

        const excess = remainingToAllocate - totalAllocated;
        if (excess > 0) {
            const excessIncId = `INC-EXCESS-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            const invTag = targetInvoiceId ? ` tagihan ${targetInvoiceId}` : '';
            db.prepare(`
                INSERT INTO general_incomes (id, date, category, amount, note, created_at)
                VALUES (?, ?, 'Titipan Sewa', ?, ?, ?)
            `).run(
                excessIncId,
                payDate,
                excess,
                `Kelebihan pembayaran sewa Unit ${room.number} (${room.tenant_name || '-'})${invTag}`,
                timestamp
            );
        }

        db.exec('COMMIT;');
    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }

    let message = '';
    if (allocations.length === 1) {
        const a = allocations[0];
        if (a.new_status === 'LUNAS') {
            message = `Tagihan ${room.number} periode ${a.month_year} berhasil dilunasi penuh (Rp ${a.allocated_amount.toLocaleString('id-ID')}). Status: LUNAS.`;
        } else {
            message = `Pembayaran cicilan Rp ${a.allocated_amount.toLocaleString('id-ID')} dicatat untuk unit ${room.number} periode ${a.month_year}. Sisa tagihan: Rp ${a.remaining_amount.toLocaleString('id-ID')}. Status: SEBAGIAN.`;
        }
    } else {
        const details = allocations.map(a => 
            `• ${a.month_year}: Masuk Rp ${a.allocated_amount.toLocaleString('id-ID')} -> ${a.new_status === 'LUNAS' ? 'LUNAS' : `Sisa Rp ${a.remaining_amount.toLocaleString('id-ID')}`}`
        );
        message = `Pembayaran total Rp ${totalAllocated.toLocaleString('id-ID')} untuk Unit ${room.number} berhasil dialokasikan secara FIFO ke ${allocations.length} periode:\n` + details.join('\n');
    }

    const excess = remainingToAllocate - totalAllocated;
    if (excess > 0) {
        message += `\n(Catatan: Terdapat kelebihan dana Rp ${excess.toLocaleString('id-ID')} yang otomatis dicatat ke Kas Pemasukan Titipan Sewa).`;
    }

    return {
        success: true,
        message,
        room_number: room.number,
        tenant_name: room.tenant_name,
        total_allocated: totalAllocated,
        excess_amount: excess,
        allocations
    };
}

function findTargetInvoiceForRoom(roomId, periodQuery) {
    if (!periodQuery) return null;
    const unpaid = db.prepare('SELECT * FROM invoices WHERE room_id = ? AND status != \'LUNAS\' ORDER BY due_date ASC').all(roomId);
    const q = periodQuery.toLowerCase().trim();

    for (const inv of unpaid) {
        if (inv.month_year.toLowerCase().includes(q)) return inv;
        const months = getMonthsList(inv.month_year);
        if (months.some(m => m.toLowerCase().includes(q))) return inv;
    }

    const monthAliases = {
        'jan': 'januari', 'feb': 'februari', 'mar': 'maret', 'apr': 'april',
        'mei': 'mei', 'jun': 'juni', 'jul': 'juli', 'agu': 'agustus',
        'agt': 'agustus', 'sep': 'september', 'okt': 'oktober', 'oct': 'oktober',
        'nov': 'november', 'des': 'desember', 'dec': 'desember'
    };
    for (const [shortM, fullM] of Object.entries(monthAliases)) {
        if (q.includes(shortM)) {
            for (const inv of unpaid) {
                if (inv.month_year.toLowerCase().includes(fullM)) return inv;
                const months = getMonthsList(inv.month_year);
                if (months.some(m => m.toLowerCase().includes(fullM))) return inv;
            }
        }
    }
    return null;
}

function findPaidInvoiceForRoom(roomId, periodQuery) {
    if (!periodQuery) return null;
    const paid = db.prepare('SELECT * FROM invoices WHERE room_id = ? AND status = \'LUNAS\' ORDER BY due_date DESC').all(roomId);
    const q = periodQuery.toLowerCase().trim();

    for (const inv of paid) {
        if (inv.month_year.toLowerCase().includes(q)) return inv;
        const months = getMonthsList(inv.month_year);
        if (months.some(m => m.toLowerCase().includes(q))) return inv;
    }

    const monthAliases = {
        'jan': 'januari', 'feb': 'februari', 'mar': 'maret', 'apr': 'april',
        'mei': 'mei', 'jun': 'juni', 'jul': 'juli', 'agu': 'agustus',
        'agt': 'agustus', 'sep': 'september', 'okt': 'oktober', 'oct': 'oktober',
        'nov': 'november', 'des': 'desember', 'dec': 'desember'
    };
    for (const [shortM, fullM] of Object.entries(monthAliases)) {
        if (q.includes(shortM)) {
            for (const inv of paid) {
                if (inv.month_year.toLowerCase().includes(fullM)) return inv;
                const months = getMonthsList(inv.month_year);
                if (months.some(m => m.toLowerCase().includes(fullM))) return inv;
            }
        }
    }
    return null;
}

function generateMonthlyInvoices(targetMonthYear = null, targetDueYm = null) {
    const ym = targetDueYm || getMonthYearWIB();
    const [yStr, mStr] = ym.split('-');
    const mIdx = parseInt(mStr, 10) - 1;
    const monthYear = targetMonthYear || `${MONTH_NAMES_ID[mIdx] || mStr} ${yStr}`;

    const occupiedRooms = db.prepare("SELECT * FROM rooms WHERE status = 'TERISI'").all();
    if (occupiedRooms.length === 0) {
        return { success: false, count: 0, message: 'Tidak ada unit berstatus TERISI saat ini' };
    }

    let createdCount = 0;
    const insertStmt = db.prepare(`
        INSERT INTO invoices (id, room_id, month_year, amount, due_date, status, access_token, created_at)
        VALUES (?, ?, ?, ?, ?, 'BELUM_BAYAR', ?, ?)
    `);

    db.exec('BEGIN IMMEDIATE;');
    try {
        for (const r of occupiedRooms) {
            const exists = db.prepare('SELECT id FROM invoices WHERE room_id = ? AND month_year = ?').get(r.id, month_year);
            if (!exists) {
                const dayStr = String(r.due_day || 1).padStart(2, '0');
                const dueDate = `${ym}-${dayStr}`;
                const invId = `INV-${ym.replace('-', '')}-${r.number.replace(/\s+/g, '').toUpperCase()}-${crypto.randomBytes(4).toString('hex')}`;
                const token = crypto.randomBytes(12).toString('hex');
                insertStmt.run(invId, r.id, month_year, r.price, dueDate, token, new Date().toISOString());
                createdCount++;
            }
        }
        db.exec('COMMIT;');
    } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
    }

    return {
        success: true,
        count: createdCount,
        month_year: monthYear,
        message: `Berhasil menerbitkan ${createdCount} tagihan baru untuk periode ${monthYear}`
    };
}

module.exports = {
    recalculateInvoiceStatus,
    allocatePaymentFIFO,
    findTargetInvoiceForRoom,
    findPaidInvoiceForRoom,
    generateMonthlyInvoices
};
