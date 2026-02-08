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
  
  // Full places data with hours
  const fullPlaces = [
    { name:"Vue de monde", cat:"dining", lat:-37.8187, lng:144.9576, hours:"6pm-11pm", vibes:"bougie,romantic" },
    { name:"San Telmo", cat:"dining", lat:-37.8122, lng:144.9724, hours:"12pm-11pm", vibes:"energetic,bougie" },
    { name:"Philippe", cat:"dining", lat:-37.8148, lng:144.9701, hours:"12pm-10pm", vibes:"romantic,bougie" },
    { name:"Gimlet", cat:"dining", lat:-37.8159, lng:144.9693, hours:"5pm-12am", vibes:"bougie,chill" },
    { name:"Donovans", cat:"dining", lat:-37.8685, lng:144.9751, hours:"12pm-10pm", vibes:"family,chill" },
    { name:"Roule Galette", cat:"cafe", lat:-37.8167, lng:144.9663, hours:"8am-4pm", vibes:"chill,romantic" },
    { name:"Hardware Société", cat:"cafe", lat:-37.8200, lng:144.9567, hours:"7am-3pm", vibes:"energetic,bougie" },
    { name:"Flour Child", cat:"cafe", lat:-37.8252, lng:144.9979, hours:"7am-3pm", vibes:"chill,family" },
    { name:"Royal Botanic Gardens", cat:"walk", lat:-37.8302, lng:144.9801, hours:"7am-8pm", vibes:"chill,family,romantic" },
    { name:"Brighton Beach", cat:"walk", lat:-37.9180, lng:144.9868, hours:"24h", vibes:"family,chill" },
    { name:"Good Times Pilates", cat:"fitness", lat:-37.8054, lng:144.9753, hours:"6am-8pm", vibes:"energetic,bougie" },
    { name:"Melbourne Museum", cat:"see", lat:-37.8033, lng:144.9717, hours:"9am-5pm", vibes:"family" },
    { name:"South Melbourne Market", cat:"see", lat:-37.8320, lng:144.9559, hours:"8am-4pm", vibes:"family,chill" },
  ];
  
  // Determine what's open
  const openNow = fullPlaces.filter(p => {
    if (p.hours === "24h") return true;
    const match = p.hours.match(/(\d+)(am|pm)-(\d+)(am|pm)/);
    if (!match) return true;
    let open = parseInt(match[1]) + (match[2] === 'pm' && match[1] !== '12' ? 12 : 0);
    let close = parseInt(match[3]) + (match[4] === 'pm' && match[3] !== '12' ? 12 : 0);
    if (close < open) close += 24;
    let h = hour;
    if (h < open && close > 24) h += 24;
    return h >= open && h < close;
  });

  // Process with GPT-4o as VJ
  const systemPrompt = `You are VJ, Yonatan's AI assistant helping explore Melbourne.
They're staying at 1 Hotel Melbourne (Docklands), Feb 9-13, with baby Lev (5 months).

Current time: ${hour}:00 Melbourne (${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'})

OPEN NOW (${openNow.length} places):
${openNow.map(p => `- ${p.name} (${p.cat}) - ${p.vibes} - ${p.hours}`).join('\n')}

ALL PLACES with coordinates:
${fullPlaces.map(p => `- ${p.name}: lat=${p.lat}, lng=${p.lng}, hours=${p.hours}`).join('\n')}

RULES:
- Be warm and concise (1-2 sentences)
- You KNOW which places are open now - use this info!
- When suggesting a place, ALWAYS add: COMMAND:{"action":"flyTo","lat":NUMBER,"lng":NUMBER}
- For filtering by vibe: COMMAND:{"action":"filter","vibes":["chill"]}
- For filtering by type: COMMAND:{"action":"filter","types":["cafe"]}`;

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
