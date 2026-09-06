import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Load before logger, storage and other modules read process.env. Explicit
// environment variables win; an empty override disables file loading in tests.
export function loadProjectEnv(path = process.env.DRIVEIN_ENV_FILE
  ?? fileURLToPath(new URL("../.env", import.meta.url))) {
  if (!path) return;
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

loadProjectEnv();
