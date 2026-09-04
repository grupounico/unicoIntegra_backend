import os from 'node:os';
import crypto from 'node:crypto';
import { prisma } from '../../../prisma/PrismaClient.js';
import { env } from '../../config/env.js';
import { processDeployment } from './service.js';

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
let timer = null; let running = false;

async function tick() {
  if (running) return; running = true;
  try {
    const staleBefore = new Date(Date.now() - env.DEPLOYMENT_LEASE_MS);
    const candidate = await prisma.clientDeployment.findFirst({ where: { status: { in: ['queued', 'provisioning_hub', 'validating_hub_catalog', 'provisioning_unicommerce', 'validating_unicommerce', 'importing_banco_unico'] }, OR: [{ workerHeartbeatAt: null }, { workerHeartbeatAt: { lt: staleBefore } }] }, orderBy: { updatedAt: 'asc' } });
    if (!candidate) return;
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
  } catch (error) { console.error('[catalog-deployment-worker]', error.message); }
  finally { running = false; }
}

export function initializeCatalogDeploymentWorker() {
  if (!env.DEPLOYMENT_WORKER_ENABLED || timer) return;
  timer = setInterval(tick, Math.max(1000, env.DEPLOYMENT_WORKER_INTERVAL_MS)); timer.unref(); tick();
}
