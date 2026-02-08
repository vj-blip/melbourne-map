// Melbourne Map Voice API - Routes to Clawdbot (VJ)
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

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

async function handleVoice({ audio, text, places, filters, userLoc, hour }) {
  let transcript = text || '';
  
  // Transcribe with Whisper if audio provided
  if (audio && audio.length > 100) {
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
    
    transcript = whisperData.text || '';
    console.log('Transcript:', transcript);
  }
  
  if (!transcript) {
    return { transcript: '', response: "I didn't catch that. Try again?" };
  }
  
  console.log('Processing:', transcript);
  
  // Process with GPT-4o as VJ
  const systemPrompt = `You are VJ, Yonatan's AI assistant. You're helping him, Coral, and baby Lev (5 months) explore Melbourne.
They're staying at 1 Hotel Melbourne in Docklands, Feb 9-13.
Time now: ${hour}:00 Melbourne
Current filters: types=${filters?.types?.join(',')}, vibes=${filters?.vibes?.join(',')}

Available places:
${places?.slice(0, 15).map(p => `- ${p.name} (${p.cat}) at ${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('\n')}

Be warm, concise, and helpful. Reply in 1-2 sentences.
If suggesting a specific place, add on a new line: COMMAND:{"action":"flyTo","lat":NUMBER,"lng":NUMBER}
If suggesting filtering: COMMAND:{"action":"filter","types":["cafe"],"vibes":["chill"]}`;

  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 250,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript }
    ]
  }));
  
  let response = gptData.choices?.[0]?.message?.content || "I'm here! What would you like to explore?";
  console.log('Response:', response);
  
  // Extract command
  let command = null;
  const cmdMatch = response.match(/COMMAND:(\{.+\})/);
  if (cmdMatch) {
    try {
      command = JSON.parse(cmdMatch[1]);
      response = response.replace(/\n?COMMAND:\{.+\}/, '').trim();
    } catch (e) {
      console.error('Failed to parse command:', e);
    }
  }
  
  return { transcript, response, command };
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Melbourne Map Voice API on port ${PORT}`);
  console.log('OpenAI key:', OPENAI_KEY ? '✓' : '✗');
});
