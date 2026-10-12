import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ShipmentRepository } from "../../domain/ports.ts";
import type { NewShipment, Shipment, ShipmentStatus, TrackingEvent } from "../../domain/types.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL,
    delay_limit_hours INTEGER,
    created_at TEXT NOT NULL
  );

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

  async list(): Promise<Shipment[]> {
    const shipmentRows = this.db
      .prepare("SELECT * FROM shipments ORDER BY created_at, id")
      .all() as unknown as ShipmentRow[];
    const eventRows = this.db
      .prepare("SELECT * FROM tracking_events ORDER BY occurred_at, dedup_key")
      .all() as unknown as EventRow[];

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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private withEvents(row: ShipmentRow): Shipment {
    const eventRows = this.db
      .prepare("SELECT * FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at, dedup_key")
      .all(row.id) as unknown as EventRow[];
    return toShipment(row, eventRows.map(toEvent));
  }
}

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
