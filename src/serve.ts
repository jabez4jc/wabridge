import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { WABridge, NOT_CONNECTED, NOT_ON_WHATSAPP } from "./socket.js";
import type { MessageContent } from "./socket.js";

const API_PORT = Number(process.env.PORT) || 3000;
const API_HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.WABRIDGE_API_KEY;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Media fields accept local file paths, so an unauthenticated API reachable from
// the network would let anyone read any file (including the WhatsApp creds).
if (!API_KEY && !LOOPBACK.has(API_HOST)) {
  console.error(`  Refusing to listen on ${API_HOST} without WABRIDGE_API_KEY set.`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function parseMessageContent(body: any): MessageContent | string {
  const caption = str(body.caption);
  if (str(body.image)) return { type: "image", url: body.image, caption };
  if (str(body.video)) return { type: "video", url: body.video, caption };
  if (str(body.audio)) {
    return { type: "audio", url: body.audio, ptt: typeof body.ptt === "boolean" ? body.ptt : undefined, mimetype: str(body.mimetype) };
  }
  if (str(body.document)) {
    if (!str(body.mimetype)) return "mimetype is required for document";
    return { type: "document", url: body.document, mimetype: body.mimetype, fileName: str(body.fileName), caption };
  }
  if (str(body.message)) return { type: "text", text: body.message };
  return "message content is required (message, image, video, audio, or document)";
}

async function readBody(c: Context): Promise<any> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const ERROR_STATUS: Record<string, 404 | 503> = { [NOT_CONNECTED]: 503, [NOT_ON_WHATSAPP]: 404 };

function errorResponse(c: Context, err: any) {
  return c.json({ error: err.message }, ERROR_STATUS[err.message] ?? 500);
}

async function send(c: Context, to: string, body: any, display = to) {
  const content = parseMessageContent(body);
  if (typeof content === "string") return c.json({ error: content }, 400);
  try {
    await bridge.sendTo(to, content);
    return c.json({ success: true, to: display });
  } catch (err: any) {
    return errorResponse(c, err);
  }
}

// ─── HTTP API ─────────────────────────────────────────

// Never exit on a session problem: stay up, report it in /status, and let POST /link
// restart linking. Exiting would make systemd restart us in a loop.
let qrShown = false;
const bridge = new WABridge({
  onQR() {
    if (qrShown) return;
    qrShown = true;
    console.log("  WhatsApp is not linked. Scan the QR code from GET /status, or stop the server and run 'wabridge'.");
  },
  onStatus(status) {
    if (status === "connecting") qrShown = false;
    if (status === "open") console.log("  WhatsApp connected!");
    if (status === "disconnected") console.log("  Disconnected. Reconnecting...");
    if (status === "replaced") console.error("  Session taken over by another device. Not reconnecting; POST /link to take it back.");
    if (status === "logged_out") console.error("  Logged out from the phone. Re-link needed: POST /link, then scan the QR code from GET /status.");
    if (status === "unlinked") console.error("  QR code expired. POST /link to get a new one.");
  },
});

const LIVE = new Set(["connecting", "open", "disconnected"]);

const app = new Hono();

if (API_KEY) {
  app.use("*", bearerAuth({ token: API_KEY }));
} else {
  // No key means loopback only: reject foreign Host headers (DNS rebinding)
  app.use("*", async (c, next) => {
    if (!LOOPBACK.has(new URL(c.req.url).hostname)) return c.json({ error: "Forbidden host" }, 403);
    await next();
  });
}

// Requiring a JSON content type forces a CORS preflight, so a web page can't POST here
app.use("*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json")) {
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }
  await next();
});

app.get("/status", (c) => {
  return c.json({
    status: bridge.status,
    user: bridge.sock?.user?.id || null,
    phone: bridge.phone,
    qr: bridge.qr,
  });
});

// Restart connecting after a terminal status; poll /status for the QR code
app.post("/link", async (c) => {
  if (LIVE.has(bridge.status)) return c.json({ error: `Already ${bridge.status}` }, 409);
  await bridge.start();
  return c.json({ status: bridge.status });
});

app.get("/groups", async (c) => {
  try {
    const groups = await bridge.listGroups();
    return c.json({ groups });
  } catch (err: any) {
    return errorResponse(c, err);
  }
});

app.post("/send", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const phone = str(body.phone);
  if (!phone) return c.json({ error: "phone is required" }, 400);
  if (!/^\d{10,15}$/.test(phone)) {
    return c.json({ error: "Invalid phone. Use digits with country code (e.g. 919876543210)" }, 400);
  }
  return send(c, phone, body);
});

app.post("/send/self", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const myJid = bridge.jid;
  if (!myJid) return c.json({ error: NOT_CONNECTED }, 503);
  return send(c, myJid, body, "self");
});

app.post("/send/group", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const groupId = str(body.groupId);
  if (!groupId) return c.json({ error: "groupId is required" }, 400);
  if (!groupId.endsWith("@g.us")) return c.json({ error: "groupId must end with @g.us" }, 400);
  return send(c, groupId, body);
});

app.post("/send/channel", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const channelId = str(body.channelId);
  if (!channelId) return c.json({ error: "channelId is required" }, 400);
  if (!channelId.endsWith("@newsletter")) return c.json({ error: "channelId must end with @newsletter" }, 400);
  return send(c, channelId, body);
});

app.get("/channel/resolve", async (c) => {
  const invite = (c.req.query("invite") || "").split("/").pop();
  if (!invite) return c.json({ error: "invite is required" }, 400);
  try {
    const meta: any = await (bridge as any).sock.newsletterMetadata("invite", invite);
    return c.json({ id: meta?.id, name: meta?.thread_metadata?.name?.text ?? meta?.name, meta });
  } catch (e: any) { return c.json({ error: String(e?.message || e) }, 500); }
});

// ─── Start ────────────────────────────────────────────

serve({ fetch: app.fetch, port: API_PORT, hostname: API_HOST }, () => {
  const url = `http://${API_HOST}:${API_PORT}`;
  const line = `  ${url}`;
  console.log([
    "",
    "  ╔══════════════════════════════════════════════════╗",
    "  ║           WABridge API - Running                 ║",
    "  ╠══════════════════════════════════════════════════╣",
    "  ║  GET  /status        - Connection status         ║",
    "  ║  POST /link          - Restart linking (QR)      ║",
    "  ║  GET  /groups        - List groups               ║",
    "  ║  POST /send          - Send to phone number      ║",
    "  ║  POST /send/self     - Send to yourself          ║",
    "  ║  POST /send/group    - Send to group             ║",
    "  ║  POST /send/channel  - Send to channel           ║",
    "  ╠══════════════════════════════════════════════════╣",
    `  ║${line.padEnd(50)}║`,
    "  ╚══════════════════════════════════════════════════╝",
    "",
  ].join("\n"));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}

bridge.start();
