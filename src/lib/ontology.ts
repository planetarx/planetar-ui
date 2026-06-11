// Client for the planetar-ontology Object API (ARCH-planetar-ontology.md §8):
// REST for queries, a WebSocket `/subscribe` feed for live entity changes.
// Deliberately mirrors the shape of lib/broker.ts.

const DEFAULT_HTTP = 'http://127.0.0.1:4000';

export interface FieldProvenance {
  obs: string;
  src: string;
  conf: number;
  ts: string;
}

/** A resolved canonical entity, as served by GET /objects/:type[/:id]. */
export interface OntologyEntity {
  id: string;
  type: string;
  schemaVersion: string;
  name: string | null;
  createdNs: string;
  updatedNs: string;
  body: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
}

/** Outcome of an Action Type execution (POST /actions/:actionType). */
export interface ActionResult {
  ok?: boolean;
  error?: string;
  action?: string;
  changed?: string[];
  target?: string | null;
}

type Status = 'connecting' | 'open' | 'closed';
type StatusListener = (s: Status) => void;
type EntityListener = (e: OntologyEntity) => void;

function httpToWs(base: string): string {
  return `${base.replace(/^http/, 'ws')}/subscribe`;
}

class OntologyClient {
  private readonly httpBase: string;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private status: Status = 'closed';
  private statusListeners = new Set<StatusListener>();
  private entityListeners = new Set<EntityListener>();
  private reconnectTimer: number | null = null;

  constructor(httpBase: string = DEFAULT_HTTP) {
    this.httpBase = httpBase;
    this.wsUrl = httpToWs(httpBase);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.setStatus('connecting');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => this.setStatus('open'));

    ws.addEventListener('message', (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { event?: string; entity?: OntologyEntity };
      if (m.event === 'entity' && m.entity) {
        for (const l of this.entityListeners) l(m.entity);
      }
    });

    ws.addEventListener('close', () => {
      this.setStatus('closed');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // a close event follows; reconnect is handled there
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  getStatus(): Status {
    return this.status;
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    l(this.status);
    return () => {
      this.statusListeners.delete(l);
    };
  }

  onEntity(l: EntityListener): () => void {
    this.entityListeners.add(l);
    return () => {
      this.entityListeners.delete(l);
    };
  }

  // ---- REST (the OSDK-equivalent surface) ----

  async listObjects(type: string): Promise<OntologyEntity[]> {
    const r = await fetch(`${this.httpBase}/objects/${encodeURIComponent(type)}`);
    if (!r.ok) throw new Error(`listObjects ${type}: HTTP ${r.status}`);
    const j = (await r.json()) as { objects?: OntologyEntity[] };
    return j.objects ?? [];
  }

  async getObject(type: string, id: string): Promise<OntologyEntity> {
    const r = await fetch(
      `${this.httpBase}/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    );
    if (!r.ok) throw new Error(`getObject ${type}/${id}: HTTP ${r.status}`);
    return (await r.json()) as OntologyEntity;
  }

  async getSchema(): Promise<unknown> {
    const r = await fetch(`${this.httpBase}/schema`);
    if (!r.ok) throw new Error(`getSchema: HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Execute an Action Type (the Kinetic layer). Returns the HTTP status
   * alongside the parsed body so callers can surface 409 precondition
   * failures and 400 validation errors, not just success.
   */
  async executeAction(
    actionType: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: ActionResult }> {
    const r = await fetch(`${this.httpBase}/actions/${encodeURIComponent(actionType)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = (await r.json().catch(() => ({}))) as ActionResult;
    return { status: r.status, body };
  }
}

export const ontology = new OntologyClient();
ontology.connect();
