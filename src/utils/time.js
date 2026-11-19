const MONTH_NAMES_ID = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const MONTH_SHORT_NAMES_ID = [
    'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
    'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'
];

function getTodayWIB() {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    } catch (_) {
        return new Date().toISOString().slice(0, 10);
    }
}

function getMonthYearWIB() {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date());
    } catch (_) {
        return new Date().toISOString().slice(0, 7);
    }
}

function getHourWIB() {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Jakarta',
            hour: 'numeric',
            hour12: false
        }).formatToParts(new Date());
        const hourPart = parts.find(p => p.type === 'hour');
        return parseInt(hourPart ? hourPart.value : new Date().getHours(), 10);
    } catch (_) {
        return new Date().getHours();
    }
}

function formatMonthKey(key) {
    if (!key || typeof key !== 'string') return key;
    const [y, m] = key.split('-');
    const mIdx = parseInt(m, 10) - 1;
    return (mIdx >= 0 && mIdx < 12) ? `${MONTH_NAMES_ID[mIdx]} ${y}` : key;
}

function formatMonthShortKey(key) {
    if (!key || typeof key !== 'string') return key;
    const [y, m] = key.split('-');
    const mIdx = parseInt(m, 10) - 1;
    return (mIdx >= 0 && mIdx < 12) ? `${MONTH_SHORT_NAMES_ID[mIdx]} ${String(y).slice(2)}` : key;
}

function getMonthsList(monthYearStr) {
    if (!monthYearStr) return [];
    const months = [
        'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];
    const parts = monthYearStr.split('-').map(p => p.trim());
    if (parts.length === 1) return [parts[0]];

    const firstPart = parts[0].split(' ');
    const lastPart = parts[1].split(' ');
    const startName = firstPart[0];
    const endName = lastPart[0];
    const year = lastPart[1] || firstPart[1] || '';

    const startIdx = months.findIndex(m => m.toLowerCase() === startName.toLowerCase());
    const endIdx = months.findIndex(m => m.toLowerCase() === endName.toLowerCase());

    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        const result = [];
        for (let i = startIdx; i <= endIdx; i++) {
            result.push(year ? `${months[i]} ${year}` : months[i]);
        }
        return result;
    }
    return [monthYearStr];
}

function formatMonthsDisplay(monthsList) {
    if (!monthsList || monthsList.length === 0) return '-';
    if (monthsList.length === 1) return monthsList[0];

    const months = [
        'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];

    const parsed = monthsList.map(mStr => {
        const parts = mStr.split(' ');
        const mIdx = months.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
        const y = parts[1] || '';
        return { name: parts[0], idx: mIdx, year: y, orig: mStr };
    });

    const isContiguous = parsed.every((item, i) => {
        if (i === 0) return true;
        const prev = parsed[i - 1];
        if (item.year === prev.year) {
            return item.idx === prev.idx + 1;
        } else if (parseInt(item.year, 10) === parseInt(prev.year, 10) + 1) {
            return prev.idx === 11 && item.idx === 0;
        }
        return false;
    });

    if (isContiguous && parsed.length > 2) {
        const first = parsed[0];
        const last = parsed[parsed.length - 1];
        if (first.year === last.year) {
            return `${first.name} - ${last.name} ${last.year}`;
        } else {
            return `${first.orig} - ${last.orig}`;
        }
    }

    return monthsList.join(', ');
}

function getDueDateDetails(dueDate, monthYearStr, todayStr) {
    const today = todayStr || getTodayWIB();
    const dDate = new Date(dueDate);
    const tDate = new Date(today);
    const diffTime = dDate.getTime() - tDate.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 3) return { isH3: true, isH1: false, isH0: false, isOverdue: false, diffDays };
    if (diffDays === 1) return { isH3: false, isH1: true, isH0: false, isOverdue: false, diffDays };
    if (diffDays === 0) return { isH3: false, isH1: false, isH0: true, isOverdue: false, diffDays };
    if (diffDays < 0) return { isH3: false, isH1: false, isH0: false, isOverdue: true, diffDays: Math.abs(diffDays) };
    return { isH3: false, isH1: false, isH0: false, isOverdue: false, diffDays };
}

function getOverdueDetails(dueDate, monthYearStr, todayStr) {
    const today = todayStr || getTodayWIB();
    const dDate = new Date(dueDate);
    const tDate = new Date(today);
    const diffTime = tDate.getTime() - dDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    const mList = getMonthsList(monthYearStr);
    const periodMonthsCount = mList.length > 0 ? mList.length : 1;
    const periodLabel = `${periodMonthsCount} Bulan Sewa`;

    if (diffDays <= 0) {
        const remainingDays = Math.abs(diffDays);
        return {
            isOverdue: false,
            days: 0,
            months: 0,
            periodMonthsCount,
            periodLabel,
            monthsList: mList,
            overdueLabel: remainingDays === 0 ? 'Hari ini Jatuh Tempo' : `Jatuh tempo dlm ${remainingDays} hari`,
            statusType: 'NORMAL'
        };
    }

    let overdueLabel = '';
    if (diffDays < 30) {
        overdueLabel = `Telat ${diffDays} hari`;
    } else {
        const approxMonths = Math.floor(diffDays / 30);
        overdueLabel = `Telat ${diffDays} hari (${approxMonths} bulan)`;
    }

    return {
        isOverdue: true,
        days: diffDays,
        months: periodMonthsCount,
        periodMonthsCount,
        periodLabel,
        monthsList: mList,
        overdueLabel,
        statusType: 'OVERDUE'
    };
}

module.exports = {
    MONTH_NAMES_ID,
    MONTH_SHORT_NAMES_ID,
    getTodayWIB,
    getMonthYearWIB,
    getHourWIB,
    formatMonthKey,
    formatMonthShortKey,
    getMonthsList,
    formatMonthsDisplay,
    getDueDateDetails,
    getOverdueDetails
};
