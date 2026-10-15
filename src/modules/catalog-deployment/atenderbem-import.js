import { prisma } from '../../../prisma/PrismaClient.js';
import { decryptSecret } from './crypto.js';
import { DeploymentError } from './errors.js';
import { createMcpClient, LabError } from './adapters/mcp.client.js';
import { readAtenderBemFeed } from './atenderbem-feed.js';

function fail(message, statusCode = 409) { return new DeploymentError('ATENDERBEM_IMPORT_ERROR', message, { statusCode }); }
async function context(deploymentId, unitId, dependencies) {
  const database = dependencies.database || prisma;
  const unit = await database.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!unit?.atenderBemConfig?.groupId) throw fail('Salve e vincule um grupo antes de importar.');
  const config = unit.atenderBemConfig;
  if (['creating_group', 'group_creation_unknown'].includes(config.status)) throw fail('Confira a criação do grupo antes de importar.');
  const secrets = JSON.parse(decryptSecret(unit.atenderBemSecretsEncrypted));
  const client = (dependencies.makeClient || createMcpClient)({ mcpUrl: config.mcpUrl, mcpKey: secrets.mcpKey });
  return { database, unit, config, secrets, client };
}
async function claim(database, unitId, previous, next) {
  const updated = await database.clientDeploymentUnit.updateMany({ where: { id: unitId, atenderBemConfig: { equals: previous } }, data: { atenderBemConfig: next } });
  if (updated.count !== 1) throw fail('Outra operação está em andamento. Atualize a página.');
}
export async function startAtenderBemImport(deploymentId, unitId, requestedBy, dependencies = {}) {
  const { database, unit, config, secrets, client } = await context(deploymentId, unitId, dependencies);
  const retryable = ['failed_before_import', 'cancelled', 'failed'];
  if (config.import?.status === 'completed' && config.import.errors > 0) retryable.push('completed');
  if (config.import?.jobId && !retryable.includes(config.import.status)) return config;
  if (config.import && !retryable.includes(config.import.status)) throw fail('O envio está em andamento ou precisa ser conferido no AtenderBem antes de repetir.');
  const baseConfig = { ...config, ...(config.import?.jobId ? { previousImport: config.import } : {}) };
  const importing = { ...baseConfig, import: { status: 'uploading', startedAt: new Date().toISOString() } };
  await claim(database, unitId, config, importing);
  let sent = false;
  let fileId;
  try {
    const tools = await client.tools();
    const { feed, feedConfig } = await readAtenderBemFeed(unit, config, secrets, dependencies);
    // The live upload endpoint counts multipart overhead against the ticket limit.
    const maxBytes = Math.min(64 * 1024 * 1024, feed.size + 1024 * 1024);
    const ticket = await client.call('files_create_upload_url', { fileName: `catalogo-unidade-${feedConfig.feedUnitId}.csv`, mimeType: 'text/csv', maxBytes, ttlSeconds: 900 }, tools);
    const url = new URL(ticket.uploadUrl);
    const origin = new URL(config.mcpUrl).origin;
    const allowed = String((dependencies.environment || process.env).CATALOG_UPLOAD_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || (url.origin !== origin && !allowed.includes(url.hostname))) throw fail('O armazenamento retornado pelo MCP precisa ser configurado na lista de destinos permitidos.', 502);
    const multipart = new FormData();
    multipart.append('file', new Blob([feed.bytes], { type: 'text/csv' }), `catalogo-unidade-${feedConfig.feedUnitId}.csv`);
    const response = await (dependencies.fetchImpl || fetch)(url.toString(), { method: 'POST', body: multipart, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(response.status === 413 ? 'O MCP recusou o tamanho do upload (HTTP 413). O ticket precisa comportar o CSV e o formulário multipart.' : `O upload retornou HTTP ${response.status}.`, 502);
    }
    const uploaded = await response.json();
    fileId = Number(uploaded.fileId);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw fail('O upload não retornou um ID de arquivo válido.', 502);
    sent = true;
    const result = await client.call('products_import', { fileId, groupId: config.groupId, format: 'csv', source: 'meta', missingAction: 0, fileChangeAction: 0 }, tools);
    const jobId = Number(result.jobId);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw fail('A importação não retornou um ID de execução válido.', 502);
    const queued = { ...baseConfig, import: { status: 'queued', jobId, fileId, bytes: feed.size, startedAt: importing.import.startedAt } };
    await database.$transaction([
      database.clientDeploymentUnit.update({ where: { id: unitId }, data: { atenderBemConfig: queued } }),
      database.clientDeploymentEvent.create({ data: { deploymentId, unitId, eventType: 'atenderbem_import_started', createdBy: requestedBy, safeMetadata: { jobId, groupId: config.groupId } } }),
    ]);
    return queued;
  } catch (error) {
    await database.clientDeploymentUnit.update({ where: { id: unitId }, data: { atenderBemConfig: { ...baseConfig, import: { status: sent ? 'unknown' : 'failed_before_import', ...(fileId ? { fileId } : {}) } } } });
    throw fail(sent ? 'Não foi possível confirmar a importação. Confira o andamento no AtenderBem antes de repetir.' : error instanceof DeploymentError || error instanceof LabError ? error.message : 'Não foi possível obter ou enviar o CSV. Confira as credenciais do feed e do MCP.', 502);
  }
}

export async function checkAtenderBemImport(deploymentId, unitId, dependencies = {}) {
  const { database, config, client } = await context(deploymentId, unitId, dependencies);
  if (!config.import?.jobId) throw fail('Nenhuma importação foi iniciada para esta unidade.');
  if (['completed', 'reindexing', 'reindex_unknown'].includes(config.import.status)) return config;
  const tools = await client.tools();
  const result = await client.call('products_import_status', { jobId: config.import.jobId }, tools);
  const job = result.job || result;
  const status = Number(job.status);
  if (![0, 1, 2, 3, 4].includes(status)) throw fail('O MCP retornou um status de importação desconhecido.', 502);
  const counters = Object.fromEntries(['total', 'processed', 'created', 'updated', 'errors'].map(key => [key, Number(job[key] || 0)]));
  const next = { ...config, import: { ...config.import, ...counters, status: ['queued', 'running', 'reindexing', 'failed', 'cancelled'][status] } };
  await claim(database, unitId, config, next);
  if (status === 2) {
    try {
      const indexed = await client.call('products_reindex', { groupIds: [config.groupId], includeIndexed: true }, tools);
      next.import.status = 'completed';
      next.import.reindexMarked = Number(indexed.marked || 0);
    } catch {
      next.import.status = 'reindex_unknown';
    }
    await database.clientDeploymentUnit.update({ where: { id: unitId }, data: { atenderBemConfig: next } });
  }
  return next;
}
