import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { initializeBancoUnicoImportWorker } from './services/bancoUnicoImports.service.js';
import { ensureNewsTableExists } from './services/news.services.js';
import { startAiUraSnapshotAuditScheduler } from './services/aiUraSnapshotAudit.services.js';
import { initializeCatalogDeploymentWorker } from './modules/catalog-deployment/worker.js';

const PORT = env.PORT;
const HOST = env.HOST;

ensureNewsTableExists().then(() => {
  startAiUraSnapshotAuditScheduler();
  initializeBancoUnicoImportWorker();
  initializeCatalogDeploymentWorker();
  app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT}`);
  }).on('error', (err) => {
    console.error('--- FALHA AO INICIAR O SERVIDOR ---');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  });
});
