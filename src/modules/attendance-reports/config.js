import { env } from '../../config/env.js';

export class ReportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const defaultClients = [{
  key: 'minas-mais', name: 'Minas Mais', tokenEnv: 'ATTENDANCE_REPORTS_MINAS_MAIS_CLIENT_TOKEN',
  units: [
    { queueId: 33, name: 'Matriz Campo Belo' },
    { queueId: 35, name: 'Campo Belo 2' },
    { queueId: 36, name: 'Campo Belo 3' },
    { queueId: 38, name: 'Boa Esperança' },
    { queueId: 40, name: 'BH Loja 2' },
    { queueId: 41, name: 'BH Loja 4' },
  ],
}];

export function reportClients(environment = process.env) {
  try {
    const raw = environment.ATTENDANCE_REPORTS_CLIENTS_JSON?.trim();
    const clients = raw ? JSON.parse(raw) : defaultClients;
    const keys = new Set();
    if (!Array.isArray(clients)) throw new Error();
    return clients.map(client => {
      if (!client || typeof client.key !== 'string' || !/^[a-z0-9-]{1,60}$/.test(client.key) || keys.has(client.key)
        || typeof client.name !== 'string' || !client.name.trim()
        || typeof client.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{1,120}$/.test(client.tokenEnv)
        || !Array.isArray(client.units) || !client.units.length) throw new Error();
      keys.add(client.key);
      const queues = new Set();
      const units = client.units.map(unit => {
        if (!unit || !Number.isSafeInteger(unit.queueId) || unit.queueId < 1 || queues.has(unit.queueId)
          || typeof unit.name !== 'string' || !unit.name.trim()) throw new Error();
        queues.add(unit.queueId);
        return { queueId: unit.queueId, name: unit.name.trim() };
      });
      return { key: client.key, name: client.name.trim(), tokenEnv: client.tokenEnv, units };
    });
  } catch {
    throw new ReportError(503, 'REPORT_CONFIGURATION_INVALID', 'A configuração das redes de relatórios está inválida no servidor.');
  }
}

export function clientToken(client, environment = process.env) {
  const token = environment[client.tokenEnv]?.trim();
  if (!token || token.length > 1024 || /[\r\n]/.test(token)) {
    throw new ReportError(503, 'REPORT_TOKEN_NOT_CONFIGURED', 'Configure o token de feed desta rede no servidor para consultar os relatórios.');
  }
  return token;
}

export function reportBaseUrl(environment = process.env) {
  const raw = environment.BANCO_UNICO_BASE_URL ?? env.BANCO_UNICO_BASE_URL;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ReportError(503, 'REPORT_BASE_URL_INVALID', 'A URL do Banco Único está inválida no servidor.');
  }
}
