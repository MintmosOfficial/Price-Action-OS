export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { contents } = req.body;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'Vault Error: Secret GROQ_API_KEY environment variable is missing.' });
    }

    // Direct extraction of user message text to match how index.html packages inputs
    let cleanUserText = "Hello";
    if (Array.isArray(contents) && contents.length > 0) {
      const lastTurn = contents[contents.length - 1];
      if (typeof lastTurn.parts === 'string') {
        cleanUserText = lastTurn.parts;
      } else if (lastTurn.parts && lastTurn.parts.text) {
        cleanUserText = lastTurn.parts.text;
      } else if (typeof lastTurn.content === 'string') {
        cleanUserText = lastTurn.content;
      }
    }

    // Format strict system instructions system manual directly matching Groq's exact format rules
    const groqMessages = [
      {
        role: "system",
        content: "You are the official MINTMOS Price Action OS AI Co-Pilot. You have absolute mastery over the Price Action Operating System, the 8 Deep Modules, the 4-stage Execution Roadmap, the T.L.S Confluence Framework (Trend + Level + Signal), and the flagship setups (BOS Retest, Zone Rejection, Second-Entry Continuation). You are strictly prohibited from answering questions outside of this trading framework, price action mechanics, risk management metrics, or administrative data regarding raoabannn@gmail.com. Keep your answers brief, high-identity, and professional."
      },
      {
        role: "user",
        content: cleanUserText
      }
    ];

    // Call Groq endpoint directly using Meta's ultra-stable, high-volume production model
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
      return res.status(response.status).json({ error: data.error?.message || 'Groq server rejection.' });
    }

    // Pass the text cleanly back to the chat dashboard 
    const replyText = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text: replyText });

  } catch (error) {
    return res.status(500).json({ error: 'Server loop connection failure.' });
  }
}
