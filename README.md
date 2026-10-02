# Stress Lab 2 · k6

Criação visual de jornadas HTTP/HTTPS, execução local com k6, agenda, evidências e relatórios XLSX. A interface usa Node.js; o tráfego é produzido por um processo k6 separado. Postman/Newman foram descontinuados.

## Iniciar

Requer Node.js 22+ e k6 2.x. Instale uma distribuição oficial do k6 conforme https://grafana.com/docs/k6/latest/set-up/install-k6/. O projeto não baixa nem instala o binário automaticamente. Use `K6_BIN=/caminho/do/k6` quando ele não estiver no PATH.

```bash
npm start
```

Abra http://127.0.0.1:3000. Dependências Node ausentes são instaladas pelo comando inicial. Para outra porta, use `PORT=3001 npm start`. O servidor informa a versão do k6 na configuração e dá uma mensagem acionável quando o binário está ausente.

## Criar uma jornada

O editor possui lista acessível por teclado e fluxograma com organização automática, seleção, zoom, desfazer e refazer. A ordem da árvore define a execução; posições visuais não alteram o cenário. Configure **Cenário → Carga → Critérios → Revisão**.

Blocos disponíveis:

- **Requisição:** método, URL, headers, JSON/texto/formulário, múltiplas validações e extrações, timeout próprio e até cinco novas tentativas.
- **Condição:** variável, operador e caminhos verdadeiro/falso.
- **Repetição:** quantidade, itens de um array ou condição; limite obrigatório de 1–1000. O editor não aceita ciclos livres.
- **Pausa:** duração fixa ou intervalo aleatório, até 60 segundos.
- **Grupo:** reúne passos e mede sua duração como uma transação.

O seletor de fases oferece preparação global, preparação por usuário, jornada e limpeza global. Preparação por usuário acontece uma vez para cada VU utilizado. Sessões não são compartilhadas entre usuários. A limpeza global recebe somente os dados da preparação global; não recebe o estado privado de cada usuário. Encerramento forçado pode impedir a limpeza e deixa a execução parcial.

Variáveis iniciais usam uma linha `NOME=valor`. Nas requisições, escreva `{{TOKEN}}`, `{{ITEM.id}}` ou `{{INDEX}}`. Extrações mantêm tipos JSON. Em loops de itens, `ITEM` representa o item e `INDEX` seu índice. Valores inseridos em corpos JSON são escapados e serializados, incluindo aspas em textos e números fora de aspas.

Dados CSV/JSON permitem selecionar uma linha por usuário ou por iteração. CSV tem cabeçalho; JSON é um array de objetos. Escolha explicitamente falhar ou reutilizar linhas quando os dados acabarem. Até 10.000 linhas e 5 MB por arquivo.

A jornada para ao falhar por padrão. Desmarque a opção para continuar. Falhas de tentativas anteriores permanecem registradas, inclusive quando uma nova tentativa funciona. Headers e valores de variáveis não aparecem nos relatórios; marque extrações sensíveis para ocultar valores no diagnóstico funcional. Tokens e credenciais conhecidos também são ocultados.

**Validar configuração** não faz tráfego. **Executar uma vez** usa um VU e uma jornada, exibe os passos percorridos e não comprova capacidade de carga. Condições não percorridas e passos interrompidos aparecem como ignorados.

## Carga e metodologia 4.0

Perfis: carga constante, stress progressivo, pico e longa duração. Estágios podem ser degraus ou rampas. Degraus são compilados com transições de 1 ms, descontadas da duração do estágio. Modelos:

- **Usuários concorrentes:** cada VU repete uma jornada. A API mais lenta reduz a taxa de novas jornadas.
- **Taxa de chegada:** controla inícios de jornadas/s. Uma jornada com três chamadas não equivale a três chegadas. O k6 registra iterações descartadas quando faltam VUs.

O limite continua em 500 VUs simultâneos. Preparação, aquecimento e limpeza ficam fora dos critérios de performance. Drenagem permite concluir jornadas iniciadas, dentro do prazo configurado. A geração XLSX acontece após a medição.

A metodologia separa:

- **Duração HTTP:** `http_req_duration` do k6, envio + espera + recebimento; exclui DNS, abertura de conexão e TLS.
- **Tempo total da chamada:** relógio do wrapper, incluindo preparação de conexão e execução da chamada.
- **Duração da jornada/bloco:** inclui requisições, processamento e pausas internas; pausa entre jornadas fica fora dessa duração.
- **Sucesso HTTP:** resposta conforme o status configurado ou, na ausência de regra, HTTP abaixo de 400, sem erro de transporte.
- **Sucesso funcional:** validações e extrações obrigatórias aprovadas e jornada concluída sem falha.

Todas as tentativas, incluindo redirects e novas tentativas, são registradas. Percentis usam nearest rank em histograma de 1 ms; HTTP tem teto de 600.000 ms, jornadas não. Somente respostas com latência entram nos percentis HTTP; timeouts sem resposta entram nas falhas. Percentis não são médias de percentis.

A carga concorrente é conferida pela integração de observações de VUs ativos da API local do k6, consultada a cada 100 ms. Lacunas iniciais não são preenchidas. Essa evidência é amostrada, não equivale a requisições simultâneas. Em chegada, o planejamento usa o integral do perfil arredondado para cima, compatível com partidas na origem; inícios e descartes reais são registrados separadamente.

CPU e memória dos processos Node e k6 ajudam a identificar interferência do gerador; não medem a API. A CPU do k6 é obtida com `ps` em macOS/Linux e pode estar indisponível. Três observações consecutivas de atraso do coletor acima do limite configurado tornam a evidência inconclusiva. O detector não prova ausência de interferência; consulte a calibração.

Resultados:

- **Aprovado:** execução final, carga/amostra suficientes, critérios cumpridos e registros íntegros.
- **Reprovado:** evidência suficiente, mas falha de performance ou funcional.
- **Inconclusivo:** amostra/carga insuficientes ou interferência detectada do coletor.
- **Parcial:** cancelamento, interrupção ou divergência/perda de registros.

Defaults: p95 HTTP 1000 ms, falhas HTTP 1%, 100 respostas por estágio e cumprimento mínimo de carga 90%. Há p95 opcional por passo e por jornada. A verificação funcional usa prazo máximo de 24 horas do executor quando não há prazo próprio. Volume mínimo não garante confiança estatística. Histórico anterior conserva sua metodologia; repetir um teste convertido cria uma nova execução 4.0, identificada como k6. Comparações entre metodologias/motores recebem ressalvas.

## Biblioteca e migração

Testes, agenda, histórico e configurações privadas ficam em `.runs/`, fora do Git. Salvar e carregar não executa a API. Há controle de revisão para evitar sobrescritas entre abas. Uma execução roda por vez; agendamentos entram na fila e exigem que o servidor esteja ligado.

Definições antigas compatíveis são convertidas ao carregar: requisições, variáveis/environment, bearer e verificações simples de status. O formato do editor anterior preserva suas extrações e validações. Scripts Postman arbitrários, autenticações não reconhecidas e corpos não suportados geram diagnóstico e bloqueiam a conversão. Originais são preservados. A conversão não tenta executar scripts para descobrir seu efeito.

Agendamentos incompatíveis ficam em `migration-required`, sem execução automática. Histórico e XLSX antigos continuam disponíveis. Para diagnosticar uma definição, envie-a a `POST /api/migrate`; a resposta traz `compatible`, `issues`, `warnings` e, quando possível, `definition`. Isso é uma ferramenta de migração, não um novo modo Postman.

## Resultados e XLSX

A interface oferece resumo, jornadas/passos, carga/gerador e eventos de falha. A comparação possui download XLSX separado, com métricas e diferenças de configuração, inclusive após a retenção dos eventos detalhados. Eventos podem ser filtrados por passo; o diagnóstico funcional inclui extrações com valores sensíveis ocultos.

XLSX inclui **Resumo, Configuração, Fluxo, Passos, Jornadas, Cenários, Gerador, Estágios, Endpoints, Evolução, HTTP, Usuários, Critérios, Integridade, Validações, Falhas e Requisições**, com gráficos editáveis, filtros e cabeçalhos congelados. Abas detalhadas são divididas automaticamente no limite do Excel; nenhuma tentativa é amostrada para caber no relatório. Requisições possuem IDs de jornada, passo e tentativa, fase, estágio e timings HTTP/total/TTFB/conexão/TLS.

A avaliação e as agregações são compartilhadas pela tela e pelo XLSX. Eventos detalhados comprimidos são preservados por sete dias e verificados por SHA-256. **Regenerar XLSX** não executa a API. Perda de eventos, divergência com contadores nativos do k6, sequências inválidas e encerramentos pendentes impedem aprovação.

## CLI e API

```bash
npm run demo:target
node load-runner.js --scenario=examples/native-flow.json --xlsx=relatorio.xlsx
```

CLI aceita `--stages`, `--loadModel`, `--timeout`, `--minResponses`, `--minLoadPercent`, `--p95` e `--errorRate` como overrides. Retorna 0 somente para execução concluída/aprovada com XLSX gerado. `--collection` e `--environment` foram retirados.

Rotas existentes de execução, biblioteca, agenda, comparação, séries, repetição e regeneração continuam disponíveis. Novas interfaces:

| Rota | Resultado |
|---|---|
| `GET /api/engine` | Disponibilidade e versão do k6 |
| `POST /api/migrate` | Diagnóstico e conversão conservadora |
| `POST /api/validate` | Validação sem tráfego; erro com `nodeId`, `field` e índice quando aplicável |
| `GET /api/runs/:id/events?page=1&pageSize=50&nodeId=id&type=request&stage=1` | Eventos paginados; limite 100 por página |

Definições novas têm `schemaVersion: 4`, `engine: "k6"`, `scenario` com `setup`, `perUser`, `steps`, `teardown` e variáveis/dataset opcionais. Condições usam `condition: {variable, operator, value}` e `then`/`else`. Loops usam `mode`, `limit`, `variable` ou `condition`, e `children`. Posições visuais não fazem parte da definição executável.

## Verificação e calibração

```bash
pnpm test
pnpm test:browser
pnpm benchmark
```

No macOS, Playwright usa o Google Chrome instalado. Em outros ambientes, instale Chromium ou informe `CHROME_PATH`.

O benchmark compara cinco repetições da ferramenta e do k6 direto com cinco VUs, respostas de 100 ms e duração de 10 s. A janela estável é calculada pelo servidor independente. Compara também detalhes ligados/desligados e consulta do painel; resultados em `.runs/benchmark-k6/results.json`. Diferenças acima de 5% de throughput ou do maior entre 10% e 10 ms de p95 são sinalizadas. A calibração vale para a máquina e cenário medidos; não define capacidade de uma API externa.

Não há execução distribuída, testes browser/gRPC/WebSocket, paralelismo interno da jornada ou editor livre de scripts nesta versão. O fluxograma cobre jornadas HTTP estruturadas com condições e repetições limitadas.
