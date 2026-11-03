# Resultados das IAs em operação

O painel do Integra em `/main/iaPage/resultados` usa o Banco Único como responsável pela coleta, persistência e cálculo. Abrir a tela só consulta o último resultado completo; o botão **Gerar levantamento** solicita uma nova coleta. A tela acompanha o mesmo UUID a cada cinco segundos e mantém instância e UUID na URL para retomar depois de recarregar.

## Configuração

No ambiente privado do back, configure `BANCO_UNICO_BASE_URL` (padrão `https://unicocontato.tech/banco-unico`) e `ATTENDANCE_REPORTS_MINAS_MAIS_CLIENT_TOKEN` com o token existente de exportação do cliente Minas Mais. Esse token pertence ao cliente no Hub; não use a credencial administrativa do Banco Único, o token de sessão do operador nem a credencial interna do MCP. Não configure esse segredo em variáveis `VITE_*`.

O perfil padrão inclui as filas 33, 35, 36, 38, 40 e 41. Outras redes podem ser cadastradas usando `ATTENDANCE_REPORTS_CLIENTS_JSON`, que **substitui** os perfis padrão:

```json
[
  {
    "key": "outra-rede",
    "name": "Outra Rede",
    "tokenEnv": "ATTENDANCE_REPORTS_OUTRA_REDE_CLIENT_TOKEN",
    "units": [{ "queueId": 7, "name": "Loja 7" }]
  }
]
```

Configure separadamente a variável indicada em `tokenEnv`. A rede e as filas também precisam estar habilitadas no Banco Único. Um cadastro no Integra não provisiona uma instância no serviço de origem. Sem token, a rede aparece como não configurada. Nenhuma migração ou worker adicional é necessário no Integra. Reinicie o back depois de alterar o ambiente.

## API do Integra

Todas as rotas abaixo exigem a sessão do operador, validada pela autoridade já usada no Integra. O navegador envia `Authorization: Bearer <sessão>`. O back consulta a rede usando `X-API-Key` com seu token privado, sem encaminhar a sessão do operador.

| Método | Rota | Retorno |
| --- | --- | --- |
| GET | `/api/ia/attendance-reports/instances` | `{data:[{key,name,units,configured}]}` |
| GET | `/api/ia/attendance-reports/:instanceKey/latest` | Último COMPLETED, com seus filtros |
| POST | `/api/ia/attendance-reports/:instanceKey/runs` | 202 e execução iniciada/reutilizada |
| GET | `/api/ia/attendance-reports/:instanceKey/runs/:runId` | Estado, progresso, erros e resultado |

O POST aceita `dateFrom`, `dateTo`, `queueIds` opcional e `comparison` opcional com `dateFrom`/`dateTo`. Datas são inclusivas em `America/Sao_Paulo`, sem dias futuros e com até 366 dias no intervalo combinado. Omitir filas seleciona todas; lista vazia ou fila de outra rede é recusada. A comparação não agenda coleta automática. Presets e exportação não fazem parte desta interface.

As respostas mantêm o contrato numérico do Banco Único, incluindo `null`, amostras observadas e falhas por fonte. `statusUrl` aponta para o Integra; URLs externas e links de exportação não são expostos. Erros `INTEGRA_SESSION_*` indicam a sessão do operador; `REPORT_NETWORK_TOKEN_INVALID`/`REPORT_NETWORK_FORBIDDEN` indicam a configuração do token da rede. Um erro do token da rede não deve desconectar o operador. `REPORT_LATEST_NOT_FOUND` significa ausência de resultado completo ou recurso/rede ainda não habilitado no Banco Único.

## Interpretação e validação

O painel apresenta somente o resumo operacional. Dados incompletos ficam identificados e não são substituídos por zero. A contagem sem mensagem humana não representa resolução autônoma; encerramento como venda não comprova pagamento. Percentuais de redução e pontos percentuais de variação de vendas são unidades distintas. Tempos são exibidos em segundos, com o tamanho da amostra. O período exibido é sempre o da execução recebida, mesmo após editar filtros.

Validação local sem fontes operacionais:

```sh
node --test test/attendanceReports.test.js test/integraSession.test.js
npm test
```

No projeto do front:

```sh
node --test test/attendanceReports.test.mjs
npm run build
```

Para validar com dados reais após configurar o ambiente, abra o painel autenticado e gere um período pequeno. Confirme `COMPLETED`, nomes das unidades e horário de corte. As consultas às fontes são realizadas pelo Banco Único; não se cria pedido nem se envia mensagem pelo painel.
