# Test architecture

Drive-In has three test layers with different jobs:

- `player/test/unit` and `server/test/unit` test deterministic policy and state transitions. They do not open sockets, touch disk, or replace globals.
- `player/test/integration` and `server/test/integration` test one real boundary such as HTTP bodies, filesystem caches, WebCodecs orchestration, or stream pipelines. External dependencies are injected.
- `test/e2e` starts the real Drive-In server in an isolated runtime directory. It drives public HTTP and WebSocket APIs, verifies rewind cache reuse against a local origin, and uses Chromium to prove that Mediabunny/WebCodecs paints frames to the Canvas.

An assertion belongs at the lowest layer that can prove the behavior. E2E tests cover a complete user journey and should not repeat every edge case from unit tests.

Tests must not use the repository's normal runtime state. Process-level tests set `DRIVEIN_RUNTIME_DIR`; network tests use local origins or injected transports. Do not mutate `globalThis.fetch`, share ports, call YouTube/Plex, or depend on an existing Drive-In process.

Run the layers independently:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

`npm run check` runs all three layers followed by the production player build.
