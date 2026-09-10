# Nutrihouse MCP — Cloudflare Worker

Port do `mcp.js` (servidor Node/LAN) para **Cloudflare Workers**. Mesma lógica e mesmas 4 tools; o `mcp.js` original continua válido para uso na LAN.

## Deploy (você roda — precisa de login na conta Cloudflare)

```bash
cd worker
npm install
npx wrangler login
```

Defina os **secrets** (não vão para o git):

```bash
# Token da API Milvus (o mesmo do .env atual)
npx wrangler secret put MILVUS_TOKEN

# Token que protege o /mcp — gere um forte e guarde (usado pelo cliente MCP/dashboard)
npx wrangler secret put MCP_AUTH_TOKEN
```

Gerar um `MCP_AUTH_TOKEN` forte (PowerShell):

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Publique:

```bash
npx wrangler deploy
```

Saída: `https://nutrihouse-mcp.<seu-subdominio>.workers.dev`.

## Testar

```bash
curl https://nutrihouse-mcp.<seu-subdominio>.workers.dev/health

curl -X POST https://nutrihouse-mcp.<seu-subdominio>.workers.dev/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resumo_periodo","arguments":{"mes":3,"ano":2025}}}'
```

## Ligar o cliente MCP / dashboard

- **URL:** `https://nutrihouse-mcp.<seu-subdominio>.workers.dev/mcp`
- **Header obrigatório:** `Authorization: Bearer <MCP_AUTH_TOKEN>`
- No dashboard, altere `MCP_URL` e inclua o header `Authorization` no `fetch`.

## Config

- `ANO_MINIMO` (em `wrangler.jsonc` → `vars`): ano mínimo de corte. Padrão `2025`.
  Para editar sem redeploy do código: `npx wrangler deploy` após alterar o valor.
- Cache de 5 min do CSV via **Cache API** (por datacenter) — sem KV.

## ⚠️ Segurança do token no dashboard

Se o dashboard rodar em navegador de usuários, o `MCP_AUTH_TOKEN` embutido no JS
fica **visível** para quem abrir a página. Aceitável só para uso interno/confiável.
Para exposição ampla, prefira proteger o dashboard atrás de **Cloudflare Access**
(service token) em vez de embutir o Bearer no front.

## Notas do port

- Sem `express/https/fs/axios/pfx` — TLS é da Cloudflare, HTTP via `fetch` handler.
- Resposta em `text/event-stream` (SSE), igual ao servidor Node (compat. com o cliente MCP).
- A lógica das tools espelha `mcp.js`; ao mudar regras, atualize os dois.
