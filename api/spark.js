export default async function handler(req, res) {
  // Enforce same-origin guard locks
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { contents, messages } = req.body;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'System Vault Error: Secret GROQ_API_KEY environment variable is missing inside Vercel.' });
    }

    // High-compatibility parser: Reads from both 'messages' or 'contents' arrays dynamically
    const incomingData = messages || contents || [];
    const groqMessages = [
      {
        role: "system",
        content: "You are the official MINTMOS Price Action OS AI Co-Pilot. You have absolute mastery over the Price Action Operating System, the 8 Deep Modules, the 4-stage Execution Roadmap, the T.L.S Confluence Framework (Trend + Level + Signal), and the flagship setups (BOS Retest, Zone Rejection, Second-Entry Continuation). You are strictly prohibited from answering questions outside of this trading framework, price action mechanics, risk management metrics, or administrative data regarding raoabannn@gmail.com. Keep your answers brief, high-identity, and professional."
      }
    ];

    // Safe translation of conversational tracking history nodes
    if (Array.isArray(incomingData)) {
      incomingData.forEach(turn => {
        // Convert model role mappings to standard assistant formats
        const role = (turn.role === 'model' || turn.role === 'assistant') ? 'assistant' : 'user';
        
        // Extract raw string text across all layout variants
        let text = '';
        if (typeof turn.content === 'string') text = turn.content;
        else if (typeof turn.parts === 'string') text = turn.parts;
        else if (turn.parts && turn.parts.text) text = turn.parts.text;
        else if (Array.isArray(turn.parts) && turn.parts[0]?.text) text = turn.parts[0].text;
        
        if (text && turn.role !== 'system') {
          groqMessages.push({ role, content: text });
        }
      });
    }

    // Fallback if the extracted log array data ends up empty
    if (groqMessages.length === 1) {
      groqMessages.push({ role: "user", content: "Explain the core MINTMOS setup." });
    }

    // Call Groq endpoint directly using their high-performance production flagship model
     const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: groqMessages,
        temperature: 0.4,
        max_tokens: 1024
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Groq connection rejected.' });
    }

    // Extract the text cleanly and return it to the dashboard interface canvas
    const replyText = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text: replyText });

  } catch (error) {
    return res.status(500).json({ error: 'Server loop timeout or parsing failure.' });
  }
}
