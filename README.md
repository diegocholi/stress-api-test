# Stress Lab

Gerador de carga HTTP real com editor de cenários pela interface, importação Postman, agendamento e resultados exportáveis. Requer Node.js 18+.

```bash
npm start
```

Esse comando instala as dependências automaticamente quando necessário e inicia a interface. Na primeira execução, é necessário acesso à internet.

Abra http://127.0.0.1:3000. A configuração tem duas abas:

- **Criar pela interface**: monte uma sequência de requisições com método, URL, headers e corpo JSON ou texto. Adicione, remova e reordene os passos. Defina status esperado, texto que a resposta deve conter e campos JSON com valores esperados. Nenhum arquivo Postman é necessário.
- **Postman**: envie uma collection v2/v2.1 e, opcionalmente, um environment.

As duas abas usam os mesmos estágios, timeouts, pausa entre cenários, threads, métricas e critérios de aprovação. Escolha **Iniciar agora** ou **Agendar**, com data futura e fuso exibido na tela.

No editor, variáveis são escritas uma por linha (`BASE_URL=http://127.0.0.1:4000`) e headers como `Authorization: Bearer {{TOKEN}}`. Use `{{NOME}}` na URL, nos headers e no corpo. Para um fluxo de login, extraia o campo `data.token` da resposta e salve em `TOKEN`; os próximos passos podem usar `{{TOKEN}}`. A extração vale dentro da execução do cenário de cada usuário. Caminhos JSON usam pontos, inclusive índices de arrays (`items.0.id`), e valores esperados usam sintaxe JSON (`123`, `true`, `"texto"`).

A agenda e o histórico persistem em `.runs/`, ignorado pelo Git. O servidor precisa estar ligado para executar os agendamentos. Um teste roda por vez; agendamentos sobrepostos entram na fila. Ao reiniciar, testes interrompidos são marcados como falha e agendamentos pendentes voltam à fila. A interface permite cancelar e baixar o relatório XLSX ao terminar. Collections e environments de testes pendentes são armazenados localmente com permissões restritas e removidos do histórico ao encerrar. Não use o histórico para compartilhar credenciais.

## Configuração, acompanhamento e resultados

A navegação separa o editor, o acompanhamento e a leitura final. Requisições podem ser recolhidas ou duplicadas, e a prévia mostra os degraus de carga. Erros indicam o campo e direcionam o foco. Variáveis do editor precisam existir na configuração inicial, entre as quatro variáveis dinâmicas ou em uma extração de passo anterior. Corpos JSON são conferidos novamente após a substituição, antes do envio; um corpo inválido é registrado como validação reprovada e não é enviado.

- **Validar configuração:** confere a definição sem fazer requisições à API.
- **Executar uma vez:** executa o cenário completo uma única vez com um usuário, incluindo scripts e validações. Essa verificação gera histórico e XLSX, mas não comprova capacidade de carga. Repeti-la mantém a finalidade funcional.
- **Acompanhamento:** gráficos de usuários observados/alvo, RPS, p95 e falhas HTTP por janela, com horários reais e consulta por mouse ou teclado. A evolução é recuperada ao recarregar ou selecionar uma execução concluída. Execuções antigas sem série mostram essa ausência explicitamente.
- **Resultados:** critérios, evidência de carga por estágio, conferência dos registros, categorias de falha e endpoints com maior p95. A comparação usa uma execução de referência e a selecionada; diferenças de configuração e metodologia são exibidas sem revelar headers, corpos ou credenciais.

O histórico tem busca, filtros e páginas de 20 execuções. As atualizações preservam o foco dos controles. O layout funciona em telas estreitas e com zoom de 200%.

## Aprovação e evidência

Novos testes usam metodologia **2.0**, com os limites iniciais configuráveis de **100 respostas com latência** e **90% da carga planejada em cada estágio com alvo positivo**. O mínimo de respostas não é garantia estatística; o tamanho da amostra acompanha os percentis.

A carga é calculada em usuários-segundo: tempo efetivo de alocação de cada usuário dentro do estágio dividido por duração planejada × alvo. Em cada instante, usuários acima do alvo não compensam períodos abaixo do alvo. Usuários em pausa continuam alocados; esse indicador não representa requisições HTTP simultâneas. A interface distingue usuários alocados, cenários em execução e usuários em pausa.

- **Aprovado:** execução concluída, evidência suficiente, critérios de performance cumpridos, validações/scripts/execuções sem falhas e registros íntegros.
- **Reprovado:** evidência suficiente, mas algum critério de performance ou validação falhou.
- **Inconclusivo:** execução concluída com carga ou volume de respostas insuficiente. Critérios que falharam continuam visíveis.
- **Parcial:** cancelamento, interrupção ou perda/incerteza dos registros. Nunca aprova, mesmo com respostas rápidas e contagens coincidentes.

Durante a execução, a avaliação é provisória. O campo público `passed` só é verdadeiro para uma avaliação final aprovada. Quando um worker precisa ser encerrado à força, tentativas pendentes conhecidas são registradas como interrompidas; buffers que não tiveram flush completo impedem declarar integridade.

Definições antigas sem versão preservam seu prazo global anterior (duas vezes o timeout da requisição) e usam mínimo de uma resposta e cumprimento mínimo de carga de 0%. Histórico antigo conserva a metodologia original; valores não registrados não são estimados.

## Timeouts e drenagem

Requisição, script e cenário têm limites separados. Em novas definições, o timeout do script começa com o mesmo valor da requisição, e o timeout total do cenário é **0**, sem limite global. Configure um prazo global quando necessário. Assim, um fluxo longo pode concluir se cada requisição/script respeitar seu limite.

O prazo de drenagem limita o tempo para terminar os cenários em andamento depois de parar a carga. Seu default no motor é duas vezes o maior timeout de requisição/script mais 3 segundos; a interface inicia com 23.000 ms e permite alterá-lo. Carga e drenagem têm durações e throughput separados. O RPS global continua incluindo ambas, e a geração do XLSX fica fora da medição.

## Salvar e reutilizar testes

Use **Salvar teste** no editor para guardar um cenário completo na biblioteca **Testes salvos**. A biblioteca permite buscar pelo nome, carregar, duplicar e excluir. Ao carregar, o formulário recupera as requisições, variáveis, headers, corpo, validações, estágios, limites e opções. Para Postman, recupera também a collection e o environment; não é preciso selecionar os arquivos novamente.

**Salvar alterações** atualiza o teste carregado. **Salvar como novo** cria outro registro a partir da configuração do editor. A aplicação sinaliza alterações não salvas e detecta edições concorrentes em outras abas, impedindo sobrescritas silenciosas. **Novo teste** limpa o editor.

Os testes ficam em `.runs/templates/`, em arquivos locais com permissões restritas, e continuam disponíveis após reiniciar o servidor. A definição inclui os valores configurados, como tokens e headers necessários à execução; esse diretório está fora do Git. Salvar ou carregar não executa requisições. A data de agendamento é definida a cada execução e não é reaplicada ao carregar um teste. Excluir um teste salvo preserva o histórico de execuções e os relatórios XLSX.

## Experimentar com uma API local

Em um terminal:

```bash
npm run demo:target
```

Em outro, execute `npm start`. Na aba **Criar pela interface**, informe `GET http://127.0.0.1:4000/health` com status esperado `200`. Para experimentar a aba **Postman**, selecione os dois JSON de `examples/`. A collection verifica `GET /health` na API de exemplo, sem acessar serviços externos.

## Linha de comando

```bash
node load-runner.js \
  --collection=examples/local.postman_collection.json \
  --environment=examples/local.postman_environment.json \
  --stages="10:2,20:5,5:0" \
  --maxWorkers=2 \
  --timeout=10000 \
  --scriptTimeout=10000 \
  --scenarioTimeout=0 \
  --drainTimeout=23000 \
  --minResponses=100 \
  --minLoadPercent=90 \
  --thinkTime=0 \
  --keepAlive=true \
  --p95=1000 \
  --errorRate=1 \
  --xlsx=relatorio.xlsx
```

O CLI imprime snapshots JSON e retorna código 0 somente quando o teste conclui e passa nos critérios. SIGINT/SIGTERM cancela e preserva métricas parciais. `--iters` foi removido: cada usuário repete a collection durante o estágio. Não há limite de iterações que esvazie a carga antes do tempo. Variáveis `VU_ID`, `VU_ITER`, `UNIQUE_ID` e `UNIQUE_EMAIL` estão disponíveis como dados da iteração.

## Executar novamente

O painel de resultados tem **Executar novamente** ao lado de **Baixar relatório XLSX**. Uma nova execução usa a configuração registrada no teste anterior, inicia imediatamente e cria um novo item no histórico com seu próprio relatório. O agendamento anterior não é reaplicado. A configuração original permanece disponível mesmo se o teste salvo for editado ou excluído.

Execuções antigas que não registraram essa configuração mostram um seletor de testes salvos antes do botão. Nesse caso, escolha explicitamente o teste da biblioteca que deseja executar. A aplicação nunca tenta reconstruir requisições a partir do relatório.

As configurações das execuções ficam em `.runs/inputs/`, em arquivos locais com permissões restritas, junto ao histórico. Incluem os dados necessários para repetir as requisições, como os testes salvos.

## Relatório final XLSX

Ao encerrar o teste, a interface prepara o arquivo e libera **Baixar relatório XLSX**. O arquivo inclui:

- **Resumo:** painel executivo com indicadores, veredito e motivos, carga/drenagem, principais pontos de atenção e integridade dos registros e quatro gráficos nativos editáveis (RPS, p95, usuários e HTTP), quando existem dados.
- **Critérios e Integridade:** todos os critérios, incluindo amostra e cumprimento por estágio, e conferência independente de tentativas, validações, scripts e execuções.
- **Configuração:** versões da ferramenta/metodologia, nome, origem, identificador, datas UTC de criação/agendamento/execução, parâmetros, critérios, versão do Node e motivo de encerramento. Credenciais e valores de variáveis não são exportados.
- **Estágios:** carga planejada, início/fim reais, duração, usuários-segundo e cumprimento observado. Estágios não iniciados e drenagem são identificados.
- **Endpoints:** tentativas, falhas, transporte, taxa de falhas, bytes recebidos, mínimo, média, p50/p90/p95/p99 e máximo, ordenados por p95.
- **Evolução:** RPS por janela, concorrência observada, alvo, latências e telemetria de CPU, memória e event loop do gerador/threads. Janelas de 1 segundo, ampliadas para manter até cerca de 3.600 pontos em execuções longas.
- **HTTP:** distribuição de códigos e métricas por código; zero significa ausência de resposta.
- **Usuários:** tentativas, iterações observadas e métricas por usuário virtual.
- **Validações:** todas as assertions, com aprovação/reprovação/ignorada e mensagem.
- **Falhas:** ocorrências HTTP, transporte, assertions, scripts e execuções, com contexto.
- **Requisições:** todas as tentativas, com horários UTC de início/fim, estágio, usuário, iteração, nome, método, URL, status, latência, bytes e erro.
- **Metodologia:** definições, critérios, escopo, integridade e limitações da coleta.

Abas detalhadas têm filtros, cabeçalhos congelados, linhas alternadas, formatos numéricos e destaque de falhas. Elas são divididas automaticamente ao atingir o limite de linhas do Excel. Não há amostragem das tentativas. Corpos e headers não são incluídos; credenciais de URL e valores de query são ocultos. Mensagens de validação vêm dos scripts da collection; valores conhecidos de credenciais também são ocultos. Conteúdo sensível arbitrário produzido por scripts pode não ser reconhecido.

Testes cancelados ou interrompidos geram um relatório identificado como parcial. A interface mostra erros de geração separadamente das falhas da API. Os eventos detalhados são removidos após uma geração bem-sucedida com integridade confirmada; metadados e série temporal permanecem para consulta. Em caso de falha, **Regenerar XLSX** reutiliza os registros sem executar a API novamente. A regeneração aguarda qualquer teste ativo para não interferir na medição. Linhas JSON truncadas aparecem como falha de integridade, com resultado parcial. Relatórios CSV do histórico anterior são convertidos para XLSX no download, indicando os campos que não existiam naquela versão.

O CLI também gera XLSX automaticamente; use `--xlsx=relatorio.xlsx` para escolher o destino. O antigo `--csv` foi substituído. `npm start` e `pnpm start` instalam as novas dependências quando necessário.

## Como a medição funciona

- Modelo fechado: cada usuário executa uma collection por vez e a repete. Threads hospedam vários usuários assíncronos. `maxWorkers` limita realmente o total de threads (1–32); o limite de usuários é 500 por estágio.
- Estágios são degraus de concorrência, não uma rampa linear nem uma taxa fixa de chegadas. Inicialização leva tempo; acompanhe usuários ativos versus alvo. Reduções deixam as collections em andamento terminar. Ao final, há drenagem limitada por prazo. Cancelar impede novas execuções e aguarda as collections em andamento, dentro do prazo de encerramento.
- Um único evento Newman `request` contabiliza tentativas HTTP concluídas, incluindo `pm.sendRequest`, respostas e falhas de transporte. Tentativas pendentes conhecidas são registradas como interrompidas quando um worker precisa ser encerrado à força. Não há soma duplicada com `summary.run.executions`.
- HTTP ≥400 e falhas de transporte contam como requisições com falha. Assertions, scripts e erros de execução têm contadores próprios; qualquer falha nesses contadores reprova o teste. Taxa HTTP = requisições com falha / total de tentativas, sem misturar a quantidade de assertions.
- p50/p95/p99 vêm exclusivamente do `responseTime` das requisições com resposta. Timeouts sem resposta entram na taxa de falhas, sem uma latência inventada. Histograma com resolução de 1 ms e teto de 600.000 ms; não usa amostragem enviesada. Não há percentil quando não há respostas.
- RPS é a média desde o início, incluindo inicialização e drenagem. Métricas parciais chegam a cada 500 ms ou 100 requisições. O registro detalhado tem uma entrada por tentativa e validação, com buffer máximo de 8 MB. Após a medição, um worker gera o XLSX; o tempo de geração não entra na duração ou no RPS. Se o disco não acompanhar, o teste falha explicitamente.
- Keep-alive é aplicado com agentes HTTP/HTTPS explícitos, conforme a [API oficial do Newman](https://github.com/postmanlabs/newman#newmanrunoptions-object--callback-function).
- CPU do processo (100% equivale a um núcleo), memória e atraso do event loop principal e dos workers ajudam a identificar sobrecarga do gerador. CPU, banco, filas e memória da API precisam ser monitorados no ambiente de destino. O número de usuários configurado sozinho não comprova capacidade da API. No modelo fechado, uma API mais lenta faz os usuários iniciarem menos operações; não há controle de taxa de chegada.

A interface fica em `127.0.0.1`; serve para uso local. Porta configurável com `PORT=3001 npm start`. Importação limitada a 5 MB. O projeto não inclui execução distribuída, controle de RPS ou agendamento recorrente.

## Validação

```bash
npm test
```

Os testes usam um servidor HTTP local e conferem carga sustentada, limite de threads, contagem exata, chamadas de scripts, falhas HTTP, assertions, timeouts, cancelamento, integridade do XLSX e cenários criados pela interface, incluindo login, extração de token e chamada autenticada.

## API local e versões

As rotas anteriores continuam disponíveis. `GET /api/runs` sem paginação mantém a resposta em array. Novas rotas:

| Rota | Uso |
| --- | --- |
| `POST /api/validate` | Validar uma configuração sem tráfego; erros podem incluir `step` (índice a partir de zero) e `field`. |
| `POST /api/runs/check` | Verificação funcional de uma execução com um usuário. |
| `GET /api/runs?page=1&pageSize=20&q=nome&status=inconclusive` | Histórico paginado, filtros e totais do workspace. `pageSize` aceita 1–100. |
| `GET /api/runs/:id` | Resultado individual. |
| `GET /api/runs/:id/series` | Janelas registradas; históricos antigos podem retornar `available: false`. |
| `GET /api/runs/compare?left=idA&right=idB` | Diferenças de configuração e métricas; variação relativa é indisponível quando a referência é zero. |
| `POST /api/runs/:id/regenerate` | Refazer XLSX a partir de eventos preservados. |

Definições e resultados novos incluem `schemaVersion: 2`; resultados incluem `methodologyVersion: "2.0"`. A avaliação expõe `verdict`, `provisional`, `criteria` e `reasons`. Parâmetros novos: `scriptTimeout`, `scenarioTimeout`, `drainTimeout` e `evidence: {minResponses, minLoadPercent}`. `singleRun: true` normaliza a configuração para uma verificação funcional com um usuário, uma thread e uma única execução.

Em resultados finais com relatório, as métricas públicas vêm dos registros que alimentam o XLSX; `engineMetrics` preserva os contadores originais do motor para conferência. Divergências são identificadas na tela e na planilha. Dados recuperados de uma interrupção continuam parciais.

Metadados e série temporal ficam em arquivos privados ao lado do XLSX. Após reiniciar, execuções interrompidas ficam parciais e exportações interrompidas permitem nova tentativa, quando os eventos estão disponíveis.

## Testes da interface

```bash
pnpm test:browser
```

No macOS, os testes usam o Google Chrome instalado em `/Applications`. Para outro caminho, use `CHROME_PATH=/caminho/do/chrome pnpm test:browser`. Em outros sistemas, instale o Chromium do Playwright com `pnpm exec playwright install chromium`, ou informe `CHROME_PATH`. Os testes iniciam uma API de exemplo local e um workspace temporário separado do histórico real.

A suíte cobre validação sem tráfego, foco de erros, duplicação/recolhimento, salvar/carregar, execução, repetição, comparação, cancelamento, download, recuperação de gráficos, tela móvel e zoom.

## Dependências

Os lockfiles preservam Newman 6.2.2; Playwright é dependência de desenvolvimento para validar a interface. Use `npm audit` para consultar a situação atual das dependências transitivas. Não foi aplicada troca forçada da versão principal do Newman. Importe collections e scripts de origem confiável.
