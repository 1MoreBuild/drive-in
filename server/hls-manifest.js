export function rewriteHlsUris(body, rewriteUri) {
  return body
    .replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUri(uri)}"`)
    .replace(/^(?!#)(\S+.*)$/gm, (_match, line) => rewriteUri(line.trim()));
}

export function rewriteTranscodePlaylist(body) {
  return rewriteHlsUris(body, (uri) => {
    if (/^https?:\/\//i.test(uri)) return uri;
    const name = uri.split("?")[0].replace(/[\\/]+/g, "").replace(/^\.+/g, "");
    return name ? `/api/transcode/segment?name=${encodeURIComponent(name)}` : uri;
  });
}
