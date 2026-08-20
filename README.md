# AI Hub - Universal AI Gateway

All free AI providers, one beautiful interface.

## Features
- **14+ Providers** pre-configured (FreeLLMAPI, CLIProxyAPI, FreeDeepseekAPI, OmniRoute, Groq, Mistral, etc.)
- **Chat Interface** with auto-routing to best available provider
- **File Manager** to browse, edit, and save files
- **AI File Editor** - let AI edit your files with natural language
- **Provider Discovery** - scan all free sources daily
- **Custom Providers** - add any OpenAI-compatible endpoint
- **Mobile Friendly** - access from your phone via network IP

## Quick Start
```
# Double-click start.bat
# Or run:
node server.js
```

Dashboard: http://localhost:8765
Phone: http://YOUR-IP:8765

## Phone as Server
1. Enable WiFi Hotspot on your phone
2. Connect PC to hotspot
3. Find your phone's hotspot IP
4. Access AI Hub from any device

## API Usage
```bash
# Chat completion (auto-routes to best provider)
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# List providers
curl http://localhost:8765/api/providers

# Add custom provider
curl -X POST http://localhost:8765/api/providers/custom \
  -H "Content-Type: application/json" \
  -d '{"id":"my-api","name":"My API","url":"https://api.example.com/v1/chat/completions","key":"sk-..."}'
```

## Port
Default: 8765
Change: `PORT=9999 node server.js`
