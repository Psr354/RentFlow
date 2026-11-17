const { PORT, HOST } = require('./src/config/env');
const { db, getSettings, setSetting } = require('./src/config/database');
const {
    parseNominalTrace,
    detectExpenseCategory,
    parseMonthYearInput,
    parseExpenseCommand,
    parseIncomeCommand
} = require('./src/utils/parser');
const {
    getUnifiedTransactions,
    getTraceFundAnalytics
} = require('./src/services/tracefund');
const {
    initWhatsAppClient,
    handleIncomingWhatsAppMessage
} = require('./src/services/whatsapp');
const { startBackgroundSchedulers } = require('./src/services/scheduler');
const { server, handleGracefulShutdown } = require('./src/app');

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        console.log(`Server Kontrakan Nenek Yuyun aktif pada http://${HOST}:${PORT}`);
    });

    initWhatsAppClient().catch(err => {
        console.error('[WhatsApp] Gagal inisialisasi socket:', err.message);
    });

    startBackgroundSchedulers();
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception terdeteksi:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection terdeteksi:', reason);
});

module.exports = {
    server,
    db,
    getUnifiedTransactions,
    getTraceFundAnalytics,
    parseNominalTrace,
    detectExpenseCategory,
    parseMonthYearInput,
    parseExpenseCommand,
    parseIncomeCommand,
    handleIncomingWhatsAppMessage,
    getSettings,
    setSetting
};
