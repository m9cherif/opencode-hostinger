"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT);
const password = process.env.OPENCODE_SERVER_PASSWORD;

const binary =
  process.env.OPENCODE_BIN ||
  path.join(
    process.env.HOME || "/home/u170282392",
    "opencode-1.19.3-test",
    "opencode"
  );

const workdir = process.env.OPENCODE_WORKDIR || __dirname;

// OpenCode itself listens on this internal loopback port only;
// the public port above is served by the proxy below.
const internalPort = port + 1;

if (!Number.isInteger(port) || port < 1 || port > 65533) {
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
// Public proxy. listen() is called SYNCHRONOUSLY at startup because Hostinger
// kills the app if no server is listening within 3 seconds. OpenCode boots
// much slower than that, so until it is ready the proxy answers 502.
// ---------------------------------------------------------------------------
let opencodeReady = false;

function forwardHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "connection" || key === "keep-alive" || key === "upgrade") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (!opencodeReady) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("OpenCode is starting, please retry in a few seconds...\n");
    return;
  }

  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: internalPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    console.error("Proxy error:", error.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end("OpenCode upstream error.\n");
  });

  req.pipe(proxyReq);
});

// WebSocket support (OpenCode uses sockets for live updates).
server.on("upgrade", (req, socket, head) => {
  if (!opencodeReady) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(internalPort, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      const values = Array.isArray(value) ? value.join(", ") : String(value);
      lines.push(`${key}: ${values}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, "0.0.0.0", () => {
  console.log("Proxy listening on port", port);
  startOpenCode();
});

server.on("error", (error) => {
  console.error("ERROR: Could not listen on port", port, error.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// OpenCode child process.
// ---------------------------------------------------------------------------
let child = null;
let shuttingDown = false;
let restarts = 0;

function startOpenCode() {
  console.log("Starting OpenCode web server...");
  console.log("OpenCode workspace:", workdir);
  console.log("OpenCode binary:", binary);

  child = spawn(
    binary,
    ["web", "--hostname", "127.0.0.1", "--port", String(internalPort)],
    {
      cwd: workdir,
      env: process.env,
      stdio: "inherit",
    }
  );

  child.once("error", (error) => {
    console.error("ERROR: Could not start OpenCode:", error.message);
  });

  child.once("exit", (code, signal) => {
    opencodeReady = false;
    console.error(
      `OpenCode exited. code=${code}, signal=${signal || "none"}`
    );

    if (shuttingDown) {
      return;
    }

    restarts += 1;
    if (restarts > 20) {
      console.error("Too many restarts, giving up.");
      return;
    }

    const delay = Math.min(restarts * 2000, 30000);
    console.log(`Restarting OpenCode in ${delay}ms...`);
    setTimeout(startOpenCode, delay);
  });
}

// OpenCode is ready when its port accepts connections.
function pollReady(attempt) {
  if (shuttingDown || opencodeReady) {
    return;
  }

  const probe = net.connect(internalPort, "127.0.0.1", () => {
    opencodeReady = true;
    console.log("OpenCode is ready on port", internalPort);
    probe.destroy();
  });

  probe.on("error", () => {
    probe.destroy();
    if (attempt < 120) {
      setTimeout(() => pollReady(attempt + 1), 1000);
    }
  });
}

setTimeout(() => pollReady(0), 1000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping OpenCode.`);
  if (child) {
    child.kill(signal);
  }
  server.close();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
