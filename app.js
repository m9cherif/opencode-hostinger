
"use strict";

const { spawn } = require("node:child_process");
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

if (!Number.isInteger(port) || port < 1 || port > 65535) {
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

console.log("Starting OpenCode web server...");
console.log("Port assigned by Hostinger:", port);
console.log("OpenCode workspace:", workdir);
console.log("OpenCode binary:", binary);

const child = spawn(
  binary,
  [
    "web",
    "--hostname",
    "0.0.0.0",
    "--port",
    String(port)
  ],
  {
    cwd: workdir,
    env: process.env,
    stdio: "inherit"
  }
);

let shuttingDown = false;

child.once("error", (error) => {
  console.error("ERROR: Could not start OpenCode:", error.message);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  console.error(
    `OpenCode exited. code=${code}, signal=${signal || "none"}`
  );

  if (!shuttingDown) {
    process.exitCode = code === 0 ? 1 : (code || 1);
  }
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}; stopping OpenCode.`);
  child.kill(signal);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
