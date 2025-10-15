// simulator.js
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const EMIT_URL = `http://localhost:${PORT}/emit`;

const AGENTS = ['EXTRACT', 'CURATE', 'AVAILS', 'ROYALTIES'];
const TICK_MS =1500;         // slower ticks (2s)
const UPDATE_PROB = 0.75;      // only 60% of live contracts emit on a given tick (feels slower)
const MAX_LIVE = 10;          // max active at once
const MAX_TOTAL = 10;         // max contracts ever created

// id -> { stageIndex, attempts, finalStage, finalOutcome }
const live = new Map();
let createdCount = 0;

/* ----------------------------- HTTP helper ----------------------------- */
async function send(events) {
  if (!events || !events.length) return;
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

/* ----------------------------- Utilities ------------------------------ */
function randomId() {
  return Math.floor(Math.random() * 900000 + 100000).toString();
}

// Choose a final plan for a contract:
// - finalStage: where the flow will eventually end
// - finalOutcome: 'success' (only if finalStage === last) or 'error'/'hil' (early stop)
function planFinal() {
  // Bias to later stages so you still see deeper progress often
  const stageWeights = [0.15, 0.25, 0.25, 0.35]; // sums to 1
  const pick = (weights) => {
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  const s = pick(stageWeights);
  if (s === AGENTS.length - 1) {
    // If last stage, 70% end in success, else error (adds variety)
    const finalOutcome = Math.random() < 0.7 ? 'success' : 'error';
    return { finalStage: s, finalOutcome };
  }
  // Early final: mostly error, sometimes HIL
  const finalOutcome = Math.random() < 0.75 ? 'error' : 'hil';
  return { finalStage: s, finalOutcome };
}

// Generic status sampler (all possibilities non-zero)
function pickStatusBase(attempts) {
  // Make success relatively rare at first; grow with attempts
  let w = {
    queued:  0.10,
    running: 0.45,
    retry:   0.18,
    hil:     0.07,
    error:   0.10,
    success: 0.10 + Math.min(0.20, attempts * 0.03), // grows with attempts
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const k of Object.keys(w)) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return 'running';
}

// When at the contract's final stage, bias toward its final outcome
function pickStatusAtFinal(attempts, finalOutcome) {
  const base = {
    queued:  0.08,
    running: 0.35,
    retry:   0.18,
    hil:     0.10,
    error:   0.14,
    success: 0.15,
  };
  // Strongly bias toward finalOutcome as attempts increase so we eventually finish
  const boost = 0.25 + Math.min(0.35, attempts * 0.05);
  if (finalOutcome === 'success') {
    base.success += boost;
  } else {
    base[finalOutcome] += boost;
    // keep success small so we don't accidentally advance past final stage
    base.success *= 0.3;
  }
  const total = Object.values(base).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const k of Object.keys(base)) {
    r -= base[k];
    if (r <= 0) return k;
  }
  return finalOutcome;
}

/* --------------------------- Spawning logic --------------------------- */
function maybeSpawn(batch) {
  if (live.size >= MAX_LIVE) return;
  if (createdCount >= MAX_TOTAL) return;

  // If none live, start one; otherwise 50% chance to start (keeps pace modest)
  if (live.size === 0 || Math.random() < 0.5) {
    const id = randomId();
    const { finalStage, finalOutcome } = planFinal();
    live.set(id, { stageIndex: 0, attempts: 0, finalStage, finalOutcome });
    createdCount += 1;

    batch.push({
      contractId: id,
      agent: AGENTS[0],
      status: 'running',
      details: 'Started extraction…',
      ts: Date.now(),
    });
  }
}

/* ------------------------ Per-contract step -------------------------- */
function stepContract(id, state, batch) {
  // Throttle: not every live contract updates each tick
  if (Math.random() > UPDATE_PROB) return;

  const now = Date.now();
  const agent = AGENTS[state.stageIndex];

  // Pick status (special bias if at final stage)
  const status =
    state.stageIndex === state.finalStage
      ? pickStatusAtFinal(state.attempts, state.finalOutcome)
      : pickStatusBase(state.attempts);

  batch.push({
    contractId: id,
    agent,
    status,
    details: `${agent} → ${status}`,
    ts: now,
  });

  // Terminal rules
  if (state.stageIndex === state.finalStage) {
    if (state.finalOutcome === 'success' && status === 'success') {
      // Finished successfully (could be at last stage or earlier by design)
      live.delete(id);
      return;
    }
    if ((state.finalOutcome === 'error' || state.finalOutcome === 'hil') && status === state.finalOutcome) {
      // Finished early with error/HIL at this stage
      live.delete(id);
      return;
    }
    // Otherwise, stay at this stage and keep trying later
    state.attempts += 1;
    return;
  }

  // Not at final stage yet:
  if (status === 'success') {
    // Advance to next stage
    state.attempts = 0;
    state.stageIndex += 1;

    // Safety: if we accidentally surpassed finalStage (rare), pin to finalStage
    if (state.stageIndex > state.finalStage) state.stageIndex = state.finalStage;

    // Kick off next stage as running
    const nextAgent = AGENTS[state.stageIndex];
    batch.push({
      contractId: id,
      agent: nextAgent,
      status: 'running',
      details: `Starting ${nextAgent.toLowerCase()}…`,
      ts: now + 1,
    });
  } else {
    // Keep working same stage
    state.attempts += 1;

    // After a hard error, sometimes schedule a reattempt hint
    if (status === 'error' && Math.random() < 0.35) {
      batch.push({
        contractId: id,
        agent,
        status: Math.random() < 0.6 ? 'queued' : 'running',
        details: `${agent} → reattempt scheduled`,
        ts: now + 2,
      });
    }
  }
}

/* ------------------------------ Main loop ---------------------------- */
setInterval(async () => {
  const batch = [];

  maybeSpawn(batch);

  for (const [id, state] of Array.from(live.entries())) {
    stepContract(id, state, batch);
  }

  await send(batch);

  // Optional: stop when all planned contracts are done
  if (createdCount >= MAX_TOTAL && live.size === 0) {
    console.log(`All ${MAX_TOTAL} contracts finished (mixed outcomes). Stopping simulator.`);
    process.exit(0); // comment out if you want to keep the process alive
  }
}, TICK_MS);

console.log(
  `Simulator running slowly. MAX_LIVE=${MAX_LIVE}, MAX_TOTAL=${MAX_TOTAL}, TICK=${TICK_MS}ms. Posting to ${EMIT_URL}`
);
