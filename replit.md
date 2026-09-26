# Jester's Hand

Private Android-first club application with member identity, communications, activities, and administration.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- Daily Check-Ins requires a **separate Scheduled deployment**; the existing API must remain Autoscale. Run `pnpm --filter @workspace/api-server run check-ins:daily` from the workspace root on a daily schedule. Configure the job's production environment with the same Firebase project ID and privileged Firebase credential used by the API. The recommended schedule is `30 8,10,12 * * *` in UTC: the first run sends codes early in the Denver morning, and the later two safely retry failed issuance without reissuing successful codes. Each invocation writes a private `checkInJobRuns` result (status, Denver date, counts, dealer alert status) and nonzero runs send private bell/device alerts to active Hand dealers. Monitor the Scheduled deployment's nonzero exits **and missing runs** (no invocation means no in-app alert); inspect its logs and `checkInJobRuns` when alerted. Same Denver day: rerun the job command to retry failed issuance; for push failures, the code is already in Pocket, so inspect the member's bell/device settings and contact them privately. Never backdate issuance after Denver midnight. The job is not active merely because this command exists in the repo—it must be set up in Publishing before promising automatic delivery.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

- Daily Check-Ins apply to **every active Joker account**, including Hand seats 00-00 and 01-54. Everyone sees who has and has not checked in today; each person's code stays private. The pinned Hand seats alone can record milestone rewards. This is a member-safety check-in in the book's lore, not an admin-only activity.

## User preferences

- Android is the only supported mobile release target; do not spend release time or build credits on iOS.
- For user-requested app releases, create a fresh `preview` Android APK with the latest code baked in. An EAS Update alone is not accepted as proof that the installed app changed.
- Keep the in-app UPDATE path on the `preview` channel working, but verify releases against the installable Android build rather than assuming OTA delivery succeeded.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
