import crypto from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../../../prisma/PrismaClient.js';
import { integraSessionMiddleware } from '../../middlewares/integraSession.middleware.js';

export const MCP_SCOPES = ['catalog:read', 'catalog:write', 'database:test', 'ai:create'];
const allowedScopes = new Set(MCP_SCOPES);
const MAX_ACTIVE_PER_OWNER = 20;

export const hashSecret = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const clean = (row) => ({
  id: row.id,
  name: row.name,
  scopes: Array.isArray(row.scopes) ? row.scopes : [],
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
});

// Prisma P2021 = table missing: the migration was not applied to this database.
function storageError(error, res, next) {
  if (error?.code === 'P2021') {
    return res.status(503).json({ code: 'MCP_CREDENTIALS_UNAVAILABLE', message: 'Tokens MCP indisponíveis: a migração do banco ainda não foi aplicada.' });
  }
  return next(error);
}

export function parseCredentialInput(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const hours = Number(body?.expiresInHours);
  const scopes = body?.scopes;
  if (!name || name.length > 120) return { error: 'Informe um nome com até 120 caracteres.' };
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760) return { error: 'A validade deve ficar entre 1 hora e 365 dias.' };
  if (!Array.isArray(scopes) || !scopes.length) return { error: 'Escolha ao menos uma permissão.' };
  if (scopes.some((scope) => !allowedScopes.has(scope))) return { error: 'Permissão desconhecida.' };
  return { name, hours, scopes: MCP_SCOPES.filter((scope) => scopes.includes(scope)) };
}

export function createCredentialRouter({ database = prisma, sessionMiddleware = integraSessionMiddleware, now = () => new Date() } = {}) {
  const router = Router();
  router.use(sessionMiddleware);
  // Tokens belong to the AtenderBem user, not to one login: they stay listed after a new login.
  router.use((req, res, next) => {
    if (!req.integraUser?.id) return res.status(401).json({ code: 'INTEGRA_SESSION_REQUIRED', message: 'Entre no Integra com seu usuário para gerenciar tokens MCP.' });
    req.mcpOwnerKey = `atenderbem-user:${req.integraUser.id}`;
    return next();
  });

  router.get('/', async (req, res, next) => {
    try {
      const rows = await database.mcpCredential.findMany({ where: { ownerKey: req.mcpOwnerKey }, orderBy: { createdAt: 'desc' }, take: 100 });
      res.json(rows.map(clean));
    } catch (error) { storageError(error, res, next); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const input = parseCredentialInput(req.body);
      if (input.error) return res.status(400).json({ code: 'INVALID_MCP_CREDENTIAL', message: input.error });
      const active = await database.mcpCredential.count({ where: { ownerKey: req.mcpOwnerKey, revokedAt: null, expiresAt: { gt: now() } } });
      if (active >= MAX_ACTIVE_PER_OWNER) return res.status(409).json({ code: 'MCP_CREDENTIAL_LIMIT', message: `Limite de ${MAX_ACTIVE_PER_OWNER} tokens ativos. Revogue um token antes de criar outro.` });
      const secret = `uim_${crypto.randomBytes(32).toString('base64url')}`;
      const row = await database.mcpCredential.create({
        data: { ownerKey: req.mcpOwnerKey, ownerName: req.integraUser.username, name: input.name, secretHash: hashSecret(secret), scopes: input.scopes, expiresAt: new Date(now().getTime() + input.hours * 3600000) },
      });
      res.set('Cache-Control', 'no-store').status(201).json({ ...clean(row), secret });
    } catch (error) { storageError(error, res, next); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ code: 'MCP_CREDENTIAL_NOT_FOUND', message: 'Token não encontrado.' });
      const result = await database.mcpCredential.updateMany({ where: { id: req.params.id, ownerKey: req.mcpOwnerKey, revokedAt: null }, data: { revokedAt: now() } });
      if (!result.count) return res.status(404).json({ code: 'MCP_CREDENTIAL_NOT_FOUND', message: 'Token não encontrado ou já revogado.' });
      res.status(204).end();
    } catch (error) { storageError(error, res, next); }
  });

  return router;
}

export const credentialRouter = createCredentialRouter();
