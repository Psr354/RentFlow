# Sistem Manajemen Sewa Kontrakan Nenek Yuyun

Sistem manajemen kontrakan berbasis web yang dirancang untuk mengelola 11 unit (21.A sampai 21.K), mencakup otomatisasi penagihan bulanan, pengingat jatuh tempo via WhatsApp dan Email, portal konfirmasi pembayaran penyewa (QRIS/Transfer/Tunai), serta dashboard analitik keuangan.

---

## 1. Menjalankan dengan Docker (Rekomendasi untuk VPS)

Sistem sudah dilengkapi dengan konfigurasi Docker lengkap sehingga Anda tidak perlu memasang Node.js secara manual di VPS.

### A. Jalankan Aplikasi
Masuk ke direktori proyek di VPS dan jalankan perintah:

```bash
docker compose up -d --build
```

Container akan otomatis dibangun dan berjalan di latar belakang pada port host `5005` (memetakan ke port internal 5000).

### B. Memeriksa Status & Log
```bash
# Cek status container
docker compose ps

# Cek log aplikasi secara real-time
docker compose logs -f
```

### C. Menghentikan atau Me-restart Aplikasi
```bash
# Restart container
docker compose restart

# Menghentikan container
docker compose down
```

### D. Persistensi Data
Seluruh data tersimpan secara persisten di folder host `./data`:
* Database SQLite: `./data/kontrakan.db`
* Bukti transfer & gambar QRIS: `./data/uploads/`

Data tidak akan hilang saat container di-restart, diperbarui, atau dibangun ulang.

---

## 2. Menghubungkan Domain ke Docker (Nginx Reverse Proxy & SSL)

Jika Anda ingin mengakses aplikasi menggunakan domain Anda (misal: `https://domain-anda.com`), pasang reverse proxy Nginx di VPS:

### A. Buat Konfigurasi Nginx
Buat berkas `/etc/nginx/sites-available/kontrakan`:

```nginx
server {
    server_name domain-anda.com www.domain-anda.com;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:5005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Aktifkan konfigurasi:
```bash
sudo ln -s /etc/nginx/sites-available/kontrakan /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### B. Pasang Sertifikat SSL Gratis (HTTPS)
```bash
sudo certbot --nginx -d domain-anda.com -d www.domain-anda.com
```

Setelah HTTPS aktif, buka menu **Pengaturan** di dashboard admin dan ubah **URL Domain / Host VPS** menjadi `https://domain-anda.com`.

---

## 3. Akun Masuk Bawaan (Default Login)

* **Username:** `admin`
* **Password:** `nekyuyun2026`

Untuk mengganti username dan password, ubah variabel `APP_USER` dan `APP_PASS` pada berkas `docker-compose.yml`.

---

## 5. WhatsApp Bot Mandiri (100% Gratis & Dua Arah)

Sistem sudah dilengkapi WhatsApp client mandiri berbasis Baileys, sehingga Anda tidak memerlukan langganan gateway pihak ketiga berbayar.

### A. Cara Menghubungkan:
1. Buka dashboard web > menu **Pengaturan & Notifikasi**.
2. Pada bagian **WhatsApp Bot Mandiri**, pindai (scan) kode QR menggunakan WhatsApp di ponsel Anda:
   * Buka WhatsApp > **Setelan** > **Perangkat Tertaut** > **Tautkan Perangkat**.
3. Status akan berubah menjadi **Terhubung (Online)**. Sesi login akan tersimpan otomatis di `./data/wa_session`.

### B. Perintah Chat WhatsApp dari Nomor Pemilik:
Hanya nomor yang terdaftar di kolom **Nomor WhatsApp Pemilik** yang dapat menjalankan perintah bot:

1. **Catat Pengeluaran Otomatis:**
   ```text
   #keluar [Kategori] [Nominal] [Keterangan]
   ```
   *Contoh:* `#keluar Listrik 150000 Beli token pompa air`  
   *Kategori yang didukung:* `Listrik`, `Air`, `Kebersihan`, `Perbaikan`, `Lainnya`.  
   Bot akan membalas rincian pengeluaran dan total pengeluaran bulan ini.

2. **Cek Status Kontrakan:**
   ```text
   #status
   #cek
   ```
   Bot akan membalas okupansi unit (terisi/kosong) dan daftar unit yang belum lunas/nunggak.

3. **Tandai Lunas via Chat:**
   ```text
   #lunas [Nama Unit]
   ```
   *Contoh:* `#lunas 21.A`

4. **Cek Laporan Keluhan Penghuni:**
   ```text
   #keluhan
   ```
   Bot akan membalas daftar laporan kerusakan / keluhan fasilitas yang belum terselesaikan.

5. **Notifikasi Otomatis ke Pemilik:**
   * Saat penyewa mengunggah bukti transfer atau memilih rencana bayar tunai, bot otomatis mengirim pesan konfirmasi ke WhatsApp pemilik.
   * Saat penyewa mengirim laporan keluhan kerusakan unit, bot otomatis mengirim rincian laporan ke WhatsApp pemilik.

---

## 6. Portal Publik Penghuni

Aplikasi menyediakan halaman web publik ramah ponsel tanpa perlu login bagi penyewa:
1. **Portal Tagihan & Bayar Sewa:**
   `https://domain-anda.com/tagihan.html?id=INV-XXXXX`
   Penyewa dapat melihat detail sewa, batas tempo, transfer ke rekening/QRIS, konfirmasi bayar tunai, dan mengunduh kuitansi PDF resmi saat lunas.
2. **Pusat Keluhan & Perbaikan Unit:**
   `https://domain-anda.com/keluhan.html`
   Penyewa dapat melaporkan kerusakan fasilitas (air, atap bocor, listrik, kunci pintu, dsb) disertai deskripsi dan foto bukti kerusakan.

