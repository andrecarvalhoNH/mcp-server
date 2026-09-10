// Testes do servidor MCP Nutrihouse-Milvus.
// Rodar: npm test        (ou: node --test)
// Teste ao vivo opcional: definir MCP_URL, ex.:
//   MCP_URL=https://192.168.0.254:3001/mcp npm test   (bash)
//   $env:MCP_URL="https://192.168.0.254:3001/mcp"; npm test   (PowerShell)
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const mcp = require("../mcp.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

// Monta um CSV (separador ;) a partir de matriz de campos, com aspas em todos.
function csv(linhas) {
  return linhas.map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

const HEADERS = [
  "NOME DO OPERADOR", "NOME DA CATEGORIA", "DESCRIÇÃO", "DATA DA SOLUÇÃO",
  "DATA DE CRIAÇÃO DO TICKET", "TICKET CONCILIADO", "TICKET REABERTO", "UNIDADE DE NEGÓCIO",
];

// Extrai o texto JSON do content[0] de um retorno de handler.
const parseHandler = ret => JSON.parse(ret.content[0].text);

// ── parsearCSV ──────────────────────────────────────────────────────────────

describe("parsearCSV", () => {
  test("separa campos simples", () => {
    const regs = mcp.parsearCSV('"a";"b";"c"');
    assert.deepEqual(regs, [["a", "b", "c"]]);
  });

  test("preserva quebra de linha DENTRO de campo entre aspas", () => {
    const texto = '"col1";"col2"\r\n"linha1\r\nlinha2";"ok"';
    const regs = mcp.parsearCSV(texto);
    assert.equal(regs.length, 2, "deve haver 2 registros (header + 1 dado)");
    assert.equal(regs[1][0], "linha1\nlinha2");
    assert.equal(regs[1][1], "ok");
  });

  test("trata aspas escapadas ('' -> \") e ; interno", () => {
    const regs = mcp.parsearCSV('"diz ""oi""";"a;b"');
    assert.deepEqual(regs, [['diz "oi"', "a;b"]]);
  });
});

// ── parseDateBR ────────────────────────────────────────────────────────────────

describe("parseDateBR", () => {
  test("converte DD/MM/AAAA HH:MM", () => {
    const d = mcp.parseDateBR("05/03/2025 14:30");
    assert.equal(d.getFullYear(), 2025);
    assert.equal(d.getMonth(), 2); // março = índice 2
    assert.equal(d.getDate(), 5);
  });

  test("retorna null para vazio, 'Não possui' e formato inválido", () => {
    assert.equal(mcp.parseDateBR(""), null);
    assert.equal(mcp.parseDateBR("Não possui"), null);
    assert.equal(mcp.parseDateBR("31-12-2025"), null);
  });
});

// ── resolverIntervalo ──────────────────────────────────────────────────────────

describe("resolverIntervalo", () => {
  test("mês/ano gera o mês inteiro", () => {
    const { ini, fim, rotulo } = mcp.resolverIntervalo({ mes: 3, ano: 2025 });
    assert.equal(rotulo, "03/2025");
    assert.equal(ini.getDate(), 1);
    assert.equal(fim.getMonth(), 2);
    assert.equal(fim.getDate(), 31); // março tem 31 dias
  });

  test("intervalo por datas", () => {
    const { rotulo } = mcp.resolverIntervalo({ data_inicio: "01/01/2025", data_fim: "31/01/2025" });
    assert.equal(rotulo, "01/01/2025 a 31/01/2025");
  });

  test("erros de validação", () => {
    assert.throws(() => mcp.resolverIntervalo({ data_inicio: "01/01/2025" }), /data_inicio E data_fim/);
    assert.throws(() => mcp.resolverIntervalo({ mes: 13, ano: 2025 }), /Mês inválido/);
    assert.throws(() => mcp.resolverIntervalo({}), /Informe mes\/ano/);
  });
});

// ── montarLinhas + filtro ANO_MINIMO ────────────────────────────────────────────

describe("montarLinhas (filtro ANO_MINIMO)", () => {
  const texto = csv([
    HEADERS,
    ["Antigo", "Redes/Wifi", "desc", "10/06/2023 10:00", "01/06/2023 09:00", "Não", "Não", "Matriz"],       // 2023 -> descarta
    ["Virada", "ERP/Financeiro", "desc", "15/01/2025 14:00", "20/12/2024 08:00", "Não", "Não", "Matriz"],    // criado 2024, solucionado 2025 -> mantém
    ["Atual", "Redes/Wifi", "linha1\r\nlinha2", "05/03/2025 09:00", "02/03/2025 08:00", "Não", "Não", "Filial"], // 2025 -> mantém
  ]);

  test(`mantém apenas ${mcp.ANO_MINIMO}+ (por criação OU solução)`, () => {
    const rows = mcp.montarLinhas(texto);
    const nomes = rows.map(r => r["NOME DO OPERADOR"]);
    assert.equal(rows.length, 2);
    assert.ok(!nomes.includes("Antigo"), "2023 deve ser descartado");
    assert.ok(nomes.includes("Virada"), "criado 2024/solucionado 2025 deve ficar");
    assert.ok(nomes.includes("Atual"), "2025 deve ficar");
  });

  test("preserva campo multilinha ao montar as linhas", () => {
    const rows = mcp.montarLinhas(texto);
    const atual = rows.find(r => r["NOME DO OPERADOR"] === "Atual");
    assert.equal(atual["DESCRIÇÃO"], "linha1\nlinha2");
  });

  test("CSV vazio retorna lista vazia", () => {
    assert.deepEqual(mcp.montarLinhas(""), []);
  });
});

// ── Handlers (dados de março/2025) ───────────────────────────────────────────────

describe("handlers", () => {
  // Ana, Bruno e Davi finalizados em 03/2025; Carlos conciliado (deve sair).
  const rows = mcp.montarLinhas(csv([
    HEADERS,
    ["Ana",    "Redes/Wifi",      "d", "05/03/2025 10:00", "02/03/2025 09:00", "Não", "Não", "Matriz"],
    ["Bruno",  "Sistemas/ERP",    "d", "10/03/2025 14:00", "01/02/2025 08:00", "Não", "Sim", "Filial A"],
    ["Carlos", "Redes/Wifi",      "d", "12/03/2025 09:00", "03/03/2025 08:00", "Sim", "Não", "Matriz"],   // conciliado -> excluído
    ["Davi",   "Redes/Cabeamento","d", "20/03/2025 09:00", "15/03/2025 08:00", "Não", "Não", "Não possui"], // unidade não conta
  ]));
  const args = { mes: 3, ano: 2025 };

  test("resumo_periodo: conciliado excluído, reabertos e unidades corretos", () => {
    const r = parseHandler(mcp.handleResumoPeriodo(args, rows));
    assert.equal(r.total_finalizados, 3); // Ana, Bruno, Davi
    assert.equal(r.reabertos, 1);          // Bruno
    assert.equal(r.unidades_atendidas, 2); // Matriz, Filial A ("Não possui" não conta)
    assert.equal(r.periodo, "03/2025");
  });

  test("tickets_por_operador: contagem e ordenação", () => {
    const r = parseHandler(mcp.handleTicketsPorOperador(args, rows));
    assert.equal(r.total, 3);
    assert.equal(r.operadores.length, 3);
    assert.ok(!r.operadores.some(o => o.nome === "Carlos"));
    assert.ok(r.operadores.every(o => o.qtd === 1));
  });

  test("tickets_por_categoria: agrupa por categoria principal com pct", () => {
    const r = parseHandler(mcp.handleTicketsPorCategoria(args, rows));
    assert.equal(r.total, 3);
    const redes = r.categorias.find(c => c.cat === "Redes");
    const sistemas = r.categorias.find(c => c.cat === "Sistemas");
    assert.equal(redes.qtd, 2);     // Ana + Davi
    assert.equal(sistemas.qtd, 1);  // Bruno
    assert.equal(redes.pct, 66.7);
  });

  test("comparativo_anual: 12 meses e conta fechados de 2025", () => {
    const r = parseHandler(mcp.handleComparativoAnual({ ano_atual: 2025 }, rows));
    assert.equal(r.ano_atual, 2025);
    assert.equal(r.ano_passado, 2024);
    assert.equal(r.dados.length, 12);
    const marco = r.dados.find(d => d.mes === "Mar");
    assert.equal(marco.fechados_atual, 4); // não aplica filtro de conciliado: Ana, Bruno, Carlos, Davi
  });

  test("comparativo_anual exige ano_atual numérico", () => {
    assert.throws(() => mcp.handleComparativoAnual({}, rows), /ano_atual/);
  });
});

// ── Definição das tools ─────────────────────────────────────────────────────────

describe("TOOLS", () => {
  test("expõe as 4 tools esperadas", () => {
    const nomes = mcp.TOOLS.map(t => t.name).sort();
    assert.deepEqual(nomes, ["comparativo_anual", "resumo_periodo", "tickets_por_categoria", "tickets_por_operador"]);
  });
});

// ── Integração ao vivo (opcional: só roda se MCP_URL estiver definido) ───────────

describe("integração ao vivo (MCP_URL)", () => {
  const URL = process.env.MCP_URL;

  test("tools/call resumo_periodo responde", { skip: URL ? false : "defina MCP_URL para rodar" }, async () => {
    // Cert self-signed do servidor local — desabilita verificação só neste teste.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const resp = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "resumo_periodo", arguments: { mes: 3, ano: 2025 } },
        }),
      });
      assert.equal(resp.ok, true, `HTTP ${resp.status}`);
      const texto = await resp.text();
      // Resposta pode vir como SSE ("data: {...}") ou JSON puro
      const linha = texto.split(/\r?\n/).map(l => l.match(/^data:\s*(.*)$/)).filter(Boolean).pop();
      const payload = JSON.parse(linha ? linha[1] : texto);
      const dados = JSON.parse(payload.result.content[0].text);
      assert.ok("total_finalizados" in dados, "deve retornar total_finalizados");
      console.log("  [ao vivo] resumo 03/2025:", dados);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });
});
