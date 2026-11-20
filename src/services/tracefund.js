const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../config/database');
const { DB_PATH, BACKUP_DIR, BACKUP_RETENTION } = require('../config/env');
const { formatMonthKey, formatMonthShortKey } = require('../utils/time');

function createDatabaseBackup() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const backupPath = path.join(BACKUP_DIR, `kontrakan-${timestamp}.db`);
        fs.copyFileSync(DB_PATH, backupPath);

        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('kontrakan-') && f.endsWith('.db'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

        for (const old of files.slice(BACKUP_RETENTION)) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (_) {}
        }
        console.log(`[TraceFund Backup] Salinan database berhasil dibuat: ${backupPath}`);
    } catch (err) {
        console.error('[TraceFund Backup Error]', err.message);
    }
}

function getUnifiedTransactions(filters = {}) {
    const month = filters.month || null;
    const year = (!filters.month && filters.year) ? filters.year : null;
    const datePrefix = month || year || null;
    const type = filters.type || null;
    const category = filters.category ? filters.category.toLowerCase().trim() : null;
    const keyword = filters.keyword ? filters.keyword.toLowerCase().trim() : null;

    const sql = `
    WITH unified AS (
        SELECT 
            p.id,
            substr(p.payment_date, 1, 10) as date,
            'masuk' as type,
            p.amount,
            ('Sewa ' || r.number || ' (' || COALESCE(r.tenant_name, '-') || ')' || 
             CASE WHEN i.status = 'SEBAGIAN' THEN ' [Cicilan ' || i.month_year || ']' ELSE ' [' || i.month_year || ']' END) as description,
            COALESCE(p.payment_method, 'Sewa') as category
        FROM invoice_payments p
        JOIN invoices i ON p.invoice_id = i.id
        JOIN rooms r ON i.room_id = r.id
        UNION ALL
        SELECT 
            i.id,
            substr(COALESCE(i.paid_at, i.due_date), 1, 10) as date,
            'masuk' as type,
            i.amount,
            ('Sewa ' || r.number || ' (' || COALESCE(r.tenant_name, '-') || ')') as description,
            'Sewa' as category
        FROM invoices i
        JOIN rooms r ON i.room_id = r.id
        WHERE i.status = 'LUNAS' AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = i.id)
        UNION ALL
        SELECT 
            g.id,
            substr(g.date, 1, 10) as date,
            'masuk' as type,
            g.amount,
            ('Pemasukan: ' || COALESCE(g.note, g.category)) as description,
            g.category
        FROM general_incomes g
        UNION ALL
        SELECT 
            e.id,
            e.date,
            'keluar' as type,
            e.amount,
            (e.category || ': ' || COALESCE(e.note, '-')) as description,
            e.category
        FROM expenses e
    ),
    with_running AS (
        SELECT 
            id, date, type, amount, description, category,
            SUM(CASE WHEN type = 'masuk' THEN amount ELSE -amount END) OVER (ORDER BY date ASC, id ASC) as running_balance
        FROM unified
    )
    SELECT * FROM with_running
    WHERE (? IS NULL OR date LIKE ? || '%')
      AND (? IS NULL OR type = ?)
      AND (? IS NULL OR lower(category) = ?)
      AND (? IS NULL OR (lower(description) LIKE '%' || ? || '%' OR lower(category) LIKE '%' || ? || '%'))
    ORDER BY date ASC, id ASC;
    `;

    const totalCount = db.prepare(`
        SELECT count(*) as c FROM (
            SELECT id FROM invoice_payments 
            UNION ALL 
            SELECT id FROM invoices WHERE status = 'LUNAS' AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = invoices.id) 
            UNION ALL 
            SELECT id FROM general_incomes 
            UNION ALL 
            SELECT id FROM expenses
        )
    `).get().c;

    const currentBalance = db.prepare(`
        SELECT COALESCE(
            (SELECT COALESCE(SUM(amount), 0) FROM invoice_payments) +
            (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status = 'LUNAS' AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = invoices.id)) +
            (SELECT COALESCE(SUM(amount), 0) FROM general_incomes) -
            (SELECT COALESCE(SUM(amount), 0) FROM expenses),
        0) as bal
    `).get().bal;

    const transactions = db.prepare(sql).all(
        datePrefix, datePrefix,
        type, type,
        category, category,
        keyword, keyword, keyword
    );

    return {
        transactions,
        current_balance: currentBalance,
        total_count: totalCount
    };
}

function getTraceFundAnalytics() {
    const { transactions, current_balance } = getUnifiedTransactions();

    const budgetRows = db.prepare('SELECT month, amount FROM budgets').all();
    const budgetMap = {};
    for (const b of budgetRows) {
        budgetMap[b.month] = b.amount;
    }

    const monthMap = {};
    for (const t of transactions) {
        const m = t.date.slice(0, 7);
        if (!monthMap[m]) {
            monthMap[m] = {
                month: m,
                month_label: formatMonthKey(m),
                month_short: formatMonthShortKey(m),
                income: 0,
                income_count: 0,
                expense: 0,
                expense_count: 0,
                diff: 0,
                cumulative_balance: 0
            };
        }
        if (t.type === 'masuk') {
            monthMap[m].income += t.amount;
            monthMap[m].income_count += 1;
        } else {
            monthMap[m].expense += t.amount;
            monthMap[m].expense_count += 1;
        }
    }

    const months = Object.keys(monthMap).sort();
    if (months.length === 0) {
        return {
            months: [],
            current_balance: 0,
            highest_income: null,
            highest_expense: null,
            best_diff: null,
            worst_diff: null
        };
    }

    let running = 0;
    const monthData = months.map(m => {
        const item = monthMap[m];
        item.diff = item.income - item.expense;
        running += item.diff;
        item.cumulative_balance = running;

        const bAmount = budgetMap[m] || null;
        item.budget = bAmount;
        item.budget_remaining = bAmount ? Math.max(bAmount - item.expense, 0) : null;
        item.budget_percent = bAmount ? Math.round((item.expense / bAmount) * 100) : null;

        return item;
    });

    const highestIncome = [...monthData].sort((a, b) => b.income - a.income)[0];
    const highestExpense = [...monthData].sort((a, b) => b.expense - a.expense)[0];
    const bestDiff = [...monthData].sort((a, b) => b.diff - a.diff)[0];
    const worstDiff = [...monthData].sort((a, b) => a.diff - b.diff)[0];

    return {
        months: monthData,
        current_balance,
        highest_income: highestIncome,
        highest_expense: highestExpense,
        best_diff: bestDiff,
        worst_diff: worstDiff
    };
}

module.exports = {
    createDatabaseBackup,
    getUnifiedTransactions,
    getTraceFundAnalytics
};
