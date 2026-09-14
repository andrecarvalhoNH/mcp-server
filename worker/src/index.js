// ─────────────────────────────────────────────────────────────────────────────
// Nutrihouse MCP — Cloudflare Worker (port do mcp.js para o runtime de Workers)
//
// Diferenças em relação ao servidor Node:
//   • Sem Express/https/fs/axios/pfx — TLS é da Cloudflare, HTTP via fetch handler.
//   • MILVUS_TOKEN e MCP_AUTH_TOKEN são secrets (wrangler secret put ...).
//   • Cache de 5 min via Cache API (isolates não compartilham memória).
//   • /mcp é público → exige Authorization: Bearer <MCP_AUTH_TOKEN>.
//
// A lógica das tools espelha mcp.js (mantenha os dois em sincronia).
// ─────────────────────────────────────────────────────────────────────────────

import PANEL_HTML from "../dashboard.html";

const MILVUS_URL = "https://apiintegracao.milvus.com.br/api/relatorio-personalizado/exportar";
const CACHE_TTL = 300; // segundos

function anoMinimo(env) {
  return Number(env.ANO_MINIMO) || 2025;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

// Tokeniza o CSV inteiro respeitando ; aspas escapadas ("") e quebras de linha
// dentro de aspas (ex.: descrição do chamado).
function parsearCSV(texto) {
  const registros = [];
  let campos = [];
  let atual = "";
  let dentroAspas = false;
  const t = String(texto).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      if (dentroAspas && t[i + 1] === '"') { atual += '"'; i++; }
      else dentroAspas = !dentroAspas;
    } else if (c === ";" && !dentroAspas) {
      campos.push(atual.trim()); atual = "";
    } else if (c === "\n" && !dentroAspas) {
      campos.push(atual.trim()); registros.push(campos); campos = []; atual = "";
    } else {
      atual += c;
    }
  }
  if (atual.length > 0 || campos.length > 0) { campos.push(atual.trim()); registros.push(campos); }
  return registros;
}

function parseDateBR(str) {
  if (!str || str === "Não possui") return null;
  const [dataPura] = String(str).trim().split(" ");
  const [d, m, y] = dataPura.split("/");
  if (!d || !m || !y) return null;
  const dt = new Date(+y, +m - 1, +d);
  return isNaN(dt.getTime()) ? null : dt;
}

// Parse + filtro ANO_MINIMO (criação OU solução >= ano).
function montarLinhas(csvTexto, ANO_MINIMO) {
  const registros = parsearCSV(String(csvTexto).trim());
  if (registros.length === 0) return [];
  const headers = registros[0];
  const rows = registros.slice(1).map(vals =>
    Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]))
  );
  return rows.filter(r => {
    const dc = parseDateBR(r["DATA DE CRIAÇÃO DO TICKET"]);
    const ds = parseDateBR(r["DATA DA SOLUÇÃO"]);
    return (dc && dc.getFullYear() >= ANO_MINIMO) || (ds && ds.getFullYear() >= ANO_MINIMO);
  });
}

async function buscarCSV(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://mcp-cache.local/milvus-csv");
  const hit = await cache.match(cacheKey);
  let texto;
  if (hit) {
    texto = await hit.text();
  } else {
    const resp = await fetch(MILVUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": env.MILVUS_TOKEN },
      body: JSON.stringify({ nome: "Milvus", tipo: "csv" }),
    });
    if (!resp.ok) throw new Error(`Milvus respondeu HTTP ${resp.status}`);
    texto = await resp.text();
    const paraCache = new Response(texto, {
      headers: { "Cache-Control": `max-age=${CACHE_TTL}`, "Content-Type": "text/csv" },
    });
    ctx.waitUntil(cache.put(cacheKey, paraCache));
  }
  return montarLinhas(texto, anoMinimo(env));
}

// ── Intervalos ───────────────────────────────────────────────────────────────

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
  const fim = new Date(ano, mes, 0, 23, 59, 59, 999);
  return { ini, fim, rotulo: `${String(mes).padStart(2, "0")}/${ano}` };
}

function filtrarFinalizados(rows, args) {
  const { ini, fim, rotulo } = resolverIntervalo(args);
  const enc = rows.filter(r => {
    const d = parseDateBR(r["DATA DA SOLUÇÃO"]);
    return d && d >= ini && d <= fim && r["TICKET CONCILIADO"] === "Não";
  });
  return { enc, rotulo };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const txt = obj => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

function handleResumoPeriodo(args, rows) {
  const { enc, rotulo } = filtrarFinalizados(rows, args);
  const reabertos = enc.filter(r => r["TICKET REABERTO"] === "Sim").length;
  const unidades = [...new Set(enc.map(r => r["UNIDADE DE NEGÓCIO"]).filter(u => u && u !== "Não possui"))].length;
  return txt({ periodo: rotulo, total_finalizados: enc.length, reabertos, unidades_atendidas: unidades, total_base: rows.length });
}

function handleTicketsPorOperador(args, rows) {
  const { enc, rotulo } = filtrarFinalizados(rows, args);
  const map = {};
  enc.forEach(r => { const op = r["NOME DO OPERADOR"] || "Sem operador"; map[op] = (map[op] || 0) + 1; });
  const lista = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([nome, qtd]) => ({ nome, qtd }));
  return txt({ periodo: rotulo, total: enc.length, operadores: lista });
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
  return txt({ periodo: rotulo, total: enc.length, categorias: principais });
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
  return txt({ ano_atual, ano_passado, observacao: "Não aplica o filtro TICKET CONCILIADO — números podem divergir das tools por período.", dados: comp });
}

// ── Tools ────────────────────────────────────────────────────────────────────

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
  { name: "resumo_periodo", description: "KPIs agregados (total finalizados, reabertos, unidades atendidas). Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.", inputSchema: SCHEMA_PERIODO },
  { name: "tickets_por_operador", description: "Contagem de tickets finalizados por operador. Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.", inputSchema: SCHEMA_PERIODO },
  { name: "tickets_por_categoria", description: "Contagem de tickets finalizados por categoria principal. Aceita mês/ano ou intervalo de datas. Filtra pela DATA DA SOLUÇÃO e desconsidera tickets conciliados.", inputSchema: SCHEMA_PERIODO },
  { name: "comparativo_anual", description: "Comparativo mensal de tickets abertos x fechados entre dois anos. Retorna 12 meses. Não aplica o filtro de tickets conciliados.", inputSchema: { type: "object", required: ["ano_atual"], properties: { ano_atual: { type: "number", description: "Ano de referência (ex: 2026). O ano anterior é calculado automaticamente." } } } },
];

async function callTool(name, args, env, ctx) {
  if (!env.MILVUS_TOKEN) return { content: [{ type: "text", text: "MILVUS_TOKEN não configurado" }], isError: true };
  try {
    const rows = await buscarCSV(env, ctx);
    if (name === "resumo_periodo")        return handleResumoPeriodo(args, rows);
    if (name === "tickets_por_operador")  return handleTicketsPorOperador(args, rows);
    if (name === "tickets_por_categoria") return handleTicketsPorCategoria(args, rows);
    if (name === "comparativo_anual")     return handleComparativoAnual(args, rows);
    return { content: [{ type: "text", text: `Tool desconhecida: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
  }
}

// ── JSON-RPC (MCP) ───────────────────────────────────────────────────────────

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg, env, ctx) {
  const { id, method, params } = msg || {};
  try {
    if (method === "initialize") {
      return rpcOk(id, {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "nutrihouse-milvus", version: "2.1.0" },
      });
    }
    if (typeof method === "string" && method.startsWith("notifications/")) return null; // sem resposta
    if (method === "ping") return rpcOk(id, {});
    if (method === "tools/list") return rpcOk(id, { tools: TOOLS });
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      return rpcOk(id, await callTool(name, args || {}, env, ctx));
    }
    return rpcErr(id, -32601, `Método não encontrado: ${method}`);
  } catch (err) {
    return rpcErr(id, -32603, err.message);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Resposta no formato SSE, igual ao servidor Node (compat. com o cliente MCP).
const sse = (payload) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return json({ status: "ok" });

    // Painel HTML servido na raiz — token injetado a partir do secret (uso interno).
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = PANEL_HTML.replaceAll("__MCP_AUTH_TOKEN__", env.MCP_AUTH_TOKEN || "");
      return new Response(html, { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404);

    // Autenticação por token no header
    const esperado = env.MCP_AUTH_TOKEN;
    const recebido = request.headers.get("authorization") || "";
    if (!esperado || recebido !== `Bearer ${esperado}`) {
      return json({ error: "unauthorized" }, 401);
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try { body = await request.json(); }
    catch { return sse(rpcErr(null, -32700, "Parse error")); }

    const res = await handleRpc(body, env, ctx);
    if (res === null) return new Response(null, { status: 202, headers: CORS }); // notificação
    return sse(res);
  },
};
