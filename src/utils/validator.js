const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_REGEX = /^\d{4}-\d{2}$/;

function validateRoom(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload data kamar tidak valid' };
    }
    if (!isUpdate) {
        if (!data.number || typeof data.number !== 'string' || data.number.trim().length === 0) {
            return { valid: false, message: 'Nomor unit kamar wajib diisi' };
        }
    }
    if (data.number !== undefined) {
        if (typeof data.number !== 'string' || data.number.trim().length === 0 || data.number.length > 50) {
            return { valid: false, message: 'Nomor unit kamar harus berupa teks valid (maksimal 50 karakter)' };
        }
    }
    if (data.price !== undefined) {
        const num = Number(data.price);
        if (isNaN(num) || num < 0) {
            return { valid: false, message: 'Tarif sewa kamar harus berupa angka non-negatif' };
        }
    }
    if (data.due_day !== undefined) {
        const day = Number(data.due_day);
        if (isNaN(day) || !Number.isInteger(day) || day < 1 || day > 31) {
            return { valid: false, message: 'Tanggal jatuh tempo harus berupa bilangan bulat antara 1 hingga 31' };
        }
    }
    return { valid: true };
}

function validateInvoice(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload tagihan tidak valid' };
    }
    if (!isUpdate) {
        if (!data.room_id || typeof data.room_id !== 'string' || data.room_id.trim().length === 0) {
            return { valid: false, message: 'ID unit kontrakan (room_id) wajib disertakan' };
        }
        if (!data.month_year || typeof data.month_year !== 'string' || data.month_year.trim().length === 0) {
            return { valid: false, message: 'Periode tagihan (month_year) wajib diisi' };
        }
        const amt = Number(data.amount);
        if (isNaN(amt) || amt <= 0) {
            return { valid: false, message: 'Nominal tagihan harus berupa angka lebih dari 0' };
        }
        if (!data.due_date || typeof data.due_date !== 'string' || !DATE_REGEX.test(data.due_date.trim())) {
            return { valid: false, message: 'Format tanggal jatuh tempo harus YYYY-MM-DD' };
        }
    } else {
        if (data.amount !== undefined) {
            const amt = Number(data.amount);
            if (isNaN(amt) || amt <= 0) {
                return { valid: false, message: 'Nominal tagihan harus berupa angka lebih dari 0' };
            }
        }
        if (data.due_date !== undefined && (!data.due_date || !DATE_REGEX.test(String(data.due_date).trim()))) {
            return { valid: false, message: 'Format tanggal jatuh tempo harus YYYY-MM-DD' };
        }
    }
    return { valid: true };
}

function validatePayment(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload pembayaran tidak valid' };
    }
    const amt = Number(data.amount);
    if (isNaN(amt) || amt <= 0) {
        return { valid: false, message: 'Nominal pembayaran harus berupa angka lebih dari 0' };
    }
    return { valid: true };
}

function validateExpense(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload pengeluaran tidak valid' };
    }
    if (!isUpdate) {
        if (!data.date || typeof data.date !== 'string' || !DATE_REGEX.test(data.date.trim())) {
            return { valid: false, message: 'Format tanggal pengeluaran harus YYYY-MM-DD' };
        }
        const amt = Number(data.amount);
        if (isNaN(amt) || amt <= 0) {
            return { valid: false, message: 'Nominal pengeluaran harus lebih dari 0' };
        }
        if (!data.category || typeof data.category !== 'string' || data.category.trim().length === 0) {
            return { valid: false, message: 'Kategori pengeluaran wajib diisi' };
        }
    } else {
        if (data.amount !== undefined) {
            const amt = Number(data.amount);
            if (isNaN(amt) || amt <= 0) {
                return { valid: false, message: 'Nominal pengeluaran harus lebih dari 0' };
            }
        }
        if (data.date !== undefined && (!data.date || !DATE_REGEX.test(String(data.date).trim()))) {
            return { valid: false, message: 'Format tanggal pengeluaran harus YYYY-MM-DD' };
        }
    }
    return { valid: true };
}

function validateIncome(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload pemasukan tidak valid' };
    }
    if (!isUpdate) {
        if (!data.date || typeof data.date !== 'string' || !DATE_REGEX.test(data.date.trim())) {
            return { valid: false, message: 'Format tanggal pemasukan harus YYYY-MM-DD' };
        }
        const amt = Number(data.amount);
        if (isNaN(amt) || amt <= 0) {
            return { valid: false, message: 'Nominal pemasukan harus lebih dari 0' };
        }
    } else {
        if (data.amount !== undefined) {
            const amt = Number(data.amount);
            if (isNaN(amt) || amt <= 0) {
                return { valid: false, message: 'Nominal pemasukan harus lebih dari 0' };
            }
        }
        if (data.date !== undefined && (!data.date || !DATE_REGEX.test(String(data.date).trim()))) {
            return { valid: false, message: 'Format tanggal pemasukan harus YYYY-MM-DD' };
        }
    }
    return { valid: true };
}

function validateBudget(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload anggaran tidak valid' };
    }
    if (!data.month || typeof data.month !== 'string' || !MONTH_REGEX.test(data.month.trim())) {
        return { valid: false, message: 'Format bulan anggaran harus YYYY-MM' };
    }
    const amt = Number(data.amount);
    if (isNaN(amt) || amt <= 0) {
        return { valid: false, message: 'Nominal batas anggaran harus lebih dari 0' };
    }
    return { valid: true };
}

function validateComplaint(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
        return { valid: false, message: 'Payload keluhan tidak valid' };
    }
    if (!isUpdate) {
        if (!data.room_id || typeof data.room_id !== 'string' || data.room_id.trim().length === 0) {
            return { valid: false, message: 'Pilihan unit kontrakan wajib diisi' };
        }
        if (!data.tenant_name || typeof data.tenant_name !== 'string' || data.tenant_name.trim().length === 0) {
            return { valid: false, message: 'Nama pelapor / penghuni wajib diisi' };
        }
        if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
            return { valid: false, message: 'Rincian keluhan fasilitas wajib diisi' };
        }
    }
    return { valid: true };
}

module.exports = {
    validateRoom,
    validateInvoice,
    validatePayment,
    validateExpense,
    validateIncome,
    validateBudget,
    validateComplaint
};
