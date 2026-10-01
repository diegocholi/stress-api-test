# Stress Lab

Gerador de carga HTTP real com editor de cenários pela interface, importação Postman, agendamento e resultados exportáveis. Requer Node.js 18+.

```bash
npm start
```

Esse comando instala as dependências automaticamente quando necessário e inicia a interface. Na primeira execução, é necessário acesso à internet.

Abra http://127.0.0.1:3000. A configuração tem duas abas:

- **Criar pela interface**: monte uma sequência de requisições com método, URL, headers e corpo JSON ou texto. Adicione, remova e reordene os passos. Defina status esperado, texto que a resposta deve conter e campos JSON com valores esperados. Nenhum arquivo Postman é necessário.
- **Postman**: envie uma collection v2/v2.1 e, opcionalmente, um environment.

As duas abas usam os mesmos estágios, timeout, pausa entre cenários, threads, métricas e critérios de aprovação. Deixe a data vazia para executar agora ou escolha uma data futura para agendar.

No editor, variáveis são escritas uma por linha (`BASE_URL=http://127.0.0.1:4000`) e headers como `Authorization: Bearer {{TOKEN}}`. Use `{{NOME}}` na URL, nos headers e no corpo. Para um fluxo de login, extraia o campo `data.token` da resposta e salve em `TOKEN`; os próximos passos podem usar `{{TOKEN}}`. A extração vale dentro da execução do cenário de cada usuário. Caminhos JSON usam pontos, inclusive índices de arrays (`items.0.id`), e valores esperados usam sintaxe JSON (`123`, `true`, `"texto"`).

A agenda e o histórico persistem em `.runs/`, ignorado pelo Git. O servidor precisa estar ligado para executar os agendamentos. Um teste roda por vez; agendamentos sobrepostos entram na fila. Ao reiniciar, testes interrompidos são marcados como falha e agendamentos pendentes voltam à fila. A interface permite cancelar e baixar o relatório XLSX ao terminar. Collections e environments de testes pendentes são armazenados localmente com permissões restritas e removidos do histórico ao encerrar. Não use o histórico para compartilhar credenciais.

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
  --thinkTime=0 \
  --keepAlive=true \
  --p95=1000 \
  --errorRate=1 \
  --xlsx=relatorio.xlsx
```

O CLI imprime snapshots JSON e retorna código 0 somente quando o teste conclui e passa nos critérios. SIGINT/SIGTERM cancela e preserva métricas parciais. `--iters` foi removido: cada usuário repete a collection durante o estágio. Não há limite de iterações que esvazie a carga antes do tempo. Variáveis `VU_ID`, `VU_ITER`, `UNIQUE_ID` e `UNIQUE_EMAIL` estão disponíveis como dados da iteração.

## Relatório final XLSX

Ao encerrar o teste, a interface prepara o arquivo e libera **Baixar relatório XLSX**. O arquivo inclui:

- **Resumo:** painel executivo com indicadores, aprovação por critério, integridade dos registros e quatro gráficos nativos editáveis (RPS, p95, usuários e HTTP), quando existem dados.
- **Configuração:** nome, origem, identificador, datas UTC de criação/agendamento/execução, parâmetros, critérios, versão do Node e motivo de encerramento. Credenciais e valores de variáveis não são exportados.
- **Estágios:** carga planejada, início/fim reais, duração e métricas observadas. Estágios não iniciados e drenagem são identificados.
- **Endpoints:** tentativas, falhas, transporte, taxa de falhas, bytes recebidos, mínimo, média, p50/p90/p95/p99 e máximo, ordenados por p95.
- **Evolução:** RPS por janela, concorrência observada, alvo, latências e telemetria do gerador. Janelas de 1 segundo, ampliadas para manter até cerca de 3.600 pontos em execuções longas.
- **HTTP:** distribuição de códigos e métricas por código; zero significa ausência de resposta.
- **Usuários:** tentativas, iterações observadas e métricas por usuário virtual.
- **Validações:** todas as assertions, com aprovação/reprovação/ignorada e mensagem.
- **Falhas:** ocorrências HTTP, transporte, assertions, scripts e execuções, com contexto.
- **Requisições:** todas as tentativas, com horários UTC de início/fim, estágio, usuário, iteração, nome, método, URL, status, latência, bytes e erro.
- **Metodologia:** definições, critérios, escopo, integridade e limitações da coleta.

Abas detalhadas têm filtros, cabeçalhos congelados, linhas alternadas, formatos numéricos e destaque de falhas. Elas são divididas automaticamente ao atingir o limite de linhas do Excel. Não há amostragem das tentativas. Corpos e headers não são incluídos; credenciais de URL e valores de query são ocultos. Mensagens de validação vêm dos scripts da collection.

Testes cancelados ou interrompidos geram um relatório identificado como parcial. A interface mostra erros de geração separadamente das falhas da API. Arquivos temporários são removidos após a geração bem-sucedida. Relatórios CSV do histórico anterior são convertidos para XLSX no download, indicando os campos que não existiam naquela versão.

O CLI também gera XLSX automaticamente; use `--xlsx=relatorio.xlsx` para escolher o destino. O antigo `--csv` foi substituído. `npm start` e `pnpm start` instalam as novas dependências quando necessário.

## Como a medição funciona

- Modelo fechado: cada usuário executa uma collection por vez e a repete. Threads hospedam vários usuários assíncronos. `maxWorkers` limita realmente o total de threads (1–32); o limite de usuários é 500 por estágio.
- Estágios são degraus de concorrência, não uma rampa linear nem uma taxa fixa de chegadas. Inicialização leva tempo; acompanhe usuários ativos versus alvo. Reduções deixam as collections em andamento terminar. Ao final, há drenagem limitada por prazo. Cancelar impede novas execuções e aguarda as collections em andamento, dentro do prazo de encerramento.
- Um único evento Newman `request` contabiliza tentativas HTTP, incluindo `pm.sendRequest`, respostas e falhas de transporte. Não há soma duplicada com `summary.run.executions`.
- HTTP ≥400 e falhas de transporte contam como requisições com falha. Assertions, scripts e erros de execução têm contadores próprios; qualquer falha nesses contadores reprova o teste. Taxa HTTP = requisições com falha / total de tentativas, sem misturar a quantidade de assertions.
- p50/p95/p99 vêm exclusivamente do `responseTime` das requisições com resposta. Timeouts sem resposta entram na taxa de falhas, sem uma latência inventada. Histograma com resolução de 1 ms e teto de 600.000 ms; não usa amostragem enviesada. Não há percentil quando não há respostas.
- RPS é a média desde o início, incluindo inicialização e drenagem. Métricas parciais chegam a cada 500 ms ou 100 requisições. O registro detalhado tem uma entrada por tentativa e validação, com buffer máximo de 8 MB. Após a medição, um worker gera o XLSX; o tempo de geração não entra na duração ou no RPS. Se o disco não acompanhar, o teste falha explicitamente.
- Keep-alive é aplicado com agentes HTTP/HTTPS explícitos, conforme a [API oficial do Newman](https://github.com/postmanlabs/newman#newmanrunoptions-object--callback-function).
- Memória e atraso do event loop ajudam a identificar sobrecarga do gerador. CPU, banco, filas e memória da API precisam ser monitorados no ambiente de destino. O número de usuários configurado sozinho não comprova capacidade da API.

A interface fica em `127.0.0.1`; serve para uso local. Porta configurável com `PORT=3001 npm start`. Importação limitada a 5 MB. O projeto não inclui execução distribuída, controle de RPS ou agendamento recorrente.

## Validação

```bash
npm test
```

Os testes usam um servidor HTTP local e conferem carga sustentada, limite de threads, contagem exata, chamadas de scripts, falhas HTTP, assertions, timeouts, cancelamento, integridade do XLSX e cenários criados pela interface, incluindo login, extração de token e chamada autenticada.

## Dependências

A instalação usa Newman 6.2.2 no lockfile. Foi aplicada a atualização compatível de dependências; `npm audit` ainda reportou 20 vulnerabilidades transitivas (8 moderadas, 11 altas e 1 crítica). Não foi aplicado `--force`, pois a proposta do npm envolve trocar a versão principal do Newman. Importe apenas collections e scripts de origem confiável; a interface local não elimina esses problemas da dependência.
