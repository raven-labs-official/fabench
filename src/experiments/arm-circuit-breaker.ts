import type { RetrievalInfrastructureError } from "../retrieval/infrastructure-error.js";

/** A rejected article is local; a provider protocol incompatible with the run is shared. */
export function shouldPauseRetrievalArm(error: RetrievalInfrastructureError): boolean {
  return error.component !== "leak-filter" || error.code === "reasoning_replay_required";
}

export interface ArmCircuitSnapshot {
  arm: string;
  component: RetrievalInfrastructureError["component"];
  code: string;
  reason: string;
  opened_at_utc: string;
  skipped_cells: number;
}

/** Shared state used by concurrent question workers to stop only the affected retrieval arms. */
export class ArmCircuitBreakers {
  private readonly open = new Map<string, ArmCircuitSnapshot>();

  constructor(private readonly webFilterArms: readonly string[]) {}

  openWebFilter(error: RetrievalInfrastructureError): string[] {
    const opened: string[] = [];
    for (const arm of this.webFilterArms) {
      if (this.open.has(arm)) continue;
      this.open.set(arm, {
        arm,
        component: error.component,
        code: error.code,
        reason: error.message,
        opened_at_utc: new Date().toISOString(),
        skipped_cells: 0,
      });
      opened.push(arm);
    }
    return opened;
  }

  isOpen(arm: string): boolean {
    return this.open.has(arm);
  }

  noteSkipped(arm: string): void {
    const state = this.open.get(arm);
    if (state) state.skipped_cells++;
  }

  snapshots(): ArmCircuitSnapshot[] {
    return [...this.open.values()].map((state) => ({ ...state }));
  }
}
