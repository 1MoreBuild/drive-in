export function validateMetadataUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    throw new Error("A valid HTTP or HTTPS URL is required");
  }
  const url = new URL(value);
  if (!url.hostname) throw new Error("A valid HTTP or HTTPS URL is required");
  return value;
}

export function metadataArgs(url, commonArgs = []) {
  return [
    ...commonArgs,
    "--no-warnings", "-j", "--no-playlist", "--skip-download",
    "--", validateMetadataUrl(url),
  ];
}
