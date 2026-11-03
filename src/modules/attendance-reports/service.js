import { clientToken, reportBaseUrl, reportClients, ReportError } from './config.js';
import { isRunId, validateReportRequest } from './validation.js';

const states = new Set(['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']);
const invalidResponse = () => new ReportError(502, 'REPORT_INVALID_RESPONSE', 'O Banco Único retornou uma resposta de relatório inválida.');

export function createReportService({ environment = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  function getClient(key) {
    const client = reportClients(environment).find(item => item.key === key);
    if (!client) throw new ReportError(404, 'REPORT_INSTANCE_NOT_FOUND', 'Rede de relatórios não encontrada.');
    return client;
  }

  async function request(key, operation, { runId, body } = {}) {
    const client = getClient(key);
    if (runId !== undefined && !isRunId(runId)) throw new ReportError(400, 'REPORT_RUN_ID_INVALID', 'Identificador do levantamento inválido.');
    const payload = operation === 'create' ? validateReportRequest(body, client, now()) : undefined;
    const token = clientToken(client, environment);
    const root = `${reportBaseUrl(environment)}/api/attendance-reports/${encodeURIComponent(key)}`;
    const suffix = operation === 'latest' ? '/latest' : `/runs${runId ? `/${runId}` : ''}`;
    let response;
    try {
      // The Banco Único authorizes the network token on every request. Never
      // forward the operator session, follow upstream URLs or retry POSTs.
      response = await fetchImpl(`${root}${suffix}`, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'X-API-Key': token, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new ReportError(503, 'REPORT_UPSTREAM_UNAVAILABLE', 'Não foi possível consultar o Banco Único. Tente novamente.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new ReportError(401, 'REPORT_NETWORK_TOKEN_INVALID', 'O token de feed desta rede é inválido ou foi revogado. Revise a configuração no servidor.');
      if (response.status === 403) throw new ReportError(403, 'REPORT_NETWORK_FORBIDDEN', 'O token configurado pertence a outra rede. Revise a configuração no servidor.');
      if (response.status === 404) throw new ReportError(404, operation === 'latest' ? 'REPORT_LATEST_NOT_FOUND' : 'REPORT_RUN_NOT_FOUND', operation === 'latest' ? 'Ainda não há levantamento completo para esta rede, ou o recurso não está habilitado no Banco Único.' : 'Levantamento ou rede não encontrado no Banco Único.');
      if (response.status === 400) throw new ReportError(400, 'REPORT_REQUEST_REJECTED', 'O Banco Único recusou os filtros. Confira o período e as unidades cadastradas.');
      throw new ReportError(503, 'REPORT_UPSTREAM_UNAVAILABLE', 'O Banco Único ou uma dependência está indisponível para esta consulta.');
    }
    let data;
    try { data = await response.json(); } catch { throw invalidResponse(); }
    if (!data || !isRunId(data.runId) || data.instanceKey !== key || !states.has(data.status)
      || (runId && data.runId.toLowerCase() !== runId.toLowerCase())
      || (operation === 'latest' && data.status !== 'COMPLETED')
      || !data.request || !data.progress || !Array.isArray(data.errors)) throw invalidResponse();
    const statusUrl = `/api/ia/attendance-reports/${encodeURIComponent(key)}/runs/${data.runId}`;
    // Explicit fields keep upstream URLs, auth metadata and accidental envelope
    // additions out of the browser. The metrics contract remains unchanged.
    return {
      runId: data.runId, instanceKey: key, status: data.status, request: data.request,
      createdAt: data.createdAt, startedAt: data.startedAt, finishedAt: data.finishedAt,
      progress: data.progress, errors: data.errors, result: data.result ?? null, statusUrl,
    };
  }

  return {
    listInstances() {
      return reportClients(environment).map(client => {
        let configured = true;
        try { clientToken(client, environment); reportBaseUrl(environment); } catch { configured = false; }
        return { key: client.key, name: client.name, units: client.units, configured };
      });
    },
    latest: key => request(key, 'latest'),
    create: (key, body) => request(key, 'create', { body }),
    get: (key, runId) => request(key, 'get', { runId }),
  };
}
