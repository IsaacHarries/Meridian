# Gemini OAuth Implementation Plan

## 1. Goal
Implement Google Gemini authentication using OAuth 2.0 with restricted scopes, matching the approach used by Zed and the official Gemini CLI. This allows users to leverage their Gemini Advanced subscription limits without providing broad Google Cloud permissions.

---

## 2. Technical Strategy

### 2.1. OAuth Configuration (Matching Gemini CLI)
*   **Client ID**: `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com` (Official Google Gemini CLI Client)
*   **Scopes**:
    *   `https://www.googleapis.com/auth/generative-language` (Primary scope for Gemini API)
    *   `https://www.googleapis.com/auth/userinfo.email`
    *   `https://www.googleapis.com/auth/userinfo.profile`
    *   `openid`
*   **Flow**: PKCE (Proof Key for Code Exchange) via a local loopback server (`http://localhost:XXXX/callback`).

### 2.2. Architecture
```
React UI (Settings) 
    ↕ (Tauri Invoke)
Rust Backend (`validate.rs`) ─── (PKCE Flow) ───▶ Google Auth (Browser)
    ↕ (Shared State)
Node.js Sidecar (`gemini.ts`) ─── (Bearer Token) ──▶ Gemini API
```

---

## 3. Implementation Steps

### Step 1: Rust Backend (`src-tauri/src/commands/validate.rs`)
Implement the `start_gemini_oauth` command. This will mirror the existing `start_claude_oauth` logic:
1.  Generate PKCE code verifier and challenge.
2.  Start a temporary `TcpListener` on a random port.
3.  Construct the Google Auth URL and open the system browser.
4.  Capture the authorization code from the redirect.
5.  Exchange the code for an Access Token and Refresh Token.
6.  Store credentials in the OS keychain:
    *   `gemini_api_key`: The Access Token.
    *   `gemini_auth_method`: "oauth".
    *   `gemini_oauth_json`: Full JSON including the Refresh Token and expiry timestamp.

### Step 2: Sidecar Integration (`src-sidecar/src/gemini.ts`)
Update the Gemini sidecar to use the `@google/generative-ai` SDK with the OAuth token:
1.  **Dependency**: Ensure `@google/generative-ai` is installed.
2.  **Streaming**: Use the `generateContentStream` method.
3.  **Token Injection**: Pass the OAuth Access Token as the "API Key" to the SDK. The Google AI SDK handles Bearer tokens passed into the constructor.

### Step 3: Token Refresh (`src-tauri/src/commands/claude.rs`)
Implement a `refresh_gemini_oauth_if_needed` function:
1.  Check the expiry timestamp in `gemini_oauth_json`.
2.  If expired (or expiring in <5 mins), use the Refresh Token to get a new Access Token.
3.  Silently update the keychain.
4.  Call this function at the start of every Gemini dispatch.

### Step 4: Frontend UI (`src/screens/SettingsScreen.tsx`)
Update the Gemini section to offer two paths:
1.  **Google AI Studio**: Simple API Key input (standard path).
2.  **Google Account**: "Sign in with Google" button (subscription path).
    *   Clicking "Sign in" triggers `start_gemini_oauth`.
    *   Displays a "Connected as [email]" status when active.

---

## 4. Advantages
*   **Privacy**: Does **not** require the `cloud-platform` scope. It cannot see your Google Cloud servers, databases, or SQL instances.
*   **Convenience**: No need to install the `gcloud` CLI.
*   **Performance**: High-speed streaming via the Node.js sidecar.
*   **Consistency**: Matches the established pattern used for the Claude provider in Meridian.
