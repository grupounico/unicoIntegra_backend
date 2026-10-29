// Builds the ERP connection string the deployment API stores, from separate fields,
// so agents never have to percent-encode passwords by hand.
const SCHEME = { alpha7: 'postgresql', automatiza: 'mysql' };
const DEFAULT_PORT = { alpha7: 5432, automatiza: 3306 };

export function connectionUrl(provider, { host, port, database, user, password, ssl = false }) {
  const scheme = SCHEME[provider];
  if (!scheme) throw new Error(`O ERP ${provider} não usa conexão com banco de dados.`);
  const hostname = String(host || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('host deve ser um nome de host ou IP, sem protocolo, porta ou caminho.');
  const portNumber = Number(port ?? DEFAULT_PORT[provider]);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('port deve estar entre 1 e 65535.');
  if (!database || !user || !password) throw new Error('database, user e password são obrigatórios.');
  const query = ssl ? (provider === 'automatiza' ? '?ssl=true' : '?sslmode=require') : '';
  return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostname}:${portNumber}/${encodeURIComponent(database)}${query}`;
}
