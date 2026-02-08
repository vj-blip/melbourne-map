const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { audio, places, filters, userLoc, hour } = req.body;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  
  try {
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
    if (!transcript) return res.json({ transcript: '', response: "Didn't catch that." });
    
    // Process with GPT
    const systemPrompt = `You are VJ, a helpful AI for Melbourne trip map. Help Yonatan, Coral, and baby Lev explore.
Time: ${hour}:00 Melbourne. Places: ${places?.map(p => p.name + '(' + p.cat + ')').join(', ') || 'loading'}

Commands (add as COMMAND:{json}):
- flyTo: {"action":"flyTo","lat":NUM,"lng":NUM}
- filter: {"action":"filter","types":["cafe"],"vibes":["chill"]}

Reply in 1-2 sentences, then command if needed.`;

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
    return res.json({ transcript, response, command });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

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
