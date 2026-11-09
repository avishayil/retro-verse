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

/**
 * Variables a setting may not set: code injection (DYLD_*, LD_*), loader/runtime hooks, and anything that changes
 * where the emulator looks for programs, its home, config or temp files.
 */
const BLOCKED = /^(DYLD_|LD_|_RLD|NODE_|ELECTRON_|VSCODE_|RETROVERSE_|XDG_|PATH$|HOME$|TMPDIR$|SHELL$|PYTHON|PERL|RUBY)/i;
/** Inherited variables that are internal to VS Code or RetroVerse and must not reach the emulator. */
const STRIP_PREFIXES = ['ELECTRON_', 'VSCODE_', 'RETROVERSE_'];
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
  const env: NodeJS.ProcessEnv = {};
  // Drop VS Code's internal variables (e.g. ELECTRON_RUN_AS_NODE, VSCODE_IPC_HOOK) and any RetroVerse ones.
  for (const [k, v] of Object.entries(base)) if (!STRIP_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) env[k] = v;
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

/** Environment variables a helper process (the capture agent) actually needs. Everything else is dropped. */
const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'];

/**
 * A small allow-listed environment instead of a copy of the extension host's, which carries VS Code internals
 * (ELECTRON_*, VSCODE_*) and whatever secrets the user's shell exported.
 */
export function minimalEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of MINIMAL_ENV_KEYS) if (typeof base[k] === 'string') env[k] = base[k];
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}
