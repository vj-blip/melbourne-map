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
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(200); res.end('Melbourne Map Voice API');
});

async function handleVoice({ audio, places, filters, userLoc, hour }) {
  // Transcribe with Whisper
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
  if (!transcript) return { transcript: '', response: "Didn't catch that. Try again?" };
  
  // Process with GPT-4o
  const systemPrompt = `You are VJ, a helpful AI for a Melbourne trip map. Help Yonatan, Coral, and baby Lev explore.
Time: ${hour}:00 Melbourne. Places: ${places.map(p => p.name + '(' + p.cat + ')').join(', ')}

Commands (add on new line as COMMAND:{json}):
- flyTo: {"action":"flyTo","lat":NUM,"lng":NUM}
- filter: {"action":"filter","types":["cafe"],"vibes":["chill"]}

Reply in 1-2 sentences, then command if needed. Be concise and helpful.`;

  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 200,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }]
  }));
  
  let response = gptData.choices?.[0]?.message?.content || "Sorry, try again.";
  let command = null;
  const cmdMatch = response.match(/COMMAND:(\{.+\})/);
  if (cmdMatch) {
    try { command = JSON.parse(cmdMatch[1]); response = response.replace(/\n?COMMAND:.+/, '').trim(); } catch(e) {}
  }
  return { transcript, response, command };
}

function httpReq(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method, headers }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ text: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => console.log(`Voice API on port ${PORT}`));
