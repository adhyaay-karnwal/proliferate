/**
 * VPS Sandbox Provider
 *
 * Cost-optimized sandbox provider using Docker containers on VPS hosts.
 * Ideal for self-hosted deployments where Modal/E2B costs are prohibitive.
 *
 * Features:
 * - Docker-based isolation (each session = container)
 * - Pause/resume via image commits
 * - Multi-host support for scaling
 * - SSH-based remote execution
 *
 * Cost: ~$0.03-0.08/hour per host (Hetzner/AWS/DigitalOcean)
 * vs $0.10-0.50/hour for Modal/E2B
 *
 * Prerequisites:
 * 1. VPS host with Docker installed
 * 2. SSH key access to the host
 * 3. Base image built and available on host
 */

import { env } from "@proliferate/environment/server";
import type { Logger } from "@proliferate/logger";
import { getSharedLogger } from "../logger";
import {
    AUTOMATION_COMPLETE_DESCRIPTION,
    AUTOMATION_COMPLETE_TOOL,
    ENV_FILE,
    REQUEST_ENV_VARIABLES_DESCRIPTION,
    REQUEST_ENV_VARIABLES_TOOL,
    SAVE_ENV_FILES_DESCRIPTION,
    SAVE_ENV_FILES_TOOL,
    SAVE_SERVICE_COMMANDS_DESCRIPTION,
    SAVE_SERVICE_COMMANDS_TOOL,
    SAVE_SNAPSHOT_DESCRIPTION,
    SAVE_SNAPSHOT_TOOL,
    VERIFY_TOOL,
    VERIFY_TOOL_DESCRIPTION,
} from "../opencode-tools";
import {
    ACTIONS_BOOTSTRAP,
    DEFAULT_CADDYFILE,
    ENV_INSTRUCTIONS,
    PLUGIN_MJS,
    SANDBOX_PATHS,
    SANDBOX_PORTS,
    SANDBOX_TIMEOUT_MS,
    type SandboxOperation,
    SandboxProviderError,
    type SessionMetadata,
    capOutput,
    getOpencodeConfig,
    shellEscape,
    shouldPullOnRestore,
    waitForOpenCodeReady,
} from "../sandbox";
import { getDefaultAgentConfig, toOpencodeModelId } from "../agents";
import { getLLMProxyBaseURL } from "../llm-proxy";
import type {
    AutoStartOutputEntry,
    CreateSandboxOpts,
    CreateSandboxResult,
    CreateTerminalSandboxOpts,
    CreateTerminalSandboxResult,
    EnsureSandboxResult,
    FileContent,
    PauseResult,
    PrebuildServiceCommand,
    SandboxProvider,
    SandboxProviderType,
    SnapshotResult,
} from "../sandbox-provider";
import type NodeSSHType from "node-ssh";
const NodeSSH = (await import("node-ssh")).default;

// TextEncoder for file operations
const encoder = new TextEncoder();

// Configuration from environment
const VPS_HOST = env.VPS_HOST;
const VPS_SSH_KEY = env.VPS_SSH_KEY;
const VPS_SSH_USER = env.VPS_SSH_USER ?? "root";
const VPS_BASE_IMAGE = env.VPS_BASE_IMAGE ?? "shadow-sandbox:latest";
const VPS_DATA_VOLUME = env.VPS_DATA_VOLUME ?? "/var/shadow/sandboxes";

const providerLogger = getSharedLogger().child({ module: "vps" });
const logLatency = (event: string, data?: Record<string, unknown>) => {
    providerLogger.info(data ?? {}, event);
};

/**
 * SSH connection pool for VPS hosts
 */
class SSHPool {
    private connections = new Map<string, NodeSSHType>();

    async getConnection(host: string): Promise<NodeSSHType> {
        const existing = this.connections.get(host);
        if (existing?.isConnected()) {
            return existing;
        }

        const ssh = new NodeSSH();
        await ssh.connect({
            host,
            username: VPS_SSH_USER,
            privateKey: VPS_SSH_KEY,
        });

        this.connections.set(host, ssh);
        return ssh;
    }

    async disconnectAll(): Promise<void> {
        await Promise.all(
            Array.from(this.connections.values()).map((ssh) => ssh.dispose()),
        );
        this.connections.clear();
    }
}

const sshPool = new SSHPool();

/**
 * Container metadata stored in Docker labels
 */
interface ContainerMetadata {
    sessionId: string;
    orgId?: string;
    createdAt: string;
    repoUrls: string[];
}

/**
 * Parse container metadata from Docker labels
 */
function parseContainerMetadata(labels: Record<string, string>): ContainerMetadata {
    return {
        sessionId: labels["shadow.sessionId"] ?? "unknown",
        orgId: labels["shadow.orgId"],
        createdAt: labels["shadow.createdAt"] ?? new Date().toISOString(),
        repoUrls: JSON.parse(labels["shadow.repoUrls"] ?? "[]"),
    };
}

/**
 * VPS Provider using Docker containers on remote hosts
 */
export class VPSProvider implements SandboxProvider {
    readonly type = "vps" as const;
    readonly supportsPause = true;
    readonly supportsAutoPause = true;
    private host: string;

    constructor(host?: string) {
        this.host = host ?? VPS_HOST ?? "localhost";
        if (!this.host) {
            throw new SandboxProviderError({
                provider: "vps",
                operation: "init",
                message: "VPS_HOST is required for VPS provider",
                isRetryable: false,
            });
        }
    }

    /**
     * Ensure a sandbox exists - recover existing or create new
     */
    async ensureSandbox(opts: CreateSandboxOpts): Promise<EnsureSandboxResult> {
        const log = providerLogger.child({ sessionId: opts.sessionId });
        const startTime = Date.now();

        logLatency("provider.ensure_sandbox.start", {
            provider: this.type,
            sessionId: opts.sessionId,
            hasSnapshotId: !!opts.snapshotId,
            hasCurrentSandboxId: !!opts.currentSandboxId,
        });

        // If we have a current sandbox ID, check if it's still alive
        if (opts.currentSandboxId) {
            const alive = await this.checkSandboxes([opts.currentSandboxId]);
            if (alive.length > 0) {
                log.debug({ sandboxId: opts.currentSandboxId }, "Recovering existing sandbox");
                const tunnels = await this.resolveTunnels(opts.currentSandboxId);
                logLatency("provider.ensure_sandbox.recovered", {
                    provider: this.type,
                    sessionId: opts.sessionId,
                    durationMs: Date.now() - startTime,
                });
                return {
                    sandboxId: opts.currentSandboxId,
                    tunnelUrl: tunnels.openCodeUrl,
                    previewUrl: tunnels.previewUrl,
                    recovered: true,
                };
            }
            log.debug({ sandboxId: opts.currentSandboxId }, "Sandbox not alive, creating new");
        }

        // Create new sandbox
        const result = await this.createSandbox(opts);
        return {
            ...result,
            recovered: false,
        };
    }

    /**
     * Create a new sandbox container
     */
    async createSandbox(opts: CreateSandboxOpts): Promise<CreateSandboxResult> {
        const startTime = Date.now();
        const log = providerLogger.child({ sessionId: opts.sessionId });

        logLatency("provider.create_sandbox.start", {
            provider: this.type,
            sessionId: opts.sessionId,
            repoCount: opts.repos.length,
            hasSnapshotId: !!opts.snapshotId,
        });

        // Generate unique container name
        const containerName = `shadow-${opts.sessionId}`;
        const ssh = await sshPool.getConnection(this.host);

        let imageName = VPS_BASE_IMAGE;

        // If restoring from snapshot, use the snapshot image
        if (opts.snapshotId) {
            imageName = opts.snapshotId;
            log.debug({ imageName }, "Restoring from snapshot image");
        }

        // Build environment variables
        const envVars: Record<string, string> = {
            SESSION_ID: opts.sessionId,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            ...opts.envVars,
        };

        // Construct docker run command
        const envFlags = Object.entries(envVars)
            .map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v)}`)
            .join(" ");

        const labels = [
            `shadow.sessionId=${opts.sessionId}`,
            `shadow.createdAt=${new Date().toISOString()}`,
            `shadow.repoUrls=${JSON.stringify(opts.repos.map((r) => r.repoUrl))}`,
        ];
        const labelFlags = labels.map((l) => `-l ${l}`).join(" ");

        // Port mappings
        const portFlags = `-p 0:${SANDBOX_PORTS.opencode} -p 0:${SANDBOX_PORTS.preview}`;

        // Volume for workspace persistence
        const volumeFlags = `-v ${VPS_DATA_VOLUME}/${opts.sessionId}:/workspace`;

        const dockerRunCmd = [
            "docker run -d --name",
            containerName,
            "--restart unless-stopped",
            portFlags,
            envFlags,
            labelFlags,
            volumeFlags,
            imageName,
        ].join(" ");

        log.debug({ cmd: dockerRunCmd.replace(/-e \w+=\S+/g, "-e ***") }, "Running docker create");

        const createResult = await ssh.execCommand(dockerRunCmd);
        if (createResult.code !== 0) {
            throw new SandboxProviderError({
                provider: "vps",
                operation: "createSandbox",
                message: `Failed to create container: ${createResult.stderr}`,
                isRetryable: true,
            });
        }

        const containerId = createResult.stdout.trim();

        // Get assigned ports
        const portsResult = await ssh.execCommand(
            `docker port ${containerName}`,
        );

        const ports = this.parseDockerPorts(portsResult.stdout);
        const opencodePort = ports[SANDBOX_PORTS.opencode];
        const previewPort = ports[SANDBOX_PORTS.preview];

        if (!opencodePort || !previewPort) {
            // Cleanup on failure
            await this.terminate(opts.sessionId, containerId);
            throw new SandboxProviderError({
                provider: "vps",
                operation: "createSandbox",
                message: "Failed to get assigned ports",
                isRetryable: true,
            });
        }

        // Build tunnel URLs
        const tunnelUrl = `http://${this.host}:${opencodePort}`;
        const previewUrl = `http://${this.host}:${previewPort}`;

        // Inject configuration files
        await this.injectSandboxFiles(containerId, opts);

        // Start OpenCode
        await this.startOpenCode(containerId, opts);

        logLatency("provider.create_sandbox.complete", {
            provider: this.type,
            sessionId: opts.sessionId,
            containerId,
            durationMs: Date.now() - startTime,
        });

        return {
            sandboxId: containerId,
            tunnelUrl,
            previewUrl,
            expiresAt: Date.now() + SANDBOX_TIMEOUT_MS,
        };
    }

    /**
     * Parse docker port output
     */
    private parseDockerPorts(output: string): Record<number, number> {
        const ports: Record<number, number> = {};
        for (const line of output.split("\n")) {
            const match = line.match(/(\d+)\/\w+ -> .*:(\d+)/);
            if (match) {
                const containerPort = Number.parseInt(match[1], 10);
                const hostPort = Number.parseInt(match[2], 10);
                if (!Number.isNaN(containerPort) && !Number.isNaN(hostPort)) {
                    ports[containerPort] = hostPort;
                }
            }
        }
        return ports;
    }

    /**
     * Inject configuration files into the sandbox
     */
    private async injectSandboxFiles(
        containerId: string,
        opts: CreateSandboxOpts,
    ): Promise<void> {
        const ssh = await sshPool.getConnection(this.host);
        const log = providerLogger.child({ sessionId: opts.sessionId });

        // Create .proliferate directory
        await ssh.execCommand(`docker exec ${containerId} mkdir -p /home/user/.proliferate`);

        // Write metadata
        const metadata: SessionMetadata = {
            sessionId: opts.sessionId,
            userName: opts.userName,
            userEmail: opts.userEmail,
            repos: opts.repos,
            branch: opts.branch,
            createdAt: new Date().toISOString(),
            provider: "vps",
        };

        await this.writeFileInContainer(
            containerId,
            "/home/user/.proliferate/metadata.json",
            JSON.stringify(metadata, null, 2),
        );

        // Write trigger context if provided
        if (opts.triggerContext) {
            await this.writeFileInContainer(
                containerId,
                "/home/user/.proliferate/trigger-context.json",
                JSON.stringify(opts.triggerContext),
            );
        }

        // Clone repos
        for (const repo of opts.repos) {
            const targetPath = `/workspace/${repo.workspacePath}`;
            await ssh.execCommand(`docker exec ${containerId} mkdir -p ${targetPath}`);

            const token = repo.token ?? opts.envVars.GITHUB_TOKEN;
            const cloneUrl = token
                ? repo.repoUrl.replace("https://", `https://${token}@`)
                : repo.repoUrl;

            log.debug({ repo: repo.repoUrl, path: targetPath }, "Cloning repo");

            const cloneResult = await ssh.execCommand(
                `docker exec ${containerId} git clone --depth 1 --branch ${opts.branch} ${cloneUrl} ${targetPath} || true`,
            );

            if (cloneResult.code !== 0) {
                log.warn({ repo: repo.repoUrl, error: cloneResult.stderr }, "Clone warning");
            }
        }

        // Setup OpenCode configuration
        await this.setupOpenCode(containerId, opts, log);

        // Write Caddyfile for preview proxy
        await ssh.execCommand(`docker exec ${containerId} mkdir -p /etc/caddy`);
        await this.writeFileInContainer(
            containerId,
            "/etc/caddy/Caddyfile",
            DEFAULT_CADDYFILE,
        );
    }

    /**
     * Setup OpenCode configuration and tools
     */
    private async setupOpenCode(
        containerId: string,
        opts: CreateSandboxOpts,
        log: Logger,
    ): Promise<void> {
        const ssh = await sshPool.getConnection(this.host);
        const globalOpencodeDir = SANDBOX_PATHS.globalOpencodeDir;
        const globalPluginDir = SANDBOX_PATHS.globalPluginDir;
        const localOpencodeDir = `/workspace/.opencode`;
        const localToolDir = `${localOpencodeDir}/tool`;

        // Get LLM proxy config
        const llmProxyBaseUrl = getLLMProxyBaseURL();
        const llmProxyApiKey = opts.envVars.LLM_PROXY_API_KEY;

        // Prepare config content
        const agentConfig = opts.agentConfig || getDefaultAgentConfig();
        const opencodeModelId = toOpencodeModelId(agentConfig.modelId);
        let opencodeConfig: string;
        if (llmProxyBaseUrl && llmProxyApiKey) {
            log.debug({ llmProxyBaseUrl }, "Using LLM proxy");
            opencodeConfig = getOpencodeConfig(opencodeModelId, llmProxyBaseUrl);
        } else {
            log.debug("Direct API mode (no proxy)");
            opencodeConfig = getOpencodeConfig(opencodeModelId);
        }
        log.debug({ modelId: agentConfig.modelId, opencodeModelId }, "Using model");

        const basePrompt = opts.systemPrompt || "You are a senior engineer working on this codebase.";
        const instructions = `${basePrompt}\n\n${ENV_INSTRUCTIONS}`;

        // Create all directories
        await ssh.execCommand(
            `docker exec ${containerId} mkdir -p ${globalOpencodeDir} ${globalPluginDir} ${localToolDir} ${SANDBOX_PATHS.proliferateDir}`,
        );

        // Write all files
        await this.writeFileInContainer(containerId, `${globalPluginDir}/proliferate.mjs`, PLUGIN_MJS);
        await this.writeFileInContainer(containerId, `${localToolDir}/verify.ts`, VERIFY_TOOL);
        await this.writeFileInContainer(containerId, `${localToolDir}/verify.txt`, VERIFY_TOOL_DESCRIPTION);
        await this.writeFileInContainer(containerId, `${localToolDir}/request_env_variables.ts`, REQUEST_ENV_VARIABLES_TOOL);
        await this.writeFileInContainer(containerId, `${localToolDir}/request_env_variables.txt`, REQUEST_ENV_VARIABLES_DESCRIPTION);
        await this.writeFileInContainer(containerId, `${localToolDir}/save_snapshot.ts`, SAVE_SNAPSHOT_TOOL);
        await this.writeFileInContainer(containerId, `${localToolDir}/save_snapshot.txt`, SAVE_SNAPSHOT_DESCRIPTION);
        await this.writeFileInContainer(containerId, `${localToolDir}/automation_complete.ts`, AUTOMATION_COMPLETE_TOOL);
        await this.writeFileInContainer(containerId, `${localToolDir}/automation_complete.txt`, AUTOMATION_COMPLETE_DESCRIPTION);
        await this.writeFileInContainer(containerId, `${globalOpencodeDir}/opencode.json`, opencodeConfig);
        await this.writeFileInContainer(containerId, `${localOpencodeDir}/instructions.md`, instructions);
        await this.writeFileInContainer(containerId, `${SANDBOX_PATHS.proliferateDir}/actions-guide.md`, ACTIONS_BOOTSTRAP);
    }

    /**
     * Write a file inside a container
     */
    private async writeFileInContainer(
        containerId: string,
        path: string,
        content: string,
    ): Promise<void> {
        const ssh = await sshPool.getConnection(this.host);
        const encoded = Buffer.from(content).toString("base64");
        await ssh.execCommand(
            `echo ${encoded} | base64 -d | docker exec -i ${containerId} tee ${path} > /dev/null`,
        );
    }

    /**
     * Start OpenCode in the container
     */
    private async startOpenCode(containerId: string, opts: CreateSandboxOpts): Promise<void> {
        const ssh = await sshPool.getConnection(this.host);

        // Start Caddy first
        await ssh.execCommand(
            `docker exec -d ${containerId} caddy run --config /etc/caddy/Caddyfile`,
        );

        // Start OpenCode
        await ssh.execCommand(
            `docker exec -d ${containerId} bash -c "cd /workspace && opencode"`,
        );

        // Wait for OpenCode to be ready
        const portsResult = await ssh.execCommand(`docker port ${containerId}`);
        const ports = this.parseDockerPorts(portsResult.stdout);
        const opencodePort = ports[SANDBOX_PORTS.opencode];

        if (opencodePort) {
            await waitForOpenCodeReady(`http://${this.host}:${opencodePort}`);
        }
    }

    /**
     * Take a snapshot of a running sandbox
     */
    async snapshot(sessionId: string, sandboxId: string): Promise<SnapshotResult> {
        const startTime = Date.now();
        const log = providerLogger.child({ sessionId });

        logLatency("provider.snapshot.start", {
            provider: this.type,
            sessionId,
            sandboxId,
        });

        const ssh = await sshPool.getConnection(this.host);
        const snapshotName = `shadow-snapshot-${sessionId}-${Date.now()}`;

        // Commit container as new image
        const result = await ssh.execCommand(`docker commit ${sandboxId} ${snapshotName}`);

        if (result.code !== 0) {
            throw new SandboxProviderError({
                provider: "vps",
                operation: "snapshot",
                message: `Failed to create snapshot: ${result.stderr}`,
                isRetryable: true,
            });
        }

        logLatency("provider.snapshot.complete", {
            provider: this.type,
            sessionId,
            snapshotName,
            durationMs: Date.now() - startTime,
        });

        return { snapshotId: snapshotName };
    }

    /**
     * Pause a sandbox (same as snapshot for VPS provider)
     */
    async pause(sessionId: string, sandboxId: string): Promise<PauseResult> {
        const log = providerLogger.child({ sessionId });
        log.debug({ sandboxId }, "Pausing sandbox (creating snapshot)");

        // Snapshot then stop the container
        const result = await this.snapshot(sessionId, sandboxId);

        // Stop the container to free resources
        const ssh = await sshPool.getConnection(this.host);
        await ssh.execCommand(`docker stop ${sandboxId}`);

        return { snapshotId: result.snapshotId };
    }

    /**
     * Terminate a sandbox
     */
    async terminate(sessionId: string, sandboxId?: string): Promise<void> {
        const log = providerLogger.child({ sessionId });
        const containerName = `shadow-${sessionId}`;

        log.debug({ sandboxId, containerName }, "Terminating sandbox");

        const ssh = await sshPool.getConnection(this.host);

        // Try by sandboxId first, then by name
        const target = sandboxId ?? containerName;

        // Stop and remove container
        await ssh.execCommand(`docker stop ${target} 2>/dev/null || true`);
        await ssh.execCommand(`docker rm ${target} 2>/dev/null || true`);

        // Clean up workspace volume
        await ssh.execCommand(`rm -rf ${VPS_DATA_VOLUME}/${sessionId}`);

        log.debug({ target }, "Sandbox terminated");
    }

    /**
     * Write environment variables to sandbox
     */
    async writeEnvFile(sandboxId: string, envVars: Record<string, string>): Promise<void> {
        await this.writeFileInContainer(
            sandboxId,
            SANDBOX_PATHS.envProfileFile,
            JSON.stringify(envVars),
        );
    }

    /**
     * Check provider health
     */
    async health(): Promise<boolean> {
        try {
            const ssh = await sshPool.getConnection(this.host);
            const result = await ssh.execCommand("docker ps");
            return result.code === 0;
        } catch {
            return false;
        }
    }

    /**
     * Check which sandboxes are still alive
     */
    async checkSandboxes(sandboxIds: string[]): Promise<string[]> {
        const ssh = await sshPool.getConnection(this.host);
        const result = await ssh.execCommand(
            `docker ps --filter "status=running" --format "{{.ID}}"`,
        );

        const runningIds = result.stdout.trim().split("\n").filter(Boolean);
        return sandboxIds.filter((id) => runningIds.some((rid: string) => rid.startsWith(id)));
    }

    /**
     * Resolve tunnel URLs for a sandbox
     */
    async resolveTunnels(sandboxId: string): Promise<{ openCodeUrl: string; previewUrl: string }> {
        const ssh = await sshPool.getConnection(this.host);
        const result = await ssh.execCommand(`docker port ${sandboxId}`);
        const ports = this.parseDockerPorts(result.stdout);

        return {
            openCodeUrl: `http://${this.host}:${ports[SANDBOX_PORTS.opencode]}`,
            previewUrl: `http://${this.host}:${ports[SANDBOX_PORTS.preview]}`,
        };
    }

    /**
     * Read files from sandbox filesystem
     */
    async readFiles(sandboxId: string, folderPath: string): Promise<FileContent[]> {
        const ssh = await sshPool.getConnection(this.host);
        const files: FileContent[] = [];

        // Get list of files
        const result = await ssh.execCommand(
            `docker exec ${sandboxId} find ${folderPath} -type f 2>/dev/null || true`,
        );

        const paths = result.stdout.trim().split("\n").filter(Boolean);

        for (const path of paths) {
            try {
                const contentResult = await ssh.execCommand(
                    `docker exec ${sandboxId} cat ${path} 2>/dev/null || true`,
                );
                if (contentResult.code === 0) {
                    files.push({
                        path: path.replace(folderPath, "").replace(/^\//, ""),
                        data: encoder.encode(contentResult.stdout),
                    });
                }
            } catch {
                // Skip files we can't read
            }
        }

        return files;
    }

    /**
     * Execute a command in the sandbox
     */
    async execCommand(
        sandboxId: string,
        argv: string[],
        opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const ssh = await sshPool.getConnection(this.host);
        const { cwd, timeoutMs = 30000, env: cmdEnv } = opts ?? {};

        const envVars = cmdEnv
            ? Object.entries(cmdEnv)
                    .map(([k, v]) => `${shellEscape(k)}=${shellEscape(v)}`)
                    .join(" ")
            : "";

        const cwdFlag = cwd ? `cd ${cwd} && ` : "";
        const timeoutFlag = timeoutMs ? `timeout ${Math.ceil(timeoutMs / 1000)}s ` : "";
        const cmd = argv.map((a) => shellEscape(a)).join(" ");

        const result = await ssh.execCommand(
            `docker exec ${sandboxId} sh -c '${cwdFlag}${envVars} ${timeoutFlag}${cmd}'`,
        );

        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.code ?? -1,
        };
    }

    /**
     * Create a terminal sandbox with SSH access
     */
    async createTerminalSandbox(
        opts: CreateTerminalSandboxOpts,
    ): Promise<CreateTerminalSandboxResult> {
        const log = providerLogger.child({ sessionId: opts.sessionId });
        log.debug("Creating terminal sandbox");

        // For VPS provider, terminal sandbox is just a regular sandbox
        // with SSH key injection
        const ssh = await sshPool.getConnection(this.host);

        // Create container with SSH support
        const containerName = `shadow-terminal-${opts.sessionId}`;

        // Add SSH keys
        for (const key of opts.userPublicKeys) {
            await ssh.execCommand(
                `mkdir -p ${VPS_DATA_VOLUME}/${opts.sessionId}/.ssh && echo ${key} >> ${VPS_DATA_VOLUME}/${opts.sessionId}/.ssh/authorized_keys`,
            );
        }

        // Get ports
        const portsResult = await ssh.execCommand(`docker port ${containerName}`);
        const ports = this.parseDockerPorts(portsResult.stdout);

        return {
            sandboxId: containerName,
            sshHost: this.host,
            sshPort: 22, // Host SSH port
            previewUrl: `http://${this.host}:${ports[SANDBOX_PORTS.preview] || 20000}`,
        };
    }

    /**
     * Test service commands in sandbox
     */
    async testServiceCommands(
        sandboxId: string,
        commands: PrebuildServiceCommand[],
        opts: { timeoutMs: number; runId: string },
    ): Promise<AutoStartOutputEntry[]> {
        const results: AutoStartOutputEntry[] = [];

        for (const cmd of commands) {
            const result = await this.execCommand(sandboxId, cmd.command.split(" "), {
                cwd: cmd.cwd,
                timeoutMs: opts.timeoutMs,
            });

            results.push({
                name: cmd.name,
                workspacePath: cmd.workspacePath,
                cwd: cmd.cwd,
                output: capOutput(result.stdout + result.stderr, 10000),
                exitCode: result.exitCode,
            });
        }

        return results;
    }
}
