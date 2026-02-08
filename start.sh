#!/bin/bash
cd /home/yonatanloewidt/clawd/melbourne-map

# Export keys
export OPENAI_API_KEY="$OPENAI_API_KEY"
export OPENCLAW_TOKEN=$(cat /home/yonatanloewidt/.openclaw/openclaw.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['gateway']['auth']['token'])")

# Kill existing
pkill -f "node server.js" 2>/dev/null
pkill -f cloudflared 2>/dev/null
sleep 2

# Start server
node server.js &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"
sleep 3

# Test server
if curl -s http://localhost:8080/ > /dev/null; then
    echo "Server OK"
else
    echo "Server FAILED"
    exit 1
fi

# Start tunnel
cloudflared tunnel --url http://localhost:8080 2>&1 | while read line; do
    echo "$line"
    if echo "$line" | grep -q "trycloudflare.com"; then
        URL=$(echo "$line" | grep -o 'https://[^[:space:]]*\.trycloudflare\.com')
        if [ -n "$URL" ]; then
            echo "TUNNEL_URL=$URL"
            # Update the HTML file
            sed -i "s|const API_BASE = .*|const API_BASE = '$URL';|" index.html
            git add index.html
            git commit -m "Update tunnel URL: $URL" 2>/dev/null
            git push origin main 2>/dev/null
            echo "Updated app with new URL"
        fi
    fi
done &

wait
