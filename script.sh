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
npm install --prefer-online 2>&1 | tail -3
echo "     Install selesai"
echo ""

echo ">>> 3. Build Next.js..."
npm run build 2>&1 | tail -5
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

echo ">>> 5. Restart service..."
systemctl restart 9router-auzt
echo "     Restart selesai"
echo ""

echo "========================================"
echo "  SELESAI!"
echo "========================================"
echo ""
systemctl status 9router-auzt --no-pager | head -8
