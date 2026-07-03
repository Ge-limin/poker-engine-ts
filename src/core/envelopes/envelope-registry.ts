import { SnapshotIntegrityError } from '../errors';
import type { Upcaster } from '../../types/index';

export class EnvelopeUpcaster<TTarget> {
  private readonly registry = new Map<number, Upcaster<TTarget>>();

  constructor(private readonly latestVersion: number) {}

  register(version: number, upcaster: Upcaster<TTarget>): void {
    this.registry.set(version, upcaster);
  }

  upcast(version: number, payload: unknown): TTarget {
    if (version === this.latestVersion) {
      return payload as TTarget;
    }

    const upcaster = this.registry.get(version);
    if (!upcaster) {
      throw new SnapshotIntegrityError('No upcaster registered for payload', {
        version,
      });
    }

    return upcaster(payload);
  }
}
