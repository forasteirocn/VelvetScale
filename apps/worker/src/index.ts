import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { webhookRouter } from './routes/webhook';
import { apiRouter } from './routes/api';
import { initQueues } from './queues';
import { closeBrowser } from './integrations/reddit';
import { startPolling, stopPolling } from './integrations/telegram-polling';
import { startScheduler, stopScheduler } from './scheduler';
import { startEngagementManager, stopEngagementManager } from './engagement';
import { startKarmaBuilder, stopKarmaBuilder } from './karma';
import { startSubDiscovery, stopSubDiscovery } from './discovery-smart';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'velvetscale-worker', timestamp: new Date().toISOString() });
});

// Routes
app.use('/webhook', webhookRouter);
app.use('/api', apiRouter);

// Initialize queues and start server
async function main() {
    try {
        await initQueues();
        console.log('✅ BullMQ queues initialized');
        console.log('🌐 Playwright browser automation ready');

        // Start Telegram long polling (no webhook needed!)
        await startPolling();

        // Start all intelligent modules
        startScheduler();          // Posts agendados (5 min)
        startEngagementManager();  // Responde comentários (30 min)
        startKarmaBuilder();       // Constrói karma (2h)
        startSubDiscovery();       // Descobre subs (24h)

        app.listen(PORT, () => {
            console.log(`🚀 VelvetScale Worker running on port ${PORT}`);
            console.log(`🔗 API: http://localhost:${PORT}/api`);
            console.log(`💡 Send /start to your Telegram bot to test!`);
        });
    } catch (error) {
        console.error('❌ Failed to start worker:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    stopPolling();
    stopScheduler();
    stopEngagementManager();
    stopKarmaBuilder();
    stopSubDiscovery();
    await closeBrowser();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    stopPolling();
    stopScheduler();
    stopEngagementManager();
    stopKarmaBuilder();
    stopSubDiscovery();
    await closeBrowser();
    process.exit(0);
});

main();


