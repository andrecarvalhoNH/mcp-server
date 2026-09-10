# ============================================================
# Diagnóstico da API Milvus — Nutrihouse TI
# Uso: abrir no PowerShell ISE e executar (F5).
# O token é solicitado via prompt seguro (não fica em histórico).
# ============================================================

# Encoding para acentos no console do ISE
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# TLS 1.2 (a API pode rejeitar TLS antigo)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  Diagnóstico API Milvus - Nutrihouse TI"    -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. Solicita token de forma segura ----------
$secureToken = Read-Host "Cole o token Milvus (não será exibido)" -AsSecureString
$BSTR        = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$token       = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR) | Out-Null

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "Token vazio. Abortando." -ForegroundColor Red
    return
}

# ---------- 2. Configuração ----------
$url = "https://apiintegracao.milvus.com.br/api/relatorio-personalizado/exportar"
$body = @{ nome = "Milvus"; tipo = "csv" } | ConvertTo-Json
$headers = @{
    "Authorization" = $token
    "Content-Type"  = "application/json"
}

Write-Host "`n[1/3] Enviando POST para $url ..." -ForegroundColor Yellow

# ---------- 3. Requisição ----------
$startedAt = Get-Date
try {
    $resp = Invoke-WebRequest -Uri $url -Method POST -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 60
    $elapsed = (Get-Date) - $startedAt

    Write-Host ""
    Write-Host "  Status HTTP        : $($resp.StatusCode) $($resp.StatusDescription)" -ForegroundColor Green
    Write-Host "  Tempo de resposta  : $([math]::Round($elapsed.TotalSeconds,2)) s"
    Write-Host "  Bytes recebidos    : $($resp.RawContentLength)"
    Write-Host "  Content-Type       : $($resp.Headers.'Content-Type')"
    Write-Host ""

    # ---------- 4. Analisa CSV ----------
    Write-Host "[2/3] Analisando CSV..." -ForegroundColor Yellow
    $linhas = ($resp.Content -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 }
    $totalLinhas = $linhas.Count
    $totalRegistros = [Math]::Max(0, $totalLinhas - 1)  # -1 = cabeçalho

    Write-Host "  Linhas totais      : $totalLinhas"
    Write-Host "  Registros (linhas-1): $totalRegistros"

    if ($totalLinhas -gt 0) {
        Write-Host ""
        Write-Host "  Cabeçalho (primeiras colunas):" -ForegroundColor DarkGray
        Write-Host "  $($linhas[0].Substring(0, [Math]::Min(200, $linhas[0].Length)))..."
    }

    if ($totalRegistros -eq 0) {
        Write-Host ""
        Write-Host "  ATENÇÃO: CSV veio SEM registros (só cabeçalho)." -ForegroundColor Yellow
        Write-Host "  Causas possíveis:" -ForegroundColor Yellow
        Write-Host "   - Filtro do relatório 'Milvus' no painel está zerando o dataset"
        Write-Host "   - Todos os tickets foram marcados como TICKET CONCILIADO = Sim"
        Write-Host "   - Intervalo de datas do relatório está fora do escopo esperado"
    }

    # ---------- 5. Salva amostra ----------
    Write-Host ""
    Write-Host "[3/3] Salvando amostra em .\milvus_amostra.csv (10 primeiras linhas) ..." -ForegroundColor Yellow
    $amostra = ($linhas | Select-Object -First 10) -join "`r`n"
    $amostra | Out-File -FilePath ".\milvus_amostra.csv" -Encoding UTF8
    Write-Host "  Amostra salva em: $(Resolve-Path .\milvus_amostra.csv)"

    Write-Host ""
    Write-Host "===========================================" -ForegroundColor Cyan
    Write-Host "  RESULTADO" -ForegroundColor Cyan
    Write-Host "===========================================" -ForegroundColor Cyan

    if ($resp.StatusCode -eq 200 -and $totalRegistros -gt 100) {
        Write-Host "OK - Token válido e API retornando dados." -ForegroundColor Green
        Write-Host "     Se o dashboard está zerado, o problema é no SERVIDOR MCP" -ForegroundColor Green
        Write-Host "     (parsing ou filtro TICKET CONCILIADO)." -ForegroundColor Green
    }
    elseif ($resp.StatusCode -eq 200 -and $totalRegistros -eq 0) {
        Write-Host "PARCIAL - Token válido, mas dataset vazio." -ForegroundColor Yellow
        Write-Host "         Verifique o relatório 'Milvus' no painel." -ForegroundColor Yellow
    }
}
catch [System.Net.WebException] {
    $elapsed = (Get-Date) - $startedAt
    $statusCode = $null
    $respBody   = $null
    if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $respBody = $reader.ReadToEnd()
    }

    Write-Host ""
    Write-Host "  Status HTTP        : $statusCode" -ForegroundColor Red
    Write-Host "  Tempo até erro     : $([math]::Round($elapsed.TotalSeconds,2)) s"
    Write-Host "  Corpo da resposta  :" -ForegroundColor DarkGray
    if ($respBody) {
        Write-Host "  $($respBody.Substring(0, [Math]::Min(500, $respBody.Length)))"
    }

    Write-Host ""
    Write-Host "===========================================" -ForegroundColor Cyan
    Write-Host "  DIAGNÓSTICO" -ForegroundColor Cyan
    Write-Host "===========================================" -ForegroundColor Cyan
    switch ($statusCode) {
        401 { Write-Host "TOKEN INVÁLIDO OU EXPIRADO - Gerar novo no painel Milvus." -ForegroundColor Red }
        403 { Write-Host "SEM PERMISSÃO - O token não tem acesso ao relatório 'Milvus'." -ForegroundColor Red }
        404 { Write-Host "ENDPOINT NÃO ENCONTRADO - API pode ter mudado. Verificar docs." -ForegroundColor Red }
        429 { Write-Host "RATE LIMIT - Aguarde e tente novamente." -ForegroundColor Yellow }
        500 { Write-Host "ERRO NO LADO DO MILVUS - Abrir chamado com o suporte." -ForegroundColor Red }
        default { Write-Host "Erro inesperado. Ver mensagem acima." -ForegroundColor Red }
    }
}
catch {
    Write-Host ""
    Write-Host "  Erro inesperado: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Tipo: $($_.Exception.GetType().FullName)" -ForegroundColor DarkGray
}
finally {
    # Limpa token da memória
    $token = $null
    [GC]::Collect()
}

Write-Host ""
Write-Host "Fim do diagnóstico." -ForegroundColor Cyan
