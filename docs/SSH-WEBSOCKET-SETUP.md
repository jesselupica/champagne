# SSH WebSocket Setup Guide

## Problem

WebSockets fail when accessing ISL through standard SSH port forwarding (`ssh -L`). The WebSocket upgrade requests are blocked/dropped by the tunnel, causing connection errors in the browser.

## Root Cause

Standard SSH port forwarding (`-L` flag) doesn't properly handle HTTP protocol upgrades (like WebSocket's `Connection: Upgrade` header). The upgrade request gets lost in the tunnel, so the server never receives it.

**Evidence:**
- ✅ HTTP requests work fine through the tunnel
- ✅ WebSockets work locally (Node.js client on server)
- ❌ WebSockets fail through SSH tunnel (browser connections)
- ❌ Backend never logs upgrade requests from tunneled connections

## Solution: Use SOCKS Proxy

Instead of port forwarding, use SSH's SOCKS proxy feature (`-D` flag), which properly handles all protocols including WebSocket upgrades.

### Step 1: Create SOCKS Tunnel

On your **local machine**, run:
```bash
ssh -D 8080 jesselupica@100.85.241.138
```

This creates a SOCKS5 proxy on `localhost:8080` that tunnels all traffic through SSH.

### Step 2: Configure Browser

#### Firefox
1. Go to **Settings** → **Network Settings**
2. Select **Manual proxy configuration**
3. Set **SOCKS Host**: `localhost`
4. Set **Port**: `8080`
5. Select **SOCKS v5**
6. Check **Proxy DNS when using SOCKS v5**

#### Chrome
Start Chrome with the proxy flag:
```bash
google-chrome --proxy-server="socks5://localhost:8080"
# Or on Mac:
open -a "Google Chrome" --args --proxy-server="socks5://localhost:8080"
```

### Step 3: Access ISL

The server will print the URL with instructions:
```
access Sapling Web with this link:
http://localhost:3000/?token=<token>&cwd=<path>

⚠️  Using SSH tunnel? WebSockets require SOCKS proxy!
Run on your local machine: ssh -D 8080 jesselupica@100.85.241.138
Configure browser SOCKS5 proxy: localhost:8080
```

Open the URL in your configured browser and WebSockets will work!

## Quick Start

```bash
# 1. On local machine: Start SSH SOCKS tunnel
ssh -D 8080 jesselupica@100.85.241.138

# 2. In another terminal: SSH to server and start ISL
ssh jesselupica@100.85.241.138
cd champagne
yarn test-git  # Or: yarn dev browser --launch <repo>

# 3. Configure browser for SOCKS proxy (localhost:8080)

# 4. Open the URL shown by ISL
```

## Alternative Solutions

### Option 1: Local Browser on Server (X11 Forwarding)
```bash
ssh -X jesselupica@100.85.241.138
firefox http://localhost:3000/...
```
Runs browser on the server, displays on your local machine. No WebSocket tunnel issues.

### Option 2: VPN over SSH (sshuttle)
```bash
pip install sshuttle
sshuttle -r jesselupica@100.85.241.138 0.0.0.0/0
```
Creates a VPN, makes the remote network appear local. No proxy configuration needed.

### Option 3: Public Tunnel (ngrok/cloudflared)
Expose the server publicly through a tunnel service. Not recommended for development.

## Troubleshooting

**WebSocket still fails:**
- Verify SOCKS proxy is configured correctly in browser
- Check SSH tunnel is running (`ps aux | grep "ssh -D"`)
- Try a different browser
- Test with the minimal WebSocket server: `node isl-server/test-ws.js`

**Can't configure browser proxy:**
- Use Chrome with `--proxy-server` flag (no browser settings needed)
- Or use Firefox Profile Manager to create a separate profile for proxied browsing

**SSH tunnel disconnects:**
- Add `-o ServerAliveInterval=60` to keep connection alive
- Use `autossh` instead of `ssh` for automatic reconnection

## Technical Details

The issue was diagnosed by:
1. Testing ISL with both Git and Sapling drivers (both failed identically)
2. Creating a minimal WebSocket test server
3. Testing from browser (failed) vs Node.js client (succeeded)
4. Confirming HTTP works but WebSocket upgrades don't reach the server

The root cause is that standard SSH port forwarding works at the TCP level but doesn't understand HTTP protocol semantics. SOCKS proxies work at a higher level and properly handle protocol upgrades.
