import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { startSocket, getBridge, getMyJid, sendTo, listGroups } from "./socket.js";
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
  if (str(body.audio)) return { type: "audio", url: body.audio, ptt: typeof body.ptt === "boolean" ? body.ptt : undefined };
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

function errorResponse(c: Context, err: any) {
  return c.json({ error: err.message }, err.message === "WhatsApp not connected" ? 503 : 500);
}

async function send(c: Context, to: string, body: any, display = to) {
  const content = parseMessageContent(body);
  if (typeof content === "string") return c.json({ error: content }, 400);
  try {
    await sendTo(to, content);
    return c.json({ success: true, to: display });
  } catch (err: any) {
    return errorResponse(c, err);
  }
}

// ─── HTTP API ─────────────────────────────────────────

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
  const bridge = getBridge();
  return c.json({
    status: bridge.status,
    user: bridge.sock?.user?.id || null,
  });
});

app.get("/groups", async (c) => {
  try {
    const groups = await listGroups();
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
  const myJid = getMyJid();
  if (!myJid) return c.json({ error: "WhatsApp not connected" }, 503);
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

startSocket({
  onQR() {
    console.error("  WhatsApp is not linked. Run 'wabridge' to link, then start the server again.");
    process.exit(1);
  },
  onOpen() {
    console.log("  WhatsApp connected!");
  },
});
