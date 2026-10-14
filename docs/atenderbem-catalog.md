# Catálogo no AtenderBem

A etapa final funciona em implantações completas, Hub e Banco Único e registros antigos. O operador seleciona a unidade, informa MCP e credenciais, escolhe criar/reutilizar grupo e confirma a revisão. O CSV é validado antes de criar um grupo. A importação é enviada por multipart com margem de 1 MiB no ticket e executada em segundo plano pelo AtenderBem. O operador retorna aos detalhes da implantação; consultas a cada 15 segundos atualizam o andamento e solicitam reindexação ao concluir. A reindexação é assíncrona; concluído indica importação terminada e reindexação solicitada, não indexação finalizada.

## Implantação

1. Aplicar `prisma migrate deploy` (migration 20261007180000_add_atenderbem_configuration) e gerar o Prisma Client.
2. Configurar DEPLOYMENT_ENCRYPTION_KEY, CATALOG_ATENDERBEM_FEED_BASE_URL (URL HTTPS completa do feed, sem query) e as listas de hosts no .env.example. Acrescentar instâncias permitidas a CATALOG_MCP_ALLOWED_HOSTS e hosts do feed a CATALOG_FEED_ALLOWED_HOSTS. CATALOG_UPLOAD_ALLOWED_HOSTS só é necessário se o armazenamento não estiver na mesma origem do MCP.
3. Publicar o backend antes do frontend. As rotas seguem o mecanismo de acesso existente em /api/v1/deployments.

O parâmetro unidadeId vem exclusivamente de hubSellerUnitId da unidade selecionada. A URL é montada no servidor a partir do ambiente. Credenciais MCP e feed são cifradas e não retornam nas consultas. Os campos vazios preservam credenciais salvas; mudar endereço/autenticação exige nova credencial.

## Endpoints

- GET /api/v1/deployments/atenderbem/settings
- PUT /api/v1/deployments/:deploymentId/units/:unitId/atenderbem
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/group
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/import
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/import/status

Ferramentas MCP: product_groups_create, files_create_upload_url, products_import, products_import_status, products_reindex. Importação: format=csv, source=meta, missingAction=0, fileChangeAction=0. Produtos com o mesmo código atualizam registros existentes; produtos ausentes são preservados. Somente o grupo escolhido é reindexado.

## Retentativas e limites

Cancelamento/falha confirmados permitem novo job, preservando o resultado anterior. Resultado incerto após uma chamada externa bloqueia retentativa para não duplicar operações. Nesse caso, ou após reinício do backend durante envio/criação/reindexação, é necessária reconciliação operacional dos IDs/estados no AtenderBem e no registro local; não há recuperação automática desses estados nesta entrega. A conferência de status/reindexação ocorre enquanto os detalhes estiverem abertos ou numa consulta explícita.

Alterar a origem do feed preserva o grupo, mas invalida a conclusão anterior. O status geral da implantação existente não é alterado. O CSV é limitado a 50 MiB. Runtime exige fetch/FormData/Blob nativos (Node 20+; observar os requisitos de Node do Prisma instalado).

A atualização recorrente de 8 horas NÃO está implementada nesta entrega; a frequência é prevista e executionEnabled permanece false. Nenhuma credencial, fixture local ou registro de teste é incluído no PR.
