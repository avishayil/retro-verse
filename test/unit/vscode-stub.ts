// Minimal stand-in for the `vscode` module so pure host logic can be unit tested under Node.
export class EventEmitter<T> {
  private ls = new Set<(e: T) => void>();
  event = (l: (e: T) => void) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(e: T) {
    for (const l of this.ls) l(e);
  }
  dispose() {
    this.ls.clear();
  }
}
export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose() {
    this.fn();
  }
}
export const commands = { executeCommand: async () => undefined, registerCommand: () => new Disposable(() => {}) };
export const window = { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, createOutputChannel: () => ({ debug() {}, info() {}, warn() {}, error() {}, show() {}, dispose() {} }) };
/** Test hook: per-key settings as VS Code's inspect() would report them. */
export const __config: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown; defaultValue?: unknown }> = {};
export const workspace = {
  getConfiguration: () => ({
    get: (k: string, d: unknown) => {
      const c = __config[k];
      return c ? (c.workspaceFolderValue ?? c.workspaceValue ?? c.globalValue ?? c.defaultValue ?? d) : d;
    },
    inspect: (k: string) => (__config[k] ? { key: k, ...__config[k] } : undefined),
  }),
  isTrusted: true,
};
export const Uri = { file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }), parse: (s: string) => ({ fsPath: s, path: s, scheme: s.split(':')[0] }) };
