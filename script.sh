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

echo ">>> 3. Build Next.js (npm run build)..."
npm run build 2>&1 | tail -5
echo "     Build selesai"
echo ""

echo ">>> 4. Copy static files ke standalone build..."
cp -r "$APP_DIR/.next/static" "$APP_DIR/.next/standalone/.next/static"
echo "     Static files copied"
echo ""

echo ">>> 5. Rebuild CLI (copy standalone ke cli/app)..."
cd "$APP_DIR/cli"
rm -rf app
cp -r "$APP_DIR/.next/standalone" app
echo "     CLI app siap"
echo ""

echo ">>> 6. Restart service 9router-auzt..."
systemctl restart 9router-auzt
echo "     Restart selesai"
echo ""

echo "========================================"
echo "  SELESAI! 9Router-auzt sudah di-update"
echo "========================================"
echo ""
systemctl status 9router-auzt --no-pager | head -8
