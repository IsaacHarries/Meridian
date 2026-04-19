# Gemini Agent Sidecar — Implementation Plan

## 1. Goal

The current Gemini integration in Meridian uses a standard API key that connects to Google's free-tier endpoints (`generativelanguage.googleapis.com`). This approach has two major limitations:

1.  **Strict Rate Limiting**: Users are hitting their request quotas very quickly.
2.  **Limited Model Access**: It does not provide access to subscription-only models available on Vertex AI, such as Gemini 2.5 Pro.

The goal of this refactor is to resolve these issues by enabling users to authenticate using their Google Cloud subscription. This will be achieved by creating a Node.js sidecar process that uses the official `@google-cloud/vertex-ai` SDK, which can leverage the user's existing `gcloud` command-line authentication (Application Default Credentials, or ADC).

This aligns with the existing architecture used for the Claude provider, ensuring a consistent and robust integration pattern.

---

## 2. Architecture

We will introduce a long-lived Node.js sidecar process managed by the Tauri Rust backend. This sidecar will handle all communication with Google's Vertex AI services.

```
React UI (TypeScript)
    ↕  Tauri invoke / events
Tauri Rust backend
    ↕  spawn + stdin/stdout JSON-RPC (new)
Node.js Gemini Sidecar (new: src-sidecar/gemini.ts)
    ↕  @google-cloud/vertex-ai SDK
Google Cloud (gcloud) CLI session (~/.config/gcloud/)
    ↕  Vertex AI API (Gemini 2.5 Pro, etc.)
```

### Advantages of this approach:

*   **Robust Authentication**: The official `@google-cloud/vertex-ai` SDK automatically finds and uses Application Default Credentials. A user only needs to run `gcloud auth application-default login` once on their machine.
*   **Full Access & Higher Limits**: This connects to the proper Vertex AI endpoints, granting access to all models and rate limits associated with the user's Google Cloud subscription.
*   **Clean Separation**: It isolates Google-specific dependencies and authentication logic within the Node.js sidecar, keeping the Rust core clean. This follows the established pattern from `ClaudeAgentSidecar.md`.

---

## 3. Implementation Details

### 3.1. Node.js Sidecar (`src-sidecar/gemini.ts`)

A new package will be created in `src-sidecar` for the Gemini agent.

**`src-sidecar/package.json` (add dependency):**
```json
{
  "dependencies": {
    "@google-cloud/vertex-ai": "latest"
  }
}
```

**New File: `src-sidecar/gemini.ts`**

This script will be the core of the sidecar. It listens for line-delimited JSON requests on `stdin`, processes them using the Vertex AI SDK, and writes line-delimited JSON responses to `stdout`.

```typescript
import * as readline from "node:readline";
import { VertexAI } from "@google-cloud/vertex-ai";

// Redirect console.log to stderr to keep stdout clean for JSON-RPC
console.log = console.error;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  let req: any;
  try {
    req = JSON.parse(line);
    // Basic request validation
    if (!req.id || !req.projectId || !req.location || !req.model || !req.messages) {
        throw new Error("Invalid request to Gemini sidecar.");
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ type: "error", message: String(e) }) + "\n");
    return;
  }

  try {
    const vertex_ai = new VertexAI({ project: req.projectId, location: req.location });
    const model = vertex_ai.getGenerativeModel({ model: req.model });

    const stream = await model.generateContentStream({
        contents: req.messages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    });

    for await (const chunk of stream.stream) {
        if (chunk.candidates && chunk.candidates[0].content.parts[0].text) {
            const delta = chunk.candidates[0].content.parts[0].text;
            process.stdout.write(JSON.stringify({ id: req.id, type: "text", delta }) + "\n");
        }
    }
    process.stdout.write(JSON.stringify({ id: req.id, type: "result", sessionId: null }) + "\n");

  } catch (err) {
    process.stdout.write(JSON.stringify({ id: req.id, type: "error", message: String(err) }) + "\n");
  }
});
```

This script will be compiled into a standalone executable using a tool like `bun build --compile` and included in the Tauri application bundle.

### 3.2. Rust Backend Integration

A new Rust module, `src-tauri/src/gemini_sidecar.rs`, will be created to manage the lifecycle and communication with the sidecar binary. The logic will be similar to the existing Claude sidecar manager.

The dispatch logic in `src-tauri/src/commands/claude.rs` will be updated to use this new module.

**`src-tauri/src/commands/claude.rs` (modification):**

```rust
// In try_provider_multi function

"gemini" => {
    let auth_method = get_credential("gemini_auth_method").unwrap_or_else(|| "api_key".to_string());
    if auth_method == "gcloud_cli" {
        // NEW: Call the Gemini sidecar manager
        // This will involve creating a new `gemini_sidecar` module and a `dispatch` function within it.
        // e.g., gemini_sidecar::dispatch(app, client, system, history_json, max_tokens).await
        Err("Gemini sidecar not implemented yet.".to_string())
    } else {
        // OLD: Existing API key path remains as a fallback
        let key = get_credential("gemini_api_key")
            .ok_or_else(|| "Gemini: not configured.".to_string())?;
        complete_multi_gemini(client, &key, &get_active_gemini_model(), system, history_json, max_tokens).await
    }
}
```

### 3.3. Frontend UI (`src/screens/SettingsScreen.tsx`)

The settings UI for Gemini needs to be updated to allow users to select their authentication method and provide the necessary configuration for the `gcloud` path.

```diff
--- a/src/screens/SettingsScreen_20260411230846.tsx
++++ b/src/screens/SettingsScreen_20260411230846.tsx
@@ -660,6 +660,9 @@
 function GeminiSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
   const [editing, setEditing] = useState(false);
   const [apiKey, setApiKey] = useState("");
+  const [authMethod, setAuthMethod] = useState("api_key");
+  const [gcpProjectId, setGcpProjectId] = useState("");
+  const [gcpLocation, setGcpLocation] = useState("");
   const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
   const [testResult, setTestResult] = useState<TestResult>("untested");
   const [models, setModels] = useState<[string, string][]>([]);
@@ -668,6 +671,9 @@
   useEffect(() => {
     getGeminiModels().then(setModels).catch(() => {});
     getNonSecretConfig().then(cfg => {
+      if (cfg.gemini_auth_method) setAuthMethod(cfg.gemini_auth_method);
+      if (cfg.gcp_project_id) setGcpProjectId(cfg.gcp_project_id);
+      if (cfg.gcp_location) setGcpLocation(cfg.gcp_location);
       if (cfg.gemini_model) setSelectedModel(cfg.gemini_model);
     }).catch(() => {});
   }, []);
@@ -685,11 +691,20 @@
   }
 
   async function handleSave() {
-    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
+    if (authMethod === 'api_key' && (!apiKey.trim() || apiKey === MASKED_SENTINEL)) return;
+    if (authMethod === 'gcloud_cli' && (!gcpProjectId.trim() || !gcpLocation.trim())) {
+      setStatus({ state: "error", message: "Google Cloud Project ID and Location are required for CLI authentication." });
+      return;
+    }
+
     setStatus({ state: "loading", message: "Saving and testing…" });
     try {
       await saveCredential("gemini_auth_method", authMethod);
-      const msg = await validateGemini(apiKey.trim());
+      if (authMethod === 'gcloud_cli') {
+        await saveCredential("gcp_project_id", gcpProjectId.trim());
+        await saveCredential("gcp_location", gcpLocation.trim());
+      }
+      const msg = authMethod === 'api_key' ? await validateGemini(apiKey.trim()) : "gcloud CLI settings saved. Run 'gcloud auth application-default login' in your terminal.";
       setTestResult("success");
       setStatus({ state: "success", message: msg });
       setEditing(false);
@@ -727,31 +742,69 @@
           </div>
         ) : (
           <div className="space-y-3">
-            <div>
-              <Label className="text-xs">Gemini API Key</Label>
-              <div className="flex gap-2 mt-1">
-                <Input
-                  type="password"
-                  value={apiKey}
-                  onChange={e => setApiKey(e.target.value)}
-                  placeholder="AIza…"
-                  className="text-xs h-8 font-mono"
-                  onFocus={() => { if (apiKey === MASKED_SENTINEL) setApiKey(""); }}
-                />
+            <div className="space-y-1">
+              <Label className="text-xs">Authentication Method</Label>
+              <div className="flex gap-2">
+                <Button variant={authMethod === 'api_key' ? 'secondary' : 'outline'} size="xs" onClick={() => setAuthMethod('api_key')}>API Key</Button>
+                <Button variant={authMethod === 'gcloud_cli' ? 'secondary' : 'outline'} size="xs" onClick={() => setAuthMethod('gcloud_cli')}>gcloud CLI</Button>
               </div>
-              <p className="text-xs text-muted-foreground mt-1">
-                Get a free key at{" "}
-                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
-            </div>
+            </div>
+
+            {authMethod === 'api_key' ? (
+              <div>
+                <Label className="text-xs">Gemini API Key</Label>
+                <div className="flex gap-2 mt-1">
+                  <Input
+                    type="password"
+                    value={apiKey}
+                    onChange={e => setApiKey(e.target.value)}
+                    placeholder="AIza…"
+                    className="text-xs h-8 font-mono"
+                    onFocus={() => { if (apiKey === MASKED_SENTINEL) setApiKey(""); }}
+                  />
+                </div>
+                <p className="text-xs text-muted-foreground mt-1">
+                  For free-tier access. Get a key at{" "}
+                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
+                    className="underline hover:text-foreground">
+                    aistudio.google.com/apikey
+                  </a>
+                </p>
+              </div>
+            ) : (
+              <div className="space-y-3">
+                <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md border">
+                  For subscription access via Vertex AI. Run <code className="bg-background px-1 rounded">gcloud auth application-default login</code> in your terminal once. Meridian will then use your logged-in account automatically.
+                </p>
+                <div>
+                  <Label className="text-xs">Google Cloud Project ID</Label>
+                  <Input
+                    value={gcpProjectId}
+                    onChange={e => setGcpProjectId(e.target.value)}
+                    placeholder="your-gcp-project-id"
+                    className="text-xs h-8 font-mono mt-1"
+                  />
+                </div>
+                <div>
+                  <Label className="text-xs">Location</Label>
+                  <Input
+                    value={gcpLocation}
+                    onChange={e => setGcpLocation(e.target.value)}
+                    placeholder="us-central1"
+                    className="text-xs h-8 font-mono mt-1"
+                  />
+                </div>
+              </div>
+            )}
+
             <div className="flex gap-2">
-              <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || apiKey === MASKED_SENTINEL}>
+              <Button
+                size="sm"
+                onClick={handleSave}
+                disabled={(authMethod === 'api_key' && (!apiKey.trim() || apiKey === MASKED_SENTINEL)) || (authMethod === 'gcloud_cli' && (!gcpProjectId.trim() || !gcpLocation.trim()))}
+              >
                 Save &amp; Test
               </Button>
               <Button variant="outline" size="sm" onClick={handleCancel}>Cancel</Button>
@@ -761,7 +814,7 @@
         <SectionMessage state={status.state} message={status.message} />
 
         {isConfigured && models.length > 0 && (
-          <div>
+          <div className="pt-2 border-t">
             <Label className="text-xs">Model</Label>
             <select
               value={selectedModel}

```

