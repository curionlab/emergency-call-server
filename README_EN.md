<div align="center">

[日本語](README.md) | [English](README_EN.md)

</div>

# Emergency Call System (Backend / Emergency Call Server)

> This repository is a "server for sending Web Push notifications to iPhone (Safari PWA)".  
> It is designed to work with the frontend (PWA): https://github.com/curionlab/emergency-call-client

***

## What It Does (Server Role)

- **Stores Push subscription information (PushSubscription)** for receivers.
- Sends **Web Push notifications** to receivers when the sender calls the API.
- Supports an auth code mechanism to control receiver registration permissions.
- Handles subscription updates when the subscription changes.

This system can be used not only for "video/phone calls" but also for **AI agents or monitoring jobs to notify users when events occur** (just change the notification payload's `title/body/url`).

***

## Main Use Case (How to Use)

This system assumes you use both repositories together:

- **Frontend (PWA)**: emergency-call-client  
  https://github.com/curionlab/emergency-call-client
- **Backend (Notification API)**: emergency-call-server (this repository)

**Basic Flow** (Operational Flow):
1. The sender generates an "auth code" on the server (valid for 30 minutes).
2. The receiver opens the PWA, grants Push notification permission, and registers using receiver ID + auth code (Push subscription is saved on the server).
3. The sender (or AI agent) calls `/send-notification`, and the notification is delivered to the receiver's iPhone.
4. When the receiver taps the notification, the PWA opens (or redirects) and uses `url/sessionId/senderId` to navigate to the next screen (client-side implementation).

***

## Important Constraints (Especially for "Local-Only Notification" Users)

### 1) Web Push Cannot Work "Local-Only"
Web Push notifications are delivered via browser/OS push services (Apple, etc.), not directly from server to device.  
Therefore, if you want to "run a server locally and notify only iPhones on the same LAN", you'll face these issues:

- If the iPhone is outside (on mobile network), it cannot reach the LAN server.
- For home server deployment, you need internet exposure (port forwarding/fixed URL/HTTPS).
- **HTTPS is required** (PWA + Push prerequisite), so you need to prepare certificates (e.g., Cloudflare/Let's Encrypt).

### 2) Subscriptions Are Not Permanent
Push subscriptions may be updated or expire due to OS/browser changes.  
For production, you should implement "re-registration flow on expiration" or "subscription recovery (pushsubscriptionchange)" (mainly frontend/Service Worker responsibility).

***

## Setup (Local)

### 1) Install & Start
```bash
npm install
npm start
```
If `PORT` is not specified, it starts on port 3000.

***

## Environment Variables (Important)

This server is configured via environment variables.

Minimum (required for Push):
- `PORT`: Server port (default: 3000)
- `VAPID_PUBLIC_KEY`: VAPID public key (for Push)
- `VAPID_PRIVATE_KEY`: VAPID private key (for Push)
- `CLIENT_URL`: Frontend URL (used for notification click redirect)

Production (recommended):
- `LOGIN_PASSWORD`: Sender login password (default: `default-password`)
- `JWT_SECRET`: Sender token signing key (default: `default-jwt-secret-key`)
- `REFRESH_TOKEN_SECRET`: Refresh token signing key (default: `default-refresh-secret`)
- `VAPID_CONTACT_EMAIL`: VAPID contact email (default: `emergency@example.com`)

> **Warning**: Using default values for `*_SECRET` or `VAPID_PRIVATE_KEY` in production is insecure. Always replace them in production environments.

***

## API Overview

> For details, see `server.js`. This section focuses on "what you can do".

### Health Check
- **`GET /`**  
  Health check (returns status, version, timestamp).

- **`GET /health`**  
  Simple health check (returns `{ status: "ok" }`).

### VAPID Public Key
- **`GET /vapid-public-key`**  
  Returns the VAPID public key needed for client-side Push subscription.

### Auth Code Generation
- **`POST /generate-auth-code`**  
  Generates an auth code for a receiver ID.  
  **Validity**: 30 minutes

  ```json
  // Request
  { "receiverId": "user123" }
  
  // Response
  { "success": true, "code": "123456", "expiresIn": "30 minutes" }
  ```

### Receiver Registration
- **`POST /register`**  
  Registers a receiver with receiver ID, auth code, and PushSubscription.  
  Issues the following tokens on success:
  - **Access token**: Valid for 15 minutes
  - **Refresh token**: Valid for 30 days

  ```json
  // Request
  {
    "receiverId": "user123",
    "authCode": "123456",
    "subscription": { "endpoint": "...", "keys": {...} }
  }
  
  // Response
  {
    "success": true,
    "accessToken": "...",
    "refreshToken": "...",
    "message": "Registration successful"
  }
  ```

### Subscription Update
- **`POST /update-subscription`**  
  Used when a receiver's PushSubscription changes.  
  Requires authentication with access token (or refresh token).

  ```json
  // Request (with Authorization header)
  {
    "receiverId": "user123",
    "subscription": { "endpoint": "...", "keys": {...} }
  }
  
  // Response
  { "success": true, "message": "Subscription updated" }
  ```

### Sender Login
- **`POST /login`**  
  Sender logs in with password and receives a token for sending notifications.  
  **Validity**: 1 hour

  ```json
  // Request
  { "password": "your-password" }
  
  // Response
  { "success": true, "token": "..." }
  ```

### Send Notification
- **`POST /send-notification`**  
  Sends a notification to the specified receiver using sender token (Authorization header).

  ```json
  // Request (with Authorization header)
  {
    "receiverId": "user123",
    "sessionId": "session-456",
    "senderId": "sender-789",
    "title": "Emergency Call",
    "body": "You have an incoming call"
  }
  
  // Response
  { "success": true, "message": "Notification sent", "sessionId": "session-456" }
  ```

### Token Refresh
- **`POST /refresh-token`**  
  Obtains a new access token using a refresh token.  
  New access token validity: 15 minutes

  ```json
  // Request
  { "token": "refresh-token..." }
  
  // Response
  { "accessToken": "new-access-token..." }
  ```

### Debug
- **`GET /status`**  
  Check registration status (auth code count, registered receivers count, etc.).

***

## Token & Code Validity Summary

| Item | Validity | Issued By | Purpose |
|------|----------|-----------|---------|
| Auth Code | 30 minutes | `/generate-auth-code` | Receiver registration authentication |
| Sender Token | 1 hour | `/login` | Notification sending authentication |
| Access Token | 15 minutes | `/register`, `/refresh-token` | Subscription update authentication |
| Refresh Token | 30 days | `/register` | Access token renewal |

***

## AI Agent Integration (Recommended Architecture)

When AI agents (monitoring, workflow, LLM agents, etc.) detect events and send notifications, we recommend this separation:

- **AI Agent**: Uses external APIs/LLM/DB to make decisions, then calls this server's `/send-notification`  
- **This Server**: Focuses on Push subscription management and notification delivery (keep responsibilities minimal)

This way, even if you replace the AI agent implementation, this server maintains "notification destination management", keeping operations simple.

### Example: Sending Notification from AI Agent (curl)

```bash
# 1. Login
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'
# → { "success": true, "token": "eyJhbGc..." }

# 2. Send notification
curl -X POST http://localhost:3000/send-notification \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{
    "receiverId": "user123",
    "sessionId": "session-456",
    "senderId": "agent-ai",
    "title": "Critical Alert",
    "body": "Anomaly detected"
  }'
```

***

## Data Storage (Current Implementation)
The current implementation saves registration data in `data.json` (if the file doesn't exist, it's treated as initial data).

- On Render/container environments where disk is volatile (wiped on deployment), consider migrating to DB/KV for long-term operations.
- For Cloudflare Workers migration, file storage isn't available, so you'll need to switch to KV/D1.

***

## Security Notes

- PushSubscription is "address information for sending notifications", so if leaked, third parties may impersonate your app and send notifications (VAPID and server-side controls mitigate but don't eliminate this risk)
- Never expose sender tokens, VAPID private keys, or any Secrets
- Ensure receiver "subscription updates" verify identity via access tokens

***

## Troubleshooting

- **Notifications not appearing on iPhone**
  - Confirm it's a "PWA added to Home Screen", not Safari
  - Check that notification permission is ON

- **Notifications stopped suddenly**
  - Subscription may have expired. Re-registration may be required
  - Check server logs for send failures (HTTP 410, etc.)

***

## License

This project is licensed under the MIT License. See `LICENSE` for details.
