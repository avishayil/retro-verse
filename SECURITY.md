# Security policy

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/avishayil/retro-verse/security/advisories/new) instead of a
public issue.

## What to report

RetroVerse runs emulators in a sandboxed webview and starts native processes for Switch games, so these areas
matter most:

- The webview: its content security policy, message validation, and which local files it can read.
- The capture agent's WebSocket on `127.0.0.1`: token checks, origin checks, and input handling.
- How RetroVerse starts Eden and the capture agent: arguments, environment variables and workspace trust.
- Anything that could send game data or file names off the machine.

[docs/security.md](docs/security.md) describes the current design.

## Supported versions

Only the latest release receives fixes.
