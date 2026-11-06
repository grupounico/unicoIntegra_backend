import crypto from 'node:crypto';
// The same fixed authority used by the Integra login page. Never trust a
// client-provided instance URL, username or a locally decoded token as proof.
const SESSION_CHECK_URL = 'https://ambientesdetesteunicocontato.atenderbem.com/ivrs/getResumedList';

// Reads the user claims of a session token. Only call this AFTER the authority
// accepted the exact token: the signature is checked there, so the claims are
// the ones it issued. Returns null for opaque or malformed tokens.
export function sessionUserFromToken(authorization) {
  const token = /^Bearer (\S+)$/i.exec(authorization || '')?.[1];
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const id = claims?.id;
    if (!(Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^[\w-]{1,64}$/.test(id))) return null;
    const username = typeof claims.username === 'string' ? claims.username.slice(0, 120) : null;
    return { id: String(id), username };
  } catch { return null; }
}

export function createIntegraSessionMiddleware({ fetchImpl = fetch, environment = process.env } = {}) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    const authorization = req.headers.authorization;
    // Backward compatibility for API clients and the previous frontend release.
    // The browser no longer needs or receives the administrative key.
    if (!authorization && req.headers['x-api-key']) {
      if (environment.ADMIN_API_KEY && req.headers['x-api-key'] === environment.ADMIN_API_KEY) return next();
      return res.status(403).json({ code: 'INTEGRA_AUTH_INVALID', message: 'Autorização inválida. Entre novamente no Integra.' });
    }
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 16384) {
      return res.status(401).json({ code: 'INTEGRA_SESSION_REQUIRED', message: 'Entre no Integra para configurar o AtenderBem.' });
    }
    try {
      const response = await fetchImpl(SESSION_CHECK_URL, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        return res.status(response.status).json({ code: 'INTEGRA_SESSION_INVALID', message: 'Sessão expirada ou sem permissão para automações. Entre novamente no Integra.' });
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel(); throw new Error('Session authority unavailable');
      }
      // A login page or arbitrary HTTP 200 must never grant access.
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('Unexpected session response');
      req.integraOwnerHash = crypto.createHash('sha256').update(authorization).digest('hex');
      req.integraUser = sessionUserFromToken(authorization);
      return next();
    } catch {
      return res.status(503).json({ code: 'INTEGRA_SESSION_UNAVAILABLE', message: 'Não foi possível validar sua sessão do Integra. Tente novamente; nenhuma alteração foi iniciada.' });
    }
  };
}

export const integraSessionMiddleware = createIntegraSessionMiddleware();
