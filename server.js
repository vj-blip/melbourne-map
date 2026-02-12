// Melbourne Map Voice API - places + smart plans (VJ-powered via OpenClaw)
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY;
const OPENCLAW_URL = process.env.OPENCLAW_URL; // e.g. https://xxx.trycloudflare.com
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
  res.end('Melbourne Map Voice API');
});

async function generateTTS(text) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/speech', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(`data:audio/mp3;base64,${Buffer.concat(chunks).toString('base64')}`));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ model: 'tts-1', input: text, voice: 'nova', response_format: 'mp3' }));
    req.end();
  });
}

async function searchPlaces(query, lat, lng, radius = 5000) {
  const params = new URLSearchParams({
    query: query + ' Melbourne Australia',
    location: `${lat},${lng}`, radius: String(radius), key: GOOGLE_PLACES_KEY
  });
  const data = await httpReq('maps.googleapis.com', `/maps/api/place/textsearch/json?${params}`, 'GET', {});
  if (data.results) {
    return data.results.slice(0, 8).map(p => ({
      name: p.name,
      address: p.formatted_address?.replace(', Australia', '').replace(', Victoria', ', VIC'),
      lat: p.geometry.location.lat, lng: p.geometry.location.lng,
      rating: p.rating || null, reviews: p.user_ratings_total || 0,
      open: p.opening_hours?.open_now ?? null, placeId: p.place_id
    }));
  }
  return [];
}

async function handleVoice({ audio, audioType, text, userLoc, hour, visitedPlaces, currentPlan }) {
  let transcript = text || '';
  const mimeType = audioType || 'audio/webm';
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('m4a') ? 'm4a' : 'webm';
  
  if (audio && audio.length > 100) {
    console.log('Audio:', Buffer.from(audio, 'base64').length, 'bytes');
    const audioBuffer = Buffer.from(audio, 'base64');
    const boundary = '----FB' + Math.random().toString(36).slice(2);
    const formBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`)
    ]);
    const wd = await httpReq('api.openai.com', '/v1/audio/transcriptions', 'POST', {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }, formBody);
    console.log('Whisper:', JSON.stringify(wd));
    transcript = wd.text || '';
  }
  
  if (!transcript) {
    const audioUrl = await generateTTS("I didn't catch that. Hold the mic and speak clearly.");
    return { transcript: '', response: "Didn't catch that.", audioUrl, type: 'error' };
  }
  
  console.log('Query:', transcript);
  const lat = userLoc?.[0] || -37.8136;
  const lng = userLoc?.[1] || 144.9631;
  const lower = transcript.toLowerCase();
  
  // Detect if this is a plan request or plan iteration
  const isPlan = /plan|itinerary|route|schedule|day trip|what should|suggest.*day|morning.*plan|afternoon.*plan/.test(lower);
  const isPlanEdit = currentPlan && /swap|change|replace|remove|skip|add|move|earlier|later|instead/.test(lower);
  
  if (isPlan || isPlanEdit) {
    return await handlePlan(transcript, lat, lng, hour, visitedPlaces, currentPlan);
  }
  
  // Regular place search
  const placesResults = await searchPlaces(transcript, lat, lng);
  console.log('Found:', placesResults.length);
  
  const gptData = await callLLM([
    { role: 'system', content: `You are VJ, an AI assistant helping a family explore Melbourne. Name map layers and give brief spoken responses.
User: "${transcript}", Found ${placesResults.length} places: ${placesResults.slice(0,5).map(p=>p.name).join(', ')}
Reply JSON: {"layerName":"2-3 word name","response":"Brief 1-2 sentence response mentioning top places"}` },
    { role: 'user', content: transcript }
  ], 200);
  
  let layerName = transcript.slice(0, 30), response = `Found ${placesResults.length} places`;
  try {
    const c = gptData.choices?.[0]?.message?.content || '';
    const p = JSON.parse(c.replace(/```json?\n?/g,'').replace(/```/g,'').trim());
    layerName = p.layerName || layerName;
    response = p.response || response;
  } catch(e) {}
  
  const audioUrl = await generateTTS(response);
  return { transcript, response, audioUrl, layerName, places: placesResults, type: 'places' };
}

async function handlePlan(transcript, lat, lng, hour, visitedPlaces, currentPlan) {
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  // Search for diverse places
  const searches = ['cafe brunch', 'restaurant lunch', 'park garden walk baby friendly', 'things to do attraction'];
  const results = await Promise.all(searches.map(q => searchPlaces(q, lat, lng, 4000)));
  const allPlaces = results.flat();
  
  const visitedStr = visitedPlaces?.length ? `\nALREADY VISITED (exclude these): ${visitedPlaces.join(', ')}` : '';
  const currentPlanStr = currentPlan ? `\nCURRENT PLAN: ${JSON.stringify(currentPlan.stops?.map(s=>s.name))}` : '';
  
  const gptData = await callLLM([
    { role: 'system', content: `Create/modify a daily plan for a family (couple + 5.5 month baby + nanny) in Melbourne.

USER REQUEST: "${transcript}"
TIME: ${hour}:00 (${timeOfDay})
USER LOCATION: ${lat.toFixed(4)}, ${lng.toFixed(4)}
${visitedStr}
${currentPlanStr}

NEARBY PLACES:
${allPlaces.slice(0,15).map(p => `- ${p.name} (${p.rating||'?'}⭐) ${p.open===true?'OPEN':''} [${p.lat},${p.lng}] ${p.address||''}`).join('\n')}

Return JSON:
{"title":"Creative day title","summary":"1-2 sentence spoken overview","stops":[{"name":"Place","lat":NUM,"lng":NUM,"time":"9:00 AM","desc":"Why + what to do","duration":"45 min","transport":"10 min walk"}]}

RULES:
- 4-6 stops in logical geographic order (minimize travel)
- Consider walking distances (with pram!)
- Include transport method + time between stops
- Mix activities: food → explore → food → nature → activity
- Baby-friendly (pram access, not too loud, nap-friendly timing)
- Use REAL coordinates from the places list
- If editing existing plan, only change what user asked for
- Start from current time (${hour}:00)` },
    { role: 'user', content: transcript }
  ], 800);
  
  let plan = { title: "Today's Plan", stops: [], summary: '' };
  try {
    const c = gptData.choices?.[0]?.message?.content || '';
    plan = JSON.parse(c.replace(/```json?\n?/g,'').replace(/```/g,'').trim());
  } catch(e) { console.log('Plan parse error:', e.message); }
  
  const audioUrl = await generateTTS(plan.summary || `Here's your plan with ${plan.stops?.length} stops.`);
  
  return { ...plan, audioUrl, type: 'plan', transcript };
}

// Route LLM calls through OpenClaw (VJ) when available, fallback to OpenAI
// Route LLM calls through OpenClaw (VJ) with OpenAI fallback
async function callLLM(messages, maxTokens = 200) {
  if (OPENCLAW_URL && OPENCLAW_TOKEN) {
    try {
      const url = new URL('/v1/chat/completions', OPENCLAW_URL);
      const data = await httpReq(url.hostname, url.pathname, 'POST', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      }, JSON.stringify({
        model: 'openclaw:main',
        max_tokens: maxTokens,
        user: 'melbourne-map',
        messages
      }));
      if (data.choices?.[0]) return data;
      console.log('OpenClaw returned no choices, falling back to OpenAI');
    } catch (e) {
      console.log('OpenClaw error, falling back to OpenAI:', e.message);
    }
  }
  // Fallback to OpenAI directly
  return httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({ model: 'gpt-4o', max_tokens: maxTokens, messages }));
}

function httpReq(host, path, method, headers, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method, headers, timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request to ${host}${path} timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => console.log(`Voice API on port ${PORT}`));
