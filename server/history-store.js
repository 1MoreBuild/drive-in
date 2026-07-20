import { dirname } from "path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";

export function loadHistoryFile(path, { onCorrupt } = {}) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value)) throw new Error("History root must be an array");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    const backupPath = `${path}.corrupt-${Date.now()}-${process.pid}`;
    try {
      renameSync(path, backupPath);
      onCorrupt?.(error, backupPath);
    } catch (backupError) {
      onCorrupt?.(error, null, backupError);
    }
    return [];
  }
}

export function saveHistoryFile(path, history) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}
