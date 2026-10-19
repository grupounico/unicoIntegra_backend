import { readFeed, LabError } from './adapters/mcp.client.js';
import { feedIdFromUnit, getAtenderBemSettings } from './atenderbem-config.js';
import { prisma } from '../../../prisma/PrismaClient.js';

export async function resolveAtenderBemFeedEnvironment(unit, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  if (!String(environment.CATALOG_ATENDERBEM_FEED_BASE_URL || '').trim().startsWith('http:')) return environment;
  const database = dependencies.database || prisma;
  const deployment = await database.clientDeployment.findUnique({ where: { id: unit.deploymentId }, select: { environment: true } });
  return { ...environment, CATALOG_LOCAL_DEPLOYMENT_ENVIRONMENT: deployment?.environment || '' };
}

export async function readAtenderBemFeed(unit, config, secrets, dependencies = {}) {
  const environment = await resolveAtenderBemFeedEnvironment(unit, dependencies);
  const feedConfig = { ...config, ...secrets, feedUnitId: feedIdFromUnit(unit), feedBaseUrl: getAtenderBemSettings(environment).feedBaseUrl };
  const feed = await (dependencies.readFeed || readFeed)(feedConfig, dependencies.fetchImpl, environment);
  const text = feed.bytes.toString('utf8').replace(/^\uFEFF/, '');
  const end = text.search(/[\r\n]/);
  const header = (end === -1 ? text : text.slice(0, end)).split(/[,;\t]/).map(column => column.trim().replace(/^"|"$/g, ''));
  if (!['id', 'title', 'price'].every(column => header.includes(column))) {
    throw new LabError('O feed da unidade não contém as colunas id, title e price exigidas para o catálogo.', 422);
  }
  if (end === -1 || !text.slice(end).trim()) {
    throw new LabError('O CSV da unidade está vazio. Confira a unidade e a disponibilidade dos produtos antes de criar o grupo.', 422);
  }
  return { feed, feedConfig };
}
