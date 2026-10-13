import os from 'node:os';
import crypto from 'node:crypto';
import { prisma } from '../../../prisma/PrismaClient.js';
import { env } from '../../config/env.js';
import { processDeployment, processHubCatalogBackground, purgeExpiredDeploymentCredentials, reconcileStorefrontAliases } from './service.js';

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
let timer = null; let running = false;

export async function runCatalogDeploymentWorkerOnce() {
  if (running) return; running = true;
  try {
    const staleBefore = new Date(Date.now() - env.DEPLOYMENT_LEASE_MS);
    const releasePollBefore = new Date(Date.now() - Math.max(5000, env.STOREFRONT_RELEASE_POLL_INTERVAL_MS));
    const candidate = await prisma.clientDeployment.findFirst({ where: { AND: [
      { status: { in: ['queued', 'provisioning_hub', 'validating_hub_catalog', 'provisioning_unicommerce', 'validating_unicommerce', 'importing_banco_unico', 'awaiting_activation', 'waiting_storefront_release', 'waiting_storefront'] } },
      { OR: [{ status: { not: 'waiting_storefront_release' } }, { status: 'waiting_storefront_release', updatedAt: { lt: releasePollBefore } }] },
      { OR: [{ status: { not: 'waiting_storefront' } }, { status: 'waiting_storefront', updatedAt: { lt: new Date(Date.now() - 30000) } }] },
      { OR: [{ workerHeartbeatAt: null }, { workerHeartbeatAt: { lt: staleBefore } }] },
    ] }, orderBy: { updatedAt: 'asc' } });
    if (!candidate) {
      await processHubCatalogBackground();
      await purgeExpiredDeploymentCredentials();
      await reconcileStorefrontAliases();
      return;
    }
    const claimed = await prisma.clientDeployment.updateMany({ where: { id: candidate.id, OR: [{ workerHeartbeatAt: null }, { workerHeartbeatAt: { lt: staleBefore } }] }, data: { workerId, workerHeartbeatAt: new Date(), startedAt: candidate.startedAt || new Date() } });
    if (claimed.count) {
      const heartbeat = setInterval(() => {
        prisma.clientDeployment.updateMany({ where: { id: candidate.id, workerId }, data: { workerHeartbeatAt: new Date() } }).catch(() => {});
      }, Math.max(1000, Math.floor(env.DEPLOYMENT_LEASE_MS / 3)));
      heartbeat.unref();
      try { await processDeployment(candidate.id); }
      finally {
        clearInterval(heartbeat);
        await prisma.clientDeployment.updateMany({ where: { id: candidate.id, workerId }, data: { workerId: null, workerHeartbeatAt: null } });
      }
    }
    await processHubCatalogBackground();
    await purgeExpiredDeploymentCredentials();
    await reconcileStorefrontAliases();
  } catch (error) { console.error('[catalog-deployment-worker]', error.message); }
  finally { running = false; }
}

export function initializeCatalogDeploymentWorker() {
  if (!env.DEPLOYMENT_WORKER_ENABLED || timer) return;
  timer = setInterval(runCatalogDeploymentWorkerOnce, Math.max(1000, env.DEPLOYMENT_WORKER_INTERVAL_MS)); timer.unref(); runCatalogDeploymentWorkerOnce();
}

export function stopCatalogDeploymentWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
