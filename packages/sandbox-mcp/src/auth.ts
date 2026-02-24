/**
 * Shared authentication logic for sandbox-mcp.
 * Used by both the HTTP API server and the terminal WebSocket endpoint.
 */

import { sandboxEnv } from "./env.js";

export const AUTH_TOKEN = sandboxEnv.authToken;

/**
 * Validate a Bearer token from an Authorization header.
 * Returns false if no token is configured (secure-by-default).
 */
export function validateBearerToken(authHeader: string | undefined): boolean {
	if (!AUTH_TOKEN) return false;
	if (!authHeader?.startsWith("Bearer ")) return false;
	return authHeader.slice(7) === AUTH_TOKEN;
}
