require("dotenv").config();
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");

const TOKEN = process.env.MILVUS_TOKEN;
let cacheCSV = null;
let cacheTime = 0;
const CACHE_MS = 5 * 60 * 1000;

// Divide uma linha CSV respeitando campos entre aspas duplas e ; interno
function parseLinhaCSV(linha) {
  const campos = [];
  let atual = "";
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (dentroAspas && linha[i + 1] === '"') { atual += '"'; i++; }
      else dentroAspas = !dentroAspas;
    } else if (c === ";" && !dentroAspas) {
      campos.push(atual.trim());
      atual = "";
    } else {
      atual += c;
    }
  }
  campos.push(atual.trim());
  return campos;
}

async function buscarCSV() {
  const agora = Date.now();
  if (cacheCSV && (agora - cacheTime) < CACHE_MS) return cacheCSV;

  const resp = await axios.post(
    "https://apiintegracao.milvus.com.br/api/relatorio-personalizado/exportar",
    { nome: "Milvus", tipo: "csv" },
    { headers: { "Content-Type": "application/json", "Authorization": TOKEN }, timeout: 30000 }
  );

  const linhas = resp.data.replace(/\r/g, "").trim().split("\n");
  const headers = parseLinhaCSV(linhas[0]);
  const rows = linhas.slice(1).map(linha => {
    const vals = parseLinhaCSV(linha);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });

  cacheCSV = rows;
  cacheTime = agora;
  return rows;
}

// ── Datas e intervalos ────────────────────────────────────────────────────────

/**
 * Converte data BR ("DD/MM/AAAA" ou "DD/MM/AAAA HH:MM") em Date no fuso local.
 * Retorna null para vazio, "Não possui" ou formato inválido.
 */
function parseDateBR(str) {
  if (!str || str === "Não possui") return null;
  const [dataPura] = String(str).trim().split(" ");
  const [d, m, y] = dataPura.split("/");
  if (!d || !m || !y) return null;
  const dt = new Date(+y, +m - 1, +d);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Resolve os argumentos recebidos em um intervalo [ini, fim] com rótulo textual.
 * Aceita mes/ano (mês inteiro) ou data_inicio/data_fim (DD/MM/AAAA).
 * Lança erro descritivo quando os argumentos são inconsistentes.
 */
function resolverIntervalo(args = {}) {
  const { mes, ano, data_inicio, data_fim } = args;

  if (data_inicio || data_fim) {
    if (!data_inicio || !data_fim) throw new Error("Informe data_inicio E data_fim (DD/MM/AAAA).");
    const ini = parseDateBR(data_inicio);
    const fim = parseDateBR(data_fim);
    if (!ini) throw new Error(`data_inicio inválida: ${data_inicio}. Use DD/MM/AAAA.`);
    if (!fim) throw new Error(`data_fim inválida: ${data_fim}. Use DD/MM/AAAA.`);
    if (ini > fim) throw new Error("data_inicio não pode ser maior que data_fim.");
    fim.setHours(23, 59, 59, 999);
    return { ini, fim, rotulo: `${data_inicio} a ${data_fim}` };
  }

  if (typeof mes !== "number" || typeof ano !== "number") {
    throw new Error("Informe mes/ano ou data_inicio/data_fim.");
  }
  if (mes < 1 || mes > 12) throw new Error(`Mês inválido: ${mes}. Use 1-12.`);

  const ini = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0, 23, 59, 59, 999); // dia 0 do mês seguinte = último dia do mês
  return { ini, fim, rotulo: `${String(mes).padStart(2, "0")}/${ano}` };
}

/**
 * Filtra tickets finalizados e não conciliados dentro do intervalo resolvido.
 * Centraliza o critério compartilhado pelas tools de análise por período.
 */
function filtrarFinalizados(rows, args) {
  const { ini, fim, rotulo } = resolverIntervalo(args);
  const enc = rows.filter(r => {
    const d = parseDateBR(r["DATA DA SOLUÇÃO"]);
    return d && d >= ini && d <= fim && r["TICKET CONCILIADO"] === "Não";
  });
  return { enc, rotulo };
}

// ── Handlers das tools ────────────────────────────────────────────────────────

function handleResumoPeriodo(args, rows) {
  const { enc, rotulo } = filtrarFinalizados(rows, args);
  const reabertos = enc.filter(r => r["TICKET REABERTO"] === "Sim").length;
  const unidades = [...new Set(enc.map(r => r["UNIDADE DE NEGÓCIO"]).filter(u => u && u !== "Não possui"))].length;
  return {
    content: [{ type: "text", text: JSON.stringify({
      periodo: rotulo,
      total_finalizados: enc.length,
      reabertos,
      unidades_atendidas: unidades,
      total_base: rows.length,
    })}],
  };
}

function handleTicketsPorOperador(args, rows) {
  const { enc, rotulo } = filtrarFinalizados(rows, args);
  const map = {};
  enc.forEach(r => { const op = r["NOME DO OPERADOR"] || "Sem operador"; map[op] = (map[op] || 0) + 1; });
  const lista = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([nome, qtd]) => ({ nome, qtd }));
  return { content: [{ type: "text", text: JSON.stringify({ periodo: rotulo, total: enc.length, operadores: lista }) }] };
}

function handleTicketsPorCategoria(args, rows) {
  const { enc, rotulo } = filtrarFinalizados(rows, args);
  const map = {};
  enc.forEach(r => { const cat = (r["NOME DA CATEGORIA"] || "Sem categoria").split("/")[0].trim(); map[cat] = (map[cat] || 0) + 1; });
  const total = enc.length || 1;
  const lista = Object.entries(map).map(([cat, qtd]) => ({ cat, qtd, pct: +(qtd / total * 100).toFixed(1) })).sort((a, b) => b.qtd - a.qtd);
  const principais = lista.filter(c => c.pct >= 5);
  const outros = lista.filter(c => c.pct < 5).reduce((s, c) => s + c.qtd, 0);
  if (outros > 0) principais.push({ cat: "Outros", qtd: outros, pct: +(outros / total * 100).toFixed(1) });
  return { content: [{ type: "text", text: JSON.stringify({ periodo: rotulo, total: enc.length, categorias: principais }) }] };
}

function handleComparativoAnual(args, rows) {
  const { ano_atual } = args;
  if (typeof ano_atual !== "number") throw new Error("Informe ano_atual (ex: 2026).");
  const ano_passado = ano_atual - 1;
  const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const comp = MESES.map((mes, idx) => ({
    mes,
    abertos_atual:    rows.filter(r => { const d = parseDateBR(r["DATA DE CRIAÇÃO DO TICKET"]); return d && d.getFullYear() === ano_atual   && d.getMonth() === idx; }).length,
    abertos_passado:  rows.filter(r => { const d = parseDateBR(r["DATA DE CRIAÇÃO DO TICKET"]); return d && d.getFullYear() === ano_passado && d.getMonth() === idx; }).length,
    fechados_atual:   rows.filter(r => { const d = parseDateBR(r["DATA DA SOLUÇÃO"]);           return d && d.getFullYear() === ano_atual   && d.getMonth() === idx; }).length,
    fechados_passado: rows.filter(r => { const d = parseDateBR(r["DATA DA SOLUÇÃO"]);           return d && d.getFullYear() === ano_passado && d.getMonth() === idx; }).length,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({
      ano_atual,
      ano_passado,
      observacao: "Não aplica o filtro TICKET CONCILIADO — números podem divergir das tools por período.",
      dados: comp,
    })}],
  };
}

// ── Definição das tools ───────────────────────────────────────────────────────

// Schema compartilhado pelas tools que aceitam mês/ano OU intervalo de datas
const SCHEMA_PERIODO = {
  type: "object",
  properties: {
    mes: { type: "number", description: "Mês (1-12). Use junto com 'ano' para analisar o mês inteiro." },
    ano: { type: "number", description: "Ano (ex: 2026). Use junto com 'mes'." },
    data_inicio: { type: "string", description: "Início do intervalo no formato DD/MM/AAAA. Alternativa a mes/ano." },
    data_fim: { type: "string", description: "Fim do intervalo no formato DD/MM/AAAA. Obrigatório quando data_inicio é informado." },
  },
};

const TOOLS = [
  {
    name: "resumo_periodo",
    description: "KPIs agregados (total finalizados, reabertos, unidades atendidas). Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.",
    inputSchema: SCHEMA_PERIODO,
  },
  {
    name: "tickets_por_operador",
    description: "Contagem de tickets finalizados por operador. Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.",
    inputSchema: SCHEMA_PERIODO,
  },
  {
    name: "tickets_por_categoria",
    description: "Contagem de tickets finalizados por categoria principal. Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.",
    inputSchema: SCHEMA_PERIODO,
  },
  {
    name: "comparativo_anual",
    description: "Comparativo mensal de tickets abertos x fechados entre dois anos. Retorna 12 meses. Não aplica o filtro de tickets conciliados.",
    inputSchema: {
      type: "object",
      required: ["ano_atual"],
      properties: {
        ano_atual: { type: "number", description: "Ano de referência (ex: 2026). O ano anterior é calculado automaticamente." },
      },
    },
  },
];

// ── Fábrica: cria uma instância nova de Server por requisição ─────────────────

function createMCPServer() {
  const server = new Server(
    { name: "nutrihouse-milvus", version: "2.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!TOKEN) return { content: [{ type: "text", text: "MILVUS_TOKEN não configurado" }], isError: true };

    try {
      const rows = await buscarCSV();

      if (name === "resumo_periodo")        return handleResumoPeriodo(args, rows);
      if (name === "tickets_por_operador")  return handleTicketsPorOperador(args, rows);
      if (name === "tickets_por_categoria") return handleTicketsPorCategoria(args, rows);
      if (name === "comparativo_anual")     return handleComparativoAnual(args, rows);

      return { content: [{ type: "text", text: `Tool desconhecida: ${name}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ── HTTPS Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Nova instância de Server + Transport por requisição — evita "Already connected to a transport"
app.all("/mcp", async (req, res) => {
  try {
    const server = createMCPServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro MCP:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const pfxPath = process.env.PFX_PATH || "./certs/mcp-server.pfx";
const pfxPassphrase = process.env.PFX_PASSPHRASE;

if (!pfxPassphrase) {
  console.error("PFX_PASSPHRASE não configurado no .env");
  process.exit(1);
}

if (!fs.existsSync(pfxPath)) {
  console.error("Certificado não encontrado em:", pfxPath);
  process.exit(1);
}

const httpsOptions = {
  pfx: fs.readFileSync(pfxPath),
  passphrase: pfxPassphrase,
};

(async () => {
  https.createServer(httpsOptions, app).listen(3001, () => {
    console.log("Nutrihouse MCP Server v2.1 escutando em https://localhost:3001");
    console.log("  /mcp    — POST/GET");
    console.log("  /health — GET");
  });
})();