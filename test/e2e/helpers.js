import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function startDriveInServer(t) {
  const runtimeDir = await mkdtemp(resolve(tmpdir(), "drive-in-e2e-"));
  const child = fork(resolve(projectRoot, "server/index.js"), [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DRIVEIN_RUNTIME_DIR: runtimeDir,
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      PORT: "0",
      SERVE_SOURCE: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.resume();
  child.stderr.resume();

  const listening = await withTimeout(new Promise((resolveMessage, reject) => {
    child.on("message", (message) => {
      if (message?.type === "drive-in-listening") resolveMessage(message);
    });
    child.once("exit", (code) => reject(new Error(`Drive-In exited before startup (${code})`)));
  }), "Drive-In startup", 10_000);

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await withTimeout(new Promise((resolveExit) => child.once("exit", resolveExit)), "Drive-In shutdown");
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${listening.port}`,
    runtimeDir,
  };
}

export async function connectPlayer(baseUrl, clientId = "tesla-player_e2e") {
  const url = new URL(baseUrl);
  const socket = new WebSocket(
    `ws://${url.host}/ws?role=player&clientId=${encodeURIComponent(clientId)}`,
    { headers: { Origin: baseUrl } },
  );
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  await withTimeout(new Promise((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  }), "player WebSocket connection");

  return {
    socket,
    next(type) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return withTimeout(new Promise((resolveMessage) => {
        waiters.push({ predicate: (message) => message.type === type, resolve: resolveMessage });
      }), `WebSocket message ${type}`);
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolveClose) => socket.once("close", resolveClose));
      socket.close();
      await withTimeout(closed, "player WebSocket close");
    },
  };
}

export async function postJson(baseUrl, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

export async function waitFor(check, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
