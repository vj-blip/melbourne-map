// Melbourne Map Voice API - with Google Places search
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
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Melbourne Map Voice API');
});

// Search Google Places
async function searchPlaces(query, lat, lng) {
  const params = new URLSearchParams({
    query: query + ' Melbourne',
    location: `${lat},${lng}`,
    radius: 5000,
    key: GOOGLE_PLACES_KEY
  });
  
  const url = `/maps/api/place/textsearch/json?${params}`;
  console.log('Searching Places:', query);
  
  const data = await httpReq('maps.googleapis.com', url, 'GET', {});
  
  if (data.results && data.results.length > 0) {
    return data.results.slice(0, 5).map(p => ({
      name: p.name,
      address: p.formatted_address,
      lat: p.geometry.location.lat,
      lng: p.geometry.location.lng,
      rating: p.rating,
      open: p.opening_hours?.open_now,
      types: p.types?.slice(0, 3).join(', ')
    }));
  }
  return [];
}

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
  
  console.log('Processing:', transcript, 'Location:', userLoc);
  
  // User location (default to Melbourne CBD if not provided)
  const lat = userLoc?.[0] || -37.8136;
  const lng = userLoc?.[1] || 144.9631;
  
  // Detect if user is asking for something we should search Google for
  const searchTerms = ['pharmacy', 'chemist', 'supermarket', 'grocery', 'atm', 'bank', 'hospital', 
    'doctor', 'petrol', 'gas station', 'parking', 'toilet', 'bathroom', 'restaurant', 'cafe', 
    'coffee', 'bar', 'pub', 'hotel', 'shop', 'store', 'mall', 'gym', 'park', 'beach'];
  
  const lowerTranscript = transcript.toLowerCase();
  let placesResults = [];
  let searchQuery = null;
  
  // Check if asking for nearby/find/where type query
  if (lowerTranscript.includes('near') || lowerTranscript.includes('find') || 
      lowerTranscript.includes('where') || lowerTranscript.includes('closest') ||
      lowerTranscript.includes('nearest') || searchTerms.some(t => lowerTranscript.includes(t))) {
    
    // Extract what they're looking for
    for (const term of searchTerms) {
      if (lowerTranscript.includes(term)) {
        searchQuery = term;
        break;
      }
    }
    
    // If no specific term, try to extract from transcript
    if (!searchQuery) {
      const match = lowerTranscript.match(/(?:find|where|nearest|closest)\s+(?:is\s+)?(?:a\s+)?(.+?)(?:\?|$)/);
      if (match) searchQuery = match[1].trim();
    }
    
    if (searchQuery) {
      placesResults = await searchPlaces(searchQuery, lat, lng);
      console.log('Found places:', placesResults.length);
    }
  }
  
  // My curated places for specific recommendations
  const curatedPlaces = [
    { name:"Vue de monde", cat:"dining", lat:-37.8187, lng:144.9576, hours:[18,23], desc:"55th floor tasting menus" },
    { name:"San Telmo", cat:"dining", lat:-37.8122, lng:144.9724, hours:[12,23], desc:"Argentinian steaks" },
    { name:"Gimlet", cat:"dining", lat:-37.8159, lng:144.9693, hours:[17,24], desc:"Oysters, cocktails" },
    { name:"Donovans", cat:"dining", lat:-37.8685, lng:144.9751, hours:[12,22], desc:"Beach vibes St Kilda" },
    { name:"Roule Galette", cat:"cafe", lat:-37.8167, lng:144.9663, hours:[8,16], desc:"French creperie" },
    { name:"Hardware Société", cat:"cafe", lat:-37.8200, lng:144.9567, hours:[7,15], desc:"Famous French toast" },
    { name:"Royal Botanic Gardens", cat:"walk", lat:-37.8302, lng:144.9801, hours:[7,20], desc:"Pram-perfect gardens" },
    { name:"Brighton Beach", cat:"walk", lat:-37.9180, lng:144.9868, hours:[0,24], desc:"Colourful bathing boxes" },
    { name:"Good Times Pilates", cat:"fitness", lat:-37.8054, lng:144.9753, hours:[6,20], desc:"Hype reformer studio" },
    { name:"Melbourne Museum", cat:"see", lat:-37.8033, lng:144.9717, hours:[9,17], desc:"Great with baby" },
  ];

  // Build context for GPT
  let placesContext = '';
  
  if (placesResults.length > 0) {
    placesContext = `GOOGLE PLACES RESULTS for "${searchQuery}" near user:
${placesResults.map((p, i) => `${i+1}. ${p.name} - ${p.address} (${p.rating ? '⭐' + p.rating : 'no rating'}, ${p.open === true ? 'OPEN' : p.open === false ? 'CLOSED' : 'hours unknown'}) [lat:${p.lat}, lng:${p.lng}]`).join('\n')}`;
  }

  const systemPrompt = `You are VJ, a helpful Melbourne guide for Yonatan, Coral, and baby Lev (5.5 months).

USER LOCATION: ${lat.toFixed(4)}, ${lng.toFixed(4)} (real-time from app)
TIME: ${hour}:00 Melbourne

${placesContext}

MY CURATED PICKS (use for restaurant/cafe/activity recs):
${curatedPlaces.map(p => `• ${p.name} (${p.cat}) - ${p.desc} [lat:${p.lat}, lng:${p.lng}]`).join('\n')}

RULES:
1. Be conversational and helpful - 1-2 sentences
2. If Google Places found results, use THE FIRST/CLOSEST one and give its name and brief directions
3. ALWAYS include coordinates for map: COMMAND:{"action":"flyTo","lat":NUMBER,"lng":NUMBER,"name":"Place Name"}
4. You HAVE Google search - never say you don't have info on pharmacies/shops/etc
5. For my curated places, share what makes them special`;

  const gptData = await httpReq('api.openai.com', '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_KEY}`
  }, JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript }
    ]
  }));
  
  let response = gptData.choices?.[0]?.message?.content || "I'm here! What would you like to find?";
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
  
  // If we found places but GPT didn't include a command, add one for the first result
  if (!command && placesResults.length > 0) {
    command = {
      action: 'flyTo',
      lat: placesResults[0].lat,
      lng: placesResults[0].lng,
      name: placesResults[0].name
    };
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
  console.log('Google Places:', GOOGLE_PLACES_KEY ? '✓' : '✗');
});
