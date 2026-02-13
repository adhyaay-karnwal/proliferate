CREATE TABLE IF NOT EXISTS "org_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'remote_http' NOT NULL,
	"url" text NOT NULL,
	"auth" jsonb NOT NULL,
	"risk_policy" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_org_connectors_org" ON "org_connectors" USING btree ("organization_id");

ALTER TABLE "org_connectors" ADD CONSTRAINT "org_connectors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "org_connectors" ADD CONSTRAINT "org_connectors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;

-- Backfill: copy existing prebuild connector configs into org_connectors.
-- For each prebuild with connectors, resolve the organization via prebuild_repos → repos.
-- Deduplicates by (organization_id, url, name) — keeps only the first occurrence.
INSERT INTO "org_connectors" ("id", "organization_id", "name", "transport", "url", "auth", "risk_policy", "enabled", "created_by", "created_at", "updated_at")
SELECT DISTINCT ON (r."organization_id", c->>'url', c->>'name')
	(c->>'id')::uuid,
	r."organization_id",
	c->>'name',
	COALESCE(c->>'transport', 'remote_http'),
	c->>'url',
	c->'auth',
	c->'riskPolicy',
	COALESCE((c->>'enabled')::boolean, true),
	p."created_by",
	COALESCE(p."connectors_updated_at", p."created_at", now()),
	COALESCE(p."connectors_updated_at", p."created_at", now())
FROM "prebuilds" p
CROSS JOIN LATERAL jsonb_array_elements(p."connectors") AS c
JOIN "prebuild_repos" pr ON pr."prebuild_id" = p."id"
JOIN "repos" r ON r."id" = pr."repo_id"
WHERE p."connectors" IS NOT NULL
  AND jsonb_array_length(p."connectors") > 0
ORDER BY r."organization_id", c->>'url', c->>'name', p."connectors_updated_at" DESC NULLS LAST;
