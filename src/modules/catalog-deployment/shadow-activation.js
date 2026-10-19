export const SHADOW_ACTIVATION_MAX_ATTEMPTS = 3;
export const SHADOW_ACTIVATION_REQUEST_TIMEOUT_MS = 35000;

// Tentativas persistidas sobrevivem a reinícios; uma requisição órfã expira após
// o timeout HTTP de 30s. A confirmação sempre vem da consulta ao mesmo run.
export function shadowActivationDecision(attempts, now = new Date()) {
  const running = attempts.find((attempt) => attempt.status === 'running'
    && now.getTime() - new Date(attempt.startedAt).getTime() < SHADOW_ACTIVATION_REQUEST_TIMEOUT_MS);
  if (running) return 'wait';
  return attempts.length >= SHADOW_ACTIVATION_MAX_ATTEMPTS ? 'exhausted' : 'dispatch';
}

export function isShadowActivationFailure(unit) {
  return unit.lastErrorCode === 'HUB_SHADOW_ACTIVATION_FAILED';
}
