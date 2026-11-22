const { db, getSettings, setSetting } = require('../config/database');
const { getTodayWIB, getHourWIB, getDueDateDetails, getOverdueDetails, getMonthsList, formatMonthsDisplay } = require('../utils/time');
const { escapeHtml } = require('../utils/security');
const { sendUnifiedWhatsApp } = require('./whatsapp');
const { generateMonthlyInvoices } = require('./billing');
const { createDatabaseBackup } = require('./tracefund');

let nodemailer;
try {
    nodemailer = require('nodemailer');
} catch (_) {
    nodemailer = null;
}

function logNotification(invoiceId, channel, recipient, status, message) {
    try {
        db.prepare(`
            INSERT INTO notification_logs (id, invoice_id, channel, recipient, status, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            invoiceId,
            channel,
            recipient,
            status,
            message,
            new Date().toISOString()
        );
    } catch (e) {
        console.error('Gagal mencatat log notifikasi:', e.message);
    }
}

async function sendEmailNotification(settings, toEmail, subject, htmlContent) {
    if (!nodemailer) return { success: false, error: 'Module nodemailer tidak terpasang' };
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
        return { success: false, error: 'Konfigurasi SMTP belum lengkap di Pengaturan' };
    }
    try {
        const transporter = nodemailer.createTransport({
            host: settings.smtp_host,
            port: Number(settings.smtp_port || 587),
            secure: settings.smtp_secure === '1' || Number(settings.smtp_port) === 465,
            auth: {
                user: settings.smtp_user,
                pass: settings.smtp_pass
            }
        });

        const info = await transporter.sendMail({
            from: settings.smtp_from || `Kontrakan Nenek Yuyun <${settings.smtp_user}>`,
            to: toEmail,
            subject: subject,
            html: htmlContent
        });
        return { success: true, messageId: info.messageId };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function buildEmailHtml(settings, inv, payUrl, milestone) {
    const formattedAmount = Number(inv.amount).toLocaleString('id-ID');
    const appName = escapeHtml(settings.app_name || 'Kontrakan Nenek Yuyun');
    const ownerName = escapeHtml(settings.owner_name || 'Pengelola Kontrakan');
    const ownerPhone = escapeHtml(settings.owner_phone || '-');
    const ownerAddress = escapeHtml(settings.owner_address || '-');
    const bankName = escapeHtml(settings.bank_name || 'BCA');
    const bankAccount = escapeHtml(settings.bank_account || '-');
    const bankHolder = escapeHtml(settings.bank_holder || ownerName);

    const safeTenant = escapeHtml(inv.tenant_name || 'Penghuni');
    const safeInvId = escapeHtml(inv.id);
    const safeRoomNumber = escapeHtml(inv.room_number);
    const safeMonthYear = escapeHtml(inv.month_year);
    const safeDueDate = escapeHtml(inv.due_date);
    const safeMilestone = milestone ? escapeHtml(milestone) : null;
    const safePayUrl = escapeHtml(payUrl);

    return `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tagihan Sewa Kontrakan</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
    <div style="max-width: 600px; margin: 30px auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0;">
        <div style="background: linear-gradient(135deg, #4338ca, #6366f1); padding: 32px 24px; text-align: center; color: #ffffff;">
            <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; opacity: 0.85;">Pemberitahuan Tagihan Sewa</p>
            <h1 style="margin: 8px 0 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">${appName}</h1>
        </div>

        <div style="padding: 28px 24px;">
            <p style="margin: 0 0 12px; font-size: 15px; color: #334155;">
                Halo <strong>${safeTenant}</strong>,
            </p>
            <p style="margin: 0 0 20px; font-size: 13.5px; line-height: 1.6; color: #475569;">
                Berikut adalah rincian tagihan sewa unit kontrakan Anda untuk periode <strong>${safeMonthYear}</strong>:
            </p>

            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr>
                        <td style="padding: 6px 0; color: #64748b;">No. Tagihan</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0f172a; font-family: monospace;">${safeInvId}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; color: #64748b;">Unit Kontrakan</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0f172a;">${safeRoomNumber}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; color: #64748b;">Periode Sewa</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0f172a;">${safeMonthYear}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; color: #64748b;">Jatuh Tempo</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #e11d48;">${safeDueDate}</td>
                    </tr>
                    ${safeMilestone ? `
                    <tr>
                        <td style="padding: 6px 0; color: #64748b;">Status</td>
                        <td style="padding: 6px 0; text-align: right;">
                            <span style="display: inline-block; background-color: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 9999px;">
                                ${safeMilestone}
                            </span>
                        </td>
                    </tr>` : ''}
                    <tr style="border-top: 1px solid #cbd5e1;">
                        <td style="padding: 14px 0 4px; font-size: 14px; font-weight: 700; color: #0f172a;">Total Tagihan</td>
                        <td style="padding: 14px 0 4px; text-align: right; font-size: 18px; font-weight: 800; color: #4338ca;">
                            Rp ${formattedAmount}
                        </td>
                    </tr>
                </table>
            </div>

            <div style="text-align: center; margin: 28px 0;">
                <a href="${safePayUrl}" style="background-color: #4338ca; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 14px; display: inline-block; box-shadow: 0 4px 10px rgba(67, 56, 202, 0.25);">
                    Buka Tagihan & Pembayaran
                </a>
            </div>

            <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
                <p style="margin: 0 0 8px; font-size: 12.5px; font-weight: 700; color: #1e40af;">Pilihan Metode Pembayaran:</p>
                <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: #1e3a8a; line-height: 1.6;">
                    <li><strong>Transfer Bank ${bankName}:</strong> ${bankAccount} a.n. ${bankHolder}</li>
                    <li><strong>QRIS:</strong> Tersedia di halaman tagihan online.</li>
                    <li><strong>Bayar Tunai:</strong> Pengelola: ${ownerAddress}</li>
                </ul>
            </div>

            <div style="border-top: 1px solid #e2e8f0; padding-top: 18px; font-size: 12px; color: #64748b; line-height: 1.5;">
                <p style="margin: 0 0 4px;"><strong>Informasi & Bantuan:</strong></p>
                <p style="margin: 0;">WhatsApp: <strong>${ownerPhone}</strong> | Nama: <strong>${ownerName}</strong></p>
            </div>
        </div>

        <div style="background-color: #f8fafc; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0;">Email ini dibuat dan dikirim secara otomatis oleh sistem administrasi ${appName}.</p>
        </div>
    </div>
</body>
</html>
    `;
}

async function runReminderCheck(forceOverdue = false) {
    const today = getTodayWIB();
    const currentHour = getHourWIB();

    // Hanya kirim pada jam wajar (08:00 - 20:00 WIB) jika berjalan otomatis
    if (!forceOverdue && (currentHour < 8 || currentHour >= 20)) {
        return [];
    }

    const settings = getSettings();
    const baseUrl = settings.base_url || 'https://sekeluarga.web.id';

    const unpaidInvoices = db.prepare(`
        SELECT i.*,
               COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id AND deleted_at IS NULL), 0) as paid_amount,
               MAX(i.amount - COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = i.id AND deleted_at IS NULL), 0), 0) as remaining_amount,
               r.number as room_number, r.tenant_name, r.tenant_phone, r.tenant_email
        FROM invoices i
        JOIN rooms r ON i.room_id = r.id
        WHERE i.status IN ('BELUM_BAYAR', 'SEBAGIAN') AND i.deleted_at IS NULL AND r.deleted_at IS NULL
    `).all();

    const results = [];

    for (const inv of unpaidInvoices) {
        const remaining = Number(inv.remaining_amount !== undefined ? inv.remaining_amount : inv.amount);
        const paid = Number(inv.paid_amount || 0);
        if (remaining <= 0) continue;

        if (!forceOverdue) {
            const alreadySentToday = db.prepare(`
                SELECT id FROM notification_logs 
                WHERE invoice_id = ? AND created_at LIKE ? AND status = 'SUCCESS'
            `).get(inv.id, `${today}%`);
            if (alreadySentToday) continue;
        }

        const ov = getOverdueDetails(inv.due_date, inv.month_year, today);
        const diffDays = ov.diffDays;
        const mList = getMonthsList(inv.month_year);
        const periodDisplay = mList.length > 1 ? formatMonthsDisplay(mList) : inv.month_year;

        let milestone = null;
        let updateField = null;

        if (diffDays === 3 && (!inv.notified_h3 || forceOverdue)) {
            milestone = 'H-3 (3 Hari Menjelang Jatuh Tempo)';
            updateField = 'notified_h3';
        } else if (diffDays === 1 && (!inv.notified_h1 || forceOverdue)) {
            milestone = 'H-1 (Besok Jatuh Tempo)';
            updateField = 'notified_h1';
        } else if (diffDays === 0 && (!inv.notified_h0 || forceOverdue)) {
            milestone = 'Hari Ini Jatuh Tempo';
            updateField = 'notified_h0';
        } else if (diffDays < 0 && (Math.abs(diffDays) % 7 === 0 || forceOverdue)) {
            milestone = `Lewat Jatuh Tempo (${ov.overdueLabel})`;
            updateField = null;
        }

        if (milestone) {
            const tokenParam = inv.access_token ? `&token=${encodeURIComponent(inv.access_token)}` : '';
            const payUrl = `${baseUrl}/tagihan.html?id=${encodeURIComponent(inv.id)}${tokenParam}`;
            
            const waMessage = `Halo Kak ${inv.tenant_name || ''},\n\n` +
                `Pemberitahuan tagihan sewa *${settings.app_name || 'Kontrakan Nenek Yuyun'}* untuk unit *${inv.room_number}*.\n\n` +
                `*Rincian Tagihan Belum Lunas:*\n` +
                `• Periode Sewa: *${inv.month_year}* (${periodDisplay})\n` +
                `• Status Keterlambatan: *${ov.overdueLabel}* (Jatuh tempo: ${inv.due_date})\n` +
                `• Total Tagihan Periode: *Rp ${Number(inv.amount).toLocaleString('id-ID')}*\n` +
                (paid > 0 ? `• Sudah Masuk (Cicilan): *Rp ${paid.toLocaleString('id-ID')}*\n` : '') +
                `• Sisa Wajib Dibayar: *Rp ${remaining.toLocaleString('id-ID')}*\n\n` +
                `Mohon kerjasamanya untuk menyelesaikan pembayaran melalui tautan berikut:\n${payUrl}\n\n` +
                `Terima kasih.`;

            let waStatusResult = 'SKIPPED';
            if (inv.tenant_phone) {
                const waRes = await sendUnifiedWhatsApp(inv.tenant_phone, waMessage);
                waStatusResult = waRes.success ? 'SUCCESS' : 'FAILED';
                logNotification(inv.id, 'WHATSAPP', inv.tenant_phone, waStatusResult, waRes.error || `Terkirim via ${waRes.method || 'Fonnte'}`);
            }

            let emailStatus = 'SKIPPED';
            if (inv.tenant_email && settings.smtp_host) {
                const html = buildEmailHtml(settings, inv, payUrl, milestone);
                const emRes = await sendEmailNotification(settings, inv.tenant_email, `[Pengingat Tagihan] Sewa ${inv.room_number} - ${settings.app_name}`, html);
                emailStatus = emRes.success ? 'SUCCESS' : 'FAILED';
                logNotification(inv.id, 'EMAIL', inv.tenant_email, emailStatus, emRes.error || 'Terkirim via SMTP');
            }

            if (updateField) {
                db.prepare(`UPDATE invoices SET ${updateField} = 1 WHERE id = ?`).run(inv.id);
            }
            results.push({ invoiceId: inv.id, unit: inv.room_number, milestone, waStatus: waStatusResult, emailStatus });
        }
    }

    return results;
}

function startBackgroundSchedulers() {
    const hourlySchedulerTimer = setInterval(() => {
        runReminderCheck().catch(err => console.error('[Scheduler] Error auto-scheduler:', err.message));

        const hour = getHourWIB();
        const today = getTodayWIB();
        const currentYm = today.slice(0, 7);
        const settings = getSettings();

        // Pencadangan database otomatis setiap hari pada atau setelah pukul 02:00 WIB
        if (hour >= 2 && settings.last_backup_date !== today) {
            try {
                createDatabaseBackup();
                setSetting('last_backup_date', today);
            } catch (err) {
                console.error('[Auto-Backup] Gagal mencadangkan database:', err.message);
            }
        }

        // Penerbitan tagihan bulanan otomatis pada tanggal 1 pada atau setelah pukul 08:00 WIB
        if (today.endsWith('-01') && hour >= 8 && settings.last_billing_period !== currentYm) {
            try {
                const res = generateMonthlyInvoices();
                if (res.success) {
                    setSetting('last_billing_period', currentYm);
                    if (res.count > 0) {
                        console.log(`[Auto-Billing] Berhasil menerbitkan ${res.count} tagihan baru.`);
                    }
                }
            } catch (err) {
                console.error('[Auto-Billing] Gagal:', err.message);
            }
        }
    }, 60 * 60 * 1000);
    hourlySchedulerTimer.unref();

    const startupReminderTimer = setTimeout(() => {
        try {
            createDatabaseBackup();
        } catch (err) {
            console.error('[Auto-Backup Startup] Gagal:', err.message);
        }
        runReminderCheck().then(res => {
            if (res.length > 0) {
                console.log(`[Auto-Reminder] Pengingat otomatis terkirim untuk ${res.length} tagihan.`);
            }
        }).catch(err => console.error('[Auto-Reminder] Gagal:', err.message));
    }, 10000);
    startupReminderTimer.unref();
}

function buildSystemNoticeEmailHtml(settings) {
    const appName = escapeHtml(settings.app_name || 'Kontrakan Nenek Yuyun');
    const ownerName = escapeHtml(settings.owner_name || 'Pengelola Kontrakan');
    const ownerPhone = escapeHtml(settings.owner_phone || '-');
    const ownerAddress = escapeHtml(settings.owner_address || '-');
    const baseUrl = escapeHtml(settings.base_url || 'https://sekeluarga.web.id');

    return `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pemberitahuan Sistem Kontrakan</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
    <div style="max-width: 600px; margin: 30px auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #059669, #10b981); padding: 32px 24px; text-align: center; color: #ffffff;">
            <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; opacity: 0.9;">Pemberitahuan Resmi Sistem</p>
            <h1 style="margin: 8px 0 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">${appName}</h1>
        </div>

        <div style="padding: 28px 24px;">
            <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 700; color: #0f172a;">
                Layanan Notifikasi Email Resmi Telah Aktif
            </h2>
            <p style="margin: 0 0 16px; font-size: 13.5px; line-height: 1.6; color: #475569;">
                Email ini mengonfirmasi bahwa saluran komunikasi email resmi untuk <strong>${appName}</strong> telah aktif dan terhubung dengan baik.
            </p>

            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 24px;">
                <p style="margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #334155;">
                    Layanan yang Dilayani Melalui Saluran Ini:
                </p>
                <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: #475569; line-height: 1.6;">
                    <li>Pengiriman lembar tagihan sewa bulanan penghuni secara terjadwal.</li>
                    <li>Pengingat otomatis mendekati tanggal jatuh tempo pembayaran sewa.</li>
                    <li>Konfirmasi penerimaan bukti pembayaran transfer / QRIS.</li>
                    <li>Pemberitahuan pemeliharaan unit dan tindak lanjut keluhan fasilitas.</li>
                </ul>
            </div>

            <!-- Detail Pengelola -->
            <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin-bottom: 24px; font-size: 12.5px;">
                <p style="margin: 0 0 6px; font-weight: 700; color: #166534;">Informasi Pengelola Kontrakan:</p>
                <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #14532d;">
                    <tr>
                        <td style="padding: 3px 0; width: 140px; color: #166534;">Nama Pengelola:</td>
                        <td style="padding: 3px 0; font-weight: 700;">${ownerName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 3px 0; color: #166534;">WhatsApp Resmi:</td>
                        <td style="padding: 3px 0; font-weight: 700;">${ownerPhone}</td>
                    </tr>
                    <tr>
                        <td style="padding: 3px 0; color: #166534;">Alamat Lokasi:</td>
                        <td style="padding: 3px 0;">${ownerAddress}</td>
                    </tr>
                </table>
            </div>

            <!-- CTA Dashboard -->
            <div style="text-align: center; margin: 24px 0 16px;">
                <a href="${baseUrl}" style="background-color: #059669; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 10px; font-weight: 700; font-size: 13.5px; display: inline-block;">
                    Buka Dashboard Kontrakan
                </a>
            </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0;">Pemberitahuan resmi dari Sistem Manajemen ${appName}.</p>
        </div>
    </div>
</body>
</html>
`;
}

module.exports = {
    logNotification,
    sendEmailNotification,
    buildEmailHtml,
    buildSystemNoticeEmailHtml,
    runReminderCheck,
    startBackgroundSchedulers
};
