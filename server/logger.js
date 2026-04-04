import pino from "pino";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = resolve(__dirname, "../.logs");
const isDev = process.env.NODE_ENV !== "production";

const targets = [];

if (isDev) {
  // Dev: pretty-printed console output
  targets.push({ target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" }, level: "debug" });
} else {
  // Prod: JSON to stdout
  targets.push({ target: "pino/file", options: { destination: 1 }, level: "info" });
}

// Always: daily rotating log file
targets.push({
  target: "pino-roll",
  options: { file: resolve(logDir, "server"), frequency: "daily", dateFormat: "yyyy-MM-dd", mkdir: true },
  level: "info",
});

// Always: separate error file
targets.push({
  target: "pino-roll",
  options: { file: resolve(logDir, "error"), frequency: "daily", dateFormat: "yyyy-MM-dd", mkdir: true },
  level: "error",
});

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: { targets },
  serializers: { err: pino.stdSerializers.err },
});

export default logger;
