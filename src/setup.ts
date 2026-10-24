import { WABridge } from "./socket.js";
// @ts-ignore no types available
import QRCode from "qrcode";
import * as readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

const usePairingCode = process.argv.includes("--code");

let promptStarted = false;
let pairingRequested = false;

const bridge = new WABridge({
  async onQR(qr, sock) {
    if (usePairingCode) {
      if (!pairingRequested) {
        pairingRequested = true;
        const phone = (await ask("  Enter your phone number (with country code, e.g. 919876543210): ")).trim();
        if (!phone || !/^\d{10,15}$/.test(phone)) {
          console.log("  Invalid phone number. Restart and try again.");
          process.exit(1);
        }
        const code = await sock.requestPairingCode(phone);
        console.log(`\n  Your pairing code: ${code}\n`);
        console.log("  Go to WhatsApp > Linked Devices > Link a Device > Link with phone number");
        console.log("  Enter the code above to link.\n");
      }
    } else {
      console.log("  Scan this QR code with WhatsApp:\n");
      const qrText = await QRCode.toString(qr, { type: "terminal", small: true, errorCorrectionLevel: "L" });
      console.log(qrText);
    }
  },
  onStatus(status) {
    if (status === "open") {
      console.log("  WhatsApp linked successfully!\n");
      if (!promptStarted) {
        promptStarted = true;
        console.log("  Commands: /send, /self, /groups, /sendgroup, /sendchannel, /status, /disconnect, /quit\n");
        promptLoop();
      }
    }
    if (status === "disconnected") console.log("  Disconnected. Reconnecting...");
    if (status === "unlinked") {
      console.log("  QR code expired. Run 'wabridge' again to link.");
      process.exit(1);
    }
    if (status === "replaced") {
      console.log("  Session taken over by another device. Stopping.");
      process.exit(1);
    }
    if (status === "logged_out") {
      console.log("  Logged out. Re-linking...\n");
      bridge.start();
    }
  },
});

async function shutdown() {
  await bridge.stop();
  console.log("  Bye!");
  process.exit(0);
}

rl.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`
  ╔══════════════════════════════════════╗
  ║        WABridge - Setup              ║
  ╠══════════════════════════════════════╣
  ║  Link your WhatsApp account          ║
  ╚══════════════════════════════════════╝
  Session folder: ${bridge.authDir}
`);

await bridge.start();

async function promptLoop() {
  while (true) {
    const input = (await ask("  > ")).trim();
    if (!input) continue;

    if (input === "/quit") await shutdown();

    if (input === "/status") {
      console.log(`  Status: ${bridge.status}`);
      console.log(`  JID: ${bridge.jid || "N/A"}`);
      continue;
    }

    if (input === "/send") {
      const phone = (await ask("  Phone (with country code, e.g. 919876543210): ")).trim();
      if (!phone || !/^\d{10,15}$/.test(phone)) {
        console.log("  Invalid phone number.");
        continue;
      }
      const msg = (await ask("  Message: ")).trim();
      if (!msg) { console.log("  Cancelled."); continue; }
      try {
        await bridge.sendTo(phone, { type: "text", text: msg });
        console.log(`  Sent to +${phone}!`);
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }
      continue;
    }

    if (input === "/self") {
      const msg = (await ask("  Message to self: ")).trim();
      if (!msg) { console.log("  Cancelled."); continue; }
      try {
        const myJid = bridge.jid;
        if (!myJid) throw new Error("WhatsApp not connected");
        await bridge.sendTo(myJid, { type: "text", text: msg });
        console.log("  Sent to yourself!");
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }
      continue;
    }

    if (input === "/groups") {
      try {
        const groups = await bridge.listGroups();
        if (groups.length === 0) {
          console.log("  No groups found.");
        } else {
          console.log(`  Found ${groups.length} group(s):\n`);
          for (const g of groups) {
            console.log(`  ${g.subject}`);
            console.log(`    JID: ${g.id}`);
            console.log(`    Members: ${g.size}`);
            if (g.desc) console.log(`    Desc: ${g.desc.slice(0, 80)}`);
            console.log("");
          }
        }
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }
      continue;
    }

    if (input === "/sendgroup") {
      const groupId = (await ask("  Group JID (use /groups to list): ")).trim();
      if (!groupId || !groupId.endsWith("@g.us")) {
        console.log("  Invalid group JID. Must end with @g.us");
        continue;
      }
      const msg = (await ask("  Message: ")).trim();
      if (!msg) { console.log("  Cancelled."); continue; }
      try {
        await bridge.sendTo(groupId, { type: "text", text: msg });
        console.log("  Sent to group!");
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }
      continue;
    }

    if (input === "/sendchannel") {
      const channelId = (await ask("  Channel JID (ends with @newsletter): ")).trim();
      if (!channelId || !channelId.endsWith("@newsletter")) {
        console.log("  Invalid channel JID. Must end with @newsletter");
        continue;
      }
      const msg = (await ask("  Message: ")).trim();
      if (!msg) { console.log("  Cancelled."); continue; }
      try {
        await bridge.sendTo(channelId, { type: "text", text: msg });
        console.log("  Sent to channel!");
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }
      continue;
    }

    if (input === "/disconnect") {
      const confirm = (await ask("  Unlink WhatsApp? This removes saved auth. (y/n): ")).trim().toLowerCase();
      if (confirm === "y") {
        try {
          await bridge.logout();
          console.log("  WhatsApp unlinked. Run 'wabridge' again to re-link.");
          process.exit(0);
        } catch (err: any) {
          console.log(`  Failed: ${err.message}`);
        }
      } else {
        console.log("  Cancelled.");
      }
      continue;
    }

    console.log("  Unknown. Commands: /send, /self, /groups, /sendgroup, /sendchannel, /status, /disconnect, /quit");
  }
}
