# Ambientes do módulo Catálogo

`CATALOG_DEPLOYMENT_ENVIRONMENT` define o destino de novas implantações:

```env
CATALOG_DEPLOYMENT_ENVIRONMENT=staging
```

Valores aceitos: `staging` e `production`. O ambiente escolhido é persistido em
`client_deployments.environment`. Alterar a flag não move implantações já
criadas e não faz um retry mudar de ambiente.

```env
HUBUNICO_PRODUCTION_BASE_URL=https://unicocontato.tech/hubunico
HUBUNICO_PRODUCTION_ADMIN_API_KEY=
HUBUNICO_STAGING_BASE_URL=https://unicocontato.tech/hubunico-staging
HUBUNICO_STAGING_ADMIN_API_KEY=

UNICOMMERCE_BACK_PRODUCTION_BASE_URL=https://unicocontato.tech/unicommerceBack
UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY=
UNICOMMERCE_BACK_STAGING_BASE_URL=https://unicocontato.tech/unicommerceBack
UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY=

BANCO_UNICO_PRODUCTION_BASE_URL=https://unicocontato.tech/banco-unico
BANCO_UNICO_PRODUCTION_AUTHORIZATION=
BANCO_UNICO_STAGING_BASE_URL=https://unicocontato.tech/banco-unico
BANCO_UNICO_STAGING_AUTHORIZATION=
```

UnicommerceBack e Banco Único podem apontar para o mesmo destino nos dois
ambientes. As variáveis legadas sem `PRODUCTION` continuam aceitas como fallback
somente em produção. Staging é fail-closed: todas as variáveis de staging devem
estar preenchidas para impedir fallback acidental para produção.

Depois de mudar a flag, reinicie o processo com `--update-env`. Confira o campo
`environment` na resposta de criação antes de iniciar a implantação.

## Storefront compartilhado na Vercel

Cada ambiente usa seu projeto Vercel compartilhado. Nenhum projeto ou build é
criado por cliente. O orquestrador aceita somente um deployment `READY` ligado
a `grupounico/unicommerce:main` cujo `githubCommitSha` seja igual ao SHA atual
do GitHub. O alias é reservado, o domínio é configurado no tenant ainda inativo
e só então o tenant é ativado. Identidade, branding responsivo e catálogo
público são validados antes de concluir.

```env
STOREFRONT_PROVISIONING_ENABLED=true
STOREFRONT_DOMAIN_PREFIX=whatsapp
STOREFRONT_DOMAIN_SUFFIX=vercel.app
STOREFRONT_HEALTH_TIMEOUT_MS=60000
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=
STOREFRONT_GITHUB_OWNER=grupounico
STOREFRONT_GITHUB_REPO=unicommerce
STOREFRONT_GITHUB_BRANCH=main
STOREFRONT_GITHUB_TOKEN=
```

A unidade inicial usa `whatsapp-<username>.vercel.app`. Filiais usam também o
código da unidade, por exemplo `whatsapp-<username>-loja-02.vercel.app`.
`VERCEL_API_TOKEN` é secreto server-side. `VERCEL_TEAM_ID` e
`VERCEL_PROJECT_ID` podem ser compartilhados entre staging e production; para
separá-los, use as variantes `VERCEL_STAGING_*` e `VERCEL_PRODUCTION_*`.

Se a release ainda não estiver alinhada, a implantação permanece em
`waiting_storefront_release` com o tenant inativo. O reconciliador apenas move
aliases concluídos quando uma nova release validada da `main` fica pronta; ele
não cria deploys, commits, merges ou pushes.

`POST /api/v1/deployments/:deploymentId/promote` promove staging para production
de forma idempotente. A rota fica bloqueada até
`CATALOG_PRODUCTION_PROMOTION_ENABLED=true`, exige que o SHA validado em staging
continue sendo a `main` atual e retém a credencial ERP cifrada por no máximo
`CATALOG_CREDENTIAL_RETENTION_DAYS` (padrão: 7).

## Webhook de pedidos por unidade

Novas implantações devem informar `orderWebhookUrl` em cada unidade. O valor
deve ser uma URL HTTPS e é incorporado em `erpConfig.orderWebhookUrl` antes da
validação e ativação do tenant:

```json
{
  "units": [
    {
      "codigo": "MATRIZ",
      "orderWebhookUrl": "https://cliente.example/webhook/capture/identificador"
    }
  ]
}
```

O orquestrador sempre busca o tenant e mescla o `erpConfig` atual antes do
`PATCH`, preservando campos adicionais. O webhook é cifrado no banco do Único
Integra e nunca aparece nas respostas públicas, snapshots de entrada, etapas
ou eventos. A API expõe apenas `hasOrderWebhookUrl` para indicar que a unidade
está configurada.

## Monitoramento exato do run no Hub

O agendamento `POST /api/v1/integration/catalog-sync/:integrationId/runs` deve
retornar `runId`. O Único Integra persiste esse valor antes de iniciar o
monitoramento. A consulta usa
`GET /api/v1/integration/catalog-sync/:integrationId/runs/:runId` e só aceita o
run exato persistido. Uma execução anterior nunca é usada para liberar o gate.
