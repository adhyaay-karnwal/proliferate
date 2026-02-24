/**
 * CLI environment adapter.
 *
 * The CLI runs as a standalone Deno binary and cannot use
 * @proliferate/environment (which requires all server vars).
 * This module centralizes the few env reads the CLI needs.
 */
const DEFAULT_API_URL = "https://app.proliferate.com";

export const cliEnv = {
	apiUrl: process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL,
	gatewayUrl:
		process.env.NEXT_PUBLIC_GATEWAY_URL ??
		`${process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL}/gateway`,
} as const;
