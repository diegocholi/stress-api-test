# Graph Report - stress-api-test  (2026-10-01)

## Corpus Check
- Corpus is ~14,137 words - fits in a single context window. You may not need a graph.

## Summary
- 390 nodes · 735 edges · 18 communities (17 shown, 1 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 45 edges (avg confidence: 0.87)
- Token cost: unavailable for session-hosted semantic extraction; recorded counters are 0 input · 0 output, not measured usage. AST extraction uses no LLM tokens.
- Graph health: 71 edges reference undeclared endpoints; 6 self-loops; 44 relations collapse in this undirected graph (41 would collapse in a directed graph). The graph remains usable, but some relationships may be incomplete or merged.

## Community Hubs (Navigation)
- Medição e avaliação
- Interface e cenários
- API e execuções
- Metodologia e funcionalidades
- Relatórios e gráficos XLSX
- Tráfego e dados sensíveis
- Dependências e comandos
- Biblioteca de testes
- Inicialização e CLI
- Testes do servidor
- Motor de carga
- Validação de cenários
- Testes do motor
- Testes de cenários
- Testes da biblioteca
- Fluxos no navegador
- Configuração do Playwright

## God Nodes (most connected - your core abstractions)
1. `buildReport()` - 18 edges
2. `Runner` - 16 edges
3. `server` - 14 edges
4. `validate()` - 13 edges
5. `TemplateStore` - 12 edges
6. `Timeline` - 11 edges
7. `loadTemplate()` - 11 edges
8. `Stress Lab` - 11 edges
9. `resetEditor()` - 10 edges
10. `accumulator()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `store()` --calls--> `TemplateStore`  [EXTRACTED]
  test/templates.test.js → lib/templates.js
- `Editor visual de requisições` --implements--> `Editor de cenários HTTP`  [INFERRED]
  public/index.html → README.md
- `Histórico e agenda na interface` --implements--> `Histórico de execuções`  [INFERRED]
  public/index.html → README.md
- `Aviso sobre modelo fechado` --conceptually_related_to--> `Evidência em usuários-segundo`  [INFERRED]
  public/index.html → README.md
- `Tabela de carga efetivamente atingida` --implements--> `Evidência em usuários-segundo`  [INFERRED]
  public/index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Aprovação sustentada por evidência e integridade** — readme_methodology_2_0, readme_load_evidence, readme_verdict, readme_record_integrity [EXTRACTED 1.00]

## Communities (18 total, 1 thin omitted)

### Community 0 - "Medição e avaliação"
Cohesion: 0.05
Nodes (57): evaluate(), lib_evaluation_methodology_version, lib_evaluation_schema_version, stageEvidence(), lib_evaluation_tool_version, {accumulator, observe, finish}, checkIntegrity(), Timeline (+49 more)

### Community 1 - "Interface e cenários"
Cohesion: 0.10
Nodes (51): addRequest(), addStage(), api(), canReplace(), clearErrors(), collectInput(), comparisonOptions, deleteTemplate() (+43 more)

### Community 2 - "API e execuções"
Cohesion: 0.09
Nodes (35): compare(), CONFIG_FIELDS, legacyInput(), generateReport(), path, {Worker}, writeJson(), body() (+27 more)

### Community 3 - "Metodologia e funcionalidades"
Cohesion: 0.08
Nodes (38): Critérios de aprovação na interface, Editor visual de requisições, Aviso sobre modelo fechado, Comparação de execuções, Tabela de carga efetivamente atingida, Iniciar agora ou agendar, Formulário de configuração, Histórico e agenda na interface (+30 more)

### Community 4 - "Relatórios e gráficos XLSX"
Cohesion: 0.09
Nodes (23): addCharts(), chartXml(), escape(), fs, {pipeline}, ref(), yauzl, yazl (+15 more)

### Community 5 - "Tráfego e dados sensíveis"
Cohesion: 0.12
Nodes (24): makeRedactor(), redactor(), sanitizeUrl(), agents, emit(), events, finish(), flush() (+16 more)

### Community 6 - "Dependências e comandos"
Cohesion: 0.09
Nodes (21): author, dependencies, exceljs, newman, yauzl, yazl, description, devDependencies (+13 more)

### Community 7 - "Biblioteca de testes"
Cohesion: 0.19
Nodes (9): countRequests(), definition(), fs, path, {randomUUID}, summary(), TemplateStore, {validate, legacyInput} (+1 more)

### Community 8 - "Inicialização e CLI"
Cohesion: 0.13
Nodes (12): ref_node_child_process, ref_node_util, {spawnSync}, assert, {execFile}, fs, http, os (+4 more)

### Community 9 - "Testes do servidor"
Cohesion: 0.14
Nodes (10): ref_node_events, assert, Excel, fs, http, {once}, os, path (+2 more)

### Community 10 - "Motor de carga"
Cohesion: 0.31
Nodes (4): Runner, fs, main(), {Runner}

### Community 11 - "Validação de cenários"
Cohesion: 0.26
Nodes (9): {compileScenario}, integer(), os, validate(), compileScenario(), jsonPath(), METHODS, text() (+1 more)

### Community 12 - "Testes do motor"
Cohesion: 0.18
Nodes (9): assert, Excel, fs, http, os, path, {Runner}, {test} (+1 more)

### Community 13 - "Testes de cenários"
Cohesion: 0.20
Nodes (8): ref_node_assert_strict, ref_node_test, assert, http, {Runner}, step, {test}, {validate}

### Community 14 - "Testes da biblioteca"
Cohesion: 0.20
Nodes (9): collection(), assert, builder, fs, os, path, store(), {TemplateStore} (+1 more)

### Community 15 - "Fluxos no navegador"
Cohesion: 0.25
Nodes (5): http, ref_node_http, @playwright/test, http, {test,expect}

### Community 16 - "Configuração do Playwright"
Cohesion: 0.40
Nodes (4): {defineConfig}, os, path, ref_node_path

## Knowledge Gaps
- **165 isolated node(s):** `http`, `CONFIG_FIELDS`, `os`, `{compileScenario}`, `{accumulator, observe, finish}` (+160 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 189 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `exceljs` connect `Dependências e comandos` to `Medição e avaliação`, `Testes do servidor`, `Relatórios e gráficos XLSX`, `Testes do motor`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `TemplateStore` connect `Biblioteca de testes` to `API e execuções`, `Testes da biblioteca`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `Runner` connect `Motor de carga` to `Medição e avaliação`, `API e execuções`, `Validação de cenários`, `Testes do motor`, `Testes de cenários`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `buildReport()` (e.g. with `workbook.js` and `finish()`) actually correct?**
  _`buildReport()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `http`, `CONFIG_FIELDS`, `os` to the rest of the system?**
  _165 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Medição e avaliação` be split into smaller, more focused modules?**
  _Cohesion score 0.051560379918588875 - nodes in this community are weakly interconnected._
- **Should `Interface e cenários` be split into smaller, more focused modules?**
  _Cohesion score 0.09941944847605225 - nodes in this community are weakly interconnected._