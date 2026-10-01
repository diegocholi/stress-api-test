# Graph Report - stress-api-test  (2026-10-01)

## Corpus Check
- Corpus is ~1,997 words - fits in a single context window. You may not need a graph.

## Summary
- 60 nodes · 69 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Metadados e scripts npm
- Estratégias de carga documentadas
- Infraestrutura do runner
- Ferramentas e modelos alternativos
- Controle de usuários virtuais
- Dependências do projeto
- Estatísticas e resumo
- Execução e dados dinâmicos

## God Nodes (most connected - your core abstractions)
1. `Load runner` - 11 edges
2. `spawnVU()` - 5 edges
3. `scaleTo()` - 5 edges
4. `Migração para ferramentas dedicadas` - 4 edges
5. `printSnapshot()` - 3 edges
6. `runOnce()` - 3 edges
7. `scripts` - 3 edges
8. `Newman` - 3 edges
9. `Postman collection` - 3 edges
10. `pushSamplesSafe()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `Newman` --references--> `Postman collection`  [EXTRACTED]
  README.md → README.md  _Bridges community 1 → community 3_

## Import Cycles
- None detected.

## Communities (9 total, 1 thin omitted)

### Community 0 - "Metadados e scripts npm"
Cohesion: 0.14
Nodes (13): author, description, keywords, license, main, name, scripts, start (+5 more)

### Community 1 - "Estratégias de carga documentadas"
Cohesion: 0.15
Nodes (14): Closed model por VUs, Dados dinâmicos por VU e iteração, Escala horizontal de geradores, Keep-Alive e reuso de conexões, Load runner, Rampa de carga por stages, Newman, Node.js 18+ (+6 more)

### Community 2 - "Infraestrutura do runner"
Cohesion: 0.18
Nodes (10): fs, metrics, newman, os, path, sampleBuffer, { Worker, isMainThread, parentPort, workerData }, ref_fs (+2 more)

### Community 3 - "Ferramentas e modelos alternativos"
Cohesion: 0.40
Nodes (6): Artillery, Migração para ferramentas dedicadas, JMeter e Gatling, k6, Open model por RPS, Postman collection

### Community 4 - "Controle de usuários virtuais"
Cohesion: 0.50
Nodes (4): pushSamplesSafe(), runStages(), scaleTo(), spawnVU()

### Community 5 - "Dependências do projeto"
Cohesion: 0.50
Nodes (4): dependencies, async, newman, path

### Community 6 - "Estatísticas e resumo"
Cohesion: 0.67
Nodes (3): printSnapshot(), pxx(), summarizeAndExit()

### Community 7 - "Execução e dados dinâmicos"
Cohesion: 0.67
Nodes (3): pushLatency(), runOnce(), vuVars()

## Knowledge Gaps
- **24 isolated node(s):** `path`, `os`, `fs`, `{ Worker, isMainThread, parentPort, workerData }`, `newman` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 35 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `newman` connect `Metadados e scripts npm` to `Infraestrutura do runner`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **Why does `path` connect `Metadados e scripts npm` to `Infraestrutura do runner`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **What connects `path`, `os`, `fs` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Metadados e scripts npm` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
## Extraction integrity notes

- 3 dangling-endpoint edges, 2 self-loop edges, and 3 undirected same-endpoint collapsed edges were flagged by diagnostics. Graph remains usable with these limitations.
- Semantic agent token usage is unavailable: the collaboration tool exposes no usage field. The zero token counts above are placeholders, not a measured zero cost.
