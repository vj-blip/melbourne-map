// Cloudflare Worker for Melbourne Map Voice Assistant
// Deploy: wrangler deploy

export default {
  async fetch(request, env) {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }
    
    const url = new URL(request.url);
    
    if (url.pathname === '/voice' && request.method === 'POST') {
      return handleVoice(request, env);
    }
    
    return new Response('Melbourne Map API', { status: 200 });
  }
};

async function handleVoice(request, env) {
  try {
    const { audio, places, filters, userLoc, hour } = await request.json();
    
    // 1. Transcribe with OpenAI Whisper
    const audioBuffer = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/webm' }), 'audio.webm');
    formData.append('model', 'whisper-1');
    
    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: formData
    });
    
    const whisperData = await whisperRes.json();
    const transcript = whisperData.text || '';
    
    if (!transcript) {
      return jsonResponse({ transcript: '', response: "I didn't catch that. Try again?" });
    }
    
    // 2. Process with Claude
    const systemPrompt = `You are VJ, a helpful AI assistant for a Melbourne trip map. You help Yonatan, Coral, and baby Lev explore Melbourne.

Current time: ${hour}:00 Melbourne time
User location: ${userLoc ? `${userLoc[0]}, ${userLoc[1]}` : 'unknown'}
Active filters: types=${filters.types.join(',')}, vibes=${filters.vibes.join(',')}, hours=${filters.hours}

Available places:
${places.map(p => `- ${p.name} (${p.cat}) at ${p.lat},${p.lng}`).join('\n')}

You can control the map by returning a JSON command in your response. Commands:
- flyTo: {"action":"flyTo","lat":NUMBER,"lng":NUMBER} - fly to a location
- filter: {"action":"filter","types":["dining","cafe"],"vibes":["chill"]} - set filters
- openMaps: {"action":"openMaps","url":"https://..."} - open Google Maps

Reply conversationally in 1-2 sentences, then if appropriate add a command on a new line as: COMMAND:{"action":"..."}

Examples:
User: "Show me coffee shops"
You: "Here are the best cafes nearby! I'll filter to just cafes for you.
COMMAND:{"action":"filter","types":["cafe"]}"

User: "Take me to San Telmo"
You: "San Telmo has amazing Argentinian steaks! Flying you there now.
COMMAND:{"action":"flyTo","lat":-37.8122,"lng":144.9724}"

User: "What's good for dinner?"
You: "For dinner tonight, I'd recommend Vue de monde for a special occasion, or San Telmo for amazing steaks. Both are open now!"

Be concise, friendly, and helpful. Reference baby Lev when relevant for family-friendly suggestions.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: transcript }],
        system: systemPrompt
      })
    });
    
    const claudeData = await claudeRes.json();
    let responseText = claudeData.content?.[0]?.text || "Sorry, I couldn't process that.";
    
    // Extract command if present
    let command = null;
    const cmdMatch = responseText.match(/COMMAND:(\{.+\})/);
    if (cmdMatch) {
      try {
        command = JSON.parse(cmdMatch[1]);
        responseText = responseText.replace(/\nCOMMAND:\{.+\}/, '').trim();
      } catch (e) {}
    }
    
    return jsonResponse({ transcript, response: responseText, command });
    
  } catch (err) {
    console.error(err);
    return jsonResponse({ transcript: '', response: 'Something went wrong. Try again?', error: err.message });
  }
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
