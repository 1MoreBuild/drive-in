# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Drive-In, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. Use [GitHub Security Advisories](https://github.com/1MoreBuild/drive-in/security/advisories/new) to report privately
3. Or email the maintainers directly

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The following are in scope for security reports:

- **Server-Side Request Forgery (SSRF)** via proxy endpoints
- **Path traversal** in file serving or caching
- **WebSocket abuse** (unauthorized commands, state manipulation)
- **Token/credential leakage** in logs, responses, or error messages
- **Command injection** via URL or parameter handling (yt-dlp, ffmpeg)

## Out of Scope

- Issues requiring physical access to the host machine
- Denial of service via resource exhaustion (known limitation of local-only design)

## Security Design

- WebSocket `updateState` only accepts the `status` field from player clients (sanitized)
- HTTP APIs, WebSocket control, and proxy endpoints do not currently have application-level authentication
- Public deployments must add an access layer such as Cloudflare Access, a VPN, or a trusted-network firewall
- yt-dlp commands have a 30-second timeout to prevent hanging
- Environment variables are used for all secrets (Plex tokens, API keys)
- No secrets are stored in the codebase
