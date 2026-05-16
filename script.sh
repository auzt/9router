#!/bin/bash
set -e

APP_DIR="/home/agussur/9router-auzt"

echo "========================================"
echo "  9Router-auzt Update & Build Script"
echo "========================================"
echo ""

echo ">>> 1. Git pull dari fork auzt/9router..."
cd "$APP_DIR"
git pull origin master
echo "     Pull selesai"
echo ""

echo ">>> 2. npm install..."
npm install --prefer-online
echo "     Install selesai"
echo ""

echo ">>> 3. Build Next.js..."
npm run build
echo "     Build selesai"
echo ""

echo ">>> 4. Setup CLI app directory..."
cd "$APP_DIR/cli"
rm -rf app
cp -r "$APP_DIR/.next/standalone" app
cp -r "$APP_DIR/.next/static" app/.next/static
cp -r "$APP_DIR/public" app/public 2>/dev/null
echo "     CLI app siap"
echo ""

echo "========================================"
echo "  Menjalankan 9router-auzt..."
echo "  Dashboard: http://localhost:20128/dashboard"
echo "  Tekan Ctrl+C untuk berhenti"
echo "========================================"
echo ""

cd "$APP_DIR/cli"
exec node cli.js --no-browser --log
