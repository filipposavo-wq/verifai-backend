const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const HF_API_KEY = process.env.HF_API_KEY;

const MODELS = [
  { id: 'Organika/sdxl-detector', aiLabel: 'artificial' },
  { id: 'umm-maybe/AI-image-detector', aiLabel: 'artificial' },
  { id: 'saltacc/anime-ai-detect', aiLabel: 'ai' },
];

async function queryModel(modelId, imageBuffer) {
  const response = await axios.post(
    'https://router.huggingface.co/hf-inference/models/' + modelId,
    imageBuffer,
    {
      headers: {
        'Authorization': 'Bearer ' + HF_API_KEY,
        'Content-Type': 'application/octet-stream',
      },
      timeout: 20000,
    }
  );
  return response.data;
}

app.post('/api/check-photo', async (req, res) => {
  try {
    const { base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, error: 'Nessuna immagine ricevuta' });
    }

    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    const votes = [];
    const scores = [];

    for (const model of MODELS) {
      try {
        console.log('Provo: ' + model.id);
        const result = await queryModel(model.id, imageBuffer);
        console.log('Risposta ' + model.id + ':', result);

        if (!Array.isArray(result)) continue;

        const aiEntry = result.find(item =>
          item.label?.toLowerCase().includes(model.aiLabel)
        );

        if (aiEntry) {
          const score = aiEntry.score;
          scores.push(score);
          votes.push(score > 0.50);
          console.log(model.id + ': ' + (score * 100).toFixed(1) + '% -> ' + (score > 0.50 ? 'AI' : 'REALE'));
        }
      } catch (err) {
        console.log('Modello ' + model.id + ' fallito: ' + err.message);
      }
    }

    if (votes.length === 0) {
      return res.status(500).json({ success: false, error: 'Nessun modello ha risposto' });
    }

    const votesAI = votes.filter(v => v === true).length;
    const votesReale = votes.filter(v => v === false).length;
    const isAI = votesAI > votesReale;
    const aiScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log('VOTI AI: ' + votesAI + ' | VOTI REALE: ' + votesReale + ' | RISULTATO: ' + (isAI ? 'AI' : 'REALE'));

    return res.json({
      success: true,
      aiScore: aiScore,
      isAI: isAI,
    });

  } catch (error) {
    console.error('Errore:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server',
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server attivo sulla porta ' + PORT);
});