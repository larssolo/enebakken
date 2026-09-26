// Runs every test suite, one at a time (they share one database), each
// with a fresh instance of the local server it talks to. Exits non-zero if
// any suite fails.
//
//   node tests/run.mjs            all suites
//   node tests/run.mjs invites    only suites whose path contains "invites"
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupDatabase } from "./db/setup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

const SUITES = [
  { file: "api/members.test.mjs" },
  { file: "api/ticks.test.mjs" },
  { file: "api/token.test.mjs" },
  { file: "api/invites.test.mjs", server: "invite-server.mjs" },
  { file: "ui/invites.test.mjs", server: "invite-server.mjs" },
  { file: "ui/remember-login.test.mjs", server: "invite-server.mjs" },
  { file: "ui/admin.test.mjs", server: "admin-server.mjs" },
  { file: "ui/uploads.test.mjs", server: "admin-server.mjs" },
  { file: "ui/checklist-reorder.test.mjs", server: "ticks-server.mjs" },
  { file: "ui/shared-ticks.test.mjs", server: "ticks-server.mjs" },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pipeWithPrefix(stream, prefix, sink, onLine) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      sink.write(prefix + line + "\n");
      onLine?.(line);
    }
  });
  stream.on("end", () => { if (buf) sink.write(prefix + buf + "\n"); });
}

// Starts a server and resolves once it says it's listening.
function startServer(file, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "servers", file)], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} did not start within 30s`)); }, 30_000);
    const onLine = (line) => { if (/ on http:\/\//.test(line)) { clearTimeout(timer); resolve(child); } };
    pipeWithPrefix(child.stdout, "  [server] ", process.stdout, onLine);
    pipeWithPrefix(child.stderr, "  [server] ", process.stderr);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`${file} exited early (${code})`)); });
  });
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { console.log(`  timed out after ${SUITE_TIMEOUT_MS / 1000}s`); child.kill("SIGKILL"); }, SUITE_TIMEOUT_MS);
    pipeWithPrefix(child.stdout, "  ", process.stdout);
    pipeWithPrefix(child.stderr, "  ", process.stderr);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve(code === 0 && !signal); });
  });
}

const filters = process.argv.slice(2);
const selected = SUITES.filter((s) => filters.length === 0 || filters.some((f) => s.file.includes(f)));
if (selected.length === 0) {
  console.error(`No suite matches ${filters.join(", ")}`);
  process.exit(1);
}

console.log("Preparing the database");
await setupDatabase();
await rm(path.join(HERE, ".build"), { recursive: true, force: true });

const outcome = [];
for (const suite of selected) {
  console.log(`\n=== ${suite.file}${suite.server ? ` (with ${suite.server})` : ""}`);
  let server = null;
  let passed = false;
  try {
    const env = {};
    if (suite.server) {
      const port = await freePort();
      server = await startServer(suite.server, port);
      server.removeAllListeners("exit");
      env.TEST_BASE_URL = `http://localhost:${port}`;
    }
    passed = await runSuite(suite.file, env);
  } catch (e) {
    console.log(`  ${e.message}`);
  } finally {
    if (server) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill();
      await exited;
    }
  }
  outcome.push({ file: suite.file, passed });
}

console.log("\n=== Summary");
for (const o of outcome) console.log(`${o.passed ? "PASS" : "FAIL"}  ${o.file}`);
const failed = outcome.filter((o) => !o.passed).length;
console.log(failed ? `\n${failed} of ${outcome.length} suites failed` : `\nAll ${outcome.length} suites passed`);
process.exit(failed ? 1 : 0);
