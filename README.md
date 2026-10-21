# WABridge

A lightweight WhatsApp HTTP Bridge. Link your WhatsApp via CLI, then send messages through a simple REST API. Supports text, images, video, audio, documents — to individuals, groups, and channels.

## Install

```bash
npm install -g wabridge
```

Or run directly:

```bash
npx wabridge
```

## Quick Start

### 1. Link WhatsApp

**QR Code (default):**

```bash
wabridge
```

Scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device).

**Pairing Code:**

```bash
wabridge --code
```

Enter your phone number and get an 8-digit pairing code. Go to WhatsApp > Linked Devices > Link a Device > Link with phone number.

Once linked, you can test messages interactively:

```
Commands: /send, /self, /groups, /sendgroup, /sendchannel, /status, /disconnect, /quit
```

Auth is saved to `~/.wabridge/` — you only need to link once.

### 2. Start the API Server

```bash
wabridge start
```

With a custom port:

```bash
wabridge start 8080
```

## API Endpoints

### Check Status

```bash
curl http://localhost:3000/status
```

```json
{ "status": "open", "user": "919876543210@s.whatsapp.net" }
```

### List Groups

```bash
curl http://localhost:3000/groups
```

```json
{
  "groups": [
    { "id": "120363012345@g.us", "subject": "My Group", "size": 15, "desc": "Group description" }
  ]
}
```

### Send Text Message

```bash
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "message": "Hello!"}'
```

```json
{ "success": true, "to": "919876543210" }
```

### Send Image

```bash
# From URL
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "image": "https://example.com/photo.jpg", "caption": "Check this out"}'

# From local file path
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "image": "/path/to/photo.jpg", "caption": "Local file"}'
```

### Send Video

```bash
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "video": "https://example.com/video.mp4", "caption": "Watch this"}'
```

### Send Voice Note

```bash
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "audio": "https://example.com/voice.ogg"}'
```

### Send Document

```bash
curl -X POST http://localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"phone": "919876543210", "document": "https://example.com/report.pdf", "mimetype": "application/pdf", "fileName": "report.pdf"}'
```

### Send to Self

```bash
curl -X POST http://localhost:3000/send/self \
  -H 'Content-Type: application/json' \
  -d '{"message": "Test alert"}'
```

### Send to Group

```bash
curl -X POST http://localhost:3000/send/group \
  -H 'Content-Type: application/json' \
  -d '{"groupId": "120363012345@g.us", "message": "Hello group!"}'
```

### Send to Channel

```bash
curl -X POST http://localhost:3000/send/channel \
  -H 'Content-Type: application/json' \
  -d '{"channelId": "120363098765@newsletter", "message": "Channel update"}'
```

## Message Content Fields

All send endpoints (`/send`, `/send/self`, `/send/group`, `/send/channel`) accept these content fields:

| Field | Type | Extra Fields | Description |
|-------|------|-------------|-------------|
| `message` | string | — | Text message |
| `image` | URL or file path | `caption?` | Image with optional caption |
| `video` | URL or file path | `caption?` | Video with optional caption |
| `audio` | URL or file path | `ptt?` (default: true) | Voice note or audio file |
| `document` | URL or file path | `mimetype` (required), `fileName?`, `caption?` | Document attachment |

Media fields accept both remote URLs (`https://...`) and local file paths (`/path/to/file`). See [Security](#security).

## CLI Commands

| Command | Description |
|---------|-------------|
| `wabridge` | Link WhatsApp via QR code + interactive CLI |
| `wabridge --code` | Link WhatsApp via pairing code |
| `wabridge start` | Start API server on port 3000 |
| `wabridge start 8080` | Start API server on custom port |

### Interactive CLI Commands

| Command | Description |
|---------|-------------|
| `/send` | Send a message to any number |
| `/self` | Send a message to yourself |
| `/groups` | List all groups with JIDs |
| `/sendgroup` | Send a message to a group |
| `/sendchannel` | Send a message to a channel |
| `/status` | Check connection status |
| `/disconnect` | Unlink WhatsApp and remove saved auth |
| `/quit` | Exit |

## Use Cases

- Trading alerts to WhatsApp
- Server monitoring notifications
- Automated reminders
- Send media (images, videos, documents) programmatically
- Group and channel messaging
- Any app that needs to send WhatsApp messages via HTTP

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| Port | `3000` | `wabridge start 8080` or `PORT=8080 wabridge start` |
| `HOST` | `127.0.0.1` | Interface to listen on. Non-loopback hosts require `WABRIDGE_API_KEY` |
| `WABRIDGE_API_KEY` | — | When set, every request needs `Authorization: Bearer <key>` |
| Auth | `~/.wabridge/auth_store` | WhatsApp session credentials |

## Security

Media fields accept local file paths, so anyone who can call the API can send any file the server can read (including your WhatsApp credentials) to any number. For that reason:

- The server listens on `127.0.0.1` only by default, and refuses to bind to another interface unless `WABRIDGE_API_KEY` is set.
- POST requests must use `Content-Type: application/json`, which stops web pages from posting to the local API.
- Without an API key, requests with a non-localhost `Host` header are rejected (DNS rebinding protection).

```bash
WABRIDGE_API_KEY=change-me HOST=0.0.0.0 wabridge start
curl -H 'Authorization: Bearer change-me' http://your-server:3000/status
```

## Requirements

- Node.js >= 20.0.0

## Credits

Built on [Baileys](https://github.com/WhiskeySockets/Baileys).

## License

[MIT](LICENSE)
