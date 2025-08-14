Pré-reqs: Node 18+, `npm i newman` (sem `async`, usamos Promises nativas).

Coloque sua collection em `postman/*.postman_collection.json` e (opcional) um environment.

## Como usar

- **Rampa de carga (stages)**: `"duracaoSeg:concorrencia"`, separados por vírgula.

  > stage: 30:200 → Durante 30 segundos, manter 200 usuários ativos em paralelo rodando sua collection Postman.

- **Exemplos:**

```bash
node load-runner.js \
  --collection=postman/autenticador.postman_collection.json \
  --environment=postman/localhost.postman_environment.json \ # [Opcional]
  --stages="30:200,60:2000,120:10000,120:20000" \
  --iters=3 \
  --timeout=60000 \
  --keepAlive=true \
  --insecure=false \
  --bail=false \
  --maxWorkers=64 \
  --quiet=true \
  --envVar="UA=<UA_DO_BROWSER>,COOKIE=<COOKIE_COPIADO>" \ # [Opcional]
  --csv=out.csv  # [Opcional]
```

> Dica: rode **vários processos** (ou containers) desse runner em máquinas diferentes para atingir 30k+ concorrentes. Use um **balanceador**/coletor (ex.: Prometheus + Pushgateway ou logs centralizados) se quiser métricas unificadas.

---

## Boas práticas para chegar em 20–30k simultâneos

1. **Open vs. Closed Model**

   - _Open (arrivals controlados por RPS)_ é melhor para saturar o sistema. Este runner simula “closed” por VUs. Para _open_, adapte para criar novos VUs continuamente por taxa pretendida (RPS).

2. **Ramp-up gradual**

   - Evita “thundering herd”. Aumente em degraus (ex. 2k → 5k → 10k → 20k).

3. **Keep-Alive + Reuso de conexões**

   - Reduz custo por request. (Ativado no script com `--keepAlive=true` por padrão).

4. **Reduza I/O**

   - Use `--quiet=true` e evite reporters verbosos. Stdout é gargalo.

5. **Dados dinâmicos**

   - Variáveis por VU/iteração (`UNIQUE_EMAIL`, `UNIQUE_ID`) para evitar cache/duplicidade do backend.

6. **Timeouts realistas**

   - `--timeout` coerente com seus SLOs. Conte timeouts como erros.

7. **Ambiente e variações**

   - Tenha environment Postman por ambiente (dev/stage/prod). Parametrize baseURL, tokens, etc.

8. **Correlação**

   - Se a collection obtém token e usa depois, mantenha as requisições na mesma execução Newman (este script faz isso). Se precisar _data feeders_ maiores, troque `iterationData` por CSV/JSON girando por VU.

9. **Escala horizontal**

   - Para 30k VUs, distribua: múltiplas VMs/containers + orquestração simples (makefile/bash) já resolve.

10. **Observabilidade**

- Colete logs/metrics do **SUT** (sistema sob teste) também: CPU, memória, fila, DB, cache, erro por rota. Os dois lados contam a história.

---

## Quando migrar para ferramentas de carga dedicadas

Se o objetivo é **controle fino de RPS**, cenários complexos, e **distribuição nativa**:

- **k6** (scripts em JS, fácil “stages” e thresholds; há conversores de collection Postman).
- **Artillery** (YAML/JS, ótimo para cenários HTTP/WebSocket; tem plugin para Postman).
- **JMeter/Gatling** (maduros, distribuídos).

Você pode manter sua collection como **fonte de verdade** e:

- Converter para k6 (há conversores de Postman → k6).
- Ou usar Artillery importando a collection.
