import { inTransitSince, isDelayed } from "./delay.ts";
import type { Clock, ShipmentRepository, TrackingProvider } from "./ports.ts";
import { currentStatus } from "./status.ts";
import type { PageCursor, Shipment, ShipmentStatus } from "./types.ts";

export interface ShipmentSnapshot {
  shipment: Shipment;
  /** `null` enquanto nenhum evento com tradução conhecida chegou. */
  status: ShipmentStatus | null;
  isDelayed: boolean;
  /** Limite que valeu para este envio: o próprio ou o global. */
  delayLimitHours: number;
  inTransitSince: Date | null;
}

export class ShipmentNotFoundError extends Error {
  override name = "ShipmentNotFoundError";
}

export interface ShipmentServiceDeps {
  provider: TrackingProvider;
  repository: ShipmentRepository;
  clock: Clock;
  defaultDelayLimitHours: number;
}

export class ShipmentService {
  private readonly provider: TrackingProvider;
  private readonly repository: ShipmentRepository;
  private readonly clock: Clock;
  private readonly defaultDelayLimitHours: number;

  constructor(deps: ShipmentServiceDeps) {
    this.provider = deps.provider;
    this.repository = deps.repository;
    this.clock = deps.clock;
    this.defaultDelayLimitHours = deps.defaultDelayLimitHours;
  }

  async register(input: {
    code: string;
    carrier: string;
    delayLimitHours: number | null;
  }): Promise<{ snapshot: ShipmentSnapshot; created: boolean }> {
    const existing = await this.repository.findByCode(input.code);
    if (existing !== null) return { snapshot: this.snapshot(existing), created: false };

    // A origem primeiro: se ela recusar, não fica envio local que ela desconhece.
    await this.provider.register(input.code, input.carrier);

    const shipment = await this.repository.create({ ...input, createdAt: this.clock.now() });
    return { snapshot: this.snapshot(shipment), created: true };
  }

  async refresh(id: string): Promise<ShipmentSnapshot> {
    const shipment = await this.findOrThrow(id);

    const events = await this.provider.fetchEvents(shipment.code);
    await this.repository.addEvents(shipment.id, events);

    return this.snapshot(await this.findOrThrow(id));
  }

  async get(id: string): Promise<ShipmentSnapshot> {
    return this.snapshot(await this.findOrThrow(id));
  }

  async list(options: {
    limit: number;
    after: PageCursor | null;
    delayed?: boolean;
  }): Promise<{ snapshots: ShipmentSnapshot[]; nextCursor: PageCursor | null }> {
    const now = this.clock.now();

    // Pede um a mais só para saber se existe próxima página.
    const shipments = await this.repository.list({
      ...options,
      limit: options.limit + 1,
      now,
      defaultDelayLimitHours: this.defaultDelayLimitHours,
    });

    const page = shipments.slice(0, options.limit);
    const last = page.at(-1);
    const hasMore = shipments.length > options.limit;

    return {
      snapshots: page.map((shipment) => this.snapshot(shipment, now)),
      nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  private async findOrThrow(id: string): Promise<Shipment> {
    const shipment = await this.repository.findById(id);
    if (shipment === null) throw new ShipmentNotFoundError(`shipment ${id} not found`);
    return shipment;
  }

  private snapshot(shipment: Shipment, now: Date = this.clock.now()): ShipmentSnapshot {
    const delayLimitHours = shipment.delayLimitHours ?? this.defaultDelayLimitHours;
    return {
      shipment,
      status: currentStatus(shipment.events),
      isDelayed: isDelayed(shipment.events, delayLimitHours, now),
      delayLimitHours,
      inTransitSince: inTransitSince(shipment.events),
    };
  }
}
