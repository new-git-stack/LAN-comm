# LAN Comm

A peer-to-peer video calling and messaging app that runs entirely on your local network. No cloud services, no external dependencies at runtime — just a Node.js server on one machine and a browser on each device.

## Prerequisites

- **Node.js** (v16 or later) — [nodejs.org](https://nodejs.org)
- **OpenSSL** — used to auto-generate a self-signed TLS certificate on first run. Pre-installed on macOS and most Linux distros. On Windows, install via [Git for Windows](https://gitforwindows.org) (includes OpenSSL) or [OpenSSL for Windows](https://slproweb.com/products/Win32OpenSSL.html) and make sure `openssl` is on your PATH.

## Install

```bash
npm install ws bcrypt cookie
```

Optional — enables `lan-comm.local` hostname discovery on the network:

```bash
npm install mdns-server
```

## Run

```bash
node server.js
```

The server prints the URLs you can use to connect:

```
  lan-comm is running

  Local:   https://localhost:8443
  By name: https://lan-comm.local:8443
  By IP:   https://<your-lan-ip>:8443
```

Open the **By IP** URL on any device connected to the same network.

### HTTP redirect (optional)

The server also tries to listen on port 80 to redirect `http://` visitors to `https://`. This requires elevated privileges:

- **Linux/macOS:** `sudo node server.js`
- **Windows:** run the terminal as Administrator

If port 80 is unavailable the server still works — users just need to type `https://` in the address bar.

## First visit — accepting the self-signed certificate

Because the TLS certificate is self-signed, browsers will show a security warning on first visit. This is expected:

- **Chrome/Edge:** click "Advanced" → "Proceed to \<ip\> (unsafe)"
- **Firefox:** click "Advanced" → "Accept the Risk and Continue"
- **Safari (iOS):** tap "Show Details" → "visit this website" → confirm

You only need to do this once per device.

## Usage

1. **Register** an account (stored locally in `users.db.json`)
2. Other users on the network appear in the **peers** list once they connect
3. Select a peer and tap the **call** button to start a video call
4. Use the chat panel to send text messages during or outside of calls

### Controls during a call

- **Mute/Unmute** — toggle your microphone
- **Camera on/off** — toggle your video
- **Switch camera** — swap front/back camera (mobile)
- **Hang up** — end the call

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8443` | HTTPS port |
| `REDIRECT_PORT` | `80` | HTTP redirect port |

Example:

```bash
PORT=9443 node server.js
```

## Project structure

```
├── server.js            Node.js server (HTTPS + WebSocket signaling)
├── lan-comm-app.html    Single-file UI (HTML + CSS)
├── app.js               Client-side logic (WebRTC, signaling, chat)
├── cert.pem             Auto-generated TLS certificate
├── key.pem              Auto-generated TLS private key
└── users.db.json        User accounts and sessions (auto-created)
```
