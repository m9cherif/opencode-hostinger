"use strict";

// ---------------------------------------------------------------------------
// OpenCode web UI behind Hostinger Node.js hosting (v13).
//
// What changed in v13 and why
// ---------------------------
// v11/v12 tried to hand the public port over to OpenCode ("handoff"). That
// cannot work on this host: LSNODE gives each app worker its public socket
// through an inherited fd / preload shim, and it only honours the FIRST
// listen() per process. A child process that binds its own TCP port is
// reachable only from the outside, but the web server (LSWS) does not route
// to it - it routes to the app worker. The result was: child prints its
// banner, owns a LISTEN socket, and every request to the domain hangs.
//
// v13 keeps THIS process listening for its whole life (satisfying the 3s
// startup check and every later request) and reverse-proxies HTTP, SSE and
// WebSocket traffic to one shared OpenCode child. Only one child is used for
// both app workers; a /tmp lock file elects the single spawner, and health
// probes decide when the child must be replaced.
//
// Because the transport from this uid to a local port is unusual on this
// host, the proxy tries several targets (127.0.0.1, 0.0.0.0, ::1, the public
// address) and remembers the first that answers. Every attempt is logged and
// exposed on /__probe so the choice is never a guess.
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dns = require("node:dns");

const port = Number(process.env.PORT);
const password = process.env.OPENCODE_SERVER_PASSWORD;
const PORT_HEX = port.toString(16).toUpperCase().padStart(4, "0");

const binary =
  process.env.OPENCODE_BIN ||
  path.join("/home/u170282392", "opencode-1.19.3-test", "opencode");

const workdir = process.env.OPENCODE_WORKDIR || __dirname;

// LSNODE sets HOME to the domain directory on this host.
const homeDir = (process.env.HOME || "/home/u170282392").split("/domains/")[0];

const docroot = path.join(homeDir, "domains/opencode1.chrif.net/public_html");
const diagFile = path.join(docroot, "diag.txt");
const childLogFile = path.join(docroot, "childlog.txt");

// One shared child for every worker of this site.
const childPort = Number(process.env.OPENCODE_CHILD_PORT || 4321);
const lockFile = path.join("/tmp", `opencode-child-${childPort}.lock`);

const SPAWN_GATE_THREADS = 130;
const PRESSURE_THREADS = 170;
const PROBE_INTERVAL_MS = 8000;
const PROBE_TIMEOUT_MS = 5000;
const NO_TRANSPORT_GRACE_MS = 45000;
const LOCK_STALE_MS = 60000;

if (!Number.isInteger(port) || port < 1 || port > 65000) {
  console.error("ERROR: Hostinger did not provide a valid PORT.");
  process.exit(1);
}

if (!password || password.length < 12) {
  console.error(
    "ERROR: Set OPENCODE_SERVER_PASSWORD to a strong password (at least 12 characters)."
  );
  process.exit(1);
}

try {
  fs.accessSync(binary, fs.constants.X_OK);
  fs.accessSync(workdir, fs.constants.R_OK);
} catch (error) {
  console.error("ERROR: OpenCode binary or workspace is unavailable.");
  console.error(error.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State + logging
// ---------------------------------------------------------------------------
const events = [];
const state = {
  phase: "init",
  spawnCount: 0,
  lastSpawn: null,
  lastSpawnThreads: null,
  lastExit: null,
  consecutiveFailures: 0,
  probeFailures: 0,
  gateSkips: 0,
  kills: [],
  chmod: "not-tried",
  lock: "unknown",
  transport: null,
  probes: [],
  req: 0,
  proxyOk: 0,
  proxyErr: 0,
  lastProxyErr: null,
  upgradeOk: 0,
  upgradeErr: 0,
  listening: false,
  transportSince: null,
};

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  events.push(line);
  if (events.length > 120) events.shift();
  console.log(message);
}

// ---------------------------------------------------------------------------
// Host introspection (pure fs reads, no fork)
// ---------------------------------------------------------------------------
function readPidsCgroup() {
  const out = {};
  for (const dir of [path.join("/sys/fs/cgroup/pids", "lve170282392"), "/sys/fs/cgroup"]) {
    try {
      out.max = fs.readFileSync(path.join(dir, "pids.max"), "utf8").trim();
      out.current = fs.readFileSync(path.join(dir, "pids.current"), "utf8").trim();
      out.source = dir;
      break;
    } catch {}
  }
  if (!out.max) {
    try {
      const txt = fs.readFileSync("/proc/self/cgroup", "utf8");
      const m = txt.match(/pids:([^\n]*)/);
      out.cgroupLine = m ? m[1].trim() : "unparsed";
    } catch (e) {
      out.cgroupLine = "unreadable:" + e.code;
    }
  }
  return out;
}

function readDisk() {
  const out = {};
  for (const p of ["/tmp", homeDir, workdir]) {
    try {
      const s = fs.statfsSync(p);
      out[p] = `${Math.floor((s.bavail * s.bsize) / 1048576)}MB avail`;
    } catch (e) {
      out[p] = "err:" + (e.code || e.message);
    }
  }
  return out;
}

function readProcScan() {
  let myUid = null;
  try {
    const m = fs.readFileSync("/proc/self/status", "utf8").match(/Uid:\s+(\d+)/);
    if (m) myUid = m[1];
  } catch {}

  const procs = [];
  let ourTotalThreads = 0;
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return { myUid, ourTotalThreads, procs, error: "readdir /proc failed" };
  }

  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const base = `/proc/${e}`;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`${base}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmd) continue;
    let threads = 0;
    let st = "?";
    let uid = "";
    try {
      const status = fs.readFileSync(`${base}/status`, "utf8");
      const t = status.match(/Threads:\s+(\d+)/);
      if (t) threads = Number(t[1]);
      const s = status.match(/State:\s+(\S)/);
      if (s) st = s[1];
      const u = status.match(/Uid:\s+(\d+)/);
      if (u) uid = u[1];
    } catch {}
    if (myUid && uid === myUid) ourTotalThreads += threads;
    procs.push({ pid: Number(e), threads, st, cmd: cmd.slice(0, 200) });
  }
  return { myUid, ourTotalThreads, procs };
}

function listenersOn(hex) {
  const found = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let txt = "";
    try {
      txt = fs.readFileSync(f, "utf8");
    } catch (e) {
      found.push({ f, error: e.code });
      continue;
    }
    for (const line of txt.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const st = parts[3] || "";
      if (local.endsWith(`:${hex}`) && st === "0A") {
        const txrx = parts[4] || "0:0";
        found.push({
          f,
          local,
          inode: parts[9] || "?",
          backlog: Number(txrx.split(":")[1] || "0") || 0,
        });
      }
    }
  }
  return found;
}

function portOwnerInfo() {
  return listenersOn(PORT_HEX);
}

function findSocketOwner(inode) {
  const target = `socket:[${inode}]`;
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${e}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${e}/fd/${fd}`) === target) {
          let cmd = "";
          try {
            cmd = fs.readFileSync(`/proc/${e}/cmdline`, "utf8").replace(/\0/g, " ").trim();
          } catch {}
          return { pid: Number(e), cmd: cmd.slice(0, 220) };
        }
      } catch {}
    }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidCmd(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function pidCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function pidEtime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[19]) || 0; // field 22 (starttime) offset in the trimmed split
  } catch {
    return 0;
  }
}

// All OpenCode processes that belong to this site (our binary + our workspace).
function ourOpencodePids() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmd.includes(binary)) continue;
    if (!cmd.includes(" web ")) continue;
    const cwd = pidCwd(pid);
    if (cwd && cwd !== workdir) continue;
    out.push({ pid, cmd: cmd.trim().slice(0, 200) });
  }
  return out;
}

function killPid(pid, kind) {
  try {
    process.kill(pid, "SIGKILL");
    state.kills.push({ pid, kind, at: new Date().toISOString() });
    if (state.kills.length > 60) state.kills.shift();
    log(`Killed ${kind} pid=${pid}`);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") log(`kill ${kind} pid=${pid} failed: ${error.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared-child election
// ---------------------------------------------------------------------------
function readLock() {
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const [pidStr, tsStr] = raw.split(" ");
    return { pid: Number(pidStr), ts: Number(tsStr) };
  } catch {
    return null;
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      state.lock = "held";
      log(`Acquired spawner lock ${lockFile}.`);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        state.lock = "error:" + (error.code || error.message);
        log(`Lock error: ${state.lock}; acting as spawner.`);
        return true;
      }
    }
    const cur = readLock();
    const age = cur ? Date.now() - cur.ts : Infinity;
    const alive = cur && cur.pid ? pidAlive(cur.pid) : false;
    if (cur && (age > LOCK_STALE_MS || !alive)) {
      log(`Breaking stale lock (pid=${cur.pid} alive=${alive} age=${Math.round(age / 1000)}s).`);
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      continue;
    }
    state.lock = `waiting(pid=${cur ? cur.pid : "?"})`;
    log(`Spawner lock held by pid=${cur ? cur.pid : "?"}; acting as proxy.`);
    return false;
  }
  state.lock = "gave-up";
  log("Could not acquire spawner lock; acting as proxy.");
  return false;
}

function releaseLock() {
  try {
    const cur = readLock();
    if (!cur || cur.pid === process.pid) fs.unlinkSync(lockFile);
  } catch {}
  state.lock = "released";
}

// ---------------------------------------------------------------------------
// filebrowser leak control (thread budget on the shared uid)
// ---------------------------------------------------------------------------
function lockdownFilebrowser() {
  const dir = path.join(homeDir, ".filebrowser");
  try {
    const st = fs.statSync(dir);
    if ((st.mode & 0o222) !== 0) {
      fs.chmodSync(dir, 0o555);
      state.chmod = "0555";
      log(`Locked ${dir} (0555): filebrowser respawns cannot create session DBs.`);
    } else {
      state.chmod = "already-locked";
    }
  } catch (error) {
    state.chmod = "failed:" + (error.code || error.message);
    log(`filebrowser lockdown skipped: ${state.chmod}`);
  }
}

function killLeechers() {
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmd.includes("/usr/local/bin/filebrowser") || !cmd.includes(homeDir)) continue;
    killPid(pid, "filebrowser");
  }
}

// ---------------------------------------------------------------------------
// Transport probing: which local address actually reaches the child?
// ---------------------------------------------------------------------------
let transport = null;
// The machine's public IPv4 (the only local address reachable from this uid).
let publicIp = process.env.PUBLIC_IPV4 || "217.65.157.33";

// Measured on this host: connects to any address of this machine that route
// through the loopback interface are refused for this uid (even to our own
// child's freshly bound port), while a connect to the machine's PUBLIC IPv4
// address succeeds and reaches the child. So the public IPv4 is the primary
// transport; the loopback variants stay as fast-failing fallbacks.
function candidateTargets() {
  const list = [];
  if (publicIp) list.push({ name: `public4:${publicIp}`, host: publicIp, port: childPort });
  list.push({ name: "127.0.0.1", host: "127.0.0.1", port: childPort });
  list.push({ name: "0.0.0.0", host: "0.0.0.0", port: childPort });
  list.push({ name: "::1", host: "::1", port: childPort });
  return list;
}

function probeTarget(target, pathName = "/", timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve({ ...target, ...result, ms: Date.now() - started });
    };
    let preq;
    try {
      preq = http.request(
        {
          host: target.host,
          port: target.port,
          path: pathName,
          method: "GET",
          agent: false,
          headers: { host: `127.0.0.1:${childPort}`, accept: "*/*" },
        },
        (pres) => {
          // Any HTTP status proves the child is answering.
          pres.resume();
          finish({ ok: true, status: pres.statusCode });
        }
      );
    } catch (error) {
      finish({ ok: false, error: error.code || error.message });
      return;
    }
    preq.setTimeout(timeoutMs, () => {
      preq.destroy(new Error("probe-timeout"));
    });
    preq.on("error", (error) => finish({ ok: false, error: error.code || error.message }));
    preq.end();
  });
}

async function probeAll(reason) {
  const results = [];
  for (const target of candidateTargets()) {
    // eslint-disable-next-line no-await-in-loop
    const r = await probeTarget(target);
    results.push(r);
  }
  state.probes = results;
  const ok = results.find((r) => r.ok);
  const summary = results
    .map((r) => `${r.name}=${r.ok ? `ok/${r.status}` : `fail(${r.error})`}`)
    .join(" ");
  if (ok) {
    if (!transport || transport.host !== ok.host) {
      transport = { host: ok.host, port: ok.port, name: ok.name };
      state.transport = ok.name;
      state.transportSince = new Date().toISOString();
      state.probeFailures = 0;
      log(`Transport selected: ${ok.name}:${ok.port} (${reason}) ${summary}`);
    } else {
      state.probeFailures = 0;
    }
    state.phase = "serving";
  } else {
    if (transport) log(`Transport ${state.transport} lost (${reason}): ${summary}`);
    transport = null;
    state.transport = null;
    log(`No transport available (${reason}): ${summary}`);
  }
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// HTTP/SSE/WebSocket reverse proxy
// ---------------------------------------------------------------------------
function upstreamOptions(req) {
  return {
    host: transport.host,
    port: transport.port,
    path: req.url,
    method: req.method,
    agent: false,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${childPort}`,
      "x-forwarded-host": req.headers.host || "",
      "x-forwarded-proto": "https",
      connection: "keep-alive",
    },
  };
}

function serveWait(res, note) {
  res.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "5",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>OpenCode starting</title>` +
      `<body style="font:16px/1.5 system-ui;padding:2rem;max-width:40rem">` +
      `<h1>OpenCode is starting</h1><p>${note}</p>` +
      `<p>This page refreshes automatically.</p>` +
      `<script>setTimeout(()=>location.reload(),5000)</script>`
  );
}

function proxyRequest(req, res) {
  state.req += 1;
  if (req.url === "/__diag") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(buildDiagText("http"));
    return;
  }
  if (req.url === "/__probe") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ transport, probes: state.probes, since: state.transportSince }, null, 2));
    return;
  }
  if (req.url === "/__childlog") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    try {
      res.end(fs.readFileSync(childLogFile, "utf8"));
    } catch {
      res.end("(no child output captured yet)\n");
    }
    return;
  }
  if (!transport) {
    serveWait(res, `Child port ${childPort} is not answering yet.`);
    return;
  }

  const preq = http.request(upstreamOptions(req), (pres) => {
    state.proxyOk += 1;
    const headers = { ...pres.headers };
    delete headers.connection;
    try {
      res.writeHead(pres.statusCode || 502, headers);
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}
    pres.pipe(res);
    pres.on("error", () => res.destroy());
  });

  preq.setTimeout(150000, () => preq.destroy(new Error("upstream-timeout")));
  preq.on("error", (error) => {
    state.proxyErr += 1;
    state.lastProxyErr = `${new Date().toISOString()} ${error.message}`;
    transport = null;
    state.transport = null;
    if (!res.headersSent) serveWait(res, `Upstream error: ${error.message}`);
    else res.destroy();
  });
  req.pipe(preq);
}

// WebSocket / upgrade passthrough.
function proxyUpgrade(req, socket, head) {
  if (!transport) {
    state.upgradeErr += 1;
    socket.destroy();
    return;
  }
  const preq = http.request({ ...upstreamOptions(req), method: req.method });
  preq.on("upgrade", (pres, psocket, phead) => {
    state.upgradeOk += 1;
    let raw = `HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || "Switching Protocols"}\r\n`;
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      raw += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    }
    raw += "\r\n";
    try {
      socket.write(raw);
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psocket.write(head);
    } catch {}
    psocket.on("error", () => socket.destroy());
    socket.on("error", () => psocket.destroy());
    psocket.pipe(socket);
    socket.pipe(psocket);
  });
  preq.on("response", (pres) => {
    // Upstream refused the upgrade: pass the plain response through.
    state.upgradeErr += 1;
    let raw = `HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || ""}\r\n`;
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      raw += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    }
    raw += "\r\n";
    try {
      socket.write(raw);
      pres.pipe(socket);
    } catch {}
  });
  preq.on("error", () => {
    state.upgradeErr += 1;
    socket.destroy();
  });
  preq.end();
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------
let child = null;
let childRunning = false;
let bannerSeen = false;
let childStartedAt = 0;
let spawnTimer = null;
let shuttingDown = false;
let childTail = "";
let isSpawner = false;

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.UV_THREADPOOL_SIZE = "4";
  env.OPENCODE_SERVER_PASSWORD = password;
  return env;
}

function scheduleSpawn(delay) {
  if (shuttingDown || spawnTimer || childRunning) return;
  spawnTimer = setTimeout(() => {
    spawnTimer = null;
    trySpawn();
  }, delay);
}

function childPortBusy() {
  return listenersOn(childPort.toString(16).toUpperCase().padStart(4, "0"));
}

function trySpawn() {
  if (shuttingDown || childRunning || spawnTimer) return;
  if (!isSpawner) {
    // Re-check the lock: the holder may have died, leaving us the job.
    if (!acquireLock()) {
      scheduleSpawn(15000);
      return;
    }
    isSpawner = true;
  }

  // Thread headroom gate (spawn EAGAIN / Bun SIGABRT protection).
  let scan = readProcScan();
  if (scan.ourTotalThreads > SPAWN_GATE_THREADS) {
    lockdownFilebrowser();
    killLeechers();
    scan = readProcScan();
    if (scan.ourTotalThreads > SPAWN_GATE_THREADS) {
      state.gateSkips += 1;
      if (state.gateSkips <= 20) {
        log(`Gate: threads=${scan.ourTotalThreads} > ${SPAWN_GATE_THREADS}; waiting (skip ${state.gateSkips}).`);
        scheduleSpawn(1500);
        return;
      }
      log(`Gate: bypassing after ${state.gateSkips} skips (threads=${scan.ourTotalThreads}).`);
    }
  }
  state.gateSkips = 0;

  // Only the lock holder spawns, so any process still on the child port is a
  // leftover from an older generation: remove it first.
  for (const p of ourOpencodePids()) {
    killPid(p.pid, "stale-opencode");
  }
  const busy = childPortBusy();
  if (busy.length > 0) {
    log(`Child port ${childPort} still held (${JSON.stringify(busy)}); retry shortly.`);
    scheduleSpawn(2500);
    return;
  }

  spawnChild(scan);
}

function spawnChild(scan) {
  state.spawnCount += 1;
  state.lastSpawn = new Date().toISOString();
  state.lastSpawnThreads = scan.ourTotalThreads;
  bannerSeen = false;
  childTail = "";
  childStartedAt = Date.now();
  state.phase = "child-booting";
  const pids = readPidsCgroup();
  log(
    `Spawning OpenCode on 0.0.0.0:${childPort} (spawn #${state.spawnCount}) threads=${scan.ourTotalThreads} procs=${scan.procs.length} pids=${pids.current || "?"}/${pids.max || "?"}`
  );

  child = spawn(binary, ["web", "--hostname", "0.0.0.0", "--port", String(childPort)], {
    cwd: workdir,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  childRunning = true;

  child.stdout.on("data", (d) => handleChildOutput(String(d)));
  child.stderr.on("data", (d) => handleChildOutput(String(d)));

  child.once("error", (error) => {
    childRunning = false;
    log(`ERROR: Could not start OpenCode: ${error.message}`);
    state.consecutiveFailures += 1;
    releaseLock();
    isSpawner = false;
    scheduleSpawn(5000);
  });

  child.once("exit", (code, signal) => {
    const uptime = Date.now() - childStartedAt;
    const hadBanner = bannerSeen;
    childRunning = false;
    bannerSeen = false;
    const scanNow = readProcScan();
    state.lastExit = `code=${code} signal=${signal || "none"} uptime=${uptime}ms`;
    const tail = childTail.slice(-400).replace(/\s+/g, " ");
    log(
      `OpenCode exited. ${state.lastExit} threadsAtSpawn=${state.lastSpawnThreads} threadsNow=${scanNow.ourTotalThreads} tail=${JSON.stringify(tail)}`
    );
    if (shuttingDown) return;
    if (hadBanner) state.consecutiveFailures = 0;
    else state.consecutiveFailures += 1;
    transport = null;
    state.transport = null;
    releaseLock();
    isSpawner = false;
    scheduleSpawn(state.consecutiveFailures <= 6 ? 3000 : 10000);
  });
}

const childOutRing = [];

function handleChildOutput(text) {
  if (childTail.length < 8000) childTail += text;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) childOutRing.push(line);
  }
  if (childOutRing.length > 300) childOutRing.splice(0, childOutRing.length - 300);

  if (!bannerSeen && /Web interface:|Local access:/.test(text)) {
    bannerSeen = true;
    state.consecutiveFailures = 0;
    log(`OpenCode banner seen (child listening on ${childPort}); probing transports.`);
    setTimeout(() => {
      probeAll("banner").catch(() => {});
    }, 500).unref();
  }
}

setInterval(() => {
  if (childOutRing.length === 0) return;
  const batch = childOutRing.splice(0, childOutRing.length);
  try {
    let existing = "";
    try {
      existing = fs.readFileSync(childLogFile, "utf8");
    } catch {}
    existing += batch.map((l) => `[c] ${l}`).join("\n") + "\n";
    if (existing.length > 60000) existing = existing.slice(existing.length - 50000);
    fs.writeFileSync(childLogFile, existing, "utf8");
  } catch {}
  for (const line of batch) log(`CHILD: ${line.slice(0, 300)}`);
}, 2000).unref();

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function buildDiagText(note) {
  const scan = readProcScan();
  const pids = readPidsCgroup();
  const disk = readDisk();
  const lines = [];
  lines.push(`time=${new Date().toISOString()} note=${note} workerPid=${process.pid}`);
  lines.push(
    `uid=${scan.myUid} ourThreads=${scan.ourTotalThreads} ourProcs=${scan.procs.length} load=${os.loadavg().map(Math.round).join(",")} freeMB=${Math.round(os.freemem() / 1048576)}`
  );
  lines.push(`pids.max=${pids.max || "?"} pids.current=${pids.current || "?"} pidsSource=${pids.source || pids.cgroupLine || "?"}`);
  lines.push(`disk=${JSON.stringify(disk)}`);
  lines.push(
    `phase=${state.phase} publicPort=${port} childPort=${childPort} listening=${state.listening} child=${childRunning ? (child && child.pid) || "?" : "down"} banner=${bannerSeen} spawns=${state.spawnCount} threadsAtSpawn=${state.lastSpawnThreads} failures=${state.consecutiveFailures} locks=${state.lock} spawner=${isSpawner}`
  );
  lines.push(`transport=${state.transport || "none"} since=${state.transportSince || "-"} probeFailures=${state.probeFailures}`);
  lines.push(`probes=${JSON.stringify(state.probes)}`);
  lines.push(`req=${state.req} proxyOk=${state.proxyOk} proxyErr=${state.proxyErr} upgradeOk=${state.upgradeOk} upgradeErr=${state.upgradeErr} lastProxyErr=${state.lastProxyErr || "-"}`);
  lines.push(`publicSockets=${JSON.stringify(portOwnerInfo())} childSockets=${JSON.stringify(childPortBusy())}`);
  lines.push(`chmod=${state.chmod} kills=${JSON.stringify(state.kills.slice(-16))}`);
  lines.push("--- our opencode processes ---");
  for (const p of ourOpencodePids()) lines.push(`${p.pid} etimeTicks=${pidEtime(p.pid)} ${p.cmd}`);
  lines.push("--- procs (pid thr state cmdline), top 30 by threads ---");
  for (const p of scan.procs.slice().sort((a, b) => b.threads - a.threads).slice(0, 30)) {
    lines.push(`${p.pid} ${p.threads} ${p.st} ${p.cmd}`);
  }
  lines.push("--- last app events ---");
  for (const e of events) lines.push(e);
  return lines.join("\n") + "\n";
}

function writeDiag(note) {
  try {
    fs.writeFileSync(diagFile, buildDiagText(note), "utf8");
  } catch {}
}

// ---------------------------------------------------------------------------
// Server: listen EXACTLY ONCE, for the lifetime of the process.
// ---------------------------------------------------------------------------
const server = http.createServer(proxyRequest);
server.on("upgrade", proxyUpgrade);
server.on("clientError", (error, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0;

server.once("listening", () => {
  state.listening = true;
  state.phase = "listening";
  log(`Server listening on 0.0.0.0:${port} (worker pid=${process.pid}); proxy target port ${childPort}.`);
  writeDiag("listening");
});

server.on("error", (error) => {
  state.listening = false;
  log(`ERROR: listen on ${port} failed: ${error.code || error.message}`);
});

server.listen(port, "0.0.0.0"); // must stay the first and only listen() call

// ---------------------------------------------------------------------------
// Startup + supervision
// ---------------------------------------------------------------------------
lockdownFilebrowser();
killLeechers();
isSpawner = acquireLock();
writeDiag("startup");

// The child is shared, so even non-spawner workers probe it.
setTimeout(() => {
  probeAll("startup")
    .then((ok) => {
      if (!ok) scheduleSpawn(100);
      else state.phase = "serving";
    })
    .catch(() => {});
}, 1500).unref();

dns.promises
  .resolve4("opencode1.chrif.net")
  .then((list) => {
    if (list && list.length) {
      publicIp = list[0];
      log(`Public IPv4 for the child transport: ${publicIp}`);
    }
  })
  .catch(() => {
    if (!publicIp) log("Could not resolve the public IPv4; loopback fallbacks only.");
  });

setInterval(async () => {
  if (shuttingDown) return;
  const scan = readProcScan();
  if (scan.ourTotalThreads > PRESSURE_THREADS) {
    log(`Thread pressure (${scan.ourTotalThreads} > ${PRESSURE_THREADS}); reaping.`);
    killLeechers();
  }

  const ok = await probeAll("periodic");
  if (ok) {
    state.probeFailures = 0;
    if (!childRunning && !spawnTimer) state.phase = "serving-shared";
    writeDiag("periodic");
    return;
  }

  state.probeFailures += 1;
  log(`Probe failure ${state.probeFailures}/6.`);
  if (state.probeFailures >= 2 && !childRunning && !spawnTimer) {
    // Either we have no child or it is not ours: make sure the spawner slot is
    // free and take it over if the recorded holder is gone.
    if (!isSpawner) {
      const cur = readLock();
      if (!cur || !pidAlive(cur.pid)) {
        isSpawner = acquireLock();
      }
    }
    scheduleSpawn(500);
  }
  if (state.probeFailures >= 3 && childRunning && Date.now() - childStartedAt > 15000) {
    log(`Child pid=${child && child.pid} not answering after banner; killing it.`);
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  writeDiag("probe-fail");
}, PROBE_INTERVAL_MS).unref();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}; stopping.`);
  if (spawnTimer) clearTimeout(spawnTimer);
  if (child && isSpawner) {
    try {
      child.kill(signal);
    } catch {}
  }
  try {
    server.close();
  } catch {}
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
