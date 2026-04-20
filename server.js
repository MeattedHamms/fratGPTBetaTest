const express = require('express');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fratgpt';
const TRAINING_PATH = path.join(__dirname, 'fratbot_data.json');
const FEEDBACK_PATH = path.join(__dirname, 'feedback.json');

const client = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
});

const DOLPHIN_MODEL = 'dolphin3';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadTraining() {
  return JSON.parse(fs.readFileSync(TRAINING_PATH, 'utf8'));
}

function loadFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];
  return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8'));
}

function saveFeedback(data) {
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(data, null, 2));
}

// Word-overlap similarity score between two strings (0–1)
function similarity(a, b) {
  const tokenize = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  return overlap / Math.max(setA.size, setB.size);
}

// Find the top-N closest training examples to a given prompt
function findClosestExamples(data, prompt, n = 3) {
  return data
    .map(entry => ({ ...entry, score: similarity(prompt, entry.prompt) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

function buildSystemPrompt(data) {
  const grouped = {};
  for (const entry of data) {
    if (!grouped[entry.prompt]) grouped[entry.prompt] = [];
    grouped[entry.prompt].push(entry.response);
  }

  let examples = '';
  for (const [prompt, responses] of Object.entries(grouped)) {
    examples += `Q: ${prompt}\n`;
    for (const r of responses) examples += `A: ${r}\n`;
    examples += '\n';
  }

  const persona = process.env.FRATGPT_PERSONA
    ? `\n\nADDITIONAL INSTRUCTIONS:\n${process.env.FRATGPT_PERSONA}`
    : '';

  return `You are FratGPT — an AI trained on real responses from actual fraternity brothers. Match the style of the examples exactly: short, crude, punchy. Most answers are one sentence or less. Never explain yourself. Never be formal.

TRAINING EXAMPLES (this is your voice — copy this style exactly):

${examples}${persona}`;
}

let _trainingData = null;
let _systemPrompt = null;

function getTrainingData() {
  if (!_trainingData) _trainingData = loadTraining();
  return _trainingData;
}

function getSystemPrompt() {
  if (!_systemPrompt) _systemPrompt = buildSystemPrompt(getTrainingData());
  return _systemPrompt;
}

// --- Routes ---

app.post('/api/chat', async (req, res) => {
  const { prompt, history } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'No prompt' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const closest = findClosestExamples(getTrainingData(), prompt.trim());
  const closestHint = closest.length
    ? `Closest examples from your training data — respond like these:\n` +
      closest.map(e => `Q: ${e.prompt}\nA: ${e.response}`).join('\n') +
      `\n\nNow answer this in that exact style:`
    : '';

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: closestHint ? `${closestHint}\n${prompt.trim()}` : prompt.trim() }
  ];

  try {
    const stream = await client.chat.completions.create({
      model: DOLPHIN_MODEL,
      max_tokens: 120,
      temperature: 0.7,
      messages,
      stream: true,
    });

    let fullText = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullText += text;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, fullText })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Dolphin API error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'API call failed' })}\n\n`);
    res.end();
  }
});

app.post('/api/feedback', (req, res) => {
  const { prompt, botResponse, result, correctResponse } = req.body;
  if (!prompt || !botResponse || !result) return res.status(400).json({ error: 'Missing fields' });

  const feedback = loadFeedback();
  const entry = { prompt, response: botResponse, result, timestamp: new Date().toISOString() };
  if (result === 'bad' && correctResponse) entry.correctResponse = correctResponse;
  feedback.push(entry);
  saveFeedback(feedback);
  res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/feedback', (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json(loadFeedback());
});

app.listen(PORT, () => {
  console.log(`FratGPT running at http://localhost:${PORT}`);
  console.log('Using Dolphin3 via Ollama at http://localhost:11434');
});
