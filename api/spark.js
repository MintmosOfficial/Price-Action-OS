export default async function handler(req, res) {
  // Enforce same-origin check
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { contents } = req.body;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'System error: Server API vault key missing.' });
    }

    // Initialize custom Mintmos instructions matching Groq spec structure
    const groqMessages = [
      {
        role: "system",
        content: "You are the official MINTMOS Price Action OS AI Co-Pilot. You have absolute mastery over the Price Action Operating System, the 8 Deep Modules, the 4-stage Execution Roadmap, the T.L.S Confluence Framework (Trend + Level + Signal), and the flagship setups (BOS Retest, Zone Rejection, Second-Entry Continuation). You are strictly prohibited from answering questions outside of this trading framework, price action mechanics, risk management metrics, or administrative data regarding raoabannn@gmail.com. Keep your answers brief, high-identity, and professional."
      }
    ];

    // Format chat history array elements safely
    if (Array.isArray(contents)) {
      contents.forEach(turn => {
        const role = turn.role === 'model' ? 'assistant' : 'user';
        // Extract text elements safely based on what your index.html packages
        const text = typeof turn.parts === 'string' ? turn.parts : (turn.parts?.[0]?.text || turn.parts?.text || '');
        if (text) groqMessages.push({ role, content: text });
      });
    }

    // Call Groq Cloud endpoint directly using Meta's absolute latest production model
    const response = await fetch('https://groq.com', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: groqMessages,
        temperature: 0.4,
        max_tokens: 1024
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Groq verification failed' });
    }

    // Pass the text safely back to your Spark chat window drawer interface
    const replyText = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text: replyText });

  } catch (error) {
    return res.status(500).json({ error: 'Server loop timeout or configuration failure.' });
  }
}
