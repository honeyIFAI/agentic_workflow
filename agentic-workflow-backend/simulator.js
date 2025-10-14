// simulator.js
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const EMIT_URL = `http://localhost:${PORT}/emit`;

const AGENTS = ['EXTRACT', 'CURATE', 'AVAILS', 'ROYALTIES'];
const STATUSES = ['queued', 'running', 'success', 'retry', 'hil', 'error'];

function randomId() { return Math.floor(Math.random() * 900000 + 100000).toString(); }

const live = new Set();

// Prefer Node 18+ (has global fetch). If Node <18, install node-fetch and import it.
async function send(events) {
  try {
    const res = await fetch(EMIT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Emit error', res.status, t);
    }
  } catch (e) {
    console.error('Emit failed', e.message);
  }
}

function randomStatus() {
  const r = Math.random();
  if (r < 0.05) return 'error';
  if (r < 0.10) return 'hil';
  if (r < 0.25) return 'retry';
  if (r < 0.70) return 'running';
  return 'success';
}

setInterval(async () => {
  // start new contract sometimes
  if (Math.random() < 0.35 || live.size === 0) {
    const id = randomId();
    live.add(id);
    await send([{
      contractId: id,
      agent: 'EXTRACT',
      status: 'running',
      details: 'Parsing layout…',
      ts: Date.now(),
    }]);
  }

  // progress existing ones
  const batch = [];
  for (const id of Array.from(live)) {
    const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
    const status = randomStatus();
    batch.push({
      contractId: id,
      agent,
      status,
      details: `${agent} → ${status}`,
      ts: Date.now(),
    });
    if (agent === 'ROYALTIES' && status === 'success') live.delete(id);
  }
  if (batch.length) await send(batch);
}, 900);

console.log(`Simulator running. Posting to ${EMIT_URL}`);
