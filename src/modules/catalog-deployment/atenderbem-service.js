import { prisma } from '../../../prisma/PrismaClient.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { DeploymentError } from './errors.js';
import { normalizeAtenderBemConfig, feedIdFromUnit, buildFeedUrl, preserveAtenderBemProgress } from './atenderbem-config.js';
import { createMcpClient } from './adapters/mcp.client.js';
import { Prisma } from '@prisma/client';
import { readAtenderBemFeed } from './atenderbem-feed.js';

export async function saveAtenderBemConfiguration(deploymentId, unitId, input, requestedBy) {
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada nesta implantação.', { statusCode: 404 });
  const oldSecrets = unit.atenderBemSecretsEncrypted ? JSON.parse(decryptSecret(unit.atenderBemSecretsEncrypted)) : {};
  const { config, secrets } = normalizeAtenderBemConfig({ ...input, feedUnitId: feedIdFromUnit(unit) }, oldSecrets);
  // Credentials must be supplied again when moving to a different destination.
  const previous = unit.atenderBemConfig;
  if (previous?.import && !['completed', 'failed', 'cancelled', 'failed_before_import'].includes(previous.import.status)) {
    throw new DeploymentError('ATENDERBEM_IMPORT_BUSY', 'A importação está em andamento ou precisa ser conferida antes de editar.', { statusCode: 409 });
  }
  if (['creating_group', 'group_creation_unknown'].includes(previous?.status)) {
    throw new DeploymentError('ATENDERBEM_GROUP_RECONCILIATION_REQUIRED', 'Confira o grupo na instância antes de alterar esta configuração.', { statusCode: 409 });
  }
  preserveAtenderBemProgress(config, previous, secrets, oldSecrets);
  if ((previous?.mcpUrl && previous.mcpUrl !== config.mcpUrl && !String(input.mcpKey || '').trim()) ||
      (previous?.feedBaseUrl && (previous.feedBaseUrl !== config.feedBaseUrl || previous.feedAuth !== config.feedAuth) && !String(input.feedKey || '').trim())) {
    throw new DeploymentError('ATENDERBEM_CREDENTIAL_REQUIRED', 'Informe novamente a credencial ao mudar o endereço ou a autenticação.', { statusCode: 400 });
  }
  const storedConfig = { ...config, updatedAt: new Date().toISOString() };
  await prisma.$transaction(async (tx) => {
    const updated = await tx.clientDeploymentUnit.updateMany({ where: { id: unitId, atenderBemConfig: { equals: previous || Prisma.DbNull } }, data: { atenderBemConfig: storedConfig, atenderBemSecretsEncrypted: encryptSecret(JSON.stringify(secrets)) } });
    if (updated.count !== 1) throw new DeploymentError('ATENDERBEM_CONFIG_CHANGED', 'A configuração mudou. Atualize a página antes de continuar.', { statusCode: 409 });
    await tx.clientDeploymentEvent.create({ data: { deploymentId, unitId, eventType: 'atenderbem_configuration_saved', createdBy: requestedBy, safeMetadata: { executionEnabled: false } } });
  });
  return { ...storedConfig, feedUrl: buildFeedUrl(config.feedBaseUrl, config.feedUnitId) };
}

export async function createAtenderBemGroup(deploymentId, unitId, requestedBy, dependencies = {}) {
  const database = dependencies.database || prisma;
  const makeClient = dependencies.makeClient || createMcpClient;
  const unit = await database.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada nesta implantação.', { statusCode: 404 });
  const config = unit.atenderBemConfig;
  if (!config) throw new DeploymentError('ATENDERBEM_CONFIG_REQUIRED', 'Salve a configuração antes de criar o grupo.', { statusCode: 409 });
  if (config.groupId) return config;
  if (config.status !== 'configured' || config.groupMode !== 'create') {
    throw new DeploymentError('ATENDERBEM_GROUP_RECONCILIATION_REQUIRED', 'A criação está em andamento ou precisa ser conferida na instância antes de repetir.', { statusCode: 409 });
  }
  // Persist the claim before the external call: concurrent requests and restarts cannot create twice.
  const claimed = { ...config, status: 'creating_group', updatedAt: new Date().toISOString() };
  const claim = await database.clientDeploymentUnit.updateMany({ where: { id: unitId, deploymentId, atenderBemConfig: { equals: config } }, data: { atenderBemConfig: claimed } });
  if (claim.count !== 1) throw new DeploymentError('ATENDERBEM_GROUP_BUSY', 'A configuração mudou ou a criação já está em andamento.', { statusCode: 409 });
  let creationSent = false;
  let validatingFeed = true;
  try {
    const secrets = JSON.parse(decryptSecret(unit.atenderBemSecretsEncrypted));
    await readAtenderBemFeed(unit, config, secrets, dependencies);
    validatingFeed = false;
    const client = makeClient({ mcpUrl: config.mcpUrl, mcpKey: secrets.mcpKey });
    const tools = await client.tools();
    creationSent = true;
    const group = await client.call('product_groups_create', { name: config.groupName, description: `Catálogo da unidade ${unit.name}, configurado pelo Integra.` }, tools);
    const id = Number(group?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Resposta sem ID de grupo válido.');
    const ready = { ...config, status: 'group_ready', groupMode: 'existing', groupId: id, updatedAt: new Date().toISOString() };
    await database.$transaction([
      database.clientDeploymentUnit.update({ where: { id: unitId }, data: { atenderBemConfig: ready } }),
      database.clientDeploymentEvent.create({ data: { deploymentId, unitId, eventType: 'atenderbem_group_created', createdBy: requestedBy, safeMetadata: { groupId: id } } }),
    ]);
    return ready;
  } catch (error) {
    await database.clientDeploymentUnit.update({ where: { id: unitId }, data: { atenderBemConfig: { ...config, status: creationSent ? 'group_creation_unknown' : 'configured', updatedAt: new Date().toISOString() } } });
    if (validatingFeed) {
      throw new DeploymentError('ATENDERBEM_FEED_VALIDATION_FAILED', `Não foi criado nenhum grupo. ${error.message}`, { statusCode: 422 });
    }
    throw new DeploymentError('ATENDERBEM_GROUP_CREATION_FAILED', creationSent
      ? 'Não foi possível confirmar a criação. Confira o grupo no AtenderBem antes de repetir para evitar duplicação.'
      : 'Não foi possível conectar ao MCP. Confira a chave e a disponibilidade da instância.', { statusCode: 502 });
  }
}
