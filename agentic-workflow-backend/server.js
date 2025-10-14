// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 4000;
const WS_PATH = process.env.WS_PATH || '/events';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// --- HTTP server (for WS upgrade) ---
const server = http.createServer(app);

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (ws) => {
  // Optionally greet on connect
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// --- Event schema (loose) ---
const AGENTS = ['EXTRACT', 'CURATE', 'AVAILS', 'ROYALTIES'];
const STATUSES = ['queued', 'running', 'success', 'retry', 'hil', 'error'];

function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'Invalid event payload.';
  if (!e.contractId || typeof e.contractId !== 'string') return 'contractId (string) is required.';
  if (!AGENTS.includes(e.agent)) return `agent must be one of ${AGENTS.join(', ')}.`;
  if (!STATUSES.includes(e.status)) return `status must be one of ${STATUSES.join(', ')}.`;
  return null;
}

// --- Health ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, wsClients: wss.clients.size, ts: Date.now() });
});

// --- Emit one or many events ---
// Accepts either a single event or { events: [...] } batch.
// Event shape:
// { contractId, agent: 'EXTRACT'|'CURATE'|'AVAILS'|'ROYALTIES',
//   status: 'queued'|'running'|'success'|'retry'|'hil'|'error',
//   details?: string, ts?: number }
app.post('/emit', (req, res) => {
  const body = req.body;

  const toArray = Array.isArray(body) ? body
    : Array.isArray(body?.events) ? body.events
    : [body];

  const errors = [];
  const payloads = [];

  for (const item of toArray) {
    const err = validateEvent(item);
    if (err) { errors.push({ item, err }); continue; }
    payloads.push({
      contractId: item.contractId,
      agent: item.agent,
      status: item.status,
      details: item.details ?? null,
      ts: item.ts ?? Date.now(),
    });
  }

  if (errors.length && !payloads.length) {
    return res.status(400).json({ ok: false, errors });
  }

  // broadcast each event
  for (const p of payloads) broadcast(p);

  res.json({ ok: true, sent: payloads.length, errors: errors.length ? errors : undefined });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`HTTP listening on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}${WS_PATH}`);
});
