export function ytdlpCookieArgs(env = process.env) {
  const file = env.YTDLP_COOKIES_FILE?.trim();
  const browser = env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (file) return ["--cookies", file];
  if (browser) return ["--cookies-from-browser", browser];
  return [];
}
