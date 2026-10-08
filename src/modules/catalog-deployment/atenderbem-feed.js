import { readFeed, LabError } from './adapters/mcp.client.js';
import { feedIdFromUnit, getAtenderBemSettings } from './atenderbem-config.js';

export async function readAtenderBemFeed(unit, config, secrets, dependencies = {}) {
  const feedConfig = { ...config, ...secrets, feedUnitId: feedIdFromUnit(unit), feedBaseUrl: getAtenderBemSettings(dependencies.environment).feedBaseUrl };
  const feed = await (dependencies.readFeed || readFeed)(feedConfig, dependencies.fetchImpl, dependencies.environment);
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
