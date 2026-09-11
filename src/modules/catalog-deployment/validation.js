import crypto from 'node:crypto';
import { DeploymentError } from './errors.js';

export const ASSET_TYPES = ['banner_1', 'banner_2', 'banner_3', 'logo_desktop', 'logo_mobile'];

export function digits(value) { return String(value || '').replace(/\D/g, ''); }

export function isValidCnpj(value) {
  const cnpj = digits(value);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const calc = (length) => {
    let sum = 0;
    let weight = length - 7;
    for (let i = 0; i < length; i += 1) {
      sum += Number(cnpj[i]) * weight;
      weight -= 1;
      if (weight === 1) weight = 9;
    }
    const result = 11 - (sum % 11);
    return result >= 10 ? 0 : result;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

export function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 100);
}

export function canonicalHash(payload) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

function requiredString(value, field, max) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) {
    throw new DeploymentError('INVALID_INPUT', `${field} é obrigatório e deve ter no máximo ${max} caracteres.`, { statusCode: 400, stage: 'validation' });
  }
  return normalized;
}

export function validateCreatePayload(payload) {
  const group = payload?.group || {};
  const groupCnpj = digits(group.cnpj);
  if (!isValidCnpj(groupCnpj)) throw new DeploymentError('INVALID_CNPJ', 'O CNPJ do grupo é inválido.', { statusCode: 400, stage: 'validation' });
  const groupName = requiredString(group.nome, 'group.nome', 255);
  const username = requiredString(group.username, 'group.username', 51).replace(/^@/, '');
  if (!username || username.length > 50) throw new DeploymentError('INVALID_USERNAME', 'group.username deve ter no máximo 50 caracteres.', { statusCode: 400, stage: 'validation' });
  if (!/^[A-Za-z0-9._-]+$/.test(username)) throw new DeploymentError('INVALID_USERNAME', 'group.username deve ser informado sem espaços.', { statusCode: 400, stage: 'validation' });
  if (!Array.isArray(payload.units) || payload.units.length === 0) throw new DeploymentError('INVALID_UNITS', 'Informe pelo menos uma unidade.', { statusCode: 400, stage: 'validation' });
  if (payload.units.filter((unit) => unit.initial === true).length > 1) throw new DeploymentError('MULTIPLE_INITIAL_UNITS', 'Somente uma unidade pode ser inicial.', { statusCode: 400, stage: 'validation' });
  const codes = new Set(); const sources = new Set();
  const units = payload.units.map((unit, index) => {
    const code = requiredString(unit.codigo, `units[${index}].codigo`, 100);
    if (codes.has(code.toLowerCase())) throw new DeploymentError('DUPLICATE_UNIT_CODE', `O código ${code} está duplicado.`, { statusCode: 400, stage: 'validation' });
    codes.add(code.toLowerCase());
    const cnpj = digits(unit.cnpj);
    if (!isValidCnpj(cnpj)) throw new DeploymentError('INVALID_CNPJ', `O CNPJ da unidade ${code} é inválido.`, { statusCode: 400, stage: 'validation' });
    const sourceUnitId = Number(unit.sourceUnitId);
    if (!Number.isInteger(sourceUnitId) || sourceUnitId <= 0) throw new DeploymentError('INVALID_SOURCE_UNIT_ID', `sourceUnitId da unidade ${code} deve ser positivo.`, { statusCode: 400, stage: 'validation' });
    if (sources.has(sourceUnitId)) throw new DeploymentError('DUPLICATE_SOURCE_UNIT_ID', `sourceUnitId ${sourceUnitId} está duplicado.`, { statusCode: 400, stage: 'validation' });
    sources.add(sourceUnitId);
    let credentialRef;
    try { credentialRef = new URL(requiredString(unit.credentialRef, `units[${index}].credentialRef`, 2048)); } catch { throw new DeploymentError('INVALID_CREDENTIAL_REF', `A conexão da unidade ${code} é inválida.`, { statusCode: 400, stage: 'validation' }); }
    if (!['postgres:', 'postgresql:'].includes(credentialRef.protocol) || !credentialRef.hostname || !credentialRef.username || !credentialRef.pathname.slice(1)) throw new DeploymentError('INVALID_CREDENTIAL_REF', `A conexão PostgreSQL da unidade ${code} está incompleta.`, { statusCode: 400, stage: 'validation' });
    const pageSize = unit.pageSize === undefined ? 500 : Number(unit.pageSize);
    const threshold = unit.validEanDropThresholdBps === undefined ? 1000 : Number(unit.validEanDropThresholdBps);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new DeploymentError('INVALID_PAGE_SIZE', 'pageSize deve estar entre 1 e 500.', { statusCode: 400, stage: 'validation' });
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10000) throw new DeploymentError('INVALID_EAN_THRESHOLD', 'validEanDropThresholdBps deve estar entre 0 e 10000.', { statusCode: 400, stage: 'validation' });
    const provider = unit.provider || 'alpha7';
    if (provider !== 'alpha7') throw new DeploymentError('UNSUPPORTED_PROVIDER', 'A primeira versão suporta apenas alpha7.', { statusCode: 400, stage: 'validation' });
    return { code, name: requiredString(unit.nome, `units[${index}].nome`, 255), cnpj, sourceUnitId,
      credentialRef: credentialRef.toString(), provider, publicationMode: 'shadow', pageSize,
      validEanDropThresholdBps: threshold, slug: slugify(unit.slug || `${groupName}-${code}`), initial: unit.initial === true };
  });
  if (!units.some((unit) => unit.initial)) units[0].initial = true;
  return { group: { cnpj: groupCnpj, nome: groupName, username }, units, requestedBy: String(payload.requestedBy || 'Sistema').trim() || 'Sistema' };
}
