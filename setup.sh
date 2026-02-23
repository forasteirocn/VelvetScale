#!/bin/bash

# =============================================
# VelvetScale — Setup Automatizado
# Rode este script no Mac dedicado
# =============================================

set -e

echo ""
echo "🟣 =================================="
echo "   VelvetScale — Setup Automatizado"
echo "🟣 =================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

# =============================================
# 1. Verificar macOS
# =============================================
echo "📋 Verificando sistema..."
if [[ "$(uname)" != "Darwin" ]]; then
    fail "Este script é para macOS apenas."
fi
ok "macOS detectado"

# =============================================
# 2. Instalar Homebrew (se necessário)
# =============================================
echo ""
echo "🍺 Verificando Homebrew..."
if ! command -v brew &> /dev/null; then
    warn "Homebrew não encontrado. Instalando..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    ok "Homebrew instalado"
else
    ok "Homebrew já instalado ($(brew --version | head -1))"
fi

# =============================================
# 3. Instalar Node.js (se necessário)
# =============================================
echo ""
echo "📦 Verificando Node.js..."
if ! command -v node &> /dev/null; then
    warn "Node.js não encontrado. Instalando..."
    brew install node
    ok "Node.js instalado"
else
    NODE_VERSION=$(node --version)
    ok "Node.js já instalado ($NODE_VERSION)"
fi

# =============================================
# 4. Instalar Redis
# =============================================
echo ""
echo "🔴 Verificando Redis..."
if ! command -v redis-server &> /dev/null; then
    warn "Redis não encontrado. Instalando..."
    brew install redis
    ok "Redis instalado"
else
    ok "Redis já instalado"
fi

# Iniciar Redis como serviço
echo "   Iniciando Redis..."
brew services start redis 2>/dev/null || true
sleep 2

if redis-cli ping 2>/dev/null | grep -q "PONG"; then
    ok "Redis rodando"
else
    warn "Redis pode não estar rodando. Tentando iniciar manualmente..."
    redis-server --daemonize yes
fi

# =============================================
# 5. Instalar dependências do projeto
# =============================================
echo ""
echo "📂 Instalando dependências do projeto..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm install
ok "Dependências instaladas"

# =============================================
# 6. Instalar Playwright + Chromium
# =============================================
echo ""
echo "🌐 Instalando Playwright + Chromium..."
npx playwright install chromium
ok "Chromium instalado"

# =============================================
# 7. Verificar .env
# =============================================
echo ""
echo "🔑 Verificando configuração..."
if [ -f .env ]; then
    # Check required vars
    MISSING=0
    for VAR in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN; do
        if ! grep -q "^${VAR}=" .env || grep -q "^${VAR}=your-" .env; then
            warn "Faltando: $VAR"
            MISSING=1
        fi
    done
    if [ $MISSING -eq 0 ]; then
        ok "Todas as chaves configuradas"
    fi
else
    fail "Arquivo .env não encontrado! Copie o .env.example e preencha."
fi

# Criar symlink do .env para o worker
if [ ! -f apps/worker/.env ]; then
    ln -s ../../.env apps/worker/.env
    ok "Symlink .env → apps/worker/.env criado"
fi

# =============================================
# 8. Testar conexão
# =============================================
echo ""
echo "🧪 Testando conexões..."

# Test Redis
if redis-cli ping 2>/dev/null | grep -q "PONG"; then
    ok "Redis: conectado"
else
    warn "Redis: sem resposta"
fi

# Test Supabase
SUPABASE_URL=$(grep "^SUPABASE_URL=" .env | cut -d'=' -f2)
SUPABASE_KEY=$(grep "^SUPABASE_ANON_KEY=" .env | cut -d'=' -f2)
if [ -n "$SUPABASE_URL" ] && [ "$SUPABASE_URL" != "your-project.supabase.co" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${SUPABASE_URL}/rest/v1/" -H "apikey: ${SUPABASE_KEY}" 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        ok "Supabase: conectado"
    else
        warn "Supabase: resposta HTTP $HTTP_CODE"
    fi
fi

# Test Telegram Bot
BOT_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d'=' -f2)
if [ -n "$BOT_TOKEN" ] && [ "$BOT_TOKEN" != "your-telegram-bot-token" ]; then
    BOT_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null)
    if echo "$BOT_INFO" | grep -q '"ok":true'; then
        BOT_NAME=$(echo "$BOT_INFO" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
        ok "Telegram Bot: @${BOT_NAME}"
    else
        warn "Telegram Bot: token inválido"
    fi
fi

# =============================================
# 9. Pronto!
# =============================================
echo ""
echo "🟣 =================================="
echo "   Setup completo!"
echo "🟣 =================================="
echo ""
echo "Para iniciar o worker:"
echo "  npm run dev --workspace=apps/worker"
echo ""
echo "Para parar:"
echo "  Ctrl+C"
echo ""
echo "Para rodar em background (permanente):"
echo "  nohup npm run dev --workspace=apps/worker > worker.log 2>&1 &"
echo ""
