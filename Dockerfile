# Menggunakan Node.js 24 Alpine yang ringan dan mendukung node:sqlite bawaan
FROM node:24-alpine

# Set direktori kerja
WORKDIR /app

# Salin berkas paket dependensi
COPY package*.json ./

# Pasang dependensi produksi
RUN npm ci --omit=dev || npm install --omit=dev

# Salin seluruh kode aplikasi dan aset
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Buat direktori data untuk persistensi database dan upload bukti transfer
RUN mkdir -p /app/data /app/data/uploads

# Set environment variabel produksi
ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

# Buka port 5000
EXPOSE 5000

# Volume untuk persistensi data di host
VOLUME ["/app/data"]

# Healthcheck status kontainer
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5000/health || exit 1

# Jalankan server
CMD ["node", "server.js"]
