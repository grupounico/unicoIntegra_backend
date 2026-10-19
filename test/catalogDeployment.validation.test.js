import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash, isValidCnpj, meetsCoverageGate, slugify, validateCreatePayload, validateUnitUpdatePayload } from '../src/modules/catalog-deployment/validation.js';

const payload = () => ({ group: { cnpj: '11.222.333/0001-81', nome: 'Rede Saúde', username: 'rede-saude' }, units: [{ codigo: 'CENTRO', nome: 'Farmácia Centro', cnpj: '11.222.333/0001-81', sourceUnitId: 1, credentialRef: 'postgresql://user:pass@db.example:5432/client', orderWebhookUrl: 'https://cliente.example/webhook/order-token' }] });

test('valida CNPJ com dígitos verificadores', () => { assert.equal(isValidCnpj('11.222.333/0001-81'), true); assert.equal(isValidCnpj('11.222.333/0001-82'), false); assert.equal(isValidCnpj('00.000.000/0000-00'), false); });
test('normaliza slug de grupo e unidade', () => assert.equal(slugify(' Rede Saúde -- CENTRO '), 'rede-saude-centro'));
test('normaliza grupo, loja e código em maiúsculas ao criar a implantação', () => {
  const value = payload();
  value.units.push({
    ...value.units[0],
    codigo: '  filial norte  ',
    nome: 'drogaria São João',
    cnpj: '45.723.174/0001-10',
    sourceUnitId: 2,
  });
  const validated = validateCreatePayload(value);
  assert.equal(validated.group.nome, 'REDE SAÚDE');
  assert.equal(validated.units[0].code, 'CENTRO');
  assert.equal(validated.units[0].name, 'FARMÁCIA CENTRO');
  assert.equal(validated.units[1].code, 'FILIAL NORTE');
  assert.equal(validated.units[1].name, 'DROGARIA SÃO JOÃO');
  assert.equal(validated.units[1].slug, 'rede-saude-filial-norte');
});
test('preserva o slug explícito do tenant', () => { const value = payload(); value.units[0].slug = 'whatsapp-complexopharma'; assert.equal(validateCreatePayload(value).units[0].slug, 'whatsapp-complexopharma'); });
test('gate de cobertura rejeita 94,99% e aceita 95%', () => { assert.equal(meetsCoverageGate(94.99), false); assert.equal(meetsCoverageGate(95), true); });
test('aplica defaults e escolhe a primeira unidade', () => { const value = validateCreatePayload(payload()); assert.equal(value.units[0].initial, true); assert.equal(value.units[0].publicationMode, 'automatic'); assert.equal(value.units[0].pageSize, 500); assert.equal(value.units[0].validEanDropThresholdBps, 1000); });
test('aceita a arroba do setup e persiste somente o username', () => { const value = payload(); value.group.username = '@rede-saude'; assert.equal(validateCreatePayload(value).group.username, 'rede-saude'); });
test('mantém compatibilidade com provider alpha7 e devolve erpId canônico', () => {
  const value = payload(); value.units[0].provider = 'alpha7';
  const unit = validateCreatePayload(value).units[0];
  assert.equal(unit.erpId, 1); assert.equal(unit.provider, 'alpha7');
});
test('rejeita ERP ainda não suportado', () => { const value = payload(); value.units[0].provider = 'trier'; assert.throws(() => validateCreatePayload(value), (error) => error.code === 'UNSUPPORTED_ERP'); });
test('exige erpId canônico para Linx', () => { const value = payload(); value.units[0].provider = 'linx'; delete value.units[0].sourceUnitId; delete value.units[0].credentialRef; assert.throws(() => validateCreatePayload(value), (error) => error.code === 'UNSUPPORTED_ERP'); });
test('rejeita erpId inválido ou divergente do provider', () => {
  const invalid = payload(); invalid.units[0].erpId = 99;
  assert.throws(() => validateCreatePayload(invalid), (error) => error.code === 'UNSUPPORTED_ERP');
  const mismatch = payload(); mismatch.units[0].erpId = 2; mismatch.units[0].provider = 'alpha7';
  assert.throws(() => validateCreatePayload(mismatch), (error) => error.code === 'UNSUPPORTED_ERP');
});
test('normaliza Linx sem ID ou credencial e fixa o modo shadow', () => {
  const value = payload();
  value.units[0].erpId = 2;
  delete value.units[0].sourceUnitId;
  delete value.units[0].credentialRef;
  value.units[0].pageSize = 100;
  value.units[0].validEanDropThresholdBps = 12;
  const unit = validateCreatePayload(value).units[0];
  assert.deepEqual({ erpId: unit.erpId, provider: unit.provider, sourceUnitId: unit.sourceUnitId, credentialRef: unit.credentialRef, publicationMode: unit.publicationMode, pageSize: unit.pageSize, threshold: unit.validEanDropThresholdBps }, {
    erpId: 2, provider: 'linx', sourceUnitId: null, credentialRef: null, publicationMode: 'shadow', pageSize: 500, threshold: 1000,
  });
});
test('Linx proíbe sourceUnitId e credentialRef', () => {
  const withSource = payload(); withSource.units[0].erpId = 2; delete withSource.units[0].credentialRef;
  assert.throws(() => validateCreatePayload(withSource), (error) => error.code === 'LINX_SOURCE_UNIT_FORBIDDEN');
  const withCredential = payload(); withCredential.units[0].erpId = 2; delete withCredential.units[0].sourceUnitId;
  assert.throws(() => validateCreatePayload(withCredential), (error) => error.code === 'LINX_CREDENTIAL_FORBIDDEN');
});
test('Automatiza exige conexão MySQL e shop_id e preserva opções operacionais', () => {
  const value = payload();
  Object.assign(value.units[0], { erpId: 3, credentialRef: 'mysql://user:pass@db.example:3306/client?ssl=true', pageSize: 250, validEanDropThresholdBps: 750 });
  const unit = validateCreatePayload(value).units[0];
  assert.equal(unit.provider, 'automatiza');
  assert.equal(unit.publicationMode, 'shadow');
  assert.equal(unit.pageSize, 250);
  assert.equal(unit.validEanDropThresholdBps, 750);
  delete value.units[0].sourceUnitId;
  assert.throws(() => validateCreatePayload(value), { code: 'INVALID_SOURCE_UNIT_ID' });
  value.units[0].sourceUnitId = 1;
  value.units[0].credentialRef = 'postgresql://user:pass@db.example/client';
  assert.throws(() => validateCreatePayload(value), { code: 'INVALID_CREDENTIAL_REF' });
  value.units[0].credentialRef = 'mysql://user:pass@db.example/client?ssl=prefer';
  assert.throws(() => validateCreatePayload(value), { code: 'INVALID_CREDENTIAL_REF' });
});
test('Vetor exige cdFilial e API key write-only normalizada sem campo extra', () => {
  const value = payload();
  delete value.units[0].credentialRef;
  Object.assign(value.units[0], { erpId: 4, vetorApiKey: '  test-vetor-key  ' });
  const unit = validateCreatePayload(value).units[0];
  assert.equal(unit.provider, 'vetor');
  assert.equal(unit.credentialRef, 'test-vetor-key');
  assert.equal(Object.hasOwn(unit, 'vetorApiKey'), false);
  assert.equal(unit.publicationMode, 'shadow');
  value.units[0].credentialRef = 'secret://vetor/manual';
  assert.throws(() => validateCreatePayload(value), { code: 'ERP_CREDENTIAL_FORBIDDEN' });
  delete value.units[0].credentialRef;
  value.units[0].vetorApiKey = 'short';
  assert.throws(() => validateCreatePayload(value), { code: 'INVALID_VETOR_API_KEY' });
});
test('permite IDs de filial iguais em origens Automatiza e Vetor diferentes', () => {
  for (const erpId of [3, 4]) {
    const value = payload();
    const first = { ...value.units[0], erpId };
    if (erpId === 3) first.credentialRef = 'mysql://user:pass@first.example/client';
    else { delete first.credentialRef; first.vetorApiKey = 'first-vetor-key'; }
    const second = { ...first, codigo: 'FILIAL', cnpj: '45.723.174/0001-10' };
    if (erpId === 3) second.credentialRef = 'mysql://user:pass@second.example/client';
    else second.vetorApiKey = 'second-vetor-key';
    value.units = [first, second];
    assert.deepEqual(validateCreatePayload(value).units.map((unit) => unit.sourceUnitId), [1, 1]);
  }
});
test('rejeita segredo Vetor em outros ERPs e campos da origem em Linx', () => {
  const value = payload(); value.units[0].vetorApiKey = 'test-vetor-key';
  assert.throws(() => validateCreatePayload(value), { code: 'ERP_CREDENTIAL_FORBIDDEN' });
  assert.throws(() => validateUnitUpdatePayload({ vetorApiKey: 'test-vetor-key' }, 'linx'), { code: 'ERP_CREDENTIAL_FORBIDDEN' });
  assert.throws(() => validateUnitUpdatePayload({ sourceUnitId: 1 }, 'linx'), { code: 'LINX_SOURCE_UNIT_FORBIDDEN' });
});
test('edição usa o provider persistido para MySQL e API key Vetor', () => {
  assert.deepEqual(validateUnitUpdatePayload({ credentialRef: 'mysql://user:pass@db.example/client' }, 'automatiza'), { credentialRef: 'mysql://user:pass@db.example/client' });
  assert.deepEqual(validateUnitUpdatePayload({ vetorApiKey: 'test-vetor-key' }, 'vetor'), { credentialRef: 'test-vetor-key' });
  assert.throws(() => validateUnitUpdatePayload({ credentialRef: 'postgresql://user:pass@db.example/client' }, 'vetor'), { code: 'ERP_CREDENTIAL_FORBIDDEN' });
  assert.throws(() => validateUnitUpdatePayload({ credentialRef: 'postgresql://user:pass@db.example/client' }, 'automatiza'), { code: 'INVALID_CREDENTIAL_REF' });
});
test('rejeita sourceUnitId duplicado', () => { const value = payload(); value.units.push({ ...value.units[0], codigo: 'NORTE', cnpj: '45.723.174/0001-10' }); assert.throws(() => validateCreatePayload(value), (error) => error.code === 'DUPLICATE_SOURCE_UNIT_ID'); });
test('aceita sourceUnitId maior que o limite de INTEGER do PostgreSQL', () => { const value = payload(); value.units[0].sourceUnitId = 50003840493; assert.equal(validateCreatePayload(value).units[0].sourceUnitId, 50003840493); });
test('rejeita sourceUnitId fora da faixa segura do JavaScript', () => { const value = payload(); value.units[0].sourceUnitId = Number.MAX_SAFE_INTEGER + 1; assert.throws(() => validateCreatePayload(value), (error) => error.code === 'INVALID_SOURCE_UNIT_ID'); });
test('exige webhook de pedidos HTTPS por unidade', () => {
  const missing = payload(); delete missing.units[0].orderWebhookUrl;
  assert.throws(() => validateCreatePayload(missing), (error) => error.code === 'INVALID_INPUT');
  const insecure = payload(); insecure.units[0].orderWebhookUrl = 'http://cliente.example/webhook/token';
  assert.throws(() => validateCreatePayload(insecure), (error) => error.code === 'INVALID_ORDER_WEBHOOK_URL');
});
test('modo Hub e Banco Único dispensa webhook e mantém o modo normalizado', () => {
  const value = payload();
  value.flowMode = 'hub_banco_only';
  delete value.units[0].orderWebhookUrl;
  const validated = validateCreatePayload(value);
  assert.equal(validated.flowMode, 'hub_banco_only');
  assert.equal(validated.units[0].orderWebhookUrl, null);
});
test('rejeita modo de fluxo desconhecido', () => {
  const value = payload();
  value.flowMode = 'hub_only';
  assert.throws(() => validateCreatePayload(value), (error) => error.code === 'INVALID_FLOW_MODE');
});
test('hash canônico ignora ordem das chaves', () => assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 })));
test('valida correção parcial da unidade sem exigir novamente os segredos preservados', () => {
  assert.deepEqual(validateUnitUpdatePayload({ pageSize: 250, validEanDropThresholdBps: 750 }), { pageSize: 250, validEanDropThresholdBps: 750 });
});
test('mantém nome e código da unidade em maiúsculas nas correções', () => {
  assert.deepEqual(validateUnitUpdatePayload({ codigo: '  loja centro  ', nome: 'farmácia saúde' }), {
    code: 'LOJA CENTRO',
    name: 'FARMÁCIA SAÚDE',
  });
});
test('normaliza novos segredos no fluxo de correção', () => {
  const value = validateUnitUpdatePayload({ credentialRef: 'postgresql://user:pass@db.example:5432/client', orderWebhookUrl: 'https://cliente.example/pedidos' });
  assert.equal(value.credentialRef, 'postgresql://user:pass@db.example:5432/client');
  assert.equal(value.orderWebhookUrl, 'https://cliente.example/pedidos');
});
test('rejeita correção vazia, campos desconhecidos e URLs inseguras', () => {
  assert.throws(() => validateUnitUpdatePayload({}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateUnitUpdatePayload({ status: 'active' }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateUnitUpdatePayload({ orderWebhookUrl: 'http://cliente.example/pedidos' }), (error) => error.code === 'INVALID_ORDER_WEBHOOK_URL');
});
