// Melbourne Map Voice API - with Google Places, TTS audio responses
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

// Generate TTS audio
async function generateTTS(text) {
  console.log('Generating TTS...');
  const body = JSON.stringify({
    model: 'tts-1',
    input: text,
    voice: 'nova',
    response_format: 'mp3'
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        resolve(`data:audio/mp3;base64,${base64}`);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Search Google Places
async function searchPlaces(query, lat, lng) {
  const params = new URLSearchParams({
    query: query + ' Melbourne',
    location: `${lat},${lng}`,
    radius: 5000,
    key: GOOGLE_PLACES_KEY
  });
  
  const data = await httpReq('maps.googleapis.com', `/maps/api/place/textsearch/json?${params}`, 'GET', {});
  
  if (data.results && data.results.length > 0) {
    return data.results.slice(0, 5).map(p => ({
      name: p.name,
      address: p.formatted_address,
      lat: p.geometry.location.lat,
      lng: p.geometry.location.lng,
      rating: p.rating,
      open: p.opening_hours?.open_now,
      placeId: p.place_id
    }));
  }
  return [];
}

async function handleVoice({ audio, audioType, text, userLoc, hour, preferences }) {
  let transcript = text || '';
  const mimeType = audioType || 'audio/webm';
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('m4a') ? 'm4a' : 'webm';
  
  // Transcribe with Whisper if audio provided
  if (audio && audio.length > 100) {
    console.log('Audio received, length:', audio.length);
    const audioBuffer = Buffer.from(audio, 'base64');
    console.log('Audio buffer size:', audioBuffer.length, 'bytes');
    
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
    
    console.log('Whisper response:', JSON.stringify(whisperData));
    transcript = whisperData.text || '';
  } else {
    console.log('No audio or too short. Audio length:', audio ? audio.length : 0);
  }
  
  if (!transcript) {
    const audioUrl = await generateTTS("I didn't catch that. Try again?");
    return { transcript: '', response: "I didn't catch that. Try again?", audioUrl };
  }
  
  console.log('Processing:', transcript);
  
  const lat = userLoc?.[0] || -37.8136;
  const lng = userLoc?.[1] || 144.9631;
  
  // Detect search queries
  const searchTerms = ['pharmacy', 'chemist', 'supermarket', 'grocery', 'atm', 'bank', 'hospital', 
    'doctor', 'petrol', 'gas', 'parking', 'toilet', 'bathroom', 'restaurant', 'cafe', 
    'coffee', 'bar', 'pub', 'hotel', 'shop', 'store', 'mall', 'gym', 'park', 'beach',
    'museum', 'gallery', 'playground', 'daycare', 'baby'];
  
  const lowerTranscript = transcript.toLowerCase();
  let placesResults = [];
  let searchQuery = null;
  
  if (lowerTranscript.includes('near') || lowerTranscript.includes('find') || 
      lowerTranscript.includes('where') || lowerTranscript.includes('closest') ||
      lowerTranscript.includes('nearest') || searchTerms.some(t => lowerTranscript.includes(t))) {
    
    for (const term of searchTerms) {
      if (lowerTranscript.includes(term)) {
        searchQuery = term;
        break;
      }
    }
    
    if (!searchQuery) {
      const match = lowerTranscript.match(/(?:find|where|nearest|closest)\s+(?:is\s+)?(?:a\s+)?(.+?)(?:\?|$)/);
      if (match) searchQuery = match[1].trim();
    }
    
    if (searchQuery) {
      placesResults = await searchPlaces(searchQuery, lat, lng);
    }
  }
  
  // Curated places
  const curatedPlaces = [
    { name:"Vue de monde", cat:"dining", lat:-37.8187, lng:144.9576, desc:"55th floor tasting menus" },
    { name:"San Telmo", cat:"dining", lat:-37.8122, lng:144.9724, desc:"Argentinian steaks" },
    { name:"Gimlet", cat:"dining", lat:-37.8159, lng:144.9693, desc:"Oysters, cocktails" },
    { name:"Roule Galette", cat:"cafe", lat:-37.8167, lng:144.9663, desc:"French creperie" },
    { name:"Hardware Société", cat:"cafe", lat:-37.8200, lng:144.9567, desc:"Famous French toast" },
    { name:"Royal Botanic Gardens", cat:"walk", lat:-37.8302, lng:144.9801, desc:"Pram-perfect gardens" },
    { name:"Brighton Beach", cat:"walk", lat:-37.9180, lng:144.9868, desc:"Colourful bathing boxes" },
    { name:"Melbourne Museum", cat:"see", lat:-37.8033, lng:144.9717, desc:"Great with baby" },
  ];

  let placesContext = placesResults.length > 0 ? 
    `GOOGLE PLACES RESULTS for "${searchQuery}":\n${placesResults.map((p, i) => 
      `${i+1}. ${p.name} - ${p.address} (${p.rating ? '⭐' + p.rating : ''}, ${p.open === true ? 'OPEN' : p.open === false ? 'CLOSED' : ''}) [lat:${p.lat}, lng:${p.lng}]`
    ).join('\n')}` : '';

  const systemPrompt = `You are VJ, a friendly Melbourne guide for Yonatan, Coral, and baby Lev (5.5 months).

USER LOCATION: ${lat.toFixed(4)}, ${lng.toFixed(4)}
TIME: ${hour}:00 Melbourne
${preferences ? `PREFERENCES: ${JSON.stringify(preferences)}` : ''}

${placesContext}

CURATED PICKS:
${curatedPlaces.map(p => `• ${p.name} - ${p.desc} [lat:${p.lat}, lng:${p.lng}]`).join('\n')}

RESPOND with:
1. Brief helpful answer (1-2 sentences, spoken naturally)
2. On new line, ONE command:
   - COMMAND:{"action":"addMarker","lat":NUM,"lng":NUM,"name":"Name","type":"search"}
   - COMMAND:{"action":"flyTo","lat":NUM,"lng":NUM}
   - COMMAND:{"action":"filter","types":["cafe"]}
   - COMMAND:{"action":"savePreference","key":"favorite_cafe","value":"Name"}

Always use addMarker for places found via search. Use flyTo for curated places.`;

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
  
  // Extract command
  let command = null;
  const cmdMatch = response.match(/COMMAND:(\{[^}]+\})/);
  if (cmdMatch) {
    try {
      command = JSON.parse(cmdMatch[1]);
      response = response.replace(/\n?COMMAND:\{[^}]+\}/, '').trim();
    } catch (e) {}
  }
  
  // Return all places found for multiple markers
  let searchResults = null;
  if (placesResults.length > 0) {
    searchResults = placesResults.map(p => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      rating: p.rating,
      open: p.open
    }));
    // Default flyTo first result if no command
    if (!command) {
      command = { action: 'flyTo', lat: placesResults[0].lat, lng: placesResults[0].lng };
    }
  }
  
  // Generate TTS audio
  const audioUrl = await generateTTS(response);
  
  return { transcript, response, command, audioUrl, searchResults };
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
