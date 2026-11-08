/**
 * Environment for the Eden process.
 *
 * On macOS, Eden runs on MoltenVK, and some builds abort with VK_ERROR_DEVICE_LOST /
 * VK_ERROR_OUT_OF_DEVICE_MEMORY ("Lost VkDevice after MTLCommandBuffer … execution failed") under
 * asynchronous submission. Synchronous queue submits plus MoltenVK's own semaphore emulation avoid it,
 * at a small performance cost. These are the defaults; users can override or remove them (value null).
 */
export const DEFAULT_EDEN_ENV: Readonly<Partial<Record<NodeJS.Platform, Record<string, string>>>> = {
  darwin: {
    MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS: '1',
    MVK_CONFIG_VK_SEMAPHORE_SUPPORT_STYLE: '0',
  },
};

/** Variables that would let a setting inject code into or hijack the emulator process. */
const BLOCKED = /^(DYLD_|LD_|_RLD|NODE_OPTIONS$|ELECTRON_|RETROVERSE_BRIDGE_TOKEN$)/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface EdenEnvResult {
  env: NodeJS.ProcessEnv;
  applied: Record<string, string>;
  rejected: string[];
}

export function edenEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, unknown> | undefined,
  platform: NodeJS.Platform = process.platform,
): EdenEnvResult {
  const env: NodeJS.ProcessEnv = { ...base };
  // The extension host may run as Node (ELECTRON_RUN_AS_NODE); never leak that into a GUI app.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RETROVERSE_BRIDGE_TOKEN;
  const applied: Record<string, string> = {};
  const rejected: string[] = [];
  const merged: Record<string, unknown> = { ...(DEFAULT_EDEN_ENV[platform] ?? {}), ...(overrides ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    if (!NAME.test(k) || BLOCKED.test(k)) {
      rejected.push(k);
      continue;
    }
    if (v === null) {
      delete env[k];
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      rejected.push(k);
      continue;
    }
    const s = String(v);
    if (s.includes('\0') || s.length > 4096) {
      rejected.push(k);
      continue;
    }
    env[k] = s;
    applied[k] = s;
  }
  return { env, applied, rejected };
}
