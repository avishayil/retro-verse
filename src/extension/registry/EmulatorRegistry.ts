import type { Platform } from '../../protocol/types';
import type { EmulatorAdapter } from '../sessions/Session';

/** Resolves an adapter by platform. Multiple adapters per platform are allowed; the first available wins unless one is preferred by id. */
export class EmulatorRegistry {
  private readonly adapters = new Map<Platform, EmulatorAdapter[]>();

  register(adapter: EmulatorAdapter): void {
    const list = this.adapters.get(adapter.platform) ?? [];
    list.push(adapter);
    this.adapters.set(adapter.platform, list);
  }

  list(platform: Platform): readonly EmulatorAdapter[] {
    return this.adapters.get(platform) ?? [];
  }

  resolve(platform: Platform, preferredId?: string): EmulatorAdapter | undefined {
    const list = this.list(platform);
    return list.find((a) => a.id === preferredId) ?? list[0];
  }
}
