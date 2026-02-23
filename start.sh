#!/bin/bash

# =============================================
# VelvetScale — Iniciar Worker (com auto-restart)
# Mantém o worker rodando permanentemente
# =============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🟣 VelvetScale Worker — Modo Permanente"
echo ""

# Verificar Redis
if ! redis-cli ping 2>/dev/null | grep -q "PONG"; then
    echo "🔴 Iniciando Redis..."
    brew services start redis 2>/dev/null || redis-server --daemonize yes
    sleep 2
fi

echo "✅ Redis OK"
echo "🚀 Iniciando worker..."
echo "   Ctrl+C para parar"
echo ""

# Rodar com auto-restart em caso de crash
while true; do
    npm run dev --workspace=apps/worker
    
    EXIT_CODE=$?
    echo ""
    echo "⚠️  Worker parou (exit code: $EXIT_CODE)"
    echo "🔄 Reiniciando em 5 segundos..."
    echo "   (Ctrl+C para parar de vez)"
    sleep 5
done
