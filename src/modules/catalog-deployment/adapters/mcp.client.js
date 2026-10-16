import { DeploymentError } from '../errors.js';
// Only curated diagnostic messages; upstream bodies and credentials stay private.
export class LabError extends DeploymentError {
  constructor(message, status = 400, code = 'ATENDERBEM_CONNECTION_ERROR', httpStatus = null) {
    super(code, message, { statusCode: status, stage: 'atenderbem_connection', httpStatus });
    this.status = status;
  }
}

export const TOOL_NAMES = ['product_groups_create', 'files_create_upload_url', 'products_import', 'products_import_status', 'products_reindex',
  'config_capabilities', 'assistants_list_models', 'assistants_list_preset_catalog', 'assistants_list', 'assistants_get', 'assistants_create', 'assistants_update',
  'automations_list', 'automations_get', 'automations_create', 'automations_validate_elements',
  'queues_list', 'queues_get', 'queues_update', 'product_groups_get', 'pipelines_list', 'pipelines_get', 'pipelines_create', 'pipelines_update',
  'pipeline_stages_list', 'pipeline_stages_get', 'pipeline_stages_create', 'pipeline_stages_update', 'forms_list', 'forms_get', 'forms_create'];

function hostMatchesPattern(hostname, rawPattern) {
  const host = String(hostname || '').trim().toLowerCase();
  const pattern = String(rawPattern || '').trim().toLowerCase();
  if (!host || !pattern) return false;
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(2);
  return Boolean(suffix) && host !== suffix && host.endsWith(`.${suffix}`);
}

export function allowedUrl(raw, kind, environment = process.env) {
  let url;
  try { url = new URL(raw); } catch { throw new LabError('Informe uma URL HTTPS válida.'); }
  const hosts = String(environment[kind === 'mcp' ? 'CATALOG_MCP_ALLOWED_HOSTS' : 'CATALOG_FEED_ALLOWED_HOSTS'] ||
    (kind === 'mcp' ? '*.atenderbem.com' : 'unicocontato.tech')).split(',').map(x => x.trim()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')
      || !hosts.some(pattern => hostMatchesPattern(url.hostname, pattern))) {
    throw new LabError(`Destino não permitido para ${kind}. Solicite a liberação deste host no backend; as chaves salvas foram preservadas.`, 403, 'ATENDERBEM_DESTINATION_NOT_ALLOWED');
  }
  if (kind === 'mcp' && url.pathname.replace(/\/$/, '') !== '/mcp') throw new LabError('A URL do MCP deve terminar em /mcp.');
  return url.toString();
}

export function decodeRpc(text, id) {
  let messages;
  if (text.trim().startsWith('{')) messages = [JSON.parse(text)];
  else messages = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => JSON.parse(data));
  const message = messages.find(item => item.id === id);
  if (!message) throw new LabError('O MCP não retornou uma resposta para a chamada.', 502);
  if (message.error) throw new LabError(`O MCP recusou a chamada (código ${message.error.code}). Confira o schema e os parâmetros.`, 502);
  return message.result;
}

export function safeResult(value, secrets = []) {
  if (typeof value === 'string') {
    let clean = value;
    for (const secret of secrets.filter(Boolean)) clean = clean.split(secret).join('[oculto]');
    return clean.replace(/https:\/\/[^\s"<>]+\?[^\s"<>]+/g, '[URL com parâmetros omitida]');
  }
  if (Array.isArray(value)) return value.map(item => safeResult(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /token|secret|password|authorization|headers|uploadurl|signedurl/i.test(key) ? '[oculto]' : safeResult(item, secrets)]));
  return value;
}

export function unwrap(result) {
  if (result?.isError) {
    const quota = /Limite contratado excedido/i.test(JSON.stringify(result));
    const error = new LabError(quota ? 'Limite contratado excedido. Amplie o plano ou revise recursos existentes; não tente novamente.' : 'A ferramenta MCP recusou a operação. Confira os parâmetros e a permissão da credencial.', 422);
    error.code = quota ? 'MCP_QUOTA_EXCEEDED' : 'MCP_TOOL_REJECTED';
    error.definitive = true;
    throw error;
  }
  if (result?.structuredContent) return result.structuredContent;
  const entry = result?.content?.find(item => item.type === 'text');
  if (entry) { try { return JSON.parse(entry.text); } catch { return result; } }
  return result;
}

export function validateArguments(schema, value, path = 'arguments') {
  if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) throw new LabError('Este schema precisa de um mapeamento específico antes de executar a ferramenta.');
  if (schema.enum && !schema.enum.includes(value)) throw new LabError(`${path}: escolha um dos valores aceitos no schema.`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LabError(`${path} deve ser um objeto.`);
    for (const key of schema.required || []) if (!(key in value)) throw new LabError(`${path}.${key} é obrigatório.`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      // Arbitrary records are allowed only where the server explicitly declares them.
      if (!child && schema.additionalProperties !== true && typeof schema.additionalProperties !== 'object') throw new LabError(`${path}.${key} não foi confirmado pelo schema.`);
      validateArguments(child || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}), item, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new LabError(`${path} deve ser uma lista.`);
    if (schema.minItems && value.length < schema.minItems) throw new LabError(`${path} não possui itens suficientes.`);
    for (const item of value) validateArguments(schema.items || {}, item, path);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) throw new LabError(`${path} deve ser numérico.`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new LabError(`${path} está abaixo do mínimo.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new LabError(`${path} está acima do máximo.`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength && value.length < schema.minLength)) throw new LabError(`${path} deve ser texto válido.`);
    if (schema.maxLength && value.length > schema.maxLength) throw new LabError(`${path} é muito longo.`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new LabError(`${path} deve ser booleano.`);
}

export function createMcpClient(config, { fetchImpl = fetch, environment = process.env } = {}) {
  const url = allowedUrl(config.mcpUrl, 'mcp', environment);
  if (!config.mcpKey?.trim()) throw new LabError('Informe a chave MCP.');
  let session; let version = '2025-03-26'; let sequence = 0;
  // One finite operation must expire before the installer's 120-second lease.
  const deadline = Date.now() + 90000;
  async function send(method, params, notification = false) {
    const id = ++sequence;
    let response;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LabError('Prazo total da operação MCP excedido. Confira a etapa antes de retomar.', 504);
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(25000, remaining)),
        headers: { Authorization: `Bearer ${config.mcpKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': version },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) });
    } catch { throw new LabError('Não foi possível conectar ao MCP dentro do prazo. Confira a URL e a rede.', 502); }
    if (!response.ok) throw new LabError(`MCP retornou HTTP ${response.status}. ${[401, 403].includes(response.status) ? 'Confira a chave MCP e a permissão da instância.' : response.status === 404 ? 'Confira se o MCP está habilitado na instância e se a URL termina em /mcp.' : 'Confira a disponibilidade do serviço.'}`, 502, 'ATENDERBEM_MCP_HTTP_ERROR', response.status);
    session = response.headers.get('Mcp-Session-Id') || session;
    if (notification) { await response.body?.cancel(); return; }
    // Consume only until the matching SSE event; some servers keep the stream open.
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
      try {
        while (true) {
          const part = await reader.read(); if (part.done) return decodeRpc(text, id);
          text += decoder.decode(part.value, { stream: true });
          if (text.length > 2 * 1024 * 1024) throw new LabError('Resposta MCP excedeu o limite.', 502);
          for (const block of text.split(/\r?\n\r?\n/).slice(0, -1)) {
            const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data && JSON.parse(data).id === id) return decodeRpc(block, id);
          }
        }
      } finally { await reader.cancel(); }
    }
    return decodeRpc(await response.text(), id);
  }
  return {
    async tools() {
      const initialized = await send('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'UnicoIntegra-catalog', version: '0.1' } });
      version = initialized.protocolVersion || version;
      await send('notifications/initialized', {}, true);
      const tools = []; let cursor; let pages = 0;
      do {
        const page = await send('tools/list', cursor ? { cursor } : {});
        tools.push(...(page.tools || [])); cursor = page.nextCursor;
        if (tools.length > 1000 || ++pages > 20) throw new LabError('Lista de ferramentas excedeu o limite.', 502);
      } while (cursor);
      return tools;
    },
    async call(name, args, tools) {
      if (!TOOL_NAMES.includes(name)) throw new LabError('Ferramenta não autorizada neste teste.');
      const tool = tools.find(item => item.name === name || item.name === `mcp__omni__${name}`);
      if (!tool) throw new LabError('Ferramenta ausente no tools/list desta instância.');
      if (!tool.inputSchema) throw new LabError('A ferramenta não publicou o schema de entrada.');
      try { validateArguments(tool.inputSchema, args); }
      catch (error) { error.definitive = true; error.code = 'MCP_ARGUMENT_INVALID'; throw error; }
      return unwrap(await send('tools/call', { name: tool.name, arguments: args }));
    },
  };
}

export async function readFeed(config, fetchImpl = fetch, environment = process.env) {
  const unit = Number(config.feedUnitId);
  if (!Number.isSafeInteger(unit) || unit <= 0) throw new LabError('Informe um ID de unidade positivo.');
  const base = new URL(allowedUrl(config.feedBaseUrl, 'feed', environment));
  base.searchParams.set('unidadeId', String(unit));
  if (!config.feedKey?.trim()) throw new LabError('Informe a credencial do feed.');
  if (!['bearer', 'api-key'].includes(config.feedAuth)) throw new LabError('Escolha a autenticação do feed.');
  const header = config.feedAuth === 'api-key' ? { 'X-API-Key': config.feedKey.trim() } : { Authorization: `Bearer ${config.feedKey.trim()}` };
  let response;
  try { response = await fetchImpl(base.toString(), { headers: header, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new LabError('Não foi possível obter o feed. Confira a URL e a rede.', 502); }
  if (!response.ok) throw new LabError(`Feed retornou HTTP ${response.status}. Confira a unidade e a credencial.`, 502);
  const type = response.headers.get('content-type') || '';
  if (/html|json/i.test(type)) { await response.body?.cancel(); throw new LabError('O feed retornou HTML/JSON em vez de CSV.', 502); }
  const limit = 50 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new LabError('CSV maior que 50 MB.'); }
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new LabError('CSV maior que 50 MB.'); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  const firstLine = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  if (!bytes.length || !/[;,\t]/.test(firstLine) || /^\s*[<{]/.test(firstLine)) throw new LabError('O arquivo não possui um cabeçalho CSV reconhecível.');
  return { bytes, size, columns: firstLine.split(/[;,\t]/).length };
}
