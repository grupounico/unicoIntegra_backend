# Observabilidade do módulo Catálogo no frontend

Use a API diretamente em `https://unicocontato.tech/api/v1`. O prefixo
`/ai-services` não deve ser usado para as APIs.

## Estado atual e progresso

```http
GET /api/v1/deployments/:deploymentId
```

A resposta contém `status`, `currentStage`, `units`, `assets`, os 200 eventos e
etapas mais recentes e o resumo:

```json
{
  "progress": {
    "percent": 75,
    "totalUnits": 3,
    "completedUnits": 0,
    "failedUnits": 1
  }
}
```

O percentual representa a média das unidades. Uma falha em uma filial não
interrompe a atualização das demais.

## Histórico paginado

```http
GET /api/v1/deployments/:deploymentId/events?page=1&pageSize=50
GET /api/v1/deployments/:deploymentId/events?unitId=:unitId
GET /api/v1/deployments/:deploymentId/events?eventType=step_failed
```

Os eventos mais recentes são retornados primeiro. A resposta possui `data` e
`meta` com `page`, `pageSize`, `totalItems` e `totalPages`.

Eventos importantes:

- `deployment_created`, `deployment_queued`, `deployment_failed`;
- `step_started`, `step_completed`, `step_failed`;
- `hub_run_status_changed`;
- `unicommerce_tenant_reconciled`;
- `banco_unico_client_reconciled`, `banco_unico_import_reconciled`;
- `banco_unico_import_progress`;
- `unit_awaiting_activation`, `unit_failed`, `unit_activated`;
- `asset_confirmed`, `tenants_activated`, `deployment_cancelled`.

Para `step_*`, consulte `safeMetadata.step`. Cada tentativa também possui
`attempt`. Erros públicos incluem código, mensagem, indicação de retry e ação
recomendada.

## Atualização em tempo real

```http
GET /api/v1/deployments/:deploymentId/stream
```

Exemplo no navegador:

```js
const stream = new EventSource(
  `${API_BASE_URL}/api/v1/deployments/${deploymentId}/stream`,
  { withCredentials: true },
);

stream.addEventListener('deployment', (message) => {
  const event = JSON.parse(message.data);
  appendTimelineEvent(event);
  refreshDeployment();
});

stream.addEventListener('heartbeat', () => {
  setConnectionStatus('online');
});

stream.onerror = () => {
  setConnectionStatus('reconnecting');
};
```

O backend envia heartbeat a cada 15 segundos. `EventSource` se reconecta
automaticamente; após reconectar, consulte o histórico paginado para preencher
eventos que possam ter ocorrido durante a queda.

## Exibição recomendada

Mostre uma barra geral e uma linha por unidade. Em cada unidade, exiba a etapa
atual, horário, tentativas e o último erro. Não conclua uma etapa apenas porque
o comando HTTP retornou `202`: acompanhe o estado e a timeline até o evento
terminal.

Nunca tente exibir credenciais. Snapshots e metadados da timeline são
deliberadamente limitados a identificadores, contagens e flags como
`hasCredential`.
