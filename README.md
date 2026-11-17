# RentFlow: Rental Property Management & TraceFund Financial Engine

RentFlow is an enterprise-grade, full-stack rental property management platform and dual-entry financial bookkeeping system. Designed for landlords and property managers, RentFlow automates recurring billing cycles based on local timezones (WIB/Asia-Jakarta), dispatches automated overdue payment reminders via a self-hosted WhatsApp Baileys client and SMTP email, provides dedicated public tenant portals for digital payments (QRIS, bank transfer, cash) and facility maintenance requests, and features the TraceFund ledger engine for real-time cash flow analytics.

---

## Architecture & Project Structure

The project follows a modular, decoupled architecture adhering to separation of concerns (SoC). It is structured for maintainability, reliability, and modern software engineering portfolio standards:

```text
RentFlow/
├── public/                 # Static frontend assets (Zero-build HTML5, Tailwind CSS, Vanilla JS)
│   ├── index.html          # Administrative management dashboard & TraceFund financial analytics
│   ├── tagihan.html        # Public tenant invoice portal & proof-of-payment submission
│   └── keluhan.html        # Public tenant maintenance & complaint submission portal
├── src/                    # Backend application core (Node.js 24+ native SQLite)
│   ├── app.js              # HTTP server initialization, security headers, CORS, graceful shutdown
│   ├── config/             # Environment and persistence configurations
│   │   ├── env.js          # Centralized environment constants and directory path resolution
│   │   └── database.js     # SQLite (node:sqlite DatabaseSync) init, PRAGMA WAL, schema & 11 performance indexes
│   ├── routes/             # API routing layer and request dispatcher
│   │   └── index.js        # 39 RESTful endpoints (Auth, Units, Invoices, Complaints, TraceFund, WhatsApp)
│   ├── services/           # Domain-driven core business services
│   │   ├── billing.js      # FIFO multi-month payment allocation, invoice state lifecycle, auto-billing
│   │   ├── tracefund.js    # Unified cash ledger, running balance calculation, cross-month analytics, DB backups
│   │   ├── whatsapp.js     # Self-hosted WhatsApp Baileys socket, webhook handlers, and 12 TraceFund bot commands
│   │   └── scheduler.js    # Automated daily invoice overdue checkers, monthly cron generators, SMTP mailer
│   └── utils/              # Pure reusable utility functions
│       ├── parser.js       # Flexible currency parser (k/jt/rb), automatic expense categorizer, command parser
│       ├── security.js     # HMAC-SHA256 tokens, in-memory rate limiter, magic bytes image validation, tenant privacy masking
│       └── time.js         # Timezone-aware date calculations and due-date logic (Asia/Jakarta / WIB)
├── scripts/                # Database migration and operational scripts
│   └── sync_from_postgres.py # Historical data sync script from PostgreSQL to local SQLite
├── tests/                  # End-to-end automated test suites
│   └── test_all.js         # Comprehensive 10-phase test runner (100% passing)
├── Dockerfile              # Multi-stage lightweight Node.js 24 Alpine container definition
├── docker-compose.yml      # Container orchestration with persistent volume mapping
├── server.js               # Clean application entry point and runner
├── package.json            # Package manifest and npm scripts
└── README.md               # Technical project documentation
```

---

## Key Features

- **Automated Lease & Billing Lifecycle:** Automatically generates monthly rental invoices on schedule, calculates arrears, and applies FIFO (First-In, First-Out) algorithms for partial or multi-month advance payments.
- **Self-Hosted WhatsApp Bot:** Powered by `@whiskeysockets/baileys` without recurring third-party gateway fees. Supports two-way administrative commands and automated tenant notifications.
- **TraceFund Financial Engine:** Real-time ledger recording rental revenues, general incomes, and categorized operating expenses with running balance calculation, monthly budget threshold monitoring, and CSV exports with UTF-8 BOM.
- **Tenant Self-Service Portals:** Clean, mobile-responsive web portals for tenants to inspect invoice details, generate QRIS payment requests, upload bank transfer receipts, submit maintenance tickets with photos, and download official receipts without requiring an account.
- **Enterprise-Grade Security:** Cryptographically verified HMAC-SHA256 session tokens, brute-force rate limiters, strict magic bytes verification for file uploads (JPEG, PNG, WEBP), and automatic tenant personally identifiable information (PII) masking on public routes.
- **Production-Ready Persistence:** Powered by Node.js native `node:sqlite` (`DatabaseSync`) configured with Write-Ahead Logging (WAL) and synchronous NORMAL PRAGMA, supplemented by 11 performance indexes.

---

## Deployment with Docker (Recommended for VPS)

The application includes a production-ready Docker container based on `node:24-alpine`.

### 1. Launch the Container
```bash
docker compose up -d --build
```
The application will build and run in the background, listening on host port `5005` (mapped to container port `5000`).

### 2. Monitor Container Status & Logs
```bash
# Check container status
docker compose ps

# Tail application logs in real time
docker compose logs -f
```

### 3. Container Management
```bash
# Restart container
docker compose restart

# Stop container
docker compose down
```

### 4. Data Persistence
All application data is mounted to the host filesystem under `./data`:
- SQLite Database: `./data/kontrakan.db`
- Uploaded receipts & QRIS assets: `./data/uploads/`
- WhatsApp Baileys credentials: `./data/wa_session/`
- Automated database backups: `./data/backups/`

---

## Local Development

### Prerequisites
- Node.js v22.x or v24.x LTS (Node.js 24 is recommended for native `node:sqlite` support).
- npm v10+

### Setup & Run
```bash
# Install dependencies
npm install

# Run the 10-phase automated test suite
npm test

# Start the server
npm start
```
The server will be reachable at `http://localhost:5000`.

---

## Automated Verification & Test Suites

Execute the comprehensive automated test suite with:
```bash
npm test
```

The test runner covers 10 critical operational areas:
1. SQLite schema validation, foreign key integrity, and access token columns.
2. WIB timezone-aware date parsing and overdue interval calculations.
3. Magic bytes binary validation for file uploads (JPEG/PNG/WEBP) and blocking dangerous extensions (.php, .js, .svg).
4. In-memory sliding window rate limiting across authentication and public endpoints.
5. HMAC-SHA256 cryptographic verification and elimination of authentication bypasses.
6. Tenant PII masking on unauthenticated public invoice endpoints.
7. Static file serving whitelist restrictions.
8. TraceFund currency parsing (`150k`, `1.5jt`, `50rb`) and auto-categorization heuristics.
9. End-to-end execution of all 12 TraceFund WhatsApp administrative bot commands.
10. Production readiness checks (Healthcheck `/health`, Security Headers, WAL Checkpoint, and indexing).

---

## WhatsApp Bot & TraceFund Commands

The system features an autonomous WhatsApp client. Once authenticated by scanning the QR code in **Settings > WhatsApp Bot**, the registered landlord phone number can execute administrative commands:

| Command | Description | Example Usage |
| :--- | :--- | :--- |
| `#keluar` | Record operational expense with flexible nominal & auto-categorization | `#keluar 150k Listrik Beli token pompa air` |
| `#masuk` | Record non-rental income (e.g. recycling, penalties, deposits) | `#masuk 500k Penjualan kardus bekas` |
| `#saldo` | Display real-time cash balance, total incoming, and total outgoing | `#saldo` |
| `#budget` | View or configure monthly expenditure threshold | `#budget 5jt` or `#budget` |
| `#kategori` | Breakdown of current month expenses grouped by category | `#kategori` |
| `#ringkasan` | Financial summary and net profit for the active month | `#ringkasan` |
| `#tahunan` | 12-month annual cash flow and profit recap | `#tahunan` |
| `#analisis` | Cross-month comparative financial trend analysis | `#analisis` |
| `#total` | Sum total expenditures matching a specific search keyword | `#total token` |
| `#riwayat` | Display the 5 most recent cash ledger transactions | `#riwayat` |
| `#ekspor` / `#csv` | Generate and receive CSV spreadsheet report directly in chat | `#ekspor` |
| `#batal` | Rollback / delete the most recent recorded expense transaction | `#batal` |
| `#status` / `#cek` | Check room occupancy status and list overdue tenants | `#status` |
| `#lunas` | Mark an invoice as fully paid via chat | `#lunas 21.A` |
| `#keluhan` | List outstanding tenant facility maintenance tickets | `#keluhan` |
| `#bantuan` | Display interactive command help menu | `#bantuan` |

---

## Public Tenant Portals

Tenants do not require administrative accounts to interact with the system:
1. **Invoice & Digital Payment Portal:**  
   `http://your-domain.com/tagihan.html?id=INV-XXXXX&token=XXXX`  
   Tenants can review rent details, inspect due dates, pay via interactive QRIS or bank transfer, notify intent for cash payments, upload payment proof, and download official receipts once verified.
2. **Facility Maintenance Portal:**  
   `http://your-domain.com/keluhan.html`  
   Tenants can submit maintenance requests (water pump, electrical, roofing, plumbing) accompanied by description notes and photo attachments.

---

## Nginx Reverse Proxy & SSL Setup (Production)

To route a domain name with SSL certificates to the Docker service:

```nginx
server {
    server_name your-domain.com www.your-domain.com;
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:5005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Issue a free Let's Encrypt SSL certificate:
```bash
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Node environment runtime mode |
| `PORT` | `5000` | Internal server HTTP port |
| `HOST` | `0.0.0.0` | Network binding interface |
| `APP_USER` | `admin` | Administrative dashboard login username |
| `APP_PASS` | `nekyuyun2026` | Administrative dashboard login password |
| `DATA_DIR` | `./data` | Directory path for persistent database and file storage |
| `BASE_URL` | `http://localhost:5005` | Canonical base URL used for email and WhatsApp invoice links |

---

## License

This project is licensed under the ISC License.
