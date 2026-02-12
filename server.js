// Melbourne Map Voice API - always returns places for map layers
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY;

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
  
  if (req.url === '/plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const result = await handlePlan(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Plan error:', err);
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
    location: `${lat},${lng}`,
    radius: String(radius),
    key: GOOGLE_PLACES_KEY
  });
  const data = await httpReq('maps.googleapis.com', `/maps/api/place/textsearch/json?${params}`, 'GET', {});
  if (data.results) {
    return data.results.slice(0, 8).map(p => ({
      name: p.name,
      address: p.formatted_address?.replace(', Australia', '').replace(', Victoria', ', VIC'),
      lat: p.geometry.location.lat,
      lng: p.geometry.location.lng,
      rating: p.rating || null,
      reviews: p.user_ratings_total || 0,
      open: p.opening_hours?.open_now ?? null,
      priceLevel: p.price_level ?? null,
      placeId: p.place_id
    }));
  }
  return [];
}

async function handleVoice({ audio, audioType, text, userLoc, hour }) {
  let transcript = text || '';
  const mimeType = audioType || 'audio/webm';
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('m4a') ? 'm4a' : 'webm';
  
  if (audio && audio.length > 100) {
    console.log('Audio size:', Buffer.from(audio, 'base64').length, 'bytes');
    const audioBuffer = Buffer.from(audio, 'base64');
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const formBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`)
    ]);
    const whisperData = await httpReq('api.openai.com', '/v1/audio/transcriptions', 'POST', {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }, formBody);
    console.log('Whisper:', JSON.stringify(whisperData));
    transcript = whisperData.text || '';
  }
  
  if (!transcript) {
    const audioUrl = await generateTTS("I didn't catch that. Hold the mic and speak clearly.");
    return { transcript: '', response: "I didn't catch that.", audioUrl, places: [], layerName: '' };
  }
  
  console.log('Query:', transcript);
  const lat = userLoc?.[0] || -37.8136;
  const lng = userLoc?.[1] || 144.9631;
  
  // Always search Google Places
  const placesResults = await searchPlaces(transcript, lat, lng);
  console.log('Found:', placesResults.length, 'places');
  
  // Generate layer name and spoken response
  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 200,
    messages: [
      { role: 'system', content: `You help name map layers and give brief spoken responses.
User asked: "${transcript}"
Found ${placesResults.length} places: ${placesResults.map(p => p.name).join(', ')}
Time: ${hour}:00 Melbourne

Reply with JSON only:
{"layerName":"Short 2-3 word layer name","response":"Brief spoken response (1-2 sentences, mention top 1-2 places)"}` },
      { role: 'user', content: transcript }
    ]
  }));
  
  let layerName = transcript.slice(0, 30);
  let response = `Found ${placesResults.length} places for "${transcript}"`;
  
  try {
    const content = gptData.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    layerName = parsed.layerName || layerName;
    response = parsed.response || response;
  } catch(e) {
    console.log('Parse error, using defaults');
  }
  
  const audioUrl = await generateTTS(response);
  
  return { transcript, response, audioUrl, layerName, places: placesResults };
}

async function handlePlan({ userLoc, hour }) {
  const lat = userLoc?.[0] || -37.8136;
  const lng = userLoc?.[1] || 144.9631;
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  // Search for a mix of places nearby
  const [cafes, restaurants, parks, activities] = await Promise.all([
    searchPlaces('best cafe brunch', lat, lng, 3000),
    searchPlaces('best restaurant lunch', lat, lng, 3000),
    searchPlaces('park garden walk', lat, lng, 5000),
    searchPlaces('things to do family attraction', lat, lng, 5000)
  ]);
  
  const allPlaces = [...cafes.slice(0,3), ...restaurants.slice(0,3), ...parks.slice(0,2), ...activities.slice(0,2)];
  
  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 600,
    messages: [{ role: 'system', content: `Create a daily plan for a family (couple + 5.5 month baby) in Melbourne.
Time: ${hour}:00 (${timeOfDay})
Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}

Available places:
${allPlaces.map(p => `- ${p.name} (${p.rating||'?'}⭐) at ${p.lat},${p.lng} ${p.open===true?'OPEN':''}`).join('\n')}

Return JSON only:
{"title":"Fun title for the day","summary":"Brief 1-sentence overview","stops":[{"name":"Place Name","lat":NUM,"lng":NUM,"time":"9:00 AM","desc":"Why go here, 1 sentence"}]}

Rules:
- 4-6 stops, logical route order
- Mix: coffee/brunch → activity → lunch → walk → afternoon activity
- Baby-friendly suggestions
- Use actual coordinates from the places list
- Start from ${timeOfDay === 'morning' ? 'breakfast' : timeOfDay === 'afternoon' ? 'lunch' : 'dinner'}` },
    { role: 'user', content: 'Create a plan' }]
  }));
  
  let plan = { title: "Today's Plan", stops: [], summary: '' };
  try {
    const content = gptData.choices?.[0]?.message?.content || '';
    plan = JSON.parse(content.replace(/```json?\n?/g,'').replace(/```/g,'').trim());
  } catch(e) { console.log('Plan parse error'); }
  
  const audioUrl = await generateTTS(plan.summary || `Here's your plan: ${plan.stops?.map(s=>s.name).join(', ')}`);
  
  return { ...plan, audioUrl };
}

function httpReq(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => console.log(`Voice API on port ${PORT}`));
