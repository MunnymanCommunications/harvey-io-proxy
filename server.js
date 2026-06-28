const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Env Keys & Custom Models
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// User custom models from Coolify Env
const OPENROUTER_MODEL_1 = process.env.OPENROUTER_MODEL_1 || 'google/gemini-2.0-flash-exp:free';
const OPENROUTER_MODEL_2 = process.env.OPENROUTER_MODEL_2 || 'google/gemma-3-27b-it:free';
const OPENROUTER_MODEL_3 = process.env.OPENROUTER_MODEL_3 || 'qwen/qwen-2.5-72b-instruct:free';
const OPENROUTER_MODEL_4 = process.env.OPENROUTER_MODEL_4 || 'meta-llama/llama-3.3-70b-instruct:free';

const openRouterModels = [
  OPENROUTER_MODEL_1,
  OPENROUTER_MODEL_2,
  OPENROUTER_MODEL_3,
  OPENROUTER_MODEL_4
];

// Timeout Helper
const fetchWithTimeout = async (url, options, timeoutMs = 30000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

// API Call Wrappers
const callOpenRouter = async (prompt, systemPrompt, model) => {
  if (!OPENROUTER_API_KEY) throw new Error('Missing OpenRouter Key');
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://rork.com/',
      'X-Title': 'Harvey iO Note Taker Proxy'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`OpenRouter failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
};

const callGeminiFlash = async (prompt, systemPrompt) => {
  if (!GEMINI_API_KEY) throw new Error('Missing Gemini Key');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUser Content:\n${prompt}` }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] }
    })
  });
  if (!res.ok) throw new Error(`Gemini failed: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
};

const callOpenAI = async (prompt, systemPrompt) => {
  if (!OPENAI_API_KEY) throw new Error('Missing OpenAI Key');
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
};

const executeChain = async (prompt, systemPrompt) => {
  // 1. Try the 4 OpenRouter models sequentially
  for (let i = 0; i < openRouterModels.length; i++) {
    const model = openRouterModels[i];
    try {
      console.log(`Attempting OpenRouter Model ${i + 1}: ${model}...`);
      return await callOpenRouter(prompt, systemPrompt, model);
    } catch (e) {
      console.warn(`OpenRouter Model ${i + 1} (${model}) failed, trying next...`);
    }
  }

  // 2. Fallback to Gemini Flash Direct API
  try {
    console.log('Attempting Direct Gemini Flash API...');
    return await callGeminiFlash(prompt, systemPrompt);
  } catch (e) {
    console.warn('Direct Gemini Flash API failed, trying OpenAI...');
  }

  // 3. Fallback to OpenAI (Only if key is set)
  if (OPENAI_API_KEY && !OPENAI_API_KEY.startsWith('YOUR_')) {
    try {
      console.log('Attempting OpenAI Fallback...');
      return await callOpenAI(prompt, systemPrompt);
    } catch (e) {
      console.error('OpenAI Fallback failed:', e.message);
    }
  } else {
    console.log('OpenAI Fallback skipped (API Key not set).');
  }

  throw new Error('All AI providers and model chains failed. Check API Keys configuration.');
};

// Endpoints
app.post('/api/summarize', async (req, res) => {
  const { rawTranscript } = req.body;
  const systemPrompt = `You are Harvey iO's voice summarizer. Analyze the transcript and extract structure.
You MUST output exactly the tags TITLE, KEY_POINTS, SUMMARY, SPEAKERS, ACTION_ITEMS, and QUESTIONS in the format below.
Do not format as generic Markdown, output exactly this structure:

TITLE: <A short, descriptive, professional title>
KEY_POINTS: ["Detailed point 1 outlining critical items", "Detailed point 2 outlining critical items", "Detailed point 3 outlining critical items"]
SUMMARY: <A concise 2-4 sentence summary of the key meeting discussion>
SPEAKERS: ["list", "of", "detected", "speakers", "or", "Unknown"]
ACTION_ITEMS: [{"text": "Action item description", "completed": false}]
QUESTIONS: ["Suggested follow-up question 1", "Suggested follow-up question 2", "Suggested follow-up question 3"]

Ensure the KEY_POINTS, ACTION_ITEMS, SPEAKERS, and QUESTIONS values are valid JSON arrays.`;

  try {
    const text = await executeChain(rawTranscript, systemPrompt);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { question, notes } = req.body;
  const contextString = notes
    .map((note) => {
      const keyPointsText = note.keyPoints && note.keyPoints.length > 0
        ? `Key Points:\n${note.keyPoints.map(p => `- ${p}`).join('\n')}\n`
        : '';
      return `[ID: ${note.id}]\nTitle: ${note.title}\n${keyPointsText}Summary: ${note.summary}\n`;
    })
    .join('\n---\n');

  const systemPrompt = `You are Harvey iO, an AI assistant answering questions about the user's meeting notes.
Here is the context of all saved notes:
${contextString}

Answer the user's question accurately using the notes summaries context.
You MUST return your answer strictly as a JSON object in this format:
{
  "answer": "A detailed synthesis answering the user's question, highlighting details from specific notes.",
  "sourceIds": ["array", "of", "matching", "note", "ids", "referenced", "in", "the", "answer"]
}
Do not write markdown block indicators, explain, or output anything else outside this JSON structure.`;

  try {
    const text = await executeChain(question, systemPrompt);
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*?\})/);
    const cleanedText = jsonMatch ? jsonMatch[1] : text;
    res.json(JSON.parse(cleanedText));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
