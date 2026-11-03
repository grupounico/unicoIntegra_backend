import { ReportError } from './config.js';

export const REPORT_TIMEZONE = 'America/Sao_Paulo';
export const isRunId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function localDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateReportRequest(body, client, now = new Date()) {
  const invalid = message => { throw new ReportError(400, 'INVALID_REPORT_REQUEST', message); };
  if (!object(body) || Object.keys(body).some(key => !['dateFrom', 'dateTo', 'queueIds', 'comparison'].includes(key))) {
    invalid('Informe somente datas, filas e comparação para o levantamento.');
  }
  const today = localDay(now);
  const checkPeriod = period => {
    if (!object(period) || !validDate(period.dateFrom) || !validDate(period.dateTo)
      || period.dateFrom > period.dateTo || period.dateTo > today) invalid('Informe datas válidas, em ordem e sem dias futuros.');
  };
  checkPeriod(body);
  if (body.comparison !== undefined) {
    if (!object(body.comparison) || Object.keys(body.comparison).some(key => !['dateFrom', 'dateTo'].includes(key))) invalid('Comparação inválida.');
    checkPeriod(body.comparison);
  }
  const available = client.units.map(unit => unit.queueId);
  const queueIds = body.queueIds ?? available;
  if (!Array.isArray(queueIds) || !queueIds.length || queueIds.some(id => !Number.isSafeInteger(id) || !available.includes(id))) {
    invalid('Selecione pelo menos uma unidade cadastrada nesta rede.');
  }
  const dates = [body.dateFrom, body.dateTo, body.comparison?.dateFrom, body.comparison?.dateTo].filter(Boolean).sort();
  if ((Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000 >= 366) invalid('O intervalo total, incluindo a comparação, não pode ultrapassar 366 dias.');
  return {
    dateFrom: body.dateFrom, dateTo: body.dateTo, queueIds: [...new Set(queueIds)].sort((a, b) => a - b),
    ...(body.comparison ? { comparison: { dateFrom: body.comparison.dateFrom, dateTo: body.comparison.dateTo } } : {}),
  };
}
