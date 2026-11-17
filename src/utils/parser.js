const { getTodayWIB } = require('./time');

function parseNominalTrace(str) {
    if (!str) return 0;
    const clean = String(str).toLowerCase().replace(/rp\.?/g, '').replace(/\s+/g, '').replace(/,/g, '.');
    if (clean.endsWith('jt') || clean.endsWith('juta')) {
        const val = parseFloat(clean.replace(/(jt|juta)/g, ''));
        return isNaN(val) ? 0 : Math.round(val * 1000000);
    }
    if (clean.endsWith('k') || clean.endsWith('rb') || clean.endsWith('ribu')) {
        const val = parseFloat(clean.replace(/(k|rb|ribu)/g, ''));
        return isNaN(val) ? 0 : Math.round(val * 1000);
    }
    const val = parseInt(clean.replace(/[^0-9]/g, ''), 10);
    return isNaN(val) ? 0 : val;
}

function detectExpenseCategory(text, explicitCategory = null) {
    const validCats = ['Listrik', 'Air', 'Kebersihan', 'Perbaikan', 'Lainnya'];
    if (explicitCategory) {
        const match = validCats.find(c => c.toLowerCase() === explicitCategory.toLowerCase());
        if (match) return match;
    }
    const lower = (text || '').toLowerCase();
    if (/token|pln|listrik|pulsa listrik|kwh|meteran/i.test(lower)) return 'Listrik';
    if (/pdam|air|pompa|sanyo|galon|toren|kran|pipa|sedot air/i.test(lower)) return 'Air';
    if (/sampah|kebersihan|sapu|pel|tpa|iuran sampah|kebun|rumput|sedot wc/i.test(lower)) return 'Kebersihan';
    if (/rusak|perbaikan|renovasi|semen|cat|pintu|kunci|genteng|atap|bocor|tukang|kayu|keramik|lampu/i.test(lower)) return 'Perbaikan';
    return 'Lainnya';
}

function parseMonthYearInput(inputStr) {
    const today = getTodayWIB();
    const [defY, defM] = today.slice(0, 7).split('-');

    if (!inputStr || !inputStr.trim()) {
        return { year: defY, month: defM, monthKey: `${defY}-${defM}` };
    }

    const str = inputStr.trim().toLowerCase();
    const lowerMonths = [
        'januari', 'februari', 'maret', 'april', 'mei', 'juni',
        'juli', 'agustus', 'september', 'oktober', 'november', 'desember'
    ];
    const shortMonths = [
        'jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agt', 'sep', 'okt', 'nov', 'des'
    ];

    let year = defY;
    const yMatch = str.match(/\b(20\d\d)\b/);
    if (yMatch) {
        year = yMatch[1];
    }

    for (let i = 0; i < 12; i++) {
        if (str.includes(lowerMonths[i]) || str.includes(shortMonths[i])) {
            const mStr = String(i + 1).padStart(2, '0');
            return { year, month: mStr, monthKey: `${year}-${mStr}` };
        }
    }

    const numMatch = str.match(/\b([1-9]|1[0-2])\b/);
    if (numMatch) {
        const mStr = String(numMatch[1]).padStart(2, '0');
        return { year, month: mStr, monthKey: `${year}-${mStr}` };
    }

    return { year, month: defM, monthKey: `${year}-${defM}` };
}

function parseExpenseCommand(text) {
    if (!text || !text.trim()) return null;
    const words = text.trim().split(/\s+/);

    let amount = 0;
    let amountIndex = -1;
    for (let i = 0; i < words.length; i++) {
        const parsed = parseNominalTrace(words[i]);
        if (parsed > 0) {
            amount = parsed;
            amountIndex = i;
            break;
        }
    }

    if (amount <= 0 || amountIndex === -1) {
        return null;
    }

    const validCats = ['Listrik', 'Air', 'Kebersihan', 'Perbaikan', 'Lainnya'];
    let category = null;
    let categoryIndex = -1;

    for (let i = 0; i < words.length; i++) {
        if (i === amountIndex) continue;
        const match = validCats.find(c => c.toLowerCase() === words[i].toLowerCase());
        if (match) {
            category = match;
            categoryIndex = i;
            break;
        }
    }

    const noteWords = words.filter((w, idx) => {
        if (idx === amountIndex || idx === categoryIndex) return false;
        if (/^(rp|rp\.)$/i.test(w)) return false;
        return true;
    });
    const note = noteWords.join(' ').trim();

    if (!category) {
        category = detectExpenseCategory(note);
    }

    return {
        amount,
        category,
        note
    };
}

function parseIncomeCommand(text) {
    if (!text || !text.trim()) return null;
    const words = text.trim().split(/\s+/);

    let amount = 0;
    let amountIndex = -1;
    for (let i = 0; i < words.length; i++) {
        const parsed = parseNominalTrace(words[i]);
        if (parsed > 0) {
            amount = parsed;
            amountIndex = i;
            break;
        }
    }

    if (amount <= 0 || amountIndex === -1) {
        return null;
    }

    const remainingWords = words.filter((w, idx) => {
        if (idx === amountIndex) return false;
        if (/^(rp|rp\.)$/i.test(w)) return false;
        return true;
    });
    const note = remainingWords.join(' ').trim();

    return {
        amount,
        category: 'Pemasukan',
        note: note || 'Pemasukan non-sewa'
    };
}

function formatRupiahTrace(amount) {
    const num = Number(amount || 0);
    const sign = num < 0 ? '-' : '';
    return `${sign}Rp ${Math.abs(num).toLocaleString('id-ID')}`;
}

module.exports = {
    parseNominalTrace,
    detectExpenseCategory,
    parseMonthYearInput,
    parseExpenseCommand,
    parseIncomeCommand,
    formatRupiahTrace
};
