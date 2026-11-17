# Sistem Manajemen Sewa Kontrakan Nenek Yuyun & TraceFund Engine

Sistem manajemen kontrakan berbasis web full-stack yang dirancang untuk mengelola 11 unit (21.A sampai 21.K), mencakup otomatisasi penagihan bulanan berbasis WIB, pengingat jatuh tempo via WhatsApp Baileys dan Email SMTP, portal konfirmasi pembayaran penyewa (QRIS/Transfer/Tunai), pusat pelaporan keluhan fasilitas, serta TraceFund engine untuk pembukuan kas dua arah terpadu.

---

## 1. Arsitektur & Struktur Proyek

Proyek ini telah direstrukturisasi secara modular dengan pemisahan tanggung jawab (*separation of concerns*) yang jelas, siap untuk produksi maupun portofolio rekayasa perangkat lunak modern:

```text
kontrakan/
├── public/                 # Berkas statis & antarmuka frontend (Zero-build HTML5/Tailwind/JS)
│   ├── index.html          # Dashboard utama manajemen kontrakan & analitik TraceFund
│   ├── tagihan.html        # Portal publik invoice penyewa & upload bukti bayar
│   └── keluhan.html        # Portal publik pengaduan kerusakan & fasilitas unit
├── src/                    # Logika inti aplikasi backend (Node.js native ES/CommonJS)
│   ├── app.js              # Inisialisasi HTTP server, middleware keamanan & CORS, graceful shutdown
│   ├── config/             # Konfigurasi lingkungan & database
│   │   ├── env.js          # Variabel lingkungan & path direktori
│   │   └── database.js     # Inisialisasi SQLite (node:sqlite DatabaseSync), PRAGMA WAL, skema & indeks
│   ├── routes/             # Router & dispatcher endpoint API
│   │   └── index.js        # Pemetaan 39 rute HTTP (Auth, Unit, Tagihan, Keluhan, TraceFund, WhatsApp)
│   ├── services/           # Layanan bisnis inti terisolasi
│   │   ├── billing.js      # Alokasi pembayaran FIFO multi-bulan, status invoice, auto-billing
│   │   ├── tracefund.js    # Mesin ledger kas gabungan, saldo berjalan, analitik keuangan, backup DB
│   │   ├── whatsapp.js     # Bot Baileys mandiri, webhook WhatsApp, dan parser 12 perintah TraceFund
│   │   └── scheduler.js    # Otomatisasi pengingat tagihan harian, cron invoice bulanan, SMTP mailer
│   └── utils/              # Fungsi pembantu murni (reusable utilities)
│       ├── parser.js       # Parser nominal fleksibel (k/jt/rb), kategori otomatis, format mata uang
│       ├── security.js     # HMAC SHA-256 tokens, rate limiter, validasi magic bytes, masking privasi
│       └── time.js         # Helper kalkulasi tanggal & jatuh tempo berbasis zona waktu WIB (Asia/Jakarta)
├── scripts/                # Skrip pemeliharaan & migrasi
│   └── sync_from_postgres.py # Skrip sinkronisasi data dari PostgreSQL ke SQLite lokal
├── tests/                  # Pengujian sistem otomatis
│   └── test_all.js         # Suite pengujian komprehensif 10 bagian (100% passing)
├── Dockerfile              # Konfigurasi container Node.js 24 Alpine
├── docker-compose.yml      # Orkestrasi Docker multi-environment & volume mounting
├── server.js               # Entry-point utama aplikasi
├── package.json            # Manifest dependensi & skrip npm
└── README.md               # Dokumentasi teknis proyek
```

---

## 2. Menjalankan dengan Docker (Rekomendasi Produksi / VPS)

Sistem telah dilengkapi dengan konfigurasi Docker multi-stage ringan berbasis `node:24-alpine` dengan modul bawaan `node:sqlite`.

### A. Jalankan Aplikasi
```bash
docker compose up -d --build
```
Container akan dibangun dan berjalan di latar belakang pada port host `5005` (memetakan ke port internal 5000).

### B. Memeriksa Status & Log
```bash
# Cek status container
docker compose ps

# Cek log aplikasi secara real-time
docker compose logs -f
```

### C. Menghentikan atau Me-restart Aplikasi
```bash
docker compose restart
docker compose down
```

### D. Persistensi Data
Seluruh data tersimpan secara persisten di folder host `./data`:
* Database SQLite: `./data/kontrakan.db`
* Bukti transfer & gambar QRIS: `./data/uploads/`
* Sesi WhatsApp Baileys: `./data/wa_session/`
* Cadangan Database: `./data/backups/`

---

## 3. Menjalankan Secara Lokal (Development)

### Prasyarat
* Node.js v22.x atau v24.x (disarankan v24 LTS yang memiliki `node:sqlite` bawaan).
* npm v10+

### Instalasi & Menjalankan
```bash
# Pasang dependensi
npm install

# Jalankan pengujian sistem (10 suite otomatis)
npm test

# Jalankan server
npm start
```
Aplikasi akan aktif di `http://localhost:5000`.

---

## 4. Pengujian Sistem Otomatis (`npm test`)

Suite pengujian mencakup 10 area kritis:
1. Skema Database SQLite, integritas relasi, dan kolom token akses.
2. Helper kalkulasi tanggal & waktu berbasis Waktu Indonesia Barat (WIB).
3. Validasi magic bytes upload gambar (JPEG/PNG/WEBP) & blokir ekstensi berbahaya (.php, .js, .svg).
4. In-memory Rate Limiter untuk mitigasi brute force dan flooding request.
5. Keamanan autentikasi HMAC SHA-256 dan eliminasi token bypass.
6. Masking privasi nama dan kontak penyewa pada respon publik.
7. Whitelist tipe berkas static uploads.
8. Parser fleksibel TraceFund (nominal `150k`, `1.5jt`, `50rb`, deteksi kategori otomatis).
9. Eksekusi 12 perintah bot TraceFund WhatsApp end-to-end.
10. Kesiapan produksi (Healthcheck `/health`, Security Headers, WAL Checkpoint, & 11 indeks performa).

---

## 5. WhatsApp Bot Mandiri & Perintah TraceFund

Sistem dilengkapi WhatsApp client mandiri berbasis Baileys (gratis tanpa langganan gateway pihak ketiga).

### A. Cara Menghubungkan
1. Buka dashboard web > menu **Pengaturan & Notifikasi**.
2. Pada bagian **WhatsApp Bot Mandiri**, pindai (*scan*) kode QR menggunakan WhatsApp di ponsel Anda (**Setelan** > **Perangkat Tertaut** > **Tautkan Perangkat**).
3. Status akan berubah menjadi **Terhubung (Online)**.

### B. Daftar Perintah Chat WhatsApp Pemilik

| Perintah | Deskripsi | Contoh Penggunaan |
| :--- | :--- | :--- |
| `#keluar` | Catat pengeluaran kas dengan nominal fleksibel & kategori otomatis | `#keluar 150k Listrik Beli token pompa air` |
| `#masuk` | Catat pemasukan non-sewa (penjualan barang bekas, denda, dsb) | `#masuk 500k Penjualan kardus bekas` |
| `#saldo` | Cek saldo kas berjalan, total masuk, dan total keluar bulan ini | `#saldo` |
| `#budget` | Tampilkan atau atur batas anggaran belanja bulanan | `#budget 5jt` atau `#budget` |
| `#kategori` | Tampilkan rincian pengeluaran per kategori bulan ini | `#kategori` |
| `#ringkasan` | Ringkasan laba bersih dan kas bulan berjalan | `#ringkasan` |
| `#tahunan` | Laporan rekapitulasi laba dan arus kas 12 bulan terakhir | `#tahunan` |
| `#analisis` | Analitik pola keuangan lintas bulan | `#analisis` |
| `#total` | Hitung akumulasi belanja berdasarkan kata kunci tertentu | `#total token` |
| `#riwayat` | Tampilkan 5 transaksi kas terakhir | `#riwayat` |
| `#ekspor` / `#csv` | Kirim dokumen spreadsheet CSV laporan transaksi | `#ekspor` |
| `#batal` | Batalkan / hapus transaksi pengeluaran kas terakhir | `#batal` |
| `#status` / `#cek` | Periksa status okupansi unit kontrakan & daftar penunggak | `#status` |
| `#lunas` | Tandai pelunasan tagihan unit kontrakan via chat | `#lunas 21.A` |
| `#keluhan` | Lihat daftar keluhan fasilitas yang belum selesai diperbaiki | `#keluhan` |
| `#bantuan` | Tampilkan petunjuk lengkap seluruh perintah bot | `#bantuan` |

---

## 6. Portal Publik Penghuni

Aplikasi menyediakan antarmuka web publik ramah perangkat seluler (*mobile-responsive*):
1. **Portal Tagihan & Pembayaran Sewa:**  
   `http://domain-anda.com/tagihan.html?id=INV-XXXXX`  
   Penyewa dapat melihat detail sewa, batas jatuh tempo, QRIS interaktif, rekening transfer bank, konfirmasi rencana bayar tunai, mengunggah bukti bayar, dan mengunduh kuitansi resmi saat lunas.
2. **Pusat Pengaduan Keluhan & Perbaikan Fasilitas:**  
   `http://domain-anda.com/keluhan.html`  
   Penyewa dapat melaporkan masalah fasilitas (pompa air, atap, listrik, kunci) beserta unggahan foto bukti kerusakan tanpa perlu login.

---

## 7. Kredensial Masuk Bawaan (Default Login)

* **Username:** `admin`
* **Password:** `nekyuyun2026`

Untuk mengganti username dan password, sesuaikan variabel `APP_USER` dan `APP_PASS` pada berkas `.env` atau `docker-compose.yml`.
