import { deliveredAt, delayState, inTransitSince } from "./delay.ts";
import type { DelayState } from "./delay.ts";
import { TrackingProviderError } from "./ports.ts";
import type { Clock, ShipmentRepository, TrackingProvider } from "./ports.ts";
import { currentStatus } from "./status.ts";
import type { PageCursor, Shipment, ShipmentStatus } from "./types.ts";

export interface ShipmentSnapshot {
  shipment: Shipment;
  /** `null` enquanto nenhum evento com tradução conhecida chegou. */
  status: ShipmentStatus | null;
  isDelayed: boolean;
  /** Separa o atrasado (ainda em trânsito) do entregue com atraso. */
  delayState: DelayState;
  /** Onde o relógio do trânsito parou; `null` enquanto não há entrega. */
  deliveredAt: Date | null;
  /** Limite que valeu para este envio: o próprio ou o global. */
  delayLimitHours: number;
  inTransitSince: Date | null;
}

/** O que uma rodada do job de aviso fez. */
export interface DelayJobReport {
  /** Envios atrasados e sem aviso que o job reconsultou. */
  checked: number;
  notified: number;
  /** Atrasados no banco local, mas não mais depois da reconsulta. */
  noLongerDelayed: number;
  /** Reconsultas que falharam; esses envios ficam para a próxima rodada. */
  providerFailures: number;
}

const DELAY_JOB_PAGE_SIZE = 100;

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

  async getDelay(id: string): Promise<{ snapshot: ShipmentSnapshot; notifiedAt: Date | null }> {
    const snapshot = await this.get(id);
    return { snapshot, notifiedAt: await this.repository.findDelayNotice(id) };
  }

  /**
   * Grava o aviso dos envios atrasados que ainda não têm aviso. O banco local pode
   * estar velho, então cada envio é reconsultado na origem antes: só recebe aviso
   * o que continua atrasado com o histórico novo. Sem resposta da origem, não há aviso.
   */
  async notifyDelays(options: { pageSize?: number } = {}): Promise<DelayJobReport> {
    const pageSize = options.pageSize ?? DELAY_JOB_PAGE_SIZE;
    const report: DelayJobReport = { checked: 0, notified: 0, noLongerDelayed: 0, providerFailures: 0 };

    let after: PageCursor | null = null;
    do {
      const page: Shipment[] = await this.repository.list({
        limit: pageSize,
        after,
        delayed: true,
        withoutDelayNotice: true,
        now: this.clock.now(),
        defaultDelayLimitHours: this.defaultDelayLimitHours,
      });

      for (const shipment of page) {
        report.checked++;
        const outcome = await this.notifyIfStillDelayed(shipment.id);
        if (outcome === "notified") report.notified++;
        if (outcome === "no_longer_delayed") report.noLongerDelayed++;
        if (outcome === "provider_failure") report.providerFailures++;
      }

      const last = page.at(-1);
      after = page.length === pageSize && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null;
    } while (after !== null);

    return report;
  }

  private async notifyIfStillDelayed(
    id: string,
  ): Promise<"notified" | "already_notified" | "no_longer_delayed" | "provider_failure"> {
    let fresh: ShipmentSnapshot;
    try {
      fresh = await this.refresh(id);
    } catch (error) {
      if (!(error instanceof TrackingProviderError)) throw error;
      return "provider_failure";
    }
    if (!fresh.isDelayed) return "no_longer_delayed";

    // Outra rodada pode ter gravado o aviso enquanto esta reconsultava.
    const recorded = await this.repository.recordDelayNotice(id, this.clock.now());
    return recorded ? "notified" : "already_notified";
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
    const state = delayState(shipment.events, delayLimitHours, now);
    return {
      shipment,
      status: currentStatus(shipment.events),
      isDelayed: state === "delayed",
      delayState: state,
      deliveredAt: deliveredAt(shipment.events),
      delayLimitHours,
      inTransitSince: inTransitSince(shipment.events),
    };
  }
}
