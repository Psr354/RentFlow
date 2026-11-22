# Pedoman Pengembangan dan Standar Verifikasi RentFlow

Setiap kali melakukan audit, code review, atau modifikasi kode pada repositori ini, agen wajib mematuhi standar verifikasi berikut:

## 1. Verifikasi Migrasi dan Skema Basis Data (SQLite)
* **Dilarang Hanya Mengandalkan Pengujian Database Kosong**:
  Skrip pengujian di `tests/test_all.js` membuat basis data baru dari nol di `/tmp/`. Kelulusan tes ini tidak menjamin kompatibilitas dengan database lama.
* **Pengujian Kompatibilitas Ganda**:
  Sebelum melakukan commit atau menyatakan migrasi aman:
  1. Pastikan seluruh perintah DDL baru (seperti `CREATE INDEX`) dieksekusi setelah migrasi penambahan kolom (`ALTER TABLE ADD COLUMN`) dijalankan.
  2. Lakukan uji coba langsung dengan menjalankan `node server.js` terhadap berkas basis data operasional yang sudah memiliki data historis (`data/kontrakan.db` atau cadangannya).

## 2. Verifikasi Skrip Antarmuka Frontend (HTML Monolitik)
* **Pemeriksaan Fungsi dan Variabel Frontend**:
  Berkas `public/index.html` dan portal publik lainnya menyimpan logika JavaScript secara inline. Perintah `node -c` tidak memindai kode ini.
* **Pemindaian Referensi Wajib**:
  Jika memodifikasi atau menambahkan elemen DOM dengan event handler (`onclick`, `onchange`, dll.) atau fungsi sanitasi teks:
  1. Periksa secara eksplisit bahwa fungsi yang dipanggil (misalnya `escapeHtml`, `escapeAttrJs`, `formatRupiah`) benar-benar telah terdefinisi di dalam tag `<script>`.
  2. Jangan berasumsi bahwa antarmuka bebas galat hanya karena endpoint API backend merespons 200.

## 3. Protokol Audit dan Klaim Kesiapan Rilis (Deploy)
* Agen dilarang menyimpulkan "tidak ada error / bebas masalah kritikal" sebelum:
  1. Server berhasil di-booting secara lokal menggunakan basis data riil dan merespons endpoint `/health`.
  2. Seluruh fungsi antarmuka yang terdampak oleh perubahan telah diverifikasi definisinya.
