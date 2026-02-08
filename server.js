// Melbourne Map Voice API - GPT-4o as VJ with Melbourne knowledge
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
  res.end('Melbourne Map Voice API');
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
  
  // Full places with hours
  const fullPlaces = [
    { name:"Vue de monde", cat:"dining", lat:-37.8187, lng:144.9576, hours:[18,23], vibes:"bougie,romantic", desc:"55th floor tasting menus" },
    { name:"San Telmo", cat:"dining", lat:-37.8122, lng:144.9724, hours:[12,23], vibes:"energetic,bougie", desc:"Argentinian steaks, laneway" },
    { name:"Philippe", cat:"dining", lat:-37.8148, lng:144.9701, hours:[12,22], vibes:"romantic,bougie", desc:"French elegance, raw bar" },
    { name:"Gimlet", cat:"dining", lat:-37.8159, lng:144.9693, hours:[17,24], vibes:"bougie,chill", desc:"Oysters, caviar, cocktails" },
    { name:"Donovans", cat:"dining", lat:-37.8685, lng:144.9751, hours:[12,22], vibes:"family,chill", desc:"Beach vibes, St Kilda" },
    { name:"Roule Galette", cat:"cafe", lat:-37.8167, lng:144.9663, hours:[8,16], vibes:"chill,romantic", desc:"French creperie, cosy" },
    { name:"Hardware Société", cat:"cafe", lat:-37.8200, lng:144.9567, hours:[7,15], vibes:"energetic,bougie", desc:"Famous French toast" },
    { name:"Flour Child", cat:"cafe", lat:-37.8252, lng:144.9979, hours:[7,15], vibes:"chill,family", desc:"Amazing pastries" },
    { name:"Royal Botanic Gardens", cat:"walk", lat:-37.8302, lng:144.9801, hours:[7,20], vibes:"chill,family,romantic", desc:"36 hectares, pram-perfect" },
    { name:"Fitzroy Gardens", cat:"walk", lat:-37.8127, lng:144.9801, hours:[6,21], vibes:"chill,family", desc:"Historic gardens, Cook's Cottage" },
    { name:"Brighton Beach", cat:"walk", lat:-37.9180, lng:144.9868, hours:[0,24], vibes:"family,chill", desc:"Iconic colourful bathing boxes" },
    { name:"St Kilda Beach", cat:"walk", lat:-37.8679, lng:144.9740, hours:[0,24], vibes:"chill,family", desc:"Penguins at sunset, Luna Park" },
    { name:"Good Times Pilates", cat:"fitness", lat:-37.8054, lng:144.9753, hours:[6,20], vibes:"energetic,bougie", desc:"THE hype reformer studio" },
    { name:"Upstate Studios", cat:"fitness", lat:-37.7983, lng:144.9768, hours:[6,20], vibes:"energetic,bougie", desc:"Coolest fitness studio" },
    { name:"Melbourne Museum", cat:"see", lat:-37.8033, lng:144.9717, hours:[9,17], vibes:"family", desc:"Dinosaurs, great with baby" },
    { name:"NGV International", cat:"see", lat:-37.8226, lng:144.9689, hours:[10,17], vibes:"chill,romantic", desc:"World-class art museum" },
    { name:"South Melbourne Market", cat:"see", lat:-37.8320, lng:144.9559, hours:[8,16], vibes:"family,chill", desc:"Foodie heaven, dim sims" },
  ];
  
  // What's open now
  const openNow = fullPlaces.filter(p => {
    if (p.hours[0] === 0 && p.hours[1] === 24) return true;
    let h = hour;
    let open = p.hours[0], close = p.hours[1];
    if (close < open) close += 24;
    if (h < open && close > 24) h += 24;
    return h >= open && h < close;
  });

  const systemPrompt = `You are VJ, Yonatan's AI assistant. You're warm, helpful, and concise.
  
CONTEXT:
- Family: Yonatan, Coral (wife), baby Lev (5.5 months)
- Staying: 1 Hotel Melbourne, Docklands, Feb 9-13
- Time now: ${hour}:00 Melbourne (${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'})

PLACES OPEN NOW (${openNow.length}):
${openNow.map(p => `• ${p.name} (${p.cat}) - ${p.desc} [${p.vibes}]`).join('\n')}

ALL PLACES WITH COORDINATES:
${fullPlaces.map(p => `• ${p.name}: lat=${p.lat}, lng=${p.lng} (open ${p.hours[0]}:00-${p.hours[1]}:00)`).join('\n')}

RULES:
1. Be conversational and warm - 1-2 sentences max
2. You KNOW opening hours - use them!
3. When suggesting a place, ALWAYS add on a new line: COMMAND:{"action":"flyTo","lat":NUMBER,"lng":NUMBER,"name":"Place"}
4. For filtering: COMMAND:{"action":"filter","types":["cafe"],"vibes":["chill"]}
5. Baby-friendly suggestions are great (Lev is 5.5 months)`;

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
  const cmdMatch = response.match(/COMMAND:(\{[^}]+\})/);
  if (cmdMatch) {
    try {
      command = JSON.parse(cmdMatch[1]);
      response = response.replace(/\n?COMMAND:\{[^}]+\}/, '').trim();
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
});
