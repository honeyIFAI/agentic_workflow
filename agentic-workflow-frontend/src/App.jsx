import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'

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
    <span className="pill" style={{
      color: t.color, background: t.bg, border: `1px solid ${t.color}22`,
      textTransform: 'capitalize'
    }}>{s}</span>
  )
}

function AgentRFNode({ data }) {
  const { label, status, details } = data
  const t = STATUS[status] || STATUS.queued
  return (
    <div style={{
      borderRadius: 14, padding: 12, minWidth: 220,
      background: t.bg, border: `1px solid ${t.color}55`,
      boxShadow: (status === 'running' || status === 'retry')
        ? `0 6px 16px ${t.color}33, 0 1px 2px rgba(0,0,0,0.06)`
        : '0 1px 2px rgba(0,0,0,0.04)'
    }}>
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
      const srcStatus = selected.agents?.[AGENTS[i].id]?.status || 'queued'
      const color = (STATUS[srcStatus] || STATUS.queued).color
      edges.push({
        id: `${selected.id}::${a.id}->${AGENTS[i + 1].id}`,
        source: `${selected.id}::${a.id}`,
        target: `${selected.id}::${AGENTS[i + 1].id}`,
        style: { stroke: color, strokeWidth: 2 },
        animated: srcStatus === 'running' || srcStatus === 'retry',
      })
    }
  })
  return { nodes, edges }
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

  // Filter: coerce id to string so numeric IDs match text input
  const list = useMemo(() => {
    const all = Object.values(contracts)
      .filter(c => c && typeof c.id === 'string' && c.id.trim())
      .sort((a, b) => (b.agents.EXTRACT.ts - a.agents.EXTRACT.ts))
    if (!filter) return all
    const q = filter.toLowerCase()
    return all.filter(c => String(c.id).toLowerCase().includes(q))
  }, [contracts, filter])

  useEffect(() => {
    // one-time cleanup of any malformed entries
    setContracts(prev => {
      const entries = Object.entries(prev).filter(([_, v]) => v && typeof v.id === 'string' && v.id.trim())
      return Object.fromEntries(entries)
    })
  }, [])

  const selected = selectedId && contracts[selectedId] ? contracts[selectedId] : list[0]
  const { nodes, edges } = useMemo(() => toFlow(selected), [selected])

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Workflows</h2>
          <span className="pill" style={{
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

        {/* SCROLLABLE LIST */}
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

      {/* Graph pane */}
      <div className="graph">
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px 8px' }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Session Flow</h2>
          <div style={{ fontSize: 12, color: '#475569' }}>queued / running / success / retry / hil / error</div>
        </div>

        <div className="graph-inner">
          {!selected ? (
            <div style={{ padding: 24, color: '#64748b' }}>No workflows yet. Awaiting events…</div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={{ agent: AgentRFNode }}
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
