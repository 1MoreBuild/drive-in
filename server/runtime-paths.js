import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(serverDir, "..");

export const runtimeRoot = process.env.DRIVEIN_RUNTIME_DIR
  ? resolve(process.env.DRIVEIN_RUNTIME_DIR)
  : projectRoot;

export function runtimePath(name) {
  return resolve(runtimeRoot, name);
}
