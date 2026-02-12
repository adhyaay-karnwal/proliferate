import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// Mock setup
// ============================================

const { mockFindById, mockUpdateRun, mockInsertRunEvent } = vi.hoisted(() => ({
	mockFindById: vi.fn(),
	mockUpdateRun: vi.fn(),
	mockInsertRunEvent: vi.fn(),
}));

vi.mock("./db", () => ({
	findById: mockFindById,
	updateRun: mockUpdateRun,
	insertRunEvent: mockInsertRunEvent,
	findByIdWithRelations: vi.fn(),
	claimRun: vi.fn(),
	listStaleRunningRuns: vi.fn(),
	listRunsForAutomation: vi.fn(),
	assignRunToUser: vi.fn(),
	unassignRun: vi.fn(),
	listRunsAssignedToUser: vi.fn(),
}));

const mockEnqueueRunNotification = vi.fn();

vi.mock("../db/client", () => ({
	getDb: vi.fn(),
	eq: vi.fn(),
	automationRuns: {},
	automationRunEvents: {},
	outbox: {},
	triggerEvents: {},
}));

vi.mock("../notifications/service", () => ({
	enqueueRunNotification: mockEnqueueRunNotification,
}));

const {
	saveEnrichmentResult,
	getEnrichmentResult,
	resolveRun,
	RunNotResolvableError,
	DEFAULT_RUN_DEADLINE_MS,
} = await import("./service");

// ============================================
// Helpers
// ============================================

function makeRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		organizationId: "org-1",
		automationId: "auto-1",
		triggerEventId: "event-1",
		status: "enriching",
		enrichmentJson: null,
		completionJson: null,
		completedAt: null,
		assignedTo: null,
		assignedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

// ============================================
// saveEnrichmentResult
// ============================================

describe("saveEnrichmentResult", () => {
	beforeEach(() => vi.clearAllMocks());

	it("writes enrichmentJson and records audit event", async () => {
		const run = makeRun();
		const payload = { summary: "Bug in auth flow", sources: ["linear-123"] };
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, enrichmentJson: payload });
		mockInsertRunEvent.mockResolvedValue({});

		const result = await saveEnrichmentResult({
			runId: "run-1",
			enrichmentPayload: payload,
		});

		expect(mockUpdateRun).toHaveBeenCalledWith("run-1", {
			enrichmentJson: payload,
		});
		expect(mockInsertRunEvent).toHaveBeenCalledWith(
			"run-1",
			"enrichment_saved",
			"enriching",
			"enriching",
			{ payloadSize: expect.any(Number) },
		);
		expect(result).toBeTruthy();
		expect(result?.enrichmentJson).toEqual(payload);
	});

	it("records payload size in event data", async () => {
		const payload = { key: "value" };
		mockFindById.mockResolvedValue(makeRun());
		mockUpdateRun.mockResolvedValue(makeRun({ enrichmentJson: payload }));
		mockInsertRunEvent.mockResolvedValue({});

		await saveEnrichmentResult({ runId: "run-1", enrichmentPayload: payload });

		const eventData = mockInsertRunEvent.mock.calls[0][4] as { payloadSize: number };
		expect(eventData.payloadSize).toBe(JSON.stringify(payload).length);
	});

	it("returns null for nonexistent run", async () => {
		mockFindById.mockResolvedValue(null);

		const result = await saveEnrichmentResult({
			runId: "nonexistent",
			enrichmentPayload: { data: "test" },
		});

		expect(result).toBeNull();
		expect(mockUpdateRun).not.toHaveBeenCalled();
		expect(mockInsertRunEvent).not.toHaveBeenCalled();
	});
});

// ============================================
// getEnrichmentResult
// ============================================

describe("getEnrichmentResult", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns enrichmentJson when present", async () => {
		const payload = { analysis: "result", confidence: 0.95 };
		mockFindById.mockResolvedValue(makeRun({ enrichmentJson: payload }));

		const result = await getEnrichmentResult("run-1");

		expect(result).toEqual(payload);
	});

	it("returns null when enrichmentJson is null", async () => {
		mockFindById.mockResolvedValue(makeRun({ enrichmentJson: null }));

		const result = await getEnrichmentResult("run-1");

		expect(result).toBeNull();
	});

	it("returns null for nonexistent run", async () => {
		mockFindById.mockResolvedValue(null);

		const result = await getEnrichmentResult("nonexistent");

		expect(result).toBeNull();
	});

	it("returns null when enrichmentJson is undefined", async () => {
		mockFindById.mockResolvedValue(makeRun());

		const result = await getEnrichmentResult("run-1");

		expect(result).toBeNull();
	});
});

// ============================================
// resolveRun
// ============================================

describe("resolveRun", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves a needs_human run to succeeded", async () => {
		const run = makeRun({ status: "needs_human" });
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, status: "succeeded" });
		mockInsertRunEvent.mockResolvedValue({});
		mockEnqueueRunNotification.mockResolvedValue(undefined);

		const result = await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
			reason: "manually verified",
			comment: "Looks good after review",
		});

		expect(result).toBeTruthy();
		expect(mockUpdateRun).toHaveBeenCalledWith("run-1", {
			status: "succeeded",
			statusReason: "manual_resolution:manually verified",
			completedAt: expect.any(Date),
		});
		expect(mockInsertRunEvent).toHaveBeenCalledWith(
			"run-1",
			"manual_resolution",
			"needs_human",
			"succeeded",
			{
				userId: "user-1",
				reason: "manually verified",
				comment: "Looks good after review",
				previousStatus: "needs_human",
			},
		);
	});

	it("resolves a failed run to succeeded", async () => {
		const run = makeRun({ status: "failed" });
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, status: "succeeded" });
		mockInsertRunEvent.mockResolvedValue({});
		mockEnqueueRunNotification.mockResolvedValue(undefined);

		const result = await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
		});

		expect(result).toBeTruthy();
	});

	it("resolves a timed_out run to failed", async () => {
		const run = makeRun({ status: "timed_out" });
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, status: "failed" });
		mockInsertRunEvent.mockResolvedValue({});
		mockEnqueueRunNotification.mockResolvedValue(undefined);

		const result = await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "failed",
			reason: "confirmed broken",
		});

		expect(result).toBeTruthy();
		expect(mockUpdateRun).toHaveBeenCalledWith("run-1", {
			status: "failed",
			statusReason: "manual_resolution:confirmed broken",
			completedAt: expect.any(Date),
		});
	});

	it("throws RunNotResolvableError for running status", async () => {
		const run = makeRun({ status: "running" });
		mockFindById.mockResolvedValue(run);

		await expect(
			resolveRun({
				runId: "run-1",
				orgId: "org-1",
				userId: "user-1",
				outcome: "succeeded",
			}),
		).rejects.toThrow(RunNotResolvableError);
	});

	it("throws RunNotResolvableError for queued status", async () => {
		const run = makeRun({ status: "queued" });
		mockFindById.mockResolvedValue(run);

		await expect(
			resolveRun({
				runId: "run-1",
				orgId: "org-1",
				userId: "user-1",
				outcome: "succeeded",
			}),
		).rejects.toThrow(RunNotResolvableError);
	});

	it("throws for invalid outcome", async () => {
		await expect(
			resolveRun({
				runId: "run-1",
				orgId: "org-1",
				userId: "user-1",
				outcome: "needs_human",
			}),
		).rejects.toThrow("Invalid resolution outcome");
	});

	it("returns null for nonexistent run", async () => {
		mockFindById.mockResolvedValue(null);

		const result = await resolveRun({
			runId: "nonexistent",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
		});

		expect(result).toBeNull();
	});

	it("returns null when org does not match", async () => {
		const run = makeRun({ organizationId: "org-other" });
		mockFindById.mockResolvedValue(run);

		const result = await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
		});

		expect(result).toBeNull();
		expect(mockUpdateRun).not.toHaveBeenCalled();
	});

	it("preserves existing completedAt if already set", async () => {
		const existingDate = new Date("2025-01-01");
		const run = makeRun({ status: "needs_human", completedAt: existingDate });
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, status: "succeeded" });
		mockInsertRunEvent.mockResolvedValue({});
		mockEnqueueRunNotification.mockResolvedValue(undefined);

		await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
		});

		expect(mockUpdateRun).toHaveBeenCalledWith("run-1", {
			status: "succeeded",
			statusReason: "manual_resolution:resolved",
			completedAt: existingDate,
		});
	});

	it("uses default reason when none provided", async () => {
		const run = makeRun({ status: "needs_human" });
		mockFindById.mockResolvedValue(run);
		mockUpdateRun.mockResolvedValue({ ...run, status: "succeeded" });
		mockInsertRunEvent.mockResolvedValue({});
		mockEnqueueRunNotification.mockResolvedValue(undefined);

		await resolveRun({
			runId: "run-1",
			orgId: "org-1",
			userId: "user-1",
			outcome: "succeeded",
		});

		expect(mockInsertRunEvent).toHaveBeenCalledWith(
			"run-1",
			"manual_resolution",
			"needs_human",
			"succeeded",
			expect.objectContaining({
				reason: null,
				comment: null,
			}),
		);
	});
});

// ============================================
// DEFAULT_RUN_DEADLINE_MS
// ============================================

describe("DEFAULT_RUN_DEADLINE_MS", () => {
	it("is 2 hours in milliseconds", () => {
		expect(DEFAULT_RUN_DEADLINE_MS).toBe(2 * 60 * 60 * 1000);
	});
});
