import { describe, expect, it } from 'vitest';
import { redact, sanitizeLogLine } from '../../src/extension/diagnostics/Log';

describe('sanitizeLogLine', () => {
  const rom = '/Users/me/Games/Secret Game (USA).nsp';
  it('replaces the game path and home directory', () => {
    const out = sanitizeLogLine(`[Loader] opening ${rom} from /Users/me/.local/share/eden`, [rom], '/Users/me');
    expect(out).not.toContain('Secret Game');
    expect(out).toContain(redact(rom));
    expect(out).toContain('~/.local/share/eden');
    expect(out).not.toContain('/Users/me');
  });
  it('strips terminal escapes and characters that could forge log lines', () => {
    const out = sanitizeLogLine('\u001b[31mred\u001b[0m\rFAKE [info] line\u0000\u0007', [], '/nohome');
    expect(out).toBe('redFAKE [info] line');
  });
  it('caps very long lines', () => {
    expect(sanitizeLogLine('x'.repeat(2000), [], '/nohome').length).toBe(501);
  });
});
