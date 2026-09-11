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

A fase 2 reutiliza um único projeto Vercel. Nenhum projeto ou build é criado por
cliente. Depois da ativação do tenant, o orquestrador associa um alias ao último
deployment de produção pronto e valida `/api/storefront/identity` antes de
concluir.

```env
STOREFRONT_PROVISIONING_ENABLED=true
STOREFRONT_DOMAIN_PREFIX=whatsapp
STOREFRONT_DOMAIN_SUFFIX=vercel.app
STOREFRONT_HEALTH_TIMEOUT_MS=60000
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=
```

A unidade inicial usa `whatsapp-<username>.vercel.app`. Filiais usam também o
código da unidade, por exemplo `whatsapp-<username>-loja-02.vercel.app`.
`VERCEL_API_TOKEN` é secreto server-side. `VERCEL_TEAM_ID` e
`VERCEL_PROJECT_ID` podem ser compartilhados entre staging e production; para
separá-los, use as variantes `VERCEL_STAGING_*` e `VERCEL_PRODUCTION_*`.

`POST /api/v1/deployments/:deploymentId/provision-storefronts` permite retomar
somente essa fase em uma implantação cujos tenants já estão ativos. O comando
exige `Idempotency-Key`.
