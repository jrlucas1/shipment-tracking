import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { inTransitSince } from "../../domain/delay.ts";
import type { ShipmentListQuery, ShipmentRepository } from "../../domain/ports.ts";
import { currentStatus } from "../../domain/status.ts";
import type { NewShipment, Shipment, ShipmentStatus, TrackingEvent } from "../../domain/types.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL,
    delay_limit_hours INTEGER,
    created_at TEXT NOT NULL,
    -- Resumo do histórico, regravado a cada addEvents, para filtrar atraso no banco.
    in_transit_since_ms INTEGER,
    delivered INTEGER NOT NULL DEFAULT 0
  );

  -- A listagem pagina nesta ordem; sem o índice cada página varre e ordena a tabela inteira.
  CREATE INDEX IF NOT EXISTS shipments_by_creation ON shipments (created_at, id);

  CREATE TABLE IF NOT EXISTS tracking_events (
    shipment_id TEXT NOT NULL REFERENCES shipments (id),
    dedup_key TEXT NOT NULL,
    external_id TEXT,
    occurred_at TEXT NOT NULL,
    status TEXT,
    raw_status TEXT NOT NULL,
    location TEXT,
    PRIMARY KEY (shipment_id, dedup_key)
  );

  -- A chave primária é o que garante um aviso de atraso por envio.
  CREATE TABLE IF NOT EXISTS delay_notices (
    shipment_id TEXT PRIMARY KEY REFERENCES shipments (id),
    notified_at TEXT NOT NULL
  );
`;

interface ShipmentRow {
  id: string;
  code: string;
  carrier: string;
  delay_limit_hours: number | null;
  created_at: string;
}

interface EventRow {
  shipment_id: string;
  external_id: string | null;
  occurred_at: string;
  status: string | null;
  raw_status: string;
  location: string | null;
}

export class SqliteShipmentRepository implements ShipmentRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async create(shipment: NewShipment): Promise<Shipment> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO shipments (id, code, carrier, delay_limit_hours, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        shipment.code,
        shipment.carrier,
        shipment.delayLimitHours,
        shipment.createdAt.toISOString(),
      );

    const stored = await this.findByCode(shipment.code);
    if (stored === null) throw new Error(`shipment ${shipment.code} was not stored`);
    return stored;
  }

  async findById(id: string): Promise<Shipment | null> {
    const row = this.db.prepare("SELECT * FROM shipments WHERE id = ?").get(id);
    return row === undefined ? null : this.withEvents(row as unknown as ShipmentRow);
  }

  async findByCode(code: string): Promise<Shipment | null> {
    const row = this.db.prepare("SELECT * FROM shipments WHERE code = ?").get(code);
    return row === undefined ? null : this.withEvents(row as unknown as ShipmentRow);
  }

  async list(query: ShipmentListQuery): Promise<Shipment[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query.after !== null) {
      conditions.push("(created_at, id) > (?, ?)");
      params.push(query.after.createdAt.toISOString(), query.after.id);
    }
    if (query.delayed !== undefined) {
      conditions.push(query.delayed ? IS_DELAYED : `NOT (${IS_DELAYED})`);
      params.push(query.now.getTime(), query.defaultDelayLimitHours);
    }
    if (query.withoutDelayNotice) {
      conditions.push("NOT EXISTS (SELECT 1 FROM delay_notices WHERE shipment_id = shipments.id)");
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const shipmentRows = this.db
      .prepare(`SELECT * FROM shipments ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, query.limit) as unknown as ShipmentRow[];

    if (shipmentRows.length === 0) return [];

    const placeholders = shipmentRows.map(() => "?").join(", ");
    const eventRows = this.db
      .prepare(
        `SELECT * FROM tracking_events WHERE shipment_id IN (${placeholders})
         ORDER BY occurred_at, dedup_key`,
      )
      .all(...shipmentRows.map((row) => row.id)) as unknown as EventRow[];

    const eventsByShipment = new Map<string, TrackingEvent[]>();
    for (const row of eventRows) {
      const events = eventsByShipment.get(row.shipment_id) ?? [];
      events.push(toEvent(row));
      eventsByShipment.set(row.shipment_id, events);
    }

    return shipmentRows.map((row) => toShipment(row, eventsByShipment.get(row.id) ?? []));
  }

  async addEvents(shipmentId: string, events: TrackingEvent[]): Promise<void> {
    // A chave primária (shipment_id, dedup_key) é o que impede o histórico de duplicar.
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tracking_events
         (shipment_id, dedup_key, external_id, occurred_at, status, raw_status, location)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        insert.run(
          shipmentId,
          dedupKey(event),
          event.externalId,
          event.occurredAt.toISOString(),
          event.status,
          event.rawStatus,
          event.location,
        );
      }
      this.updateSummary(shipmentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async recordDelayNotice(shipmentId: string, at: Date): Promise<boolean> {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO delay_notices (shipment_id, notified_at) VALUES (?, ?)")
      .run(shipmentId, at.toISOString());
    return result.changes === 1;
  }

  async findDelayNotice(shipmentId: string): Promise<Date | null> {
    const row = this.db.prepare("SELECT notified_at FROM delay_notices WHERE shipment_id = ?").get(shipmentId);
    return row === undefined ? null : new Date(row.notified_at as string);
  }

  close(): void {
    this.db.close();
  }

  private withEvents(row: ShipmentRow): Shipment {
    return toShipment(row, this.eventsOf(row.id));
  }

  private eventsOf(shipmentId: string): TrackingEvent[] {
    const eventRows = this.db
      .prepare("SELECT * FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at, dedup_key")
      .all(shipmentId) as unknown as EventRow[];
    return eventRows.map(toEvent);
  }

  // As colunas saem das mesmas funções do domínio que calculam o atraso na leitura.
  private updateSummary(shipmentId: string): void {
    const events = this.eventsOf(shipmentId);
    this.db
      .prepare("UPDATE shipments SET in_transit_since_ms = ?, delivered = ? WHERE id = ?")
      .run(
        inTransitSince(events)?.getTime() ?? null,
        currentStatus(events) === "delivered" ? 1 : 0,
        shipmentId,
      );
  }
}

// Mesma conta de `isDelayed`: não entregue e em trânsito há mais tempo que o limite.
// Parâmetros, nesta ordem: agora em ms e limite global em horas.
const IS_DELAYED = `(
  delivered = 0
  AND in_transit_since_ms IS NOT NULL
  AND (? - in_transit_since_ms) > COALESCE(delay_limit_hours, ?) * ${MS_PER_HOUR}
)`;

/** Id da origem quando existe; senão, o que identifica o evento: quando, o quê e onde. */
function dedupKey(event: TrackingEvent): string {
  if (event.externalId !== null) return `id:${event.externalId}`;
  return `natural:${JSON.stringify([event.occurredAt.toISOString(), event.rawStatus, event.location])}`;
}

function toShipment(row: ShipmentRow, events: TrackingEvent[]): Shipment {
  return {
    id: row.id,
    code: row.code,
    carrier: row.carrier,
    delayLimitHours: row.delay_limit_hours,
    createdAt: new Date(row.created_at),
    events,
  };
}

function toEvent(row: EventRow): TrackingEvent {
  return {
    externalId: row.external_id,
    occurredAt: new Date(row.occurred_at),
    status: row.status as ShipmentStatus | null,
    rawStatus: row.raw_status,
    location: row.location,
  };
}
