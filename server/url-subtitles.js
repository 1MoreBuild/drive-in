import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchTextWithRetry } from "./upstream-fetch.js";
import { srtToVtt } from "./plex-subtitles.js";

const MAX_PLEX_SUBTITLE_BYTES = 20 * 1024 * 1024;

export async function downloadSubtitlesDirect(subtitleList, destDir, { log = console } = {}) {
  mkdirSync(destDir, { recursive: true });
  const results = [];
  for (const sub of subtitleList) {
    try {
      let content;

      if (sub.data) {
        // Inline data (Bilibili etc) — already converted to VTT
        content = sub.data;
      } else if (sub.url) {
        const fetchedSubtitle = await fetchTextWithRetry(sub.url, {}, {
          retries: 2,
          label: `subtitle-${sub.lang}`,
          timeoutMs: 30_000,
          maxBytes: MAX_PLEX_SUBTITLE_BYTES,
        });
        const resp = fetchedSubtitle.response;
        if (!resp.ok) {
          log.warn({ lang: sub.lang, status: resp.status }, "Subtitle fetch failed");
          continue;
        }
        content = fetchedSubtitle.body;

        // YouTube returns HLS playlist for long videos — fetch all segments
        if (content.startsWith("#EXTM3U")) {
          const segUrls = content.split("\n").filter((l) => l.startsWith("http"));
          const parts = [];
          let combinedBytes = 0;
          for (const segUrl of segUrls) {
            const fetchedSegment = await fetchTextWithRetry(segUrl, {}, {
              retries: 2,
              label: `subtitle-segment-${sub.lang}`,
              timeoutMs: 30_000,
              maxBytes: MAX_PLEX_SUBTITLE_BYTES,
            });
            if (fetchedSegment.response.ok) {
              combinedBytes += Buffer.byteLength(fetchedSegment.body);
              if (combinedBytes > MAX_PLEX_SUBTITLE_BYTES) {
                throw new Error("Combined subtitle segments are larger than 20 MiB");
              }
              parts.push(fetchedSegment.body);
            }
          }
          content = parts.map((p, i) => {
            if (i === 0) return p;
            return p.replace(/^WEBVTT[\s\S]*?\n\n/, "");
          }).join("\n");
        }

        // SRT → VTT conversion
        if (sub.ext === "srt" && !content.startsWith("WEBVTT")) {
          content = srtToVtt(content);
        }
      } else {
        continue;
      }

      if (!content.includes("-->")) {
        log.warn({ lang: sub.lang }, "No valid subtitle cues");
        continue;
      }

      // Clean VTT: strip cue tags (<c>, timestamp tags) and decode HTML entities
      content = content
        .replace(/<\/?c[^>]*>/g, "")
        .replace(/<[\d:.]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");

      const safeLanguage = String(sub.lang || "unknown")
        .normalize("NFKC")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[_\-.]+|[_\-.]+$/g, "")
        .slice(0, 120) || "unknown";
      const filename = `sub_${safeLanguage}.vtt`;
      writeFileSync(resolve(destDir, filename), content);
      results.push({ lang: sub.lang, name: sub.name, auto: sub.auto, filename });
    } catch (e) {
      log.error({ lang: sub.lang, err: e.message }, "Subtitle fetch error");
    }
  }
  return results;
}
