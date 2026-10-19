# Evidência de validação Linx em staging

Data: 2026-10-08

## Escopo

- Hub: `https://api.unicocontato.ia.br/hubunico-staging`
- CNPJ da unidade: `10.974.173/0001-64`
- Banco Único e Unicommerce: simulados localmente; nenhuma gravação foi feita nesses serviços em produção.
- Produção: não publicada.

## Recursos criados no Hub staging

- Seller: `10`
- Seller unit: `10`
- Integração Linx: `6`
- Publication mode: `shadow`
- Run: `1443b266-84e8-484a-a02e-9335dd239fd6`

O payload da integração não continha `sourceUnitId`, `credentialRef` ou API key Linx.

## Transição observada

1. O run foi criado como `queued`.
2. O mesmo `runId` avançou para `running`.
3. O snapshot terminou como `failed` com `error.code=RUN_REQUIRES_ACTIVATION`, contendo 111.178 linhas processadas e 1.980 válidas. Esse estado foi tratado como snapshot pronto, não como falha definitiva.
4. `/activate` foi chamado uma vez. A resposta imediata excedeu 30 segundos e foi ignorada.
5. O mesmo `runId` continuou sendo consultado, sem criação de outro run e sem reenvio automático da ativação.
6. O run chegou a `published` em `2026-10-08T16:17:42.625Z`.

Resultado final do run:

- Processadas: 111.178
- Válidas: 1.980
- Publicadas segundo o run: 1.980
- Status: `published`

## Catálogo consultável

O endpoint `GET /api/v1/produtos/unidades/10/catalogo` foi paginado até `hasNext=false`:

- Página `offset=0`: 1.000 produtos
- Página `offset=1000`: 261 produtos
- Total consolidado: 1.261 produtos
- EANs únicos: 1.261
- Todos os produtos retornados possuíam EAN.

Uma consulta direta em `POST /api/v1/produtos/consultar-eans` retornou HTTP 200 e encontrou o produto solicitado na unidade 10.

A diferença entre as 1.980 linhas publicadas do run e os 1.261 produtos expostos no catálogo corresponde ao resultado consolidado e único por EAN observado na consulta do catálogo.

## Verificações locais

- 58 testes unitários do backend aprovados.
- E2E Alpha7 completo aprovado.
- E2E Linx aprovado com uma única ativação e o mesmo `runId` até `published`.
- Build do frontend aprovado.
- Lint do frontend sem erros.
- Migração que torna `sourceUnitId` nullable validada em PostgreSQL isolado.

## Gate de produção

A publicação em produção permanece bloqueada até aprovação explícita desta evidência. Nenhum dado de produção foi alterado durante a validação.
