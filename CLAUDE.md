# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**apricot** is an IRC proxy running on Cloudflare Workers + Durable Objects. It maintains a persistent connection to an IRC server and exposes it via browser (Web UI), WebSocket (IRC clients), and REST API.

## Commands

All commands must be run from the `workers/` directory.

```bash
npm run dev      # Start local dev server at http://localhost:8787
npm run check    # TypeScript type check (tsc --noEmit)
npm test         # Run all tests (Vitest)
npm run deploy   # Deploy to Cloudflare Workers
```

Run a single test file:
```bash
npx vitest run test/modules/web.test.ts
```

Set secrets for production:
```bash
npx wrangler secret put API_KEY
npx wrangler secret put IRC_PASSWORD
npx wrangler secret put CLIENT_PASSWORD
```

Local secrets go in `workers/.dev.vars` (gitignored).

## Architecture

### Request Flow

```
Browser / IRC Client / REST API
        ↓
  src/index.ts  (Worker entry: routing, API key auth)
        ↓
  IrcProxyDO   (Durable Object: per proxy-ID instance)
        ↓
  cloudflare:sockets  (TCP)
        ↓
    IRC server
```

### Source Files

| File | Role |
|------|------|
| `src/index.ts` | Worker entry point, URL routing, Bearer auth |
| `src/irc-proxy.ts` | Durable Object body — state, WebSocket & HTTP handlers, alarm/keepalive |
| `src/irc-connection.ts` | TCP socket lifecycle to IRC server (state machine: idle → pending → processing → destroyed) |
| `src/irc-parser.ts` | Parse/build raw IRC messages (IRCv3 tag support) |
| `src/proxy-config.ts` | Typed env var parsing; `ProxyConfig` (shared) and `ProxyInstanceConfig` (per-proxy persisted overrides) |
| `src/module-system.ts` | plum-compatible module system dispatching `ss_*` / `cs_*` events |
| `src/input-validation.ts` | Shared validation for IRC inputs (channel, nick, message, password) — returns `ValidationResult` |
| `src/custom-css.ts` | CSS sanitization for user-supplied extra CSS |
| `src/irc-text-escape.ts` | Escape IRC formatting chars unsupported in Web UI |
| `src/modules/ping.ts` | Auto PING/PONG |
| `src/modules/channel-track.ts` | Track JOIN/PART/KICK/QUIT/NICK state |
| `src/modules/client-sync.ts` | Replay state to newly connected WebSocket clients |
| `src/modules/web.ts` | Web UI HTML rendering, in-memory message buffer, DO storage persistence |
| `src/modules/url-metadata.ts` | Fetch page title / Twitter oEmbed for URL posts |
| `src/templates/` | HTML and CSS template files (imported as text via wrangler `Text` rules) |
| `src/env.d.ts` | Cloudflare env/binding type declarations |

### Durable Object Keepalive

IRC connections are kept alive by scheduling `storage.setAlarm()` every `KEEPALIVE_INTERVAL` seconds after a connection is established. Each `alarm()` handler re-schedules the next alarm while connected. This prevents the DO from being evicted by Cloudflare's idle timeout.

### Proxy ID Isolation

Each proxy ID (e.g., `myproxy`) maps to a separate Durable Object instance with its own IRC connection, channel state, and message buffers. All instances share the same `wrangler.toml` env vars.

### Config Layering

Nick and autojoin are resolved in priority order (highest first):
1. `ProxyInstanceConfig` — per-proxy overrides persisted in DO storage (`proxy:config:v1`)
2. Proxy ID — sanitized into a valid IRC nick as a fallback
3. `ProxyConfig` / env vars — shared defaults from `wrangler.toml` / `.dev.vars`

`resolveProxyConfig()` merges these layers into a single runtime `ProxyConfig`.

### Template System

HTML pages are built by importing template files as text strings (`src/templates/*.html`) and replacing `{{PLACEHOLDER}}` markers with rendered HTML fragments. The substitution is done with `.replace("{{PLACEHOLDER}}", value)` calls in `modules/web.ts` and `irc-proxy.ts`.

### Module Registration Order

In `IrcProxyDO` constructor, module registration order is significant for `QUIT`/`NICK` events:
1. `pingModule` — handles PING/PONG
2. `web.module` — logs messages (must see full membership before removal)
3. `channelTrackModule` — removes members from channel state
4. `clientSyncModule` — replays state to new clients

### X-Proxy-Prefix Header

`index.ts` injects the `X-Proxy-Prefix` header (e.g., `/proxy/myproxy`) before forwarding requests to the DO. The DO uses this to build absolute URLs for links and form actions visible in the browser.

## Key Patterns

### ValidationResult

All input validation returns a discriminated union:
```typescript
type ValidationResult = { ok: true; value: string } | { ok: false; error: string };
```
Check `result.ok` before using `result.value`.

### DO Route Matching

Routes in `IrcProxyDO.fetch()` are matched by direct string comparison against `url.pathname` (which is relative to the DO — no `/proxy/:id` prefix). There is no router library.

## Testing

Tests live in `workers/test/`. Integration tests for `IrcProxyDO` use `FakeState` / `FakeStorage` classes (defined per test file) that implement the DO storage interface. `cloudflare:sockets` is always mocked.

Template modules are mocked with minimal `{{PLACEHOLDER}}`-containing strings — keep the mock in sync with new placeholders added to the real template.

## Commit Conventions

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/). Write descriptions in Japanese. No emoji. No trailing period in the header line.

```
feat(web): チャンネル一覧ページにリンクを追加
fix: PING 応答の遅延を修正
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
