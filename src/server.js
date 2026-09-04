import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { initializeBancoUnicoImportWorker } from './services/bancoUnicoImports.service.js';
import { ensureNewsTableExists } from './services/news.services.js';
import { startAiUraSnapshotAuditScheduler } from './services/aiUraSnapshotAudit.services.js';
import { initializeCatalogDeploymentWorker } from './modules/catalog-deployment/worker.js';
import { prisma } from '../prisma/PrismaClient.js';
import { adminPool } from './database/adminPool.js';

const PORT = env.PORT;
const HOST = env.HOST;

ensureNewsTableExists().then(() => {
  startAiUraSnapshotAuditScheduler();
  if (env.BANCO_UNICO_IMPORT_WORKER_ENABLED) {
    initializeBancoUnicoImportWorker();
  }
  initializeCatalogDeploymentWorker();
  const server = app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT}`);
  }).on('error', (err) => {
    console.error('--- FALHA AO INICIAR O SERVIDOR ---');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} recebido; encerrando conexoes.`);

    const forceExit = setTimeout(() => {
      console.error('[shutdown] Tempo limite excedido; encerrando processo.');
      process.exit(1);
    }, 25000);
    forceExit.unref();

    server.close(async (error) => {
      if (error) console.error('[shutdown] Falha ao encerrar HTTP:', error.message);
      await Promise.allSettled([prisma.$disconnect(), adminPool.end()]);
      clearTimeout(forceExit);
      process.exit(error ? 1 : 0);
    });
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
});
