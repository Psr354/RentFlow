#!/usr/bin/env python3
import json
import sqlite3
import os
import paramiko
from datetime import datetime

SSH_HOST = os.getenv("SSH_HOST", "192.168.151.152")
SSH_USER = os.getenv("SSH_USER", "teamskip")
SSH_PASS = os.getenv("SSH_PASS", "")

TARGET_DBS = [
    "/mnt/c/kontrakan/data/kontrakan.db",
    "/mnt/c/kontrakan/kontrakan.db"
]

CATEGORY_MAP = {
    'lainnya': 'Lainnya',
    'listrik': 'Listrik',
    'kebersihan': 'Kebersihan',
    'perbaikan': 'Perbaikan',
    'air': 'Air'
}

MONTH_NAMES_ID = [
    '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
]

def format_month_year(date_str):
    if not date_str:
        return ""
    dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
    return f"{MONTH_NAMES_ID[dt.month]} {dt.year}"

def fetch_postgres_data():
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    if os.getenv("SSH_STRICT_HOST_CHECK", "0") == "1":
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        ssh.set_missing_host_key_policy(paramiko.WarningPolicy())
    ssh.connect(SSH_HOST, username=SSH_USER, password=SSH_PASS, timeout=10)

    def query_json(sql):
        cmd = f'docker exec -i kos-manager-db psql -U kosuser -d kos_manager -t -A -c "SELECT json_agg(t) FROM ({sql}) t;"'
        stdin, stdout, stderr = ssh.exec_command(cmd)
        out = stdout.read().decode().strip()
        return json.loads(out) if out else []

    rooms = query_json("SELECT * FROM rooms ORDER BY id")
    tenants = query_json("SELECT * FROM tenants ORDER BY id")
    contracts = query_json("""
        SELECT c.*, r.name as room_name, t.name as tenant_name, t.phone as tenant_phone, t.email as tenant_email
        FROM contracts c
        JOIN rooms r ON c.room_id = r.id
        JOIN tenants t ON c.tenant_id = t.id
        ORDER BY c.id
    """)
    payments = query_json("""
        SELECT p.*, r.name as room_name, t.name as tenant_name, c.room_id, c.monthly_price
        FROM payments p
        JOIN contracts c ON p.contract_id = c.id
        JOIN rooms r ON c.room_id = r.id
        JOIN tenants t ON c.tenant_id = t.id
        ORDER BY p.id
    """)
    expenses = query_json("SELECT * FROM expenses ORDER BY id")

    ssh.close()
    return {
        "rooms": rooms,
        "tenants": tenants,
        "contracts": contracts,
        "payments": payments,
        "expenses": expenses
    }

def sync_to_sqlite(data, db_path):
    print(f"Syncing data ke SQLite: {db_path}...")
    if not os.path.exists(db_path):
        print(f"File {db_path} belum ada, lewati.")
        return

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Pastikan tabel invoice_payments dibuat
    c.execute("""
    CREATE TABLE IF NOT EXISTS invoice_payments (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL CHECK(amount > 0),
        payment_method TEXT NOT NULL DEFAULT 'TRANSFER',
        payment_date TEXT NOT NULL,
        payment_proof TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
    );
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_invoice_payments_inv ON invoice_payments(invoice_id);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_invoice_payments_date ON invoice_payments(payment_date);")

    # Ambil no telepon lama jika ada agar tidak hilang
    existing_phones = {}
    existing_emails = {}
    try:
        rows = c.execute("SELECT number, tenant_phone, tenant_email FROM rooms").fetchall()
        for num, ph, em in rows:
            if ph and ph.strip() and not ph.startswith('081234567890') and not ph.startswith('081298765432'):
                existing_phones[num] = ph.strip()
            if em and em.strip() and not em.endswith('@example.com'):
                existing_emails[num] = em.strip()
    except Exception:
        pass

    # 1. Bersihkan tabel
    c.execute("DELETE FROM invoice_payments")
    c.execute("DELETE FROM invoices")
    c.execute("DELETE FROM expenses")
    c.execute("DELETE FROM rooms")

    # Mapping room ID PostgreSQL ke unit ID standar lokal
    room_map = {}
    active_contracts_by_room = {}
    for ct in data["contracts"]:
        if ct["status"] == "active":
            active_contracts_by_room[ct["room_id"]] = ct

    for r in data["rooms"]:
        letter = r["name"].split("-")[-1].lower() # 'a' s/d 'k'
        unit_id = f"unit-{letter}"
        room_map[r["id"]] = {
            "unit_id": unit_id,
            "number": r["name"],
            "type": "Kontrakan (4 org)",
            "price": int(r["price"]),
            "status": "KOSONG",
            "tenant_name": "",
            "tenant_phone": existing_phones.get(r["name"], ""),
            "tenant_email": existing_emails.get(r["name"], ""),
            "due_day": 1,
            "entry_date": "",
            "created_at": r["created_at"]
        }
        if r["id"] in active_contracts_by_room:
            ct = active_contracts_by_room[r["id"]]
            room_map[r["id"]]["status"] = "TERISI"
            room_map[r["id"]]["tenant_name"] = ct["tenant_name"]
            if ct.get("tenant_phone"):
                room_map[r["id"]]["tenant_phone"] = ct["tenant_phone"]
            if ct.get("tenant_email"):
                room_map[r["id"]]["tenant_email"] = ct["tenant_email"]
            if ct.get("start_date"):
                dt = datetime.strptime(ct["start_date"], "%Y-%m-%d")
                room_map[r["id"]]["due_day"] = dt.day
                room_map[r["id"]]["entry_date"] = ct["start_date"]

    for r_id, r_data in sorted(room_map.items()):
        c.execute("""
            INSERT INTO rooms (id, number, type, price, status, tenant_name, tenant_phone, tenant_email, due_day, entry_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            r_data["unit_id"],
            r_data["number"],
            r_data["type"],
            r_data["price"],
            r_data["status"],
            r_data["tenant_name"],
            r_data["tenant_phone"],
            r_data["tenant_email"],
            r_data["due_day"],
            r_data["entry_date"],
            r_data["created_at"]
        ))

    # 2. Masukkan Pengeluaran (Expenses) asli dari PostgreSQL
    for exp in data["expenses"]:
        exp_id = f"EXP-{exp['id']:03d}"
        exp_date = exp["expense_date"]
        cat_key = (exp["category"] or "").lower()
        category = CATEGORY_MAP.get(cat_key, "Lainnya")
        amount = int(exp["amount"])
        note = (exp["note"] or "").strip()
        created_at = exp["created_at"]

        c.execute("""
            INSERT INTO expenses (id, date, category, amount, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (exp_id, exp_date, category, amount, note, created_at))

    # 3. Model Tagihan dan Pembayaran Parsial Terstruktur
    # Setiap tagihan merepresentasikan periode sewa sesungguhnya.
    # Jika sudah dibayar penuh -> LUNAS.
    # Jika baru dibayar sebagian -> SEBAGIAN (cicilan dicatat di invoice_payments).
    # Jika belum dibayar -> BELUM_BAYAR.

    invoices_def = [
        # 21-A (Wahyu, 1.500.000/bln)
        {
            "id": "INV-202610-21A",
            "unit_id": "unit-a",
            "month_year": "Oktober 2026",
            "amount": 1500000,
            "due_date": "2026-10-07",
            "notes": "Tagihan sewa Oktober 2026",
            "payments": [
                { "id": "PAY-006", "amount": 1500000, "date": "2026-11-06", "method": "CASH", "notes": "Lunas sewa Oktober" }
            ]
        },
        {
            "id": "INV-202611-21A",
            "unit_id": "unit-a",
            "month_year": "November 2026",
            "amount": 1500000,
            "due_date": "2026-11-07",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": []
        },

        # 21-C (Pudin, 1.500.000/bln)
        {
            "id": "INV-202608-21C",
            "unit_id": "unit-c",
            "month_year": "Agustus 2026",
            "amount": 1500000,
            "due_date": "2026-08-14",
            "notes": "Tagihan sewa Agustus 2026",
            "payments": [
                { "id": "PAY-011", "amount": 1000000, "date": "2026-11-12", "method": "CASH", "notes": "Cicilan Agustus (blm lunas, sisa 500.000)" }
            ]
        },
        {
            "id": "INV-DUE-21C",
            "unit_id": "unit-c",
            "month_year": "September - November 2026",
            "amount": 4500000,
            "due_date": "2026-09-14",
            "notes": "Tunggakan Sep, Okt, Nov 2026 (3 bulan @ Rp 1.500.000)",
            "payments": []
        },

        # 21-D (Asep, 800.000/bln)
        {
            "id": "INV-202611-21D",
            "unit_id": "unit-d",
            "month_year": "November 2026",
            "amount": 800000,
            "due_date": "2026-11-04",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": []
        },

        # 21-E (Sandi, 1.200.000/bln)
        {
            "id": "INV-202609-21E",
            "unit_id": "unit-e",
            "month_year": "September 2026",
            "amount": 1200000,
            "due_date": "2026-09-07",
            "notes": "Tagihan sewa September 2026",
            "payments": [
                { "id": "PAY-003", "amount": 1000000, "date": "2026-10-31", "method": "CASH", "notes": "Cicilan September (sisa 200.000)" }
            ]
        },
        {
            "id": "INV-DUE-21E",
            "unit_id": "unit-e",
            "month_year": "Oktober - November 2026",
            "amount": 2400000,
            "due_date": "2026-10-07",
            "notes": "Tunggakan Okt & Nov 2026 (2 bulan @ Rp 1.200.000)",
            "payments": []
        },

        # 21-F (Rima / Supri, 1.500.000/bln)
        {
            "id": "INV-202611-21F",
            "unit_id": "unit-f",
            "month_year": "November 2026",
            "amount": 1500000,
            "due_date": "2026-11-07",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": []
        },

        # 21-G (Rian / Yuniar, 1.200.000/bln)
        {
            "id": "INV-202611-21G",
            "unit_id": "unit-g",
            "month_year": "November 2026",
            "amount": 1200000,
            "due_date": "2026-11-04",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": [
                { "id": "PAY-009", "amount": 500000, "date": "2026-11-02", "method": "CASH", "notes": "Cicilan pertama Nov (blm lunas, sisa 700.000)" }
            ]
        },

        # 21-H (Imron, 1.400.000/bln)
        {
            "id": "INV-202611-21H",
            "unit_id": "unit-h",
            "month_year": "November 2026",
            "amount": 1400000,
            "due_date": "2026-11-07",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": []
        },

        # 21-I (Irma-hamza, 1.200.000/bln)
        {
            "id": "INV-202610-21I",
            "unit_id": "unit-i",
            "month_year": "Oktober 2026",
            "amount": 1200000,
            "due_date": "2026-10-07",
            "notes": "Tagihan sewa Oktober 2026",
            "payments": [
                { "id": "PAY-007", "amount": 700000, "date": "2026-11-12", "method": "CASH", "notes": "Cicilan Oktober (kurang 500.000)" }
            ]
        },
        {
            "id": "INV-202611-21I",
            "unit_id": "unit-i",
            "month_year": "November 2026",
            "amount": 1200000,
            "due_date": "2026-11-07",
            "notes": "Tagihan sewa November 2026 (1 bulan)",
            "payments": []
        },

        # 21-J (Jemmy, 500.000/bln)
        {
            "id": "INV-202611-21J",
            "unit_id": "unit-j",
            "month_year": "November 2026",
            "amount": 500000,
            "due_date": "2026-11-04",
            "notes": "Tagihan sewa November 2026",
            "payments": [
                { "id": "PAY-010", "amount": 500000, "date": "2026-11-01", "method": "CASH", "notes": "Lunas sewa November" }
            ]
        },

        # 21-K (Dita PJ, 1.000.000/bln)
        {
            "id": "INV-202607-21K",
            "unit_id": "unit-k",
            "month_year": "Juli 2026",
            "amount": 1000000,
            "due_date": "2026-07-05",
            "notes": "Tagihan sewa Juli 2026",
            "payments": [
                { "id": "PAY-002", "amount": 550000, "date": "2026-09-14", "method": "CASH", "notes": "Cicilan Juli (sisa 450.000)" }
            ]
        },
        {
            "id": "INV-202608-21K",
            "unit_id": "unit-k",
            "month_year": "Agustus 2026",
            "amount": 1000000,
            "due_date": "2026-08-05",
            "notes": "Tagihan sewa Agustus 2026",
            "payments": [
                { "id": "PAY-001", "amount": 1000000, "date": "2026-10-31", "method": "CASH", "notes": "Lunas sewa Agustus" }
            ]
        },
        {
            "id": "INV-DUE-21K",
            "unit_id": "unit-k",
            "month_year": "September - November 2026",
            "amount": 3000000,
            "due_date": "2026-09-05",
            "notes": "Tunggakan Sep, Okt, Nov 2026 (3 bulan @ Rp 1.000.000)",
            "payments": []
        }
    ]

    for inv in invoices_def:
        payments = inv.get("payments", [])
        total_paid = sum(p["amount"] for p in payments)
        
        if total_paid >= inv["amount"]:
            status = "LUNAS"
            paid_at = f"{payments[-1]['date']}T12:00:00Z"
            pay_method = payments[-1]["method"]
        elif total_paid > 0:
            status = "SEBAGIAN"
            paid_at = None
            pay_method = payments[-1]["method"]
        else:
            status = "BELUM_BAYAR"
            paid_at = None
            pay_method = None

        c.execute("""
            INSERT INTO invoices (
                id, room_id, month_year, amount, due_date, status, payment_method,
                payment_proof, paid_at, notified_h3, notified_h1, notified_h0, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, datetime('now'))
        """, (
            inv["id"],
            inv["unit_id"],
            inv["month_year"],
            inv["amount"],
            inv["due_date"],
            status,
            pay_method,
            paid_at,
            inv["notes"]
        ))

        # Masukkan transaksi pembayaran ke invoice_payments
        for p in payments:
            c.execute("""
                INSERT INTO invoice_payments (id, invoice_id, amount, payment_method, payment_date, payment_proof, notes, created_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, datetime('now'))
            """, (
                p["id"],
                inv["id"],
                p["amount"],
                p["method"],
                p["date"],
                p["notes"]
            ))

    conn.commit()
    conn.close()
    print(f"Berhasil menyinkronkan {db_path} dengan sistem pembayaran parsial.")

def main():
    print("Menghubungi PostgreSQL kos-manager-db di 192.168.151.152...")
    data = fetch_postgres_data()
    print(f"Data riil ditemukan: {len(data['rooms'])} Rooms, {len(data['tenants'])} Tenants, {len(data['contracts'])} Contracts, {len(data['payments'])} Payments, {len(data['expenses'])} Expenses")

    for p in TARGET_DBS:
        sync_to_sqlite(data, p)

    print("\nVerifikasi Data Berhasil Selesai.")

if __name__ == "__main__":
    main()
