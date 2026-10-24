#!/usr/bin/env node
export {};

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const command = process.argv[2];

// libsignal prints failed decrypts of incoming messages as raw errors with stack traces.
// Reword them for the terminal: one line per message, with an explanation the first time.
const consoleError = console.error;
let decryptExplained = false;
console.error = (...args: unknown[]) => {
  const line = String(args[0]);
  if (line === "Failed to decrypt message with any known session...") return;
  if (line.startsWith("Session error:")) {
    const reason = line.slice("Session error:".length).replace(/^Error: /, "");
    consoleError(`\n  Could not decrypt an incoming message (${reason}).`);
    if (!decryptExplained) {
      decryptExplained = true;
      consoleError("  The sender's encryption keys don't match this session. Sending is not affected.");
      consoleError("  A few right after linking are normal. If it keeps happening, another machine");
      consoleError("  is probably using this same session folder: run it on one machine only.");
    }
    return;
  }
  consoleError(...args);
};

if (command === "--version" || command === "-v") {
  console.log(`wabridge/${pkg.version}`);
} else if (command === "--help" || command === "-h") {
  console.log(`wabridge/${pkg.version}

Usage: wabridge [command]

Commands:
  (default)      Scan QR code and link WhatsApp
  start [port]   Start the API server (default port: 3000)

API Endpoints:
  GET  /status        Connection status (and QR code while linking)
  POST /link          Restart linking after logout, takeover or QR expiry
  GET  /groups        List groups
  POST /send          Send to phone (text, image, video, audio, document)
  POST /send/self     Send to yourself
  POST /send/group    Send to group
  POST /send/channel  Send to channel/newsletter

Options:
  --code         Link with a pairing code instead of a QR code
  -v, --version  Show version
  -h, --help     Show this help

Environment:
  PORT              API port (default: 3000)
  HOST              Listen address (default: 127.0.0.1)
  WABRIDGE_API_KEY  Require "Authorization: Bearer <key>" on every request
  WABRIDGE_HOME     Data folder holding the session (default: ~/.wabridge)`);
} else if (command === "start") {
  const port = process.argv[3];
  if (port) process.env.PORT = port;
  await import("./serve.js");
} else {
  await import("./setup.js");
}
