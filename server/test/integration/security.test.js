import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPublicImage,
  isPrivateAddress,
  resolveSubtitleFile,
} from "../../security.js";

test("private and special-use IP addresses are rejected", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.0.1",
    "192.168.1.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("subtitle resolution stays inside the fixed cache root", () => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subs-"));
  const keyDir = join(root, "video_123");
  mkdirSync(keyDir);
  const validFile = join(keyDir, "sub_en.vtt");
  writeFileSync(validFile, "WEBVTT\n");
  assert.equal(resolveSubtitleFile(root, "video_123", "sub_en.vtt"), realpathSync(validFile));
  assert.equal(resolveSubtitleFile(root, "../..", "sub_en.vtt"), null);
  assert.equal(resolveSubtitleFile(root, "video_123", "../sub_en.vtt"), null);
  assert.equal(resolveSubtitleFile(root, "video_123", ".env"), null);
});

test("subtitle resolution rejects symlinks that leave the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subs-"));
  const outside = mkdtempSync(join(tmpdir(), "drivein-outside-"));
  mkdirSync(join(root, "video_123"));
  writeFileSync(join(outside, "secret.vtt"), "secret");
  symlinkSync(join(outside, "secret.vtt"), join(root, "video_123", "sub_en.vtt"));
  assert.equal(resolveSubtitleFile(root, "video_123", "sub_en.vtt"), null);
});

test("thumbnail fetch rejects loopback before opening a connection", async () => {
  await assert.rejects(
    fetchPublicImage("http://127.0.0.1:9/image.jpg"),
    (error) => error.status === 403,
  );
});
