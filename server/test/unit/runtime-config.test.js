import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ytdlpCookieArgs } from "../../ytdlp-options.js";

test("cookies are optional and an explicit file takes precedence", () => {
  assert.deepEqual(ytdlpCookieArgs({}), []);
  assert.deepEqual(ytdlpCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: "chrome:Profile 1" }), ["--cookies-from-browser", "chrome:Profile 1"]);
  assert.deepEqual(ytdlpCookieArgs({ YTDLP_COOKIES_FILE: "/private/cookies.txt", YTDLP_COOKIES_FROM_BROWSER: "chrome" }), ["--cookies", "/private/cookies.txt"]);
});

test("env file loads before runtime paths and preserves exported settings from any cwd", (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "drive-in-env-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = resolve(dir, "test.env");
  writeFileSync(envPath, `DRIVEIN_RUNTIME_DIR=${dir}\nDRIVEIN_CONFIG_FIXTURE=file\nDRIVEIN_PRIORITY_FIXTURE=file\n`);
  const environmentUrl = new URL("../../environment.js", import.meta.url).href;
  const pathsUrl = new URL("../../runtime-paths.js", import.meta.url).href;
  const script = `import ${JSON.stringify(environmentUrl)}; import { runtimeRoot } from ${JSON.stringify(pathsUrl)}; console.log(JSON.stringify([runtimeRoot, process.env.DRIVEIN_CONFIG_FIXTURE, process.env.DRIVEIN_PRIORITY_FIXTURE]));`;
  const env = { ...process.env, DRIVEIN_ENV_FILE: envPath, DRIVEIN_PRIORITY_FIXTURE: "exported" };
  delete env.DRIVEIN_RUNTIME_DIR;
  delete env.DRIVEIN_CONFIG_FIXTURE;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), [dir, "file", "exported"]);
  for (const path of ["", resolve(dir, "missing.env")]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(environmentUrl)}`], { cwd: dir, env: { ...env, DRIVEIN_ENV_FILE: path } });
  }
});
