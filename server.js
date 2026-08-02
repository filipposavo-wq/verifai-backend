const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(cors());

// Pagine statiche: informativa privacy e supporto.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/privacy', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'privacy.html')),
);
app.get('/supporto', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'supporto.html')),
);
app.get('/support', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'supporto.html')),
);

/**
 * app-ads.txt — standard IAB che dichiara chi è autorizzato a vendere gli
 * spazi pubblicitari di questa app. Google lo cerca all'indirizzo indicato
 * come "sito web dello sviluppatore" nella scheda App Store.
 * Deve essere servito come testo semplice, non come HTML.
 */
app.get('/app-ads.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'app-ads.txt'));
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const SIGHTENGINE_USER = process.env.SIGHTENGINE_USER;
const SIGHTENGINE_SECRET = process.env.SIGHTENGINE_SECRET;
const SIGHTENGINE_URL = 'https://api.sightengine.com/1.0/check.json';

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

/**
 * Cache dei risultati, per hash del contenuto dell'immagine.
 *
 * Le immagini virali vengono analizzate da migliaia di persone diverse: senza
 * cache pagheresti la stessa analisi ogni volta. Con la cache la seconda
 * richiesta della stessa immagine costa zero operazioni.
 *
 * È in memoria, quindi si azzera a ogni deploy o riavvio del servizio. Va bene
 * per i volumi attuali; se un domani servisse persistenza, la sostituzione
 * naturale è Redis, che Railway offre come servizio aggiuntivo.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 giorni
const CACHE_MAX_ENTRIES = 5000;
const cache = new Map();

function cacheGet(hash) {
  const hit = cache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(hash);
    return null;
  }
  return hit.aiScore;
}

function cacheSet(hash, aiScore) {
  // Map conserva l'ordine di inserimento: la prima chiave è la più vecchia.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(hash, { aiScore, at: Date.now() });
}

app.get('/', (req, res) => {
  res.json({
    service: 'verifai-backend',
    status: 'online',
    detector: 'sightengine/genai',
    hasCredentials: Boolean(SIGHTENGINE_USER && SIGHTENGINE_SECRET),
    cacheSize: cache.size,
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * Interroga Sightengine con il modello `genai`.
 * Restituisce la probabilità 0-1 che l'immagine sia generata o modificata con AI.
 */
async function detectAi(imageBuffer) {
  const form = new FormData();
  form.append('media', imageBuffer, {
    filename: 'image.jpg',
    contentType: 'image/jpeg',
  });
  form.append('models', 'genai');
  form.append('api_user', SIGHTENGINE_USER);
  form.append('api_secret', SIGHTENGINE_SECRET);

  const response = await axios.post(SIGHTENGINE_URL, form, {
    headers: form.getHeaders(),
    timeout: 25000,
    maxBodyLength: Infinity,
  });

  const data = response.data;

  if (data.status !== 'success') {
    throw new Error(
      `Sightengine: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`,
    );
  }

  const score = data.type?.ai_generated;
  if (typeof score !== 'number') {
    throw new Error('Sightengine: punteggio ai_generated assente nella risposta');
  }

  return score;
}

app.post('/api/check-photo', async (req, res) => {
  try {
    if (!SIGHTENGINE_USER || !SIGHTENGINE_SECRET) {
      console.error('Credenziali Sightengine mancanti nelle variabili d ambiente.');
      return res.status(500).json({
        success: false,
        error: 'Configurazione del server incompleta.',
      });
    }

    const { base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, error: 'Nessuna immagine ricevuta' });
    }

    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    if (imageBuffer.length < 1024) {
      return res.status(400).json({ success: false, error: 'Immagine non valida' });
    }

    const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    const cached = cacheGet(hash);
    if (cached !== null) {
      console.log(
        `cache HIT  ${hash.slice(0, 12)}  ${(cached * 100).toFixed(1)}%  (0 operazioni)`,
      );
      return res.json({
        success: true,
        aiScore: cached,
        isAI: cached > 0.5,
        cached: true,
      });
    }

    console.log(
      `cache MISS ${hash.slice(0, 12)}  ${(imageBuffer.length / 1024).toFixed(0)} KB → Sightengine`,
    );

    const aiScore = await detectAi(imageBuffer);
    cacheSet(hash, aiScore);

    console.log(
      `risultato  ${hash.slice(0, 12)}  ${(aiScore * 100).toFixed(1)}% → ${aiScore > 0.5 ? 'AI' : 'REALE'}`,
    );

    return res.json({
      success: true,
      aiScore,
      isAI: aiScore > 0.5,
      cached: false,
    });
  } catch (error) {
    // Il messaggio di Sightengine è la parte utile: 401 credenziali errate,
    // 429 quota esaurita, 400 immagine non supportata.
    const detail = error.response
      ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data).slice(0, 200)}`
      : error.message;

    console.error('Analisi fallita:', detail);

    const quotaExhausted =
      error.response?.status === 429 ||
      /usage limit|quota/i.test(JSON.stringify(error.response?.data ?? ''));

    return res.status(quotaExhausted ? 429 : 502).json({
      success: false,
      error: quotaExhausted
        ? 'Il servizio di analisi ha raggiunto il limite giornaliero. Riprova domani.'
        : 'Analisi non riuscita. Riprova fra poco.',
      details: detail,
    });
  }
});

const PORT = process.env.PORT || 3000;

// '0.0.0.0' è obbligatorio su Railway: senza, il router esterno non raggiunge
// il processo e la risposta è 502 "Application failed to respond".
app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`  verifai-backend avviato sulla porta ${PORT}`);
  console.log(`  Rilevatore: Sightengine (modello genai)`);
  console.log(
    `  Credenziali presenti: ${SIGHTENGINE_USER && SIGHTENGINE_SECRET ? 'si' : 'NO'}`,
  );
  console.log(`  Node ${process.version}`);
  console.log('==================================================');
});

process.on('unhandledRejection', (reason) => console.error('Promise non gestita:', reason));
process.on('uncaughtException', (error) => console.error('Eccezione non gestita:', error));
