import Database from "better-sqlite3";

export function subtitleLanguage(value = "") {
  const lang = String(value).toLowerCase();
  if (/^(zh|zho|chi|中文)/.test(lang)) return "zh";
  if (/^(en|eng|english)/.test(lang)) return "en";
  if (/^(ja|jpn|日本)/.test(lang)) return "ja";
  if (/^(ko|kor|한국)/.test(lang)) return "ko";
  return lang.split("-")[0];
}

// Service-owned state lives alongside the queue in the existing runtime DB.
// Explicit Off is stored as [], distinct from a video with no saved choice.
export class SubtitlePreferences {
  constructor(path) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS subtitle_preferences (source TEXT PRIMARY KEY, selection TEXT NOT NULL)");
    this.read = this.db.prepare("SELECT selection FROM subtitle_preferences WHERE source = ?");
    this.write = this.db.prepare("INSERT INTO subtitle_preferences VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET selection = excluded.selection");
    this.saveTransaction = this.db.transaction((source, selection) => {
      this.write.run(source, JSON.stringify(selection));
      this.write.run("default", JSON.stringify(selection));
    });
  }

  get(source) {
    const row = this.read.get(source);
    return row ? JSON.parse(row.selection) : null;
  }

  save(source, tracks) {
    this.saveTransaction(source, tracks.map((track) => ({
      id: String(track.id ?? track.lang),
      language: subtitleLanguage(track.languageCode || track.lang || track.language),
      title: track.title || "",
      delivery: track.delivery || "external",
    })));
  }

  select(source, tracks) {
    const saved = this.get(source);
    const preferences = saved ?? this.get("default");
    if (preferences === null) return null;
    const chosen = [];
    for (const preference of preferences) {
      const exact = saved && tracks.find((track) => String(track.id ?? track.lang) === preference.id);
      const matching = tracks.filter((track) => subtitleLanguage(track.languageCode || track.lang || track.language) === preference.language);
      const match = exact || matching.find((track) => track.title === preference.title && (track.delivery || "external") === preference.delivery)
        || matching.find((track) => (track.delivery || "external") === preference.delivery) || matching[0];
      if (match && !chosen.includes(match)) chosen.push(match);
    }
    return chosen;
  }

  close() { this.db.close(); }
}
