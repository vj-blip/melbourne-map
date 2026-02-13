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
  
  if (req.url === '/streets' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const result = await handleStreets(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Streets error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
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

async function handleStreets({ lat, lng, radius }) {
  lat = lat || -37.8136;
  lng = lng || 144.9631;
  radius = Math.max(radius || 15, 10); // Default 15km — cover nearby suburbs
  
  console.log(`Streets request: ${lat}, ${lng}, radius ${radius}km`);
  
  // Step 1: Ask OpenClaw to research interesting streets
  const researchPrompt = `You are helping a family (couple + baby) exploring Melbourne, Australia.
Research the best streets and laneways within ${radius}km of coordinates ${lat.toFixed(4)}, ${lng.toFixed(4)}.

IMPORTANT: Think broadly — include streets in nearby neighborhoods and suburbs that are worth a 10-30 minute drive. Places like Richmond, Carlton, Fitzroy, South Yarra, Armadale, St Kilda, Brunswick, Collingwood, Prahran, etc. are all fair game. Even areas up to 45-60 minutes away if there's something truly notable.

For LONG streets (like Collins Street, Brunswick Street, etc.) — be SPECIFIC about which SECTION is interesting. Use the format "Street Name (Section)" e.g. "Collins Street (Paris End)" or "Brunswick Street (between Johnston and Gertrude)". We will highlight only that section on the map.

Focus on:
- Walkable streets with great cafes, brunch spots, family-friendly restaurants
- Interesting laneways with street art, boutique shops, character
- Shopping strips with unique stores (not generic malls)
- Streets near parks/gardens (pram-friendly walks)
- Cultural streets: galleries, markets, bookshops
- Village-feel high streets in inner suburbs

SKIP: nightlife-heavy streets, bar strips, club areas.

Return EXACTLY this JSON (no other text):
{"streets":[{"name":"Street Name","section":"specific section or cross-streets if applicable","description":"Brief 1-2 sentence description of what makes it interesting for a family","category":"food|nature|shopping|culture","searchQuery":"specific search term to find the BEST places on this specific section","suburb":"suburb name"}]}

Return 10-15 streets, covering different neighborhoods. Order by quality/interest, not just distance.`;

  const llmData = await callLLM([
    { role: 'system', content: researchPrompt },
    { role: 'user', content: `Find interesting streets near ${lat.toFixed(4)}, ${lng.toFixed(4)} in Melbourne` }
  ], 1200);

  let researchedStreets = [];
  try {
    const c = llmData.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(c.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    researchedStreets = parsed.streets || [];
  } catch (e) {
    console.log('Streets parse error:', e.message);
    researchedStreets = [];
  }

  if (!researchedStreets.length) {
    return { streets: [], error: 'No streets found' };
  }

  console.log(`Researched ${researchedStreets.length} streets`);

  // Step 2: For each street, get places FIRST (to know where the interesting section is), then get geometry
  const streets = await Promise.all(researchedStreets.map(async (s, idx) => {
    const id = `street_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
    const cleanName = s.name.replace(/\s*\(.*?\)\s*/g, '').trim();
    const suburb = s.suburb || '';

    // STEP A: Get places from Google Places FIRST
    let places = [];
    if (GOOGLE_PLACES_KEY) {
      try {
        const query = s.searchQuery || `${cleanName} ${suburb}`;
        const params = new URLSearchParams({
          query: query + ' Melbourne',
          location: `${lat},${lng}`,
          radius: String(radius * 1000),
          key: GOOGLE_PLACES_KEY
        });
        const placesData = await httpReq('maps.googleapis.com', `/maps/api/place/textsearch/json?${params}`, 'GET', {});
        if (placesData.results) {
          places = placesData.results.slice(0, 12).map(p => ({
            name: p.name,
            lat: p.geometry.location.lat,
            lng: p.geometry.location.lng,
            type: guessPlaceType(p.types || [], p.name),
            rating: p.rating || null
          }));
        }
      } catch (e) {
        console.log(`Places error for ${s.name}:`, e.message);
      }
    }

    // STEP B: Get geometry from Overpass, scoped to where the places are (not whole city)
    let coordinates = [];
    const placesCenter = places.length ? {
      lat: places.reduce((sum, p) => sum + p.lat, 0) / places.length,
      lng: places.reduce((sum, p) => sum + p.lng, 0) / places.length
    } : { lat, lng };
    
    try {
      // Use a tight radius around where places actually are (1km, not 15km)
      const searchRadius = 1000;
      const overpassQuery = `[out:json][timeout:15];way["name"="${cleanName.replace(/"/g, '\\"')}"](around:${searchRadius},${placesCenter.lat},${placesCenter.lng});out geom;`;
      const overpassData = await httpReq('overpass-api.de', `/api/interpreter`, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, `data=${encodeURIComponent(overpassQuery)}`, 20000);
      if (overpassData.elements?.length) {
        const segments = overpassData.elements
          .filter(e => e.geometry?.length)
          .map(e => e.geometry.map(g => [g.lat, g.lon]));
        coordinates = mergeWaySegments(segments);
      }
    } catch (e) {
      console.log(`Overpass error for ${s.name}:`, e.message);
    }

    // STEP C: Clip to interesting section using ONLY nearby places
    // First filter places to those actually near the street/area (within 300m)
    let nearbyPlaces = places;
    if (coordinates.length > 1) {
      nearbyPlaces = places.filter(p => {
        for (let i = 0; i < coordinates.length; i++) {
          if (haversine(p.lat, p.lng, coordinates[i][0], coordinates[i][1]) < 0.3) return true;
        }
        return false;
      });
      console.log(`${s.name}: ${nearbyPlaces.length}/${places.length} places within 300m of street`);
    }
    
    // Clip geometry to where nearby places cluster
    if (nearbyPlaces.length >= 2 && coordinates.length > 4) {
      coordinates = clipToInterestingSection(coordinates, nearbyPlaces);
    }

    // Fallback: if no geometry, create polyline through places
    if (!coordinates.length && places.length >= 2) {
      // Cluster: find the densest group of places within 0.5km of each other
      const clustered = clusterPlaces(places, 0.5);
      const sorted = clustered.sort((a, b) => (a.lat + a.lng) - (b.lat + b.lng));
      coordinates = sorted.map(p => [p.lat, p.lng]);
      nearbyPlaces = clustered;
      console.log(`${s.name}: place-based polyline from ${clustered.length}/${places.length} clustered places`);
    }

    // FINAL hard cap: if polyline > 1.2km, trim from center to ~0.8km
    const polyLen = polylineLength(coordinates);
    if (polyLen > 1.2 && coordinates.length > 2) {
      coordinates = trimPolylineToLength(coordinates, 0.8);
      console.log(`${s.name}: trimmed ${polyLen.toFixed(1)}km → ~0.8km`);
    }
    
    // Replace full places list with nearby ones for the response
    if (nearbyPlaces.length >= 2) places = nearbyPlaces;

    // Calculate distance from user
    const midpoint = coordinates.length ? coordinates[Math.floor(coordinates.length / 2)] : [lat, lng];
    const distance = haversine(lat, lng, midpoint[0], midpoint[1]);

    return {
      id,
      name: s.section ? `${s.name} (${s.section})` : s.name,
      suburb: s.suburb || null,
      description: s.description,
      category: s.category || 'culture',
      distance: Math.round(distance * 10) / 10,
      coordinates,
      places,
      discoveredAt: Date.now(),
      userLat: lat,
      userLng: lng
    };
  }));

  // Sort by distance
  streets.sort((a, b) => a.distance - b.distance);
  const withGeom = streets.filter(s => s.coordinates.length > 1).length;
  console.log(`Returning ${streets.length} streets (${withGeom} with geometry)`);
  return { streets };
}

// Merge multiple OSM way segments into one continuous polyline
function mergeWaySegments(segments) {
  if (!segments.length) return [];
  if (segments.length === 1) return segments[0];
  
  const merged = [...segments[0]];
  const used = new Set([0]);
  
  // Greedily connect nearest endpoints
  for (let i = 1; i < segments.length; i++) {
    let bestIdx = -1, bestDist = Infinity, bestReverse = false, bestPrepend = false;
    const head = merged[0], tail = merged[merged.length - 1];
    
    for (let j = 0; j < segments.length; j++) {
      if (used.has(j)) continue;
      const seg = segments[j];
      const segHead = seg[0], segTail = seg[seg.length - 1];
      
      // Try connecting seg to tail of merged
      const d1 = haversine(tail[0], tail[1], segHead[0], segHead[1]);
      const d2 = haversine(tail[0], tail[1], segTail[0], segTail[1]);
      // Try connecting seg to head of merged
      const d3 = haversine(head[0], head[1], segTail[0], segTail[1]);
      const d4 = haversine(head[0], head[1], segHead[0], segHead[1]);
      
      const minD = Math.min(d1, d2, d3, d4);
      if (minD < bestDist) {
        bestDist = minD;
        bestIdx = j;
        if (minD === d1) { bestReverse = false; bestPrepend = false; }
        else if (minD === d2) { bestReverse = true; bestPrepend = false; }
        else if (minD === d3) { bestReverse = false; bestPrepend = true; }
        else { bestReverse = true; bestPrepend = true; }
      }
    }
    
    if (bestIdx >= 0) {
      used.add(bestIdx);
      let seg = bestReverse ? [...segments[bestIdx]].reverse() : segments[bestIdx];
      if (bestPrepend) merged.unshift(...seg);
      else merged.push(...seg);
    }
  }
  return merged;
}

// Clip a street's coordinates to the interesting section (where places cluster)
function clipToInterestingSection(coordinates, places, bufferKm = 0.15) {
  if (!coordinates.length || !places.length) return coordinates;
  
  // Only clip places that are actually ON the street (within 150m)
  const nearPlaces = places.filter(p => {
    let minD = Infinity;
    for (let i = 0; i < coordinates.length; i++) {
      minD = Math.min(minD, haversine(p.lat, p.lng, coordinates[i][0], coordinates[i][1]));
    }
    return minD < 0.15; // 150m from street
  });
  if (nearPlaces.length < 2) return coordinates; // not enough to clip
  
  // Find the extent of nearby places along the street
  let minIdx = Infinity, maxIdx = 0;
  for (const place of nearPlaces) {
    let bestDist = Infinity, bestI = 0;
    for (let i = 0; i < coordinates.length; i++) {
      const d = haversine(place.lat, place.lng, coordinates[i][0], coordinates[i][1]);
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    minIdx = Math.min(minIdx, bestI);
    maxIdx = Math.max(maxIdx, bestI);
  }
  
  // Small fixed buffer — just enough to not cut off abruptly (5 points or 3% of street)
  const buffer = Math.min(5, Math.max(2, Math.floor(coordinates.length * 0.03)));
  const start = Math.max(0, minIdx - buffer);
  const end = Math.min(coordinates.length - 1, maxIdx + buffer);
  
  return coordinates.slice(start, end + 1);
}

// Calculate total polyline length in km
function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
  }
  return len;
}

// Trim polyline to maxKm centered on the middle
function trimPolylineToLength(coords, maxKm) {
  if (coords.length < 2) return coords;
  // Find midpoint index
  const totalLen = polylineLength(coords);
  const halfMax = maxKm / 2;
  const mid = Math.floor(coords.length / 2);
  
  // Walk outward from mid in both directions
  let startIdx = mid, endIdx = mid;
  let leftLen = 0, rightLen = 0;
  
  while (startIdx > 0 && leftLen < halfMax) {
    leftLen += haversine(coords[startIdx][0], coords[startIdx][1], coords[startIdx-1][0], coords[startIdx-1][1]);
    startIdx--;
  }
  while (endIdx < coords.length - 1 && rightLen < halfMax) {
    rightLen += haversine(coords[endIdx][0], coords[endIdx][1], coords[endIdx+1][0], coords[endIdx+1][1]);
    endIdx++;
  }
  
  return coords.slice(startIdx, endIdx + 1);
}

// Find the densest cluster of places within maxKm of each other
function clusterPlaces(places, maxKm) {
  if (places.length <= 3) return places;
  // For each place, count how many others are within maxKm
  const scores = places.map((p, i) => ({
    idx: i,
    count: places.filter((q, j) => i !== j && haversine(p.lat, p.lng, q.lat, q.lng) < maxKm).length
  }));
  // Find the place with most neighbors (cluster center)
  scores.sort((a, b) => b.count - a.count);
  const center = places[scores[0].idx];
  // Return all places within maxKm of that center
  return places.filter(p => haversine(p.lat, p.lng, center.lat, center.lng) < maxKm);
}

function guessPlaceType(types, name) {
  const t = types.join(' ') + ' ' + name.toLowerCase();
  if (/cafe|coffee|espresso|roast/.test(t)) return 'cafe';
  if (/restaurant|dining|food|eat|kitchen|bistro/.test(t)) return 'restaurant';
  if (/bar|pub|wine|beer|cocktail/.test(t)) return 'bar';
  if (/park|garden|nature|trail/.test(t)) return 'park';
  if (/shop|store|boutique|market|retail/.test(t)) return 'shop';
  if (/gallery|museum|art|culture|theater|theatre/.test(t)) return 'gallery';
  return 'other';
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function httpReq(host, path, method, headers, body, timeoutMs = 300000) {
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
