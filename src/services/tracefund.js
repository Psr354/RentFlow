const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../config/database');
const { DB_PATH, BACKUP_DIR, BACKUP_RETENTION } = require('../config/env');
const { formatMonthKey, formatMonthShortKey } = require('../utils/time');

function createDatabaseBackup() {
    try {
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
    const incomeRows = db.prepare(`
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
    `).all();

    const expenseRows = db.prepare(`
        SELECT 
            e.id,
            e.date,
            'keluar' as type,
            e.amount,
            (e.category || ': ' || COALESCE(e.note, '-')) as description,
            e.category,
            e.note
        FROM expenses e
    `).all();

    const all = [...incomeRows, ...expenseRows].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.id.localeCompare(b.id);
    });

    let running = 0;
    const enriched = all.map(t => {
        running += (t.type === 'masuk' ? t.amount : -t.amount);
        return {
            ...t,
            running_balance: running
        };
    });

    let filtered = enriched;
    if (filters.month) {
        filtered = filtered.filter(t => t.date.startsWith(filters.month));
    }
    if (filters.year) {
        filtered = filtered.filter(t => t.date.startsWith(filters.year));
    }
    if (filters.keyword) {
        const kw = filters.keyword.toLowerCase().trim();
        filtered = filtered.filter(t => 
            t.description.toLowerCase().includes(kw) || 
            (t.category && t.category.toLowerCase().includes(kw))
        );
    }
    if (filters.category) {
        const cat = filters.category.toLowerCase().trim();
        filtered = filtered.filter(t => t.category && t.category.toLowerCase() === cat);
    }
    if (filters.type) {
        filtered = filtered.filter(t => t.type === filters.type);
    }

    return {
        transactions: filtered,
        current_balance: running,
        total_count: enriched.length
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
