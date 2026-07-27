const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());

// Pagine statiche: serve l'informativa privacy su /privacy.html.
// Apple richiede un URL pubblico e raggiungibile per ogni app con annunci.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/privacy', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'privacy.html')),
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const HF_API_KEY = process.env.HF_API_KEY;

const MODELS = [
  { id: 'Organika/sdxl-detector', aiLabel: 'artificial' },
  { id: 'umm-maybe/AI-image-detector', aiLabel: 'artificial' },
  { id: 'saltacc/anime-ai-detect', aiLabel: 'ai' },
];

// Log di ogni richiesta: senza, sui log di Railway non si capisce
// se il problema e' che le richieste non arrivano o che falliscono dentro.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

/**
 * Rotte di stato.
 * Servono per verificare da browser che il server sia vivo, e permettono
 * a Railway di fare l'healthcheck. Senza una rotta su "/", Express
 * risponde 404 e ogni controllo sembra un errore.
 */
app.get('/', (req, res) => {
  res.json({
    service: 'verifai-backend',
    status: 'online',
    hasApiKey: Boolean(HF_API_KEY),
    models: MODELS.map((m) => m.id),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

async function queryModel(modelId, imageBuffer) {
  const response = await axios.post(
    'https://router.huggingface.co/hf-inference/models/' + modelId,
    imageBuffer,
    {
      headers: {
        Authorization: 'Bearer ' + HF_API_KEY,
        'Content-Type': 'application/octet-stream',
      },
      timeout: 20000,
    },
  );
  return response.data;
}

app.post('/api/check-photo', async (req, res) => {
  try {
    if (!HF_API_KEY) {
      console.error('HF_API_KEY non impostata: nessun modello puo rispondere.');
      return res.status(500).json({
        success: false,
        error: 'Configurazione del server incompleta (chiave API mancante).',
      });
    }

    const { base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, error: 'Nessuna immagine ricevuta' });
    }

    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    console.log(`Immagine ricevuta: ${(imageBuffer.length / 1024).toFixed(0)} KB`);

    const votes = [];
    const scores = [];
    const failures = [];

    for (const model of MODELS) {
      try {
        const result = await queryModel(model.id, imageBuffer);

        if (!Array.isArray(result)) {
          failures.push(`${model.id}: risposta inattesa ${JSON.stringify(result).slice(0, 120)}`);
          continue;
        }

        const aiEntry = result.find((item) =>
          item.label?.toLowerCase().includes(model.aiLabel),
        );

        if (!aiEntry) {
          failures.push(`${model.id}: etichetta "${model.aiLabel}" non trovata`);
          continue;
        }

        scores.push(aiEntry.score);
        votes.push(aiEntry.score > 0.5);
        console.log(
          `${model.id}: ${(aiEntry.score * 100).toFixed(1)}% -> ${aiEntry.score > 0.5 ? 'AI' : 'REALE'}`,
        );
      } catch (err) {
        // Il messaggio di HuggingFace e' la parte utile: 401 chiave errata,
        // 404 modello rimosso, 503 modello in caricamento.
        const detail = err.response
          ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}`
          : err.message;
        failures.push(`${model.id}: ${detail}`);
        console.log(`Modello ${model.id} fallito -> ${detail}`);
      }
    }

    if (votes.length === 0) {
      console.error('Nessun modello ha risposto. Dettagli:', failures);
      return res.status(502).json({
        success: false,
        error: 'Nessun modello di analisi ha risposto.',
        details: failures,
      });
    }

    const votesAI = votes.filter(Boolean).length;
    const aiScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const isAI = votesAI > votes.length - votesAI;

    console.log(
      `Modelli utili: ${votes.length}/${MODELS.length} | media ${(aiScore * 100).toFixed(1)}% | esito ${isAI ? 'AI' : 'REALE'}`,
    );

    return res.json({
      success: true,
      aiScore,
      isAI,
      modelsUsed: votes.length,
    });
  } catch (error) {
    console.error('Errore interno:', error);
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server',
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

// '0.0.0.0' e' obbligatorio su Railway: se il processo ascolta solo su
// localhost, il router esterno non lo raggiunge e la risposta e' 502
// "Application failed to respond", esattamente il sintomo osservato.
app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`  verifai-backend avviato sulla porta ${PORT}`);
  console.log(`  Chiave HuggingFace presente: ${HF_API_KEY ? 'si' : 'NO'}`);
  console.log(`  Node ${process.version}`);
  console.log('==================================================');
});

process.on('unhandledRejection', (reason) => {
  console.error('Promise non gestita:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Eccezione non gestita:', error);
});
