import { DeploymentError } from './errors.js';
import { allowedUrl } from './adapters/mcp.client.js';

// Etapa "Criação da IA", depois do AtenderBem. Usa o mesmo instalador por template das
// demais IAs (createManagedIntegratedAi) com a conta de serviço da instância: o operador
// não informa credenciais. Funil CRM e vínculo da fila ficam para o processo do AtenderBem.
export const AI_MODALITIES = { venda: 'IA de venda' };
const STALE_MS = 5 * 60 * 1000;

function fail(code, message, statusCode = 409) {
  throw new DeploymentError(code, message, { statusCode, stage: 'ai_creation' });
}

export function instanceFromMcpUrl(mcpUrl, environment = process.env) {
  return new URL(allowedUrl(mcpUrl, 'mcp', environment)).origin;
}

export function aiStep({ database, installers, environment = process.env }) {
  async function save(unit, before, ai, eventType, actor) {
    const after = { ...before, ai };
    await database.$transaction(async tx => {
      const result = await tx.clientDeploymentUnit.updateMany({
        where: { id: unit.id, deploymentId: unit.deploymentId, atenderBemConfig: { equals: before } },
        data: { atenderBemConfig: after },
      });
      if (result.count !== 1) fail('AI_CREATION_BUSY', 'A unidade mudou ou outra criação está em andamento. Atualize a página.');
      await tx.clientDeploymentEvent.create({ data: { deploymentId: unit.deploymentId, unitId: unit.id, eventType,
        safeMetadata: { modality: ai.modality, status: ai.status, assistantId: ai.assistantId || null }, createdBy: actor } });
    });
    return after;
  }

  async function createAi(deploymentId, unitId, input = {}, actor = 'Sistema') {
    const modality = String(input.modality || 'venda');
    if (!installers[modality]) fail('AI_MODALITY_UNAVAILABLE', 'Modalidade de IA ainda não disponível.', 400);
    const unit = await database.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
    if (!unit) fail('UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    const config = unit.atenderBemConfig || {};
    if (!config.mcpUrl || !config.groupId) fail('ATENDERBEM_CONFIG_REQUIRED', 'Conclua a etapa AtenderBem (instância e grupo de produtos) antes de criar a IA.');
    // Validate the stored destination before claiming work or sending the service account.
    const instance = instanceFromMcpUrl(config.mcpUrl, environment);
    const current = config.ai;
    if (current?.status === 'created') fail('AI_ALREADY_CREATED', `A IA já foi criada nesta unidade (assistente ${current.assistantId}).`);
    if (current?.status === 'creating' && Date.now() - Date.parse(current.startedAt) < STALE_MS) fail('AI_CREATION_BUSY', 'A criação da IA está em andamento. Aguarde alguns minutos.');
    if (config.import?.status !== 'completed') fail('ATENDERBEM_IMPORT_PENDING', 'Aguarde a importação do catálogo terminar antes de criar a IA.');

    const name = String(input.name || '').trim() || `IA de Venda - ${unit.name}`;
    const signatureName = String(input.signatureName || '').trim() || unit.name;
    if (name.length > 120 || signatureName.length > 100 || /[{}]/.test(name + signatureName)) fail('AI_INPUT_INVALID', 'Nome e assinatura devem ser curtos e sem chaves {}.', 400);

    const base = { modality, instance, name, signatureName, productsGroupId: Number(config.groupId), startedAt: new Date().toISOString() };
    // Marca a tentativa antes de chamar a instância: clique duplo não cria duas IAs.
    const before = await save(unit, config, { ...base, status: 'creating' }, 'ai_creation_started', actor);
    try {
      const result = await installers[modality]({ instance, name, nome_cliente: unit.name, signatureName, productsGroupId: Number(config.groupId) });
      const ai = { ...base, status: 'created', assistantId: result?.id ?? result?.installation?.assistantId ?? null,
        supportFlows: result?.supportFlows || {}, finishedAt: new Date().toISOString() };
      await save(unit, before, ai, 'ai_created', actor);
      return ai;
    } catch (error) {
      const message = error instanceof DeploymentError ? error.message : 'Falha ao criar a IA na instância. Confira no AtenderBem se algum recurso ficou criado antes de tentar de novo.';
      const ai = { ...base, status: 'failed', error: message, finishedAt: new Date().toISOString() };
      await save(unit, before, ai, 'ai_creation_failed', actor);
      return ai;
    }
  }
  return { createAi };
}
