import { nodeEnv } from "@proliferate/environment/runtime";
import { env } from "@proliferate/environment/server";
import * as Sentry from "@sentry/nextjs";

const sentryDsn = env.NEXT_PUBLIC_SENTRY_DSN ?? "";

Sentry.init({
	dsn: sentryDsn,

	// Set sample rate for production
	tracesSampleRate: nodeEnv === "production" ? 0.1 : 1.0,

	// Enable debug in development
	debug: false,
});
