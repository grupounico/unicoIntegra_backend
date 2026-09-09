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
