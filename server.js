// Simple voice API server for Melbourne Map
// Run: OPENAI_API_KEY=xxx node server.js

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3847;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/voice' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await handleVoice(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  res.writeHead(200);
  res.end('Melbourne Map API');
});

async function handleVoice({ audio, places, filters, userLoc, hour }) {
  // 1. Transcribe with OpenAI Whisper
  const audioBuffer = Buffer.from(audio, 'base64');
  
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const formBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`)
  ]);
  
  const whisperData = await httpRequest({
    hostname: 'api.openai.com',
    path: '/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formBody.length
    }
  }, formBody);
  
  const transcript = whisperData.text || '';
  console.log('Transcript:', transcript);
  
  if (!transcript) {
    return { transcript: '', response: "I didn't catch that. Try again?" };
  }
  
  // 2. Process with GPT-4
  const systemPrompt = `You are VJ, a helpful AI assistant for a Melbourne trip map. You help Yonatan, Coral, and baby Lev (5 months) explore Melbourne.

Current time: ${hour}:00 Melbourne time
User location: ${userLoc ? `${userLoc[0].toFixed(4)}, ${userLoc[1].toFixed(4)}` : 'unknown'}
Active filters: types=${filters.types.join(',')}, vibes=${filters.vibes.join(',')}, hours=${filters.hours}

Available places:
${places.map(p => `- ${p.name} (${p.cat}) at ${p.lat},${p.lng}`).join('\n')}

You can control the map by returning a JSON command. Commands:
- flyTo: {"action":"flyTo","lat":NUMBER,"lng":NUMBER}
- filter: {"action":"filter","types":["dining","cafe"],"vibes":["chill"]}

Reply conversationally in 1-2 short sentences, then add command on a new line as: COMMAND:{"action":"..."}

Examples:
User: "Show me coffee shops"
Response: "Here are the best cafes! Filtering to cafes for you.
COMMAND:{"action":"filter","types":["cafe"]}"

User: "Take me to San Telmo"
Response: "San Telmo has incredible Argentinian steaks! Flying there now.
COMMAND:{"action":"flyTo","lat":-37.8122,"lng":144.9724}"

User: "What should we do?"
Response: "It's ${hour > 17 ? 'evening — perfect for dinner' : hour > 11 ? 'afternoon — great for a walk' : 'morning — time for coffee'}! I'd suggest ${hour > 17 ? 'San Telmo or Vue de monde' : hour > 11 ? 'Royal Botanic Gardens' : 'Roule Galette for crepes'}."

Be concise, warm, and helpful. Consider baby Lev for family-friendly suggestions.`;

  const gptData = await httpRequest({
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`
    }
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript }
    ]
  }));
  
  let responseText = gptData.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
  console.log('GPT:', responseText);
  
  // Extract command
  let command = null;
  const cmdMatch = responseText.match(/COMMAND:(\{.+\})/);
  if (cmdMatch) {
    try {
      command = JSON.parse(cmdMatch[1]);
      responseText = responseText.replace(/\n?COMMAND:\{.+\}/, '').trim();
    } catch (e) {}
  }
  
  return { transcript, response: responseText, command };
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ text: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Melbourne Map API running on http://0.0.0.0:${PORT}`);
  console.log('OpenAI key:', OPENAI_KEY ? '✓ set' : '✗ missing');
});
