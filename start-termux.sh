#!/bin/bash
# AI Hub - Phone Server (Termux)
# Install: pkg install nodejs git
# Run: bash start-termux.sh

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║     AI HUB - Phone Server Mode           ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Check node
if ! command -v node &> /dev/null; then
    echo "[1/3] Installing Node.js..."
    pkg update -y
    pkg install -y nodejs
fi

echo "[2/3] Setting up AI Hub..."
mkdir -p ~/ai-hub/data
cd ~/ai-hub

# Create server if not exists
if [ ! -f server.js ]; then
    echo "Creating server..."
    cat > package.json << 'PKGJSON'
{
  "name": "ai-hub",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5"
  }
}
PKGJSON
    npm install 2>/dev/null
    echo "Server files need to be copied from PC."
    echo "Run on PC: adb push ai-hub/ /sdcard/ai-hub/"
    echo "Then in Termux: cp -r /sdcard/ai-hub/* ~/ai-hub/"
fi

echo "[3/3] Starting AI Hub..."
PORT=8765 node server.js
