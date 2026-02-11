# Container Lifecycle Management

> Complete design guide for the sandbox/container lifecycle system. Covers creation, runtime, pause/resume, migration, snapshotting, and teardown.

---

## Table of Contents

- [System Overview](#system-overview)
- [Key Entities](#key-entities)
- [Snapshot Layering Architecture](#snapshot-layering-architecture)
- [Session State Machine](#session-state-machine)
- [Lifecycle Flows](#lifecycle-flows)
  - [1. Session Creation](#1-session-creation)
  - [2. Runtime Ready (Hot Path)](#2-runtime-ready-hot-path)
  - [3. Sandbox Provisioning (Inside Provider)](#3-sandbox-provisioning-inside-provider)
  - [4. Pause](#4-pause)
  - [5. Resume](#5-resume)
  - [6. Migration (Sandbox Expiry)](#6-migration-sandbox-expiry)
  - [7. Snapshot (Without Pause)](#7-snapshot-without-pause)
  - [8. Termination & Cleanup](#8-termination--cleanup)
- [Provider Abstraction](#provider-abstraction)
- [Gateway Runtime Architecture](#gateway-runtime-architecture)
- [Worker Jobs](#worker-jobs)
- [Service Boot Framework](#service-boot-framework)
- [Billing Integration](#billing-integration)
- [Key File Index](#key-file-index)
- [Prerequisites: Concepts to Understand](#prerequisites-concepts-to-understand)

---

## System Overview

The container lifecycle system manages sandbox instances that run user coding sessions. Each sandbox is a cloud container (Modal or E2B) containing:
- A cloned git repository (or multiple)
- An OpenCode coding agent (Claude-powered)
- Supporting services (PostgreSQL, Redis, Caddy, etc.)
- SSH access and web preview tunnels

The core architectural principle: **the API layer creates session _records_, but the Gateway creates _sandboxes_**. Session creation returns immediately; the actual sandbox is provisioned when the client connects via WebSocket.

```
                       ┌──────────────────────────────────────────────┐
                       │                 Web Client                   │
                       └──────────┬───────────────────────────────────┘
                                  │ WebSocket
                       ┌──────────▼───────────────────────────────────┐
                       │              Gateway (SessionHub)             │
                       │  ┌────────────────┐  ┌────────────────────┐  │
                       │  │ SessionRuntime  │  │ MigrationController│  │
                       │  │ (sandbox owner) │  │ (expiry/snapshot)  │  │
                       │  └───────┬────────┘  └────────────────────┘  │
                       └──────────┼───────────────────────────────────┘
                                  │ SSE (events) + HTTP (API)
                       ┌──────────▼───────────────────────────────────┐
                       │          Sandbox (Modal / E2B)                │
                       │  ┌──────────┐ ┌──────┐ ┌─────┐ ┌─────────┐  │
                       │  │ OpenCode │ │ Caddy│ │ SSH │ │Services │  │
                       │  │ (agent)  │ │(proxy)│ │     │ │(pg,redis)│  │
                       │  └──────────┘ └──────┘ └─────┘ └─────────┘  │
                       └──────────────────────────────────────────────┘

Next.js API: Session lifecycle (create/pause/resume/delete) — NOT in streaming path.
PostgreSQL:  Metadata persistence only — NOT in streaming path.
```

---

## Key Entities

### Session (`packages/db/src/schema/sessions.ts`)

An active or paused instance of a sandbox. The central record tracking the full lifecycle.

| Field | Purpose |
|-------|---------|
| `id` | UUID, primary key |
| `status` | `starting` \| `running` \| `paused` \| `suspended` \| `stopped` |
| `sessionType` | `setup` \| `coding` \| `terminal` |
| `sandboxId` | Provider-specific ID (null when paused/stopped) |
| `sandboxProvider` | `modal` \| `e2b` |
| `snapshotId` | Filesystem snapshot for resume (set on pause/snapshot) |
| `prebuildId` | FK → prebuilds (source configuration) |
| `sandboxExpiresAt` | When the provider will kill this sandbox |
| `codingAgentSessionId` | OpenCode session ID inside the sandbox |
| `openCodeTunnelUrl` | HTTPS tunnel to OpenCode (port 4096) |
| `previewTunnelUrl` | HTTPS tunnel to web preview (port 20000) |
| `pauseReason` | Why session was paused (e.g. `credit_limit`) |
| `stopReason` | Why session was stopped (e.g. `sandbox_terminated`) |
| `clientType` | `web` \| `cli` \| `slack` \| `automation` |

### Prebuild (`packages/db/src/schema/prebuilds.ts`)

A snapshot configuration — bundles one or more repos with an optional filesystem snapshot and service commands.

| Field | Purpose |
|-------|---------|
| `id` | UUID, primary key |
| `snapshotId` | Provider snapshot ID (null while building) |
| `status` | `building` \| `ready` \| `failed` |
| `type` | `manual` \| `managed` |
| `serviceCommands` | JSONB array of auto-start service specs |
| `envFiles` | JSONB spec for env file generation on boot |

Junction table `prebuild_repos` links prebuilds to repos with a `workspacePath` for each.

### Repo (`packages/db/src/schema/repos.ts`)

A GitHub repository record, with optional snapshot fields for the clone-only layer:

| Field | Purpose |
|-------|---------|
| `repoSnapshotId` | Provider image with pre-cloned repo |
| `repoSnapshotStatus` | `building` \| `ready` \| `failed` |
| `repoSnapshotCommitSha` | Git SHA at snapshot time |
| `serviceCommands` | Per-repo service commands (fallback if prebuild has none) |

### Sandbox Base Snapshot (`packages/db/src/schema/schema.ts` → `sandboxBaseSnapshots`)

Global base image with pre-installed tooling (OpenCode, Caddy, services). One per `(versionKey, provider, modalAppName)`.

---

## Snapshot Layering Architecture

Snapshots are layered to minimize cold-start time. Each layer extends the previous:

```
Layer 0: Provider Base Image
  └─ Layer 1: Base Snapshot (OpenCode + Caddy + services + CLI)
       └─ Layer 2: Repo Snapshot (git clone of specific repo)
            └─ Layer 3: Prebuild Snapshot (dependencies installed, services configured)
                 └─ Layer 4: Session Snapshot (full runtime state at pause time)
```

### Resolution Order (when starting a session)

Code path: `apps/gateway/src/lib/session-store.ts` → `loadSessionContext()`, then `session-runtime.ts` → `ensureRuntimeReady()`

1. **Session has `snapshotId`** (from pause/previous snapshot) → use it directly
2. **Prebuild has `snapshotId`** (prebuild is `ready`) → use it
3. **Single repo with `repoSnapshotId`** (Modal, `ready` status) → use it as starting point
4. **Base snapshot** available via `MODAL_BASE_SNAPSHOT_ID` env → use it, clone repos fresh
5. **Nothing** → bare provider image, clone everything from scratch

The flag `snapshotHasDeps` tracks whether the resolved snapshot includes installed dependencies (true for prebuild/session snapshots, false for repo-only snapshots). This gates service auto-start on boot.

---

## Session State Machine

```
                    ┌─────────────────────────────────┐
                    │           starting               │
                    │  (record created, no sandbox)    │
                    └──────────────┬──────────────────┘
                                   │ client connects via WebSocket
                                   │ → ensureRuntimeReady()
                                   ▼
                    ┌─────────────────────────────────┐
              ┌────►│            running                │◄──────┐
              │     │  (sandbox alive, SSE connected)   │       │
              │     └──┬──────┬───────┬──────┬────────┘       │
              │        │      │       │      │                 │
              │   pause│  SSE │  expire│  stop│                │
              │        │ drop │       │      │                 │
              │        ▼      ▼       ▼      ▼                 │
              │     paused  reconnect migrate stopped           │
              │        │      │       │                         │
              │        │      │       │ (has clients)           │
              │        │      └───┐   │ snapshot + new sandbox  │
              │        │          │   └─────────────────────────┘
              │        │          │
              │     resume    retry with backoff
              │     (new WS     [1s, 2s, 5s, 10s]
              │     connect)       │
              └────────┴───────────┘
```

**Status values sent to clients** (via WebSocket `StatusMessage`):
`creating` | `resuming` | `running` | `paused` | `stopped` | `error` | `migrating`

---

## Lifecycle Flows

### 1. Session Creation

**Trigger**: User clicks "New Session" or API call
**Entry point**: `apps/web/src/server/routers/sessions-create.ts`

```
User Request
  │
  ├─ Validate billing (checkCanStartSession)
  ├─ Verify prebuild exists + user has access
  ├─ Resolve repos from prebuild_repos junction
  ├─ Determine provider (modal | e2b)
  ├─ Resolve snapshot layering (prebuild → repo → base → none)
  │
  ├─ INSERT into sessions table (status: "starting")
  │
  └─ Return sessionId immediately
      (sandbox does NOT exist yet)
```

The key insight: **no sandbox is created during the API call**. The session record is created with `status: starting` and the response returns immediately. The sandbox is provisioned later when the client connects.

### 2. Runtime Ready (Hot Path)

**Trigger**: Client WebSocket connects to Gateway
**Entry point**: `apps/gateway/src/hub/session-hub.ts` → `addClient()` → `initializeClient()`
**Core logic**: `apps/gateway/src/hub/session-runtime.ts` → `ensureRuntimeReady()`

This is the critical hot path — everything from WebSocket connect to `status: running`.

```
WebSocket Connect
  │
  ├─ Authenticate (token from query param or header)
  │     └─ apps/gateway/src/middleware/auth.ts
  │
  ├─ hubManager.getOrCreate(sessionId)
  │     └─ apps/gateway/src/hub/hub-manager.ts
  │     └─ Deduplicates concurrent creation via promise caching
  │
  ├─ hub.addClient(ws, userId)
  │     └─ Register WS, setup close/error handlers
  │
  ├─ broadcastStatus("resuming" | "creating")
  │
  ├─ ensureRuntimeReady()                     ◄── DEDUPLICATION: returns existing promise if already in-flight
  │   │
  │   ├─ waitForMigrationLockRelease()        ← blocks if migration is in progress
  │   │
  │   ├─ loadSessionContext()                 ← reload fresh from DB
  │   │   └─ apps/gateway/src/lib/session-store.ts
  │   │   ├─ sessions.findByIdInternal()
  │   │   ├─ prebuilds.getPrebuildReposWithDetails()
  │   │   ├─ Resolve GitHub tokens per repo
  │   │   ├─ Build system prompt (setup | coding | automation)
  │   │   ├─ Load + decrypt secrets (env vars)
  │   │   ├─ Derive agentConfig (modelId)
  │   │   ├─ Resolve service commands (prebuild → repo fallback)
  │   │   └─ Return SessionContext
  │   │
  │   ├─ provider.ensureSandbox(opts)         ← THE BIG CALL
  │   │   └─ (see "Sandbox Provisioning" below)
  │   │
  │   ├─ sessions.update(sessionId, {
  │   │     sandboxId, status: "running",
  │   │     openCodeTunnelUrl, previewTunnelUrl,
  │   │     sandboxExpiresAt
  │   │   })
  │   │
  │   ├─ scheduleSessionExpiry()              ← BullMQ delayed job
  │   │   └─ apps/gateway/src/expiry/expiry-queue.ts
  │   │
  │   ├─ ensureOpenCodeSession()
  │   │   ├─ Check stored codingAgentSessionId
  │   │   ├─ Verify via listOpenCodeSessions()
  │   │   └─ If invalid: createOpenCodeSession()
  │   │
  │   └─ sseClient.connect(openCodeUrl)       ← Start event stream
  │       └─ apps/gateway/src/hub/sse-client.ts
  │       └─ Heartbeat monitor starts
  │
  ├─ sendInit(ws)                             ← Fetch messages, send to client
  │
  └─ broadcastStatus("running")
```

### 3. Sandbox Provisioning (Inside Provider)

**Modal**: `packages/shared/src/providers/modal-libmodal.ts`
**E2B**: `packages/shared/src/providers/e2b.ts`

Both implement the `SandboxProvider` interface (`packages/shared/src/sandbox-provider.ts`).

```
provider.ensureSandbox(opts)
  │
  ├─ Check for existing sandbox (by sessionId/sandboxId)
  │   ├─ Modal: client.sandboxes.list() → find by name
  │   └─ E2B:   Sandbox.getInfo(currentSandboxId)
  │
  ├─ If found + alive → recover it (return { recovered: true })
  │   └─ E2B: re-inject env vars (don't persist across pause/resume)
  │
  └─ If not found → createSandbox(opts)
      │
      ├─ Resolve image/template:
      │   ├─ snapshotId provided → restore from snapshot
      │   ├─ baseSnapshotId → use as foundation, clone fresh
      │   └─ Neither → provider base image
      │
      ├─ Create sandbox container:
      │   ├─ Modal: client.sandboxes.create(app, image, {
      │   │     command: ["sh", "-c", "... start-dockerd.sh"],
      │   │     encryptedPorts: [4096, 20000],   // OpenCode + preview
      │   │     unencryptedPorts: [22],           // SSH
      │   │     cpu: 2, memoryMiB: 4096,
      │   │     timeoutMs: 24h,
      │   │     env: { SESSION_ID, ANTHROPIC_API_KEY, ... }
      │   │   })
      │   │
      │   └─ E2B: Sandbox.create(template, opts)
      │           or Sandbox.connect(snapshotId) for resume
      │
      ├─ Wait for tunnels (up to 30s)
      │
      ├─ setupSandbox() — WORKSPACE SETUP
      │   ├─ If snapshot: read metadata, resolve repoDir
      │   └─ If fresh: mkdir workspace, git clone each repo
      │
      ├─ setupEssentialDependencies() — BLOCKING
      │   ├─ Write OpenCode config files
      │   ├─ Write tool definitions (verify, save_snapshot, request_env_variables)
      │   ├─ Write instructions.md
      │   ├─ Copy pre-installed node_modules for tools
      │   ├─ Optionally write SSH authorized_keys + start sshd
      │   └─ Start OpenCode server → poll until ready
      │
      ├─ setupAdditionalDependencies() — FIRE-AND-FORGET (async)
      │   ├─ Configure git identity
      │   ├─ Start services: PostgreSQL, Redis, Mailcatcher
      │   ├─ Write Caddyfile + start Caddy
      │   ├─ Start sandbox-mcp API server
      │   └─ bootServices()
      │       ├─ proliferate env apply --spec {JSON}   (inject env files)
      │       └─ proliferate services start --name ... (each service command)
      │
      └─ Return { sandboxId, tunnelUrl, previewUrl, sshHost, sshPort, expiresAt }
```

**Key provider differences:**

| Capability | Modal | E2B |
|-----------|-------|-----|
| `supportsPause` | `false` | `true` |
| `supportsAutoPause` | `false` | `true` |
| Pause behavior | Snapshot + terminate | Native pause (can resume from same ID) |
| Resume | Always creates new sandbox from snapshot | Reconnects to paused sandbox |
| Env vars on resume | Persisted in snapshot | Must re-inject |

### 4. Pause

**Trigger**: User clicks "Pause" in UI
**Entry point**: `apps/web/src/server/routers/sessions-pause.ts` → `pauseSessionHandler()`

```
Pause Request
  │
  ├─ Validate: session exists, status === "running", has sandboxId
  │
  ├─ provider.snapshot(sessionId, sandboxId)
  │   ├─ Modal: sandbox.snapshotFilesystem() → image ID
  │   └─ E2B:   Sandbox.betaPause(sandboxId) → sandbox ID as snapshot
  │
  ├─ provider.terminate(sessionId, sandboxId)
  │   └─ Best-effort, doesn't fail if already dead
  │
  ├─ billing.finalizeSessionBilling(sessionId)
  │   └─ Record compute usage before changing status
  │
  └─ sessions.updateSession(sessionId, {
        status: "paused",
        snapshotId: <from snapshot>,
        sandboxId: null,
        openCodeTunnelUrl: null,
        previewTunnelUrl: null,
        codingAgentSessionId: null,
        pausedAt: now()
      })
```

### 5. Resume

**Trigger**: User clicks on a paused session
**Entry point**: Client WebSocket → Gateway → same `ensureRuntimeReady()` path as creation

Resume is NOT a separate code path. It's the same `ensureRuntimeReady()` flow, but the session already has a `snapshotId` from the pause. The provider's `ensureSandbox()` handles the recovery:

```
ensureRuntimeReady()
  │
  ├─ loadSessionContext()
  │   └─ session.snapshot_id is set (from pause)
  │   └─ snapshotHasDeps = true (was a running session)
  │
  ├─ broadcastStatus("resuming")
  │
  ├─ provider.ensureSandbox({
  │     snapshotId: session.snapshot_id,
  │     currentSandboxId: session.sandbox_id,  // null (was cleared on pause)
  │     ...
  │   })
  │   ├─ Modal: No existing sandbox → creates fresh from snapshotId
  │   └─ E2B:   Checks if paused sandbox exists → auto-resumes
  │             Then re-injects env vars
  │
  ├─ Full setup: essential deps, OpenCode session, SSE connect
  │
  └─ broadcastStatus("running")
```

### 6. Migration (Sandbox Expiry)

**Trigger**: BullMQ delayed job fires at `expiresAt - 5 minutes`
**Entry point**: `apps/gateway/src/expiry/expiry-queue.ts` → `hub.runExpiryMigration()`
**Core logic**: `apps/gateway/src/hub/migration-controller.ts` → `migrateToNewSandbox()`

Sandboxes have finite lifetimes (Modal: ~24h). Before expiry, the system snapshots and creates a new sandbox. Two paths based on whether clients are connected:

```
Expiry Job Fires
  │
  ├─ runWithMigrationLock(sessionId, 60s)     ← Redis distributed lock
  │
  ├─ ensureOpenCodeStopped(30s timeout)
  │   ├─ Wait for in-progress message to complete
  │   └─ If still running: abort OpenCode session
  │
  ├─ IF clients connected (or automation session):
  │   │   migrationState = "migrating"
  │   │   broadcastStatus("migrating", "Extending session...")
  │   │
  │   ├─ provider.snapshot(sessionId, sandboxId) → new snapshotId
  │   ├─ sessions.update(sessionId, { snapshotId })
  │   ├─ runtime.disconnectSse()
  │   ├─ runtime.resetSandboxState()
  │   ├─ runtime.ensureRuntimeReady({ skipMigrationLock: true })
  │   │   └─ Creates NEW sandbox from fresh snapshot
  │   │   └─ Reconnects SSE, OpenCode session
  │   ├─ migrationState = "normal"
  │   └─ broadcastStatus("running")
  │
  └─ IF no clients connected:
      │
      ├─ IF provider.supportsPause (E2B):
      │   ├─ provider.pause() → snapshotId
      │   └─ sessions.update({ status: "paused", snapshotId, pausedAt })
      │
      └─ IF NOT supportsPause (Modal):
          ├─ provider.snapshot() → snapshotId
          ├─ provider.terminate()
          ├─ sessions.update({ status: "stopped", snapshotId })
          └─ sessions.markSessionStopped()
```

### 7. Snapshot (Without Pause)

**Trigger**: User saves snapshot from UI (or agent tool call `save_snapshot`)
**Entry point**: `apps/web/src/server/routers/sessions-snapshot.ts` → `snapshotSessionHandler()`

Creates a checkpoint without stopping the session:

```
Snapshot Request
  │
  ├─ Validate: session exists, has sandboxId
  │
  ├─ provider.snapshot(sessionId, sandboxId) → snapshotId
  │
  └─ sessions.updateSession(sessionId, { snapshotId })
      (session stays "running" — sandbox is NOT terminated)
```

### 8. Termination & Cleanup

Sessions can be terminated by:
- **User action** (delete/stop from UI)
- **Billing enforcement** (`packages/services/src/billing/org-pause.ts`)
- **Sandbox natural expiry** (provider kills container)
- **Billing metering cycle** (detects dead sandbox)

```
Termination
  │
  ├─ provider.terminate(sessionId, sandboxId)
  │
  ├─ billing.finalizeSessionBilling(sessionId)
  │
  └─ sessions.update(sessionId, {
        status: "stopped",
        sandboxId: null,
        endedAt: now()
      })
```

**Billing-triggered mass termination** (`handleCreditsExhaustedV2`):
- Fetches all running sessions for an org
- Terminates each sandbox via provider
- Sets `status: "stopped"`, `stopReason: "sandbox_terminated"`

---

## Provider Abstraction

**Interface**: `packages/shared/src/sandbox-provider.ts` → `SandboxProvider`

```typescript
interface SandboxProvider {
  type: SandboxProviderType;               // "modal" | "e2b"
  supportsPause?: boolean;                 // Can pause and resume from same ID
  supportsAutoPause?: boolean;             // Provider auto-pauses on expiry

  ensureSandbox(opts): Promise<EnsureSandboxResult>;  // Find-or-create (preferred entry)
  createSandbox(opts): Promise<CreateSandboxResult>;  // Always creates fresh
  snapshot(sessionId, sandboxId): Promise<SnapshotResult>;
  pause(sessionId, sandboxId): Promise<PauseResult>;
  terminate(sessionId, sandboxId?): Promise<void>;
  writeEnvFile(sandboxId, envVars): Promise<void>;
  health(): Promise<boolean>;

  // Optional methods
  checkSandboxes?(sandboxIds): Promise<string[]>;     // Batch liveness check
  resolveTunnels?(sandboxId): Promise<{ openCodeUrl, previewUrl }>;
  readFiles?(sandboxId, folderPath): Promise<FileContent[]>;
  createTerminalSandbox?(opts): Promise<CreateTerminalSandboxResult>;
  testServiceCommands?(sandboxId, commands, opts): Promise<AutoStartOutputEntry[]>;
  execCommand?(sandboxId, argv, opts): Promise<{ stdout, stderr, exitCode }>;
}
```

**Factory**: `packages/shared/src/providers/index.ts` → `getSandboxProvider(type?)` — returns singleton based on `DEFAULT_SANDBOX_PROVIDER` env var or explicit type.

---

## Gateway Runtime Architecture

The Gateway manages the real-time bridge between clients and sandboxes. Key classes:

### HubManager (`apps/gateway/src/hub/hub-manager.ts`)
- Registry of `SessionHub` instances, one per session
- `getOrCreate(sessionId)` deduplicates concurrent creation via promise caching

### SessionHub (`apps/gateway/src/hub/session-hub.ts`, ~1000 lines)
- One per session — the central coordinator
- Manages N WebSocket client connections
- Owns `SessionRuntime`, `EventProcessor`, `MigrationController`
- Routes client messages (prompt, cancel, git ops, save_snapshot, etc.)
- Broadcasts server events to all connected clients
- Handles reconnection with exponential backoff: `[1s, 2s, 5s, 10s]`
- For `clientType: "automation"`, maintains reconnection even without WebSocket clients

### SessionRuntime (`apps/gateway/src/hub/session-runtime.ts`, ~500 lines)
- **Owns sandbox lifecycle**: provision, track, reset
- **Owns OpenCode session**: create, verify, store ID
- **Owns SSE connection**: connect to OpenCode `/event` stream
- Single entry point: `ensureRuntimeReady()` (promise-deduplicated)
- Tracks: `openCodeUrl`, `previewUrl`, `sandboxExpiresAt`, `sshHost/Port`

### EventProcessor (`apps/gateway/src/hub/event-processor.ts`, ~500 lines)
- Transforms OpenCode SSE events into `ServerMessage` types for clients
- Intercepts specific tool calls (`verify`, `save_snapshot`, `save-env-files`, `save-service-commands`)
- Tracks in-progress message state for migration coordination

### MigrationController (`apps/gateway/src/hub/migration-controller.ts`, ~280 lines)
- Orchestrates snapshot-before-expiry
- Acquires distributed lock via Redis
- Coordinates with EventProcessor to wait for/abort in-progress messages
- Two paths: migrate (snapshot + new sandbox) or idle shutdown (pause/stop)

### SseClient (`apps/gateway/src/hub/sse-client.ts`, ~310 lines)
- Transport-only SSE connection to OpenCode `/event` endpoint
- Heartbeat monitoring (configurable timeout)
- Does NOT handle reconnection — delegates to SessionHub via `onDisconnect` callback

---

## Worker Jobs

### Base Snapshot Build (`apps/worker/src/base-snapshots/index.ts`)
- **Queue**: `base-snapshot-builds` (concurrency: 1)
- **When**: On worker startup if version changed
- **What**: Creates Layer 1 snapshot with OpenCode + Caddy + services pre-installed
- **DB**: `sandboxBaseSnapshots` table, status: `building` → `ready` | `failed`

### Repo Snapshot Build (`apps/worker/src/repo-snapshots/index.ts`)
- **Queue**: `repo-snapshot-builds` (concurrency: 2, 3 retries with 5s backoff)
- **When**: Async when repo added (via `requestRepoSnapshotBuild()`)
- **What**: Creates Layer 2 snapshot with pre-cloned repository
- **DB**: `repos.repoSnapshotId`, status fields on repo record
- **Token resolution**: GitHub App → repo connection → Nango fallback

### Session Expiry (`apps/gateway/src/expiry/expiry-queue.ts`)
- **Queue**: `session-expiry` (BullMQ delayed jobs)
- **When**: Scheduled at `expiresAt - GRACE_MS` (5 min grace) during `ensureRuntimeReady()`
- **What**: Triggers migration — see [Migration](#6-migration-sandbox-expiry)
- **Dedup**: Job ID = `session_expiry__{sessionId}`, removes existing before scheduling new

### Billing Metering (`apps/worker/src/billing/worker.ts`)
- **Interval**: Every 30 seconds
- **What**: Checks sandbox liveness, bills compute time, detects dead sandboxes
- **On dead sandbox**: Bills final interval, marks session `stopped`
- **Uses**: Redis distributed lock to prevent duplicate billing across workers

---

## Service Boot Framework

When a sandbox starts (or resumes from a snapshot that has dependencies), the boot framework runs service commands automatically.

**Code path**: Provider's `setupAdditionalDependencies()` → `bootServices()`

```
bootServices()
  │
  ├─ Apply env files:
  │   └─ proliferate env apply --spec <JSON from prebuild.envFiles>
  │   └─ Writes .env files to specified paths (e.g. /workspace/api/.env.local)
  │
  └─ Start each service command:
      └─ proliferate services start --name <name> --command <cmd> --cwd <dir>
      └─ Tracked by proliferate CLI, visible in UI Services panel
```

**Gates**: Service auto-start only runs when `snapshotHasDeps === true` (indicates the snapshot has installed dependencies, not just a bare clone).

**Service command resolution** (`packages/shared/src/sandbox/service-commands.ts` → `resolveServiceCommands()`):
1. Prebuild-level `serviceCommands` (JSONB on prebuilds table) — preferred
2. Per-repo `serviceCommands` from each repo record — fallback
3. Cross-repo aware via `workspacePath` for multi-repo prebuilds

---

## Billing Integration

Billing is tightly coupled to the container lifecycle:

| Event | Billing Action |
|-------|---------------|
| Session create | `checkCanStartSession()` — verify credits |
| Runtime running | Metering worker bills every 30s |
| Pause | `finalizeSessionBilling()` — close out compute |
| Migration | Billing continues seamlessly (new sandbox) |
| Stop/terminate | `finalizeSessionBilling()` — final charges |
| Credits exhausted | `handleCreditsExhaustedV2()` — terminate all org sessions |

---

## Key File Index

### Provider Layer
| File | Purpose |
|------|---------|
| `packages/shared/src/sandbox-provider.ts` | Provider interface + types |
| `packages/shared/src/providers/modal-libmodal.ts` (~1,670 lines) | Modal SDK provider |
| `packages/shared/src/providers/e2b.ts` (~1,140 lines) | E2B SDK provider |
| `packages/shared/src/providers/index.ts` | Provider factory |

### Gateway Layer
| File | Purpose |
|------|---------|
| `apps/gateway/src/hub/session-hub.ts` (~1,038 lines) | Central session coordinator |
| `apps/gateway/src/hub/session-runtime.ts` (~500 lines) | Sandbox + OpenCode lifecycle |
| `apps/gateway/src/hub/migration-controller.ts` (~283 lines) | Expiry migration logic |
| `apps/gateway/src/hub/event-processor.ts` (~509 lines) | SSE → ServerMessage transform |
| `apps/gateway/src/hub/sse-client.ts` (~312 lines) | SSE transport |
| `apps/gateway/src/hub/hub-manager.ts` (~82 lines) | SessionHub registry |
| `apps/gateway/src/lib/session-store.ts` (~422 lines) | Context loading from DB |
| `apps/gateway/src/lib/session-creator.ts` | Session + sandbox creation |
| `apps/gateway/src/lib/opencode.ts` (~270 lines) | OpenCode HTTP API client |
| `apps/gateway/src/expiry/expiry-queue.ts` (~106 lines) | BullMQ expiry scheduling |
| `apps/gateway/src/api/proliferate/ws/index.ts` | WebSocket upgrade + auth |
| `apps/gateway/src/api/proliferate/http/sessions.ts` | Session creation HTTP route |

### API Layer (Next.js)
| File | Purpose |
|------|---------|
| `apps/web/src/server/routers/sessions-create.ts` | Session creation handler |
| `apps/web/src/server/routers/sessions-pause.ts` | Pause handler |
| `apps/web/src/server/routers/sessions-snapshot.ts` | Snapshot handler |

### Services Layer
| File | Purpose |
|------|---------|
| `packages/services/src/sessions/db.ts` | Session CRUD queries |
| `packages/services/src/sessions/service.ts` | Session business logic |
| `packages/services/src/sessions/sandbox-env.ts` | Env var building + secret decryption |
| `packages/services/src/prebuilds/service.ts` | Prebuild business logic |
| `packages/services/src/prebuilds/db.ts` | Prebuild CRUD queries |
| `packages/services/src/base-snapshots/service.ts` | Base snapshot build tracking |
| `packages/services/src/billing/metering.ts` | Compute metering cycle |
| `packages/services/src/billing/org-pause.ts` | Mass session pause/terminate |

### Worker Layer
| File | Purpose |
|------|---------|
| `apps/worker/src/index.ts` | Worker entry point + queue setup |
| `apps/worker/src/base-snapshots/index.ts` | Base snapshot build handler |
| `apps/worker/src/repo-snapshots/index.ts` | Repo snapshot build handler |
| `apps/worker/src/billing/worker.ts` | Billing metering worker |

### Database Schema
| File | Purpose |
|------|---------|
| `packages/db/src/schema/sessions.ts` | Sessions table |
| `packages/db/src/schema/prebuilds.ts` | Prebuilds + prebuild_repos tables |
| `packages/db/src/schema/repos.ts` | Repos table (incl. snapshot fields) |
| `packages/db/src/schema/secrets.ts` | Encrypted secrets table |
| `packages/db/src/schema/schema.ts` | Base snapshots + misc tables |

### Client Layer
| File | Purpose |
|------|---------|
| `packages/gateway-clients/src/` | WebSocket client SDK |
| `packages/shared/src/index.ts` | Message type definitions (ClientMessage, ServerMessage) |

---

## Prerequisites: Concepts to Understand

To deeply comprehend this system, you need working knowledge of these subsystems, concepts, and technologies:

### Cloud Container Providers
- **Modal** — Serverless container platform with snapshot/image layering, tunnel system, sandbox API. Key concepts: `App`, `Image`, `Sandbox`, `snapshotFilesystem()`, encrypted/unencrypted ports, image layering.
- **E2B** — Cloud sandbox platform with native pause/resume. Key concepts: `Sandbox.create()`, `Sandbox.connect()`, `Sandbox.betaPause()`, template system, `getHost()` for tunnels.
- **Container snapshotting** — How filesystem snapshots work (copy-on-write, image layers), the difference between pause (freeze process state) vs snapshot (freeze filesystem only).

### BullMQ & Redis
- **BullMQ** — Job queues: `Queue`, `Worker`, delayed jobs, job deduplication via `jobId`, retry with exponential backoff, `removeOnComplete`/`removeOnFail`. Used for: session expiry, snapshot builds, Slack processing, automation execution.
- **Redis distributed locks** — Used for migration coordination (`runWithMigrationLock`) and billing metering (prevent duplicate billing across workers). Understand lock TTL, renewal, and contention.
- **Redis Pub/Sub** — Used for cross-service session event coordination (e.g., web user posts message → wakes Slack receiver).

### WebSocket & SSE
- **WebSocket protocol** — Persistent bidirectional connection between client and Gateway. Upgrade handshake, message framing, heartbeats, graceful close.
- **Server-Sent Events (SSE)** — One-way event stream from OpenCode to Gateway. Event parsing, heartbeat detection, reconnection. The Gateway is an SSE _client_ consuming OpenCode's `/event` stream.
- **Message routing** — How the Gateway bridges N WebSocket clients to 1 SSE stream, broadcasting events to all clients.

### OpenCode
- **OpenCode** — The Claude-powered coding agent running inside each sandbox. Key concepts: session creation, message/prompt API, tool definitions, SSE event types (`message.updated`, `message.part.updated`, `session.idle`, `session.status`).
- **Tool interception** — How the Gateway intercepts specific tool calls (e.g., `save_snapshot`, `verify`) from OpenCode, executes them server-side, and returns results.

### Database & ORM
- **Drizzle ORM** — TypeScript ORM for PostgreSQL. Schema definitions, query builder, migrations. All DB access goes through `packages/services/src/**/db.ts`.
- **Session state machine** — The status transitions and what each field means at each state (when `sandboxId` is null, when `snapshotId` is set, etc.).
- **Junction tables** — `prebuild_repos` linking prebuilds to repos with `workspacePath`.

### Authentication & Secrets
- **Token types** — JWT (user sessions), CLI tokens, service tokens (inter-service auth), sandbox MCP tokens (HMAC-derived per session).
- **Secret management** — AES encryption of env vars in DB, decryption at sandbox creation time, injection into sandbox filesystem.
- **GitHub token resolution** — Chain: repo connection → user's integration → org GitHub App → Nango OAuth fallback.

### Networking & Tunnels
- **Tunnel system** — How Modal/E2B expose sandbox ports as public HTTPS URLs. Port 4096 = OpenCode, port 20000 = web preview, port 22 = SSH.
- **Caddy** — Reverse proxy inside the sandbox, routes preview traffic.

### Node.js Runtime Patterns
- **Promise deduplication** — `ensureReadyPromise` pattern: cache the in-flight promise to prevent concurrent duplicate work. Critical for `ensureRuntimeReady()`.
- **Fire-and-forget async** — `setupAdditionalDependencies()` runs async without awaiting. Errors are caught and logged but don't block the session.
- **Graceful shutdown** — Worker drains all queues and closes Redis connections before exit.

### Observability
- **Structured logging** — Pino-based `@proliferate/logger`. Context injection via `.child()`. Latency tracking with `elapsedMs` from lifecycle start.
- **Performance timing** — Each major operation in `ensureRuntimeReady()` is individually timed and logged.
