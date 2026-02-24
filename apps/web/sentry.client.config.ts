import { env } from "@proliferate/environment/public";
import { nodeEnv } from "@proliferate/environment/runtime";
import * as Sentry from "@sentry/nextjs";

const sentryDsn = env.NEXT_PUBLIC_SENTRY_DSN ?? "";

Sentry.init({
	dsn: sentryDsn,

	// Set sample rates for production
	tracesSampleRate: nodeEnv === "production" ? 0.1 : 1.0,
	replaysSessionSampleRate: 0.1,
	replaysOnErrorSampleRate: 1.0,

	// Enable debug in development
	debug: false,

	integrations: [
		Sentry.replayIntegration({
			maskAllText: false,
			blockAllMedia: false,
			maskAllInputs: true,
		}),
	],

	// Filter out non-critical errors
	beforeSend(event, hint) {
		// Don't send errors in development
		if (nodeEnv !== "production") {
			return null;
		}

		// Filter out common non-actionable errors
		const error = hint.originalException;
		if (error instanceof Error) {
			// Ignore network errors from browser extensions
			if (error.message.includes("ResizeObserver loop")) {
				return null;
			}
		}

		return event;
	},
});
