import { parentPort, workerData } from "worker_threads";
import { analyzeSubtitle } from "./plex-subtitles.js";

try {
  parentPort.postMessage(analyzeSubtitle(workerData.stream, workerData.buffer));
} catch (error) {
  parentPort.postMessage({ error: error.message || String(error) });
}
