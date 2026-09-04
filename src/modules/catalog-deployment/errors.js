export class DeploymentError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.statusCode = options.statusCode || 500;
    this.stage = options.stage || null;
    this.unitId = options.unitId || null;
    this.retryable = Boolean(options.retryable);
    this.action = options.action || null;
    this.httpStatus = options.httpStatus || null;
  }
}

export function publicError(error, context = {}) {
  const known = error instanceof DeploymentError;
  return {
    code: known ? error.code : 'INTERNAL_ERROR',
    message: known ? error.message : 'Falha interna ao processar a implantação.',
    stage: error.stage || context.stage || null,
    deploymentId: context.deploymentId || null,
    unitId: error.unitId || context.unitId || null,
    retryable: known ? error.retryable : false,
    action: error.action || (known ? null : 'Contate o suporte técnico.'),
  };
}

export function mapUpstreamError(error, prefix, stage, unitId = null) {
  if (error instanceof DeploymentError) return error;
  const status = Number(error.response?.status || 0);
  if (status === 401 || status === 403) {
    return new DeploymentError(`${prefix}_AUTH_FAILED`, `A autenticação com ${prefix} falhou.`, {
      statusCode: 502, stage, unitId, httpStatus: status,
      action: 'Revise a credencial server-side da integração.',
    });
  }
  if (status === 409) {
    return new DeploymentError('RECONCILIATION_REQUIRED', 'O recurso já existe e precisa ser reconciliado.', {
      statusCode: 409, stage, unitId, httpStatus: status,
      action: 'Confirme os identificadores externos antes de repetir.',
    });
  }
  const retryable = !status || status === 429 || status >= 500;
  return new DeploymentError(`${prefix}_UNAVAILABLE`, `${prefix} está indisponível no momento.`, {
    statusCode: 502, stage, unitId, httpStatus: status || null, retryable,
    action: retryable ? 'A operação será tentada novamente.' : 'Revise a configuração enviada.',
  });
}
