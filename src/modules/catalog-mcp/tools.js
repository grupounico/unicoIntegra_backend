import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DeploymentError, publicError } from '../catalog-deployment/errors.js';
import { connectionUrl } from './connection.js';
import { summarizeDeployment } from './summary.js';

const ERP_IDS = { alpha7: 1, linx: 2, automatiza: 3, vetor: 4 };

export const WORKFLOW_GUIDE = `Fluxo de instalação da IA de catálogo (Hub + Banco Único → AtenderBem → IA)

1. Teste a conexão do ERP de cada unidade com catalog_test_database_connection (Alpha7 = PostgreSQL, Automatiza = MySQL; Linx e Vetor não usam banco).
2. Crie a implantação com catalog_create_deployment.
3. Inicie a carga com catalog_start_deployment. A carga no Hub leva alguns minutos: chame catalog_refresh_runs a cada ~1 minuto até o status ser completed.
4. Para cada unidade, conecte o AtenderBem com atenderbem_configure_unit (URL /mcp e chave da instância, credencial do CSV e grupo de produtos).
5. Vincule o grupo com atenderbem_create_group e inicie a importação com atenderbem_start_import.
6. Acompanhe com atenderbem_check_import até a importação terminar (completed).
7. Crie a IA de catálogo com catalog_create_ai.

Toda resposta traz "nextAction" com a próxima ferramenta e os argumentos. Siga-a. Quando nextAction.humanRequired for true, pare e peça ajuda a um operador: não repita a ação por conta própria.
Nunca repita catalog_create_deployment para o mesmo grupo: use catalog_list_deployments para encontrar uma implantação existente.`;

const id = z.string().uuid();
const operator = z.string().trim().min(2).max(120).describe('Nome ou login do operador responsável. Fica registrado no histórico.');
const confirm = z.literal(true).describe('Confirme que deseja executar esta ação nos sistemas reais.');

function asText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function asError(error, context) {
  const body = error instanceof DeploymentError ? publicError(error, context) : { code: 'INVALID_INPUT', message: error?.message || 'Falha ao executar a ferramenta.' };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

// Services are injected so tests can run without the database or external systems.
export function createCatalogMcpServer(services) {
  const server = new McpServer({ name: 'unico-integra-catalogo', version: '1.0.0' }, { instructions: WORKFLOW_GUIDE });
  const actor = (name) => `${name} (via MCP)`;
  const summary = async (deploymentId) => summarizeDeployment(await services.getDeployment(deploymentId));
  const tool = (name, config, handler) => server.registerTool(name, config, async (args) => {
    try { return asText(await handler(args)); }
    catch (error) { return asError(error, { deploymentId: args?.deploymentId, unitId: args?.unitId }); }
  });

  tool('catalog_workflow_guide', {
    title: 'Guia do fluxo', description: 'Explica as etapas da instalação da IA de catálogo e a ordem das ferramentas.',
    annotations: { readOnlyHint: true },
  }, async () => ({ guide: WORKFLOW_GUIDE }));

  tool('catalog_list_deployments', {
    title: 'Listar implantações', description: 'Lista implantações de catálogo, das mais recentes para as mais antigas, com a próxima ação de cada uma.',
    inputSchema: { search: z.string().max(120).optional().describe('Trecho do nome do grupo ou do usuário.'), cnpj: z.string().max(18).optional(), status: z.string().max(60).optional(), page: z.number().int().min(1).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ search, cnpj, status, page }) => {
    const result = await services.listDeployments({ search, cnpj, status, page, pageSize: 20 });
    return { deployments: result.data.map((item) => { const s = summarizeDeployment(item); return { deploymentId: s.deploymentId, group: s.group, flowMode: s.flowMode, status: s.status, units: s.units.length, nextAction: s.nextAction }; }), meta: result.meta };
  });

  tool('catalog_get_deployment', {
    title: 'Consultar implantação', description: 'Mostra a situação da implantação, de cada unidade, do AtenderBem e da IA, com a próxima ação.',
    inputSchema: { deploymentId: id }, annotations: { readOnlyHint: true },
  }, async ({ deploymentId }) => summary(deploymentId));

  tool('catalog_test_database_connection', {
    title: 'Testar conexão do ERP', description: 'Testa a conexão com o banco do ERP da unidade antes de criar a implantação. Alpha7 usa PostgreSQL; Automatiza usa MySQL e também confere o shop_id com o CNPJ.',
    inputSchema: {
      erp: z.enum(['alpha7', 'automatiza']), host: z.string().max(253), port: z.number().int().min(1).max(65535).optional(), database: z.string().max(128), user: z.string().max(128), password: z.string().max(512),
      ssl: z.boolean().optional().describe('Somente se o servidor exigir conexão segura.'), cnpj: z.string().max(18), sourceUnitId: z.number().int().positive(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ erp, host, port, database, user, password, ssl, cnpj, sourceUnitId }) => {
    const result = await services.testDatabaseConnection({ driver: erp === 'automatiza' ? 'mysql' : 'postgres', host, port: port ?? (erp === 'automatiza' ? 3306 : 5432), database, user, password, ssl: Boolean(ssl), cnpj, sourceUnitId });
    return { success: result.success, message: result.message, latencyMs: result.latencyMs, businessUnit: result.businessUnitLookup ?? null };
  });

  const connection = z.object({ host: z.string().max(253), port: z.number().int().min(1).max(65535).optional(), database: z.string().max(128), user: z.string().max(128), password: z.string().max(512), ssl: z.boolean().optional() });
  tool('catalog_create_deployment', {
    title: 'Criar implantação', description: 'Cria a implantação Hub + Banco Único (rascunho). Depois chame catalog_start_deployment.',
    inputSchema: {
      group: z.object({ cnpj: z.string().max(18), name: z.string().max(255), username: z.string().max(50).describe('Usuário de acesso do grupo, sem espaços.') }),
      units: z.array(z.object({
        code: z.string().max(100).describe('Código da unidade, ex.: MATRIZ.'), name: z.string().max(255), cnpj: z.string().max(18),
        erp: z.enum(['alpha7', 'linx', 'automatiza', 'vetor']),
        sourceUnitId: z.number().int().positive().optional().describe('ID da unidade no ERP (não se aplica ao Linx).'),
        connection: connection.optional().describe('Banco do ERP: obrigatório para alpha7 e automatiza.'),
        vetorApiKey: z.string().min(8).max(2048).optional().describe('Obrigatório para vetor.'),
        initial: z.boolean().optional(),
      })).min(1).max(50),
      requestedBy: operator,
      idempotencyKey: z.string().max(255).optional().describe('Reenvie a mesma chave para não duplicar a implantação em caso de nova tentativa.'),
      confirm,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group, units, requestedBy, idempotencyKey }) => {
    const payload = {
      flowMode: 'hub_banco_only',
      requestedBy: actor(requestedBy),
      group: { cnpj: group.cnpj, nome: group.name, username: group.username },
      units: units.map((unit, index) => ({
        codigo: unit.code, nome: unit.name, cnpj: unit.cnpj, erpId: ERP_IDS[unit.erp], provider: unit.erp, initial: unit.initial ?? index === 0,
        ...(unit.erp !== 'linx' ? { sourceUnitId: unit.sourceUnitId } : {}),
        ...(unit.erp === 'alpha7' || unit.erp === 'automatiza' ? { credentialRef: connectionUrl(unit.erp, unit.connection || {}) } : {}),
        ...(unit.erp === 'vetor' ? { vetorApiKey: unit.vetorApiKey } : {}),
      })),
    };
    const created = await services.createDeployment(payload, idempotencyKey || crypto.randomUUID(), crypto.randomUUID());
    return summarizeDeployment(created);
  });

  tool('catalog_start_deployment', {
    title: 'Iniciar carga', description: 'Inicia a carga do catálogo no Hub e no Banco Único.',
    inputSchema: { deploymentId: id, requestedBy: operator, confirm },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ deploymentId, requestedBy }) => { await services.startDeployment(deploymentId, actor(requestedBy)); return summary(deploymentId); });

  tool('catalog_refresh_runs', {
    title: 'Atualizar carga', description: 'Consulta no Hub o andamento da carga e devolve a situação atualizada. Use a cada ~1 minuto enquanto a carga estiver em andamento.',
    inputSchema: { deploymentId: id }, annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ deploymentId }) => summarizeDeployment(await services.refreshDeploymentRuns(deploymentId)));

  tool('catalog_retry_deployment', {
    title: 'Retomar implantação', description: 'Retoma uma implantação interrompida a partir da última etapa confirmada. Informe unitId para retomar só uma unidade.',
    inputSchema: { deploymentId: id, unitId: id.optional(), requestedBy: operator, confirm },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ deploymentId, unitId, requestedBy }) => {
    if (unitId) await services.retryUnit(deploymentId, unitId, actor(requestedBy)); else await services.retryDeployment(deploymentId, actor(requestedBy));
    return summary(deploymentId);
  });

  tool('atenderbem_configure_unit', {
    title: 'Conectar AtenderBem', description: 'Salva a conexão da unidade com a instância do AtenderBem. As chaves ficam criptografadas; omita mcpKey ou feedKey para manter as já salvas.',
    inputSchema: {
      deploymentId: id, unitId: id,
      mcpUrl: z.string().url().max(2048).describe('Endpoint HTTPS da instância terminado em /mcp, ex.: https://cliente.atenderbem.com/mcp'),
      mcpKey: z.string().min(1).max(8192).optional(), feedKey: z.string().min(1).max(8192).optional().describe('Credencial que permite ao AtenderBem baixar o CSV do catálogo.'),
      feedAuth: z.enum(['api-key', 'bearer']).default('api-key'),
      group: z.discriminatedUnion('mode', [z.object({ mode: z.literal('create'), name: z.string().min(1).max(255) }), z.object({ mode: z.literal('existing'), id: z.number().int().positive() })]),
      requestedBy: operator, confirm,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ deploymentId, unitId, mcpUrl, mcpKey, feedKey, feedAuth, group, requestedBy }) => {
    await services.saveAtenderBemConfiguration(deploymentId, unitId, { mcpUrl, mcpKey, feedKey, feedAuth, groupMode: group.mode, groupName: group.mode === 'create' ? group.name : '', groupId: group.mode === 'existing' ? group.id : null }, actor(requestedBy));
    return summary(deploymentId);
  });

  tool('atenderbem_create_group', {
    title: 'Vincular grupo de produtos', description: 'Valida a conexão com o AtenderBem e cria (ou confirma) o grupo de produtos da unidade.',
    inputSchema: { deploymentId: id, unitId: id, requestedBy: operator, confirm },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ deploymentId, unitId, requestedBy }) => { await services.createAtenderBemGroup(deploymentId, unitId, actor(requestedBy)); return summary(deploymentId); });

  tool('atenderbem_start_import', {
    title: 'Importar catálogo', description: 'Envia o CSV do catálogo da unidade para o AtenderBem e inicia a importação.',
    inputSchema: { deploymentId: id, unitId: id, requestedBy: operator, confirm },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ deploymentId, unitId, requestedBy }) => { await services.startAtenderBemImport(deploymentId, unitId, actor(requestedBy)); return summary(deploymentId); });

  tool('atenderbem_check_import', {
    title: 'Acompanhar importação', description: 'Consulta no AtenderBem o andamento da importação da unidade.',
    inputSchema: { deploymentId: id, unitId: id }, annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ deploymentId, unitId }) => { await services.checkAtenderBemImport(deploymentId, unitId); return summary(deploymentId); });

  tool('catalog_create_ai', {
    title: 'Criar IA de catálogo', description: 'Cria a IA de venda da unidade na instância do AtenderBem, usando o grupo de produtos importado. Só funciona com a importação concluída.',
    inputSchema: { deploymentId: id, unitId: id, name: z.string().max(120).optional().describe('Nome da IA. Padrão: "IA de Venda - <unidade>".'), signatureName: z.string().max(100).optional().describe('Nome usado na assinatura das mensagens.'), requestedBy: operator, confirm },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ deploymentId, unitId, name, signatureName, requestedBy }) => {
    const ai = await services.createAi(deploymentId, unitId, { modality: 'venda', name, signatureName }, actor(requestedBy));
    return { ai: { status: ai.status, name: ai.name, assistantId: ai.assistantId ?? null, error: ai.error ?? null }, deployment: await summary(deploymentId) };
  });

  server.registerPrompt('instalar_ia_catalogo', {
    title: 'Instalar IA de catálogo', description: 'Conduz a instalação completa da IA de catálogo para um grupo de farmácias.',
    argsSchema: { grupo: z.string().describe('Nome ou CNPJ do grupo.') },
  }, ({ grupo }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Instale a IA de catálogo para o grupo ${grupo}. Comece procurando uma implantação existente com catalog_list_deployments.\n\n${WORKFLOW_GUIDE}` } }] }));

  return server;
}
