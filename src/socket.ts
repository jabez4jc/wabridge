// @ts-ignore - Baileys exports differ between CJS types and ESM runtime
import { makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from "baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import type { Logger } from "pino";
import path from "path";
import os from "os";
import fs from "fs";

export const DATA_DIR = process.env.WABRIDGE_HOME || path.join(os.homedir(), ".wabridge");
export const DEFAULT_AUTH_DIR = path.join(DATA_DIR, "auth_store");

export type WASocket = any;

// connecting/open/disconnected are live states (disconnected = waiting to retry);
// the rest are terminal: the bridge has stopped and won't reconnect on its own.
export type Status = "connecting" | "open" | "disconnected" | "replaced" | "logged_out" | "unlinked" | "stopped";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | { type: "video"; url: string; caption?: string }
  | { type: "audio"; url: string; ptt?: boolean; mimetype?: string }
  | { type: "document"; url: string; mimetype: string; fileName?: string; caption?: string };

export interface WABridgeOptions {
  authDir?: string;
  /** Pino-compatible logger passed to Baileys (default: silent) */
  logger?: Logger;
  onQR?: (qr: string, sock: WASocket) => void;
  onStatus?: (status: Status) => void;
  /** Random gap between sends, [min, max] ms (default: 3000–6000) */
  sendGapMs?: [number, number];
}

export const NOT_CONNECTED = "WhatsApp not connected";
export const NOT_ON_WHATSAPP = "Number is not on WhatsApp";

const MIN_RETRY_MS = 3000;
const MAX_RETRY_MS = 60000;

/** What to do when the connection closes. Exported for tests. */
export function closeAction(statusCode: number | undefined, linked: boolean): Status {
  if (statusCode === DisconnectReason.connectionReplaced) return "replaced";
  if (statusCode === DisconnectReason.loggedOut) return "logged_out";
  if (!linked) return "unlinked"; // QR expired unscanned
  return "disconnected";
}

export const nextRetryMs = (ms: number) => Math.min(ms * 2, MAX_RETRY_MS);

function buildBaileysContent(content: MessageContent): any {
  switch (content.type) {
    case "text":
      return { text: content.text };
    case "image":
      return { image: { url: content.url }, caption: content.caption };
    case "video":
      return { video: { url: content.url }, caption: content.caption };
    case "audio": {
      const ptt = content.ptt ?? false;
      return { audio: { url: content.url }, ptt, mimetype: content.mimetype ?? (ptt ? "audio/ogg; codecs=opus" : "audio/mpeg") };
    }
    case "document":
      return { document: { url: content.url }, mimetype: content.mimetype, fileName: content.fileName, caption: content.caption };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WABridge {
  sock: WASocket = null;
  status: Status = "stopped";
  qr: string | null = null;

  readonly authDir: string;
  private logger: Logger;
  private stopping = false;
  private retryMs = MIN_RETRY_MS;
  private retryTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();
  private sendQueue: Promise<unknown> = Promise.resolve();
  private nextSendAt = 0;

  constructor(private opts: WABridgeOptions = {}) {
    this.authDir = opts.authDir ?? DEFAULT_AUTH_DIR;
    this.logger = opts.logger ?? pino({ level: "silent" });
  }

  /** Own JID without the device suffix, e.g. 919876543210@s.whatsapp.net */
  get jid(): string | null {
    return this.sock?.user?.id?.replace(/:\d+@/, "@") || null;
  }

  get phone(): string | null {
    return this.jid?.split("@")[0] || null;
  }

  async start() {
    this.stopping = false;
    this.retryMs = MIN_RETRY_MS;
    await this.connect();
  }

  /** Close the socket without logging out, flushing pending session writes */
  async stop() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.sock?.end(undefined);
    await this.saving;
    this.setStatus("stopped");
  }

  /** Unlink this device and delete the saved session */
  async logout() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    try {
      await this.sock?.logout();
    } finally {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      this.setStatus("stopped");
    }
  }

  private setStatus(status: Status) {
    if (status !== "connecting") this.qr = null;
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private async connect() {
    this.setStatus("connecting");
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    if (this.stopping) return;

    const old = this.sock;
    const sock = makeWASocket({
      version,
      logger: this.logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
    });
    this.sock = sock;
    old?.end(undefined);

    sock.ev.process(async (events: any) => {
      // A late event from a replaced socket must not touch the current state
      if (sock !== this.sock) return;

      if (events["creds.update"]) {
        this.saving = this.saving.then(saveCreds);
        await this.saving;
      }

      const update = events["connection.update"];
      if (!update) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.opts.onQR?.(qr, sock);
      }

      if (connection === "open") {
        this.retryMs = MIN_RETRY_MS;
        this.setStatus("open");
      }

      if (connection === "close") {
        if (this.stopping) return;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const action = closeAction(statusCode, !!sock.authState.creds.me);
        if (action === "logged_out") fs.rmSync(this.authDir, { recursive: true, force: true });
        if (action !== "disconnected") {
          this.stopping = true;
          this.setStatus(action);
          return;
        }
        this.setStatus("disconnected");
        this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = nextRetryMs(this.retryMs);
      }
    });
  }

  private requireOpen() {
    if (!this.sock || this.status !== "open") throw new Error(NOT_CONNECTED);
  }

  /** Phone number → its registered JID (handles older number formats); other JIDs pass through */
  private async resolveJid(to: string): Promise<string> {
    if (to.includes("@")) return to;
    if (!/^\d{10,15}$/.test(to)) throw new Error("Invalid recipient. Use phone number, groupId@g.us, or channelId@newsletter");
    const [result] = (await this.sock.onWhatsApp(to)) ?? [];
    if (!result?.exists) throw new Error(NOT_ON_WHATSAPP);
    return result.jid;
  }

  async sendTo(to: string, content: MessageContent) {
    this.requireOpen();
    const jid = await this.resolveJid(to);
    const msg = buildBaileysContent(content);
    // ponytail: one in-process queue; multiple instances on one number don't share pacing
    const run = this.sendQueue.then(async () => {
      await sleep(this.nextSendAt - Date.now());
      try {
        this.requireOpen();
        await this.sock.sendMessage(jid, msg);
      } finally {
        const [min, max] = this.opts.sendGapMs ?? [3000, 6000];
        this.nextSendAt = Date.now() + min + Math.random() * (max - min);
      }
    });
    this.sendQueue = run.catch(() => {});
    await run;
    return { success: true, to: jid };
  }

  async listGroups() {
    this.requireOpen();
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g: any) => ({
      id: g.id,
      subject: g.subject,
      size: g.size ?? g.participants?.length ?? 0,
      desc: g.desc || null,
    }));
  }
}
