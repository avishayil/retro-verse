import * as vscode from 'vscode';
import path from 'node:path';
import { formatForPath, type FormatInfo } from '../registry/formats';

/** Readonly document: stores identity/metadata only, never the ROM bytes. */
export class GameDocument implements vscode.CustomDocument {
  private _romId: string | undefined;

  constructor(
    readonly uri: vscode.Uri,
    readonly format: FormatInfo,
  ) {}

  static create(uri: vscode.Uri): GameDocument {
    const format = formatForPath(uri.path);
    if (!format) throw new Error(`Unsupported game file type: ${path.extname(uri.path) || '(none)'}`);
    return new GameDocument(uri, format);
  }

  get platform() {
    return this.format.platform;
  }

  /** Display title: file name without extension (rendered via textContent in the webview, never as HTML). */
  get title(): string {
    return path.basename(this.uri.path, path.extname(this.uri.path));
  }

  get romId(): string | undefined {
    return this._romId;
  }

  set romId(id: string | undefined) {
    this._romId = id;
  }

  dispose(): void {
    /* nothing held */
  }
}
