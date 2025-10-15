import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow'
import 'reactflow/dist/style.css'

/**
 * React Flow Realtime Workflow — with summaries & connected edges
 * WebSocket URL: import.meta.env.VITE_WS_URL (default ws://localhost:4000/events)
 * Event shape:
 * { contractId, agent: 'EXTRACT'|'CURATE'|'AVAILS'|'ROYALTIES',
 *   status: 'queued'|'running'|'success'|'retry'|'hil'|'error', details?, ts? }
 */

const AGENTS = [
  { id: 'EXTRACT',  label: 'A · Extraction' },
  { id: 'CURATE',   label: 'B · Clause Curation' },
  { id: 'AVAILS',   label: 'C · Rights & Avails' },
  { id: 'ROYALTIES',label: 'D · Royalties' },
]

const STATUS = {
  queued:  { color: '#94a3b8', bg: '#f1f5f9' },
  running: { color: '#2563eb', bg: '#eff6ff' },
  success: { color: '#059669', bg: '#ecfdf5' },
  retry:   { color: '#d97706', bg: '#fffbeb' },
  hil:     { color: '#ea580c', bg: '#fff7ed' },
  error:   { color: '#e11d48', bg: '#fff1f2' },
}

function Pill({ s }) {
  const t = STATUS[s] || STATUS.queued
  return (
    <span style={{
      color: t.color, background: t.bg, border: `1px solid ${t.color}22`,
      textTransform: 'capitalize', padding: '2px 8px', borderRadius: 999, fontSize: 12
    }}>{s}</span>
  )
}

/** Custom React Flow node with left/right handles so edges connect */
function AgentRFNode({ data }) {
  const { label, status, details } = data
  const t = STATUS[status] || STATUS.queued
  return (
    <div style={{
      position: 'relative',
      borderRadius: 14, padding: 12, minWidth: 220,
      background: t.bg, border: `1px solid ${t.color}55`,
      boxShadow: (status === 'running' || status === 'retry')
        ? `0 6px 16px ${t.color}33, 0 1px 2px rgba(0,0,0,0.06)`
        : '0 1px 2px rgba(0,0,0,0.04)'
    }}>
      <Handle type="target" position={Position.Left} style={{ background: t.color, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: t.color, width: 8, height: 8 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{label}</strong>
        <Pill s={status} />
      </div>
      {details ? <div style={{ marginTop: 6, fontSize: 12, color: '#334155' }}>{details}</div> : null}
    </div>
  )
}
const nodeTypes = { agent: AgentRFNode }

/** WebSocket with backoff (no flicker) */
function useWebSocket(url, onMessage) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const stopRef = useRef(false)
  const retriesRef = useRef(0)

  useEffect(() => {
    stopRef.current = false
    function connect() {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => { setConnected(true); retriesRef.current = 0 }
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data)
          Array.isArray(data) ? data.forEach(onMessage) : onMessage(data)
        } catch {}
      }
      ws.onclose = () => {
        setConnected(false)
        if (!stopRef.current) {
          const delay = Math.min(1000 * Math.pow(2, retriesRef.current), 8000)
          retriesRef.current += 1
          setTimeout(connect, delay)
        }
      }
    }
    connect()
    return () => { stopRef.current = true; wsRef.current && wsRef.current.close() }
  }, [url, onMessage])

  return connected
}

function emptyContract(id) {
  const now = Date.now()
  return {
    id,
    agents: {
      EXTRACT:   { status: 'queued', ts: now, details: '' },
      CURATE:    { status: 'queued', ts: now, details: '' },
      AVAILS:    { status: 'queued', ts: now, details: '' },
      ROYALTIES: { status: 'queued', ts: now, details: '' },
    }
  }
}

/** Convert one contract to React Flow nodes & edges (edges = smooth, colored) */
function toFlow(selected) {
  const nodes = []
  const edges = []
  if (!selected) return { nodes, edges }

  const baseY = 80, gapX = 280, startX = 50
  AGENTS.forEach((a, i) => {
    const st = selected.agents?.[a.id] || { status: 'queued', details: '' }
    nodes.push({
      id: `${selected.id}::${a.id}`,
      type: 'agent',
      position: { x: startX + i * gapX, y: baseY },
      data: { label: a.label, status: st.status, details: `${a.id} → ${st.status}` },
      draggable: false,
    })
    if (i < AGENTS.length - 1) {
      // Edge color/animation follows the SOURCE node's status
      const srcStatus = selected.agents?.[AGENTS[i].id]?.status || 'queued'
      const color = (STATUS[srcStatus] || STATUS.queued).color
      edges.push({
        id: `${selected.id}::${a.id}->${AGENTS[i + 1].id}`,
        source: `${selected.id}::${a.id}`,
        target: `${selected.id}::${AGENTS[i + 1].id}`,
        type: 'smoothstep',
        style: { stroke: color, strokeWidth: 2 },
        animated: srcStatus === 'running' || srcStatus === 'retry',
      })
    }
  })
  return { nodes, edges }
}

/** Determine a contract's current stage (first non-success) */
function computeContractStage(contract) {
  for (const a of AGENTS) {
    const s = contract.agents[a.id]?.status || 'queued'
    if (s !== 'success') return { stage: a.id, status: s }
  }
  return { stage: 'DONE', status: 'success' }
}

/** Summaries across all contracts — includes Queued so totals add up */
function summarize(allContracts) {
  const values = Object.values(allContracts).filter(c => c && c.id && String(c.id).trim())
  const total = values.length

  // per-agent breakdown (for the per-agent table)
  const perAgent = {}
  for (const a of AGENTS) perAgent[a.id] = { queued:0, running:0, success:0, retry:0, hil:0, error:0 }

  // final & current-stage tallies
  let done = 0, failed = 0
  const current = { queued: 0, running: 0, retry: 0, hil: 0, error: 0 }
  const perContractStage = []

  for (const c of values) {
    // per-agent tally
    for (const a of AGENTS) {
      const st = c.agents[a.id]?.status || 'queued'
      perAgent[a.id][st] = (perAgent[a.id][st] || 0) + 1
    }

    const allSuccess = AGENTS.every(a => c.agents[a.id]?.status === 'success')
    const anyError   = AGENTS.some(a => c.agents[a.id]?.status === 'error')

    if (allSuccess) {
      done++
      perContractStage.push({ id: c.id, stage: 'DONE', status: 'success' })
      continue // finished contracts are not in current-stage buckets
    }
    if (anyError) failed++

    const { stage, status } = computeContractStage(c)
    perContractStage.push({ id: c.id, stage, status })
    if (current[status] !== undefined) current[status] += 1
  }

  const active = total - done // contracts not yet done

  return {
    total,
    active,
    queued: current.queued,
    running: current.running,
    retrying: current.retry,
    hil: current.hil,
    error: current.error,
    done,
    failed,
    perAgent,
    perContractStage,
  }
}

function Card({ title, value, color }) {
  return (
    <div style={{
      padding: 10, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff',
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 100
    }}>
      <div style={{ fontSize: 12, color: '#64748b' }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || '#0f172a' }}>{value}</div>
    </div>
  )
}

export default function App() {
  const [contracts, setContracts] = useState({})
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState(null)

  const onMessage = useCallback((msg) => {
    if (!msg || typeof msg.contractId !== 'string' || !msg.contractId.trim()) return
    setContracts(prev => {
      const next = { ...prev }
      const cur = next[msg.contractId] ?? emptyContract(msg.contractId)
      cur.agents[msg.agent] = {
        status: msg.status,
        ts: msg.ts ?? Date.now(),
        details: msg.details ?? cur.agents[msg.agent].details,
      }
      next[msg.contractId] = { ...cur }
      return next
    })
  }, [])

  const wsUrl = import.meta.env?.VITE_WS_URL || 'ws://localhost:4000/events'
  const connected = useWebSocket(wsUrl, onMessage)

  const list = useMemo(() => {
    const all = Object.values(contracts)
      .filter(c => c && typeof c.id === 'string' && c.id.trim())
      .sort((a, b) => (b.agents.EXTRACT.ts - a.agents.EXTRACT.ts))
    if (!filter) return all
    const q = filter.toLowerCase()
    return all.filter(c => String(c.id).toLowerCase().includes(q))
  }, [contracts, filter])

  useEffect(() => {
    setContracts(prev => {
      const entries = Object.entries(prev).filter(([_, v]) => v && typeof v.id === 'string' && v.id.trim())
      return Object.fromEntries(entries)
    })
  }, [])

  const selected = selectedId && contracts[selectedId] ? contracts[selectedId] : list[0]
  const { nodes, edges } = useMemo(() => toFlow(selected), [selected])
  const sums = useMemo(() => summarize(contracts), [contracts])

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>GEContractX</h2>
          <span style={{
            fontSize: 12, padding: '2px 8px', borderRadius: 8,
            background: connected ? '#dcfce7' : '#fee2e2',
            color: connected ? '#065f46' : '#991b1b'
          }}>{connected ? 'Live' : 'Disconnected'}</span>
        </div>

        <input
          className="search"
          placeholder="Filter by contract id…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="list">
          {list.map(c => {
            const isSel = selected && c.id === selected.id
            const done = AGENTS.filter(a => c.agents[a.id].status === 'success').length
            const pct  = Math.round((done / AGENTS.length) * 100)
            return (
              <button
                key={c.id}
                className={`card${isSel ? ' selected' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div style={{ fontWeight: 600 }}>
                  Contract <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace" }}>{String(c.id)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#475569' }}>{pct}% complete</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Right pane: summaries + graph */}
      <div className="graph">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px 8px' }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Orchestrator Flow</h2>
          <div style={{ fontSize: 12, color: '#475569' }}>queued / running / success / retry / hil / error</div>
        </div>

        {/* Header metrics — includes Active & Queued so totals add up */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(110px, 1fr))', gap: 8, padding: '0 8px 8px' }}>
          <Card title="Total"   value={sums.total} />
          <Card title="Active"  value={sums.active} />
          <Card title="Queued"  value={sums.queued}  color={STATUS.queued.color} />
          <Card title="Running" value={sums.running} color={STATUS.running.color} />
          <Card title="Retry"   value={sums.retrying} color={STATUS.retry.color} />
          <Card title="HIL"     value={sums.hil}      color={STATUS.hil.color} />
          <Card title="Errors"  value={sums.error}    color={STATUS.error.color} />
          <Card title="Done"    value={sums.done}     color={STATUS.success.color} />
        </div>

        {/* Per-Agent Overview */}
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Running Summary (per agent)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {AGENTS.map(a => {
              const pa = sums.perAgent[a.id]
              return (
                <div key={a.id} style={{ padding: 10, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{a.label}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, auto)', gap: 6, fontSize: 12 }}>
                    <Pill s="queued"  /> <span>{pa.queued}</span>
                    <Pill s="running" /> <span>{pa.running}</span>
                    <Pill s="retry"   /> <span>{pa.retry}</span>
                    <Pill s="hil"     /> <span>{pa.hil}</span>
                    <Pill s="error"   /> <span>{pa.error}</span>
                    <Pill s="success" /> <span>{pa.success}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Final Summary */}
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Final Summary</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            <Card title="All Agents Success" value={sums.done}   color={STATUS.success.color} />
            <Card title="Any Agent Error"    value={sums.failed} color={STATUS.error.color} />
          </div>
        </div>

        {/* Per-Contract Stage
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Per-Contract Stage</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, maxHeight: 160, overflow: 'auto' }}>
            {sums.perContractStage.map(row => (
              <div key={row.id} style={{ padding: 8, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Contract {String(row.id)}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <div>Stage:</div>
                  <strong>{row.stage}</strong>
                  <Pill s={row.status} />
                </div>
              </div>
            ))}
          </div>
        </div> */}

        {/* Graph */}
        <div className="graph-inner">
          {!selected ? (
            <div style={{ padding: 24, color: '#64748b' }}>No workflows yet. Awaiting events…</div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              nodesDraggable={false}
            >
              <MiniMap pannable zoomable />
              <Controls />
              <Background gap={16} />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  )
}
