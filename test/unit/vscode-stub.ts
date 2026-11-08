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
export const workspace = { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), isTrusted: true };
export const Uri = { file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }), parse: (s: string) => ({ fsPath: s, path: s, scheme: s.split(':')[0] }) };
