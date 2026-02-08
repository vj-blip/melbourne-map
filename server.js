// Melbourne Map Voice API - Routes to Clawdbot (VJ)
// User speaks → Whisper transcribes → Sends to VJ via OpenClaw → VJ responds

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENCLAW_URL = 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  if (req.url === '/voice' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const result = await handleVoice(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Melbourne Map Voice API - Routes to VJ (Clawdbot)');
});

async function handleVoice({ audio, places, filters, userLoc, hour }) {
  // 1. Transcribe with Whisper
  console.log('Transcribing audio...');
  const audioBuffer = Buffer.from(audio, 'base64');
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const formBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`)
  ]);
  
  const whisperData = await httpReq('api.openai.com', '/v1/audio/transcriptions', 'POST', {
    'Authorization': `Bearer ${OPENAI_KEY}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }, formBody);
  
  const transcript = whisperData.text || '';
  console.log('Transcript:', transcript);
  
  if (!transcript) {
    return { transcript: '', response: "I didn't catch that. Try again?" };
  }
  
  // 2. Format context for VJ
  const mapContext = `
[Melbourne Map Voice Command]
User said: "${transcript}"
Time: ${hour}:00 Melbourne
Location: ${userLoc ? `${userLoc[0].toFixed(4)}, ${userLoc[1].toFixed(4)}` : 'unknown'}
Filters: types=${filters?.types?.join(',')}, vibes=${filters?.vibes?.join(',')}, hours=${filters?.hours}
Places on map: ${places?.slice(0, 10).map(p => `${p.name}(${p.cat})`).join(', ')}...

Respond conversationally in 1-2 sentences. If you want to control the map, add a command on a new line:
COMMAND:{"action":"flyTo","lat":-37.xxx,"lng":144.xxx}
COMMAND:{"action":"filter","types":["cafe"],"vibes":["chill"]}
`;

  // 3. Send to VJ via OpenClaw sessions API
  console.log('Sending to VJ...');
  
  // Use sessions_spawn to get a response from VJ
  const response = await sendToVJ(mapContext);
  console.log('VJ response:', response);
  
  // 4. Parse response and extract command
  let responseText = response || "I'm here! What would you like to explore?";
  let command = null;
  
  const cmdMatch = responseText.match(/COMMAND:(\{.+\})/);
  if (cmdMatch) {
    try {
      command = JSON.parse(cmdMatch[1]);
      responseText = responseText.replace(/\n?COMMAND:\{.+\}/, '').trim();
    } catch (e) {
      console.error('Failed to parse command:', e);
    }
  }
  
  return { transcript, response: responseText, command };
}

async function sendToVJ(message) {
  // Method 1: Try OpenClaw gateway API
  try {
    const gatewayRes = await httpReqLocal(OPENCLAW_URL, '/api/sessions/spawn', 'POST', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`
    }, JSON.stringify({
      task: message,
      label: 'melbourne-map-voice',
      runTimeoutSeconds: 30,
      cleanup: 'delete'
    }));
    
    if (gatewayRes.result?.response) {
      return gatewayRes.result.response;
    }
  } catch (e) {
    console.log('Gateway API not available, using fallback');
  }
  
  // Method 2: Fallback to simple GPT response with VJ personality
  // This ensures the app works even if gateway isn't directly accessible
  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 200,
    messages: [{
      role: 'system',
      content: `You are VJ, Yonatan's AI assistant. You're helping him, Coral, and baby Lev explore Melbourne. 
You know about their trip: staying at 1 Hotel Melbourne in Docklands, Feb 9-13.
Be warm, concise, and helpful. You can suggest places and control the map.
If suggesting a specific place, include: COMMAND:{"action":"flyTo","lat":NUMBER,"lng":NUMBER}`
    }, {
      role: 'user',
      content: message
    }]
  }));
  
  return gptData.choices?.[0]?.message?.content || "I'm here! What would you like to explore?";
}

function httpReq(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch(e) { resolve({ text: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpReqLocal(baseUrl, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ text: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Melbourne Map Voice API on port ${PORT}`);
  console.log('OpenAI key:', OPENAI_KEY ? '✓' : '✗');
  console.log('OpenClaw token:', OPENCLAW_TOKEN ? '✓' : '✗');
  console.log('Routes voice commands to VJ (Clawdbot)');
});
