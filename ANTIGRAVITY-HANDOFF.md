# Paste this prompt into Antigravity

Finish the application in D:\AI\niramaalia ONLY. Treat D:\AI\itech as strictly read-only: never edit, install, build, run tests or use its database credentials. Read AGENTS.md. Work autonomously on the UI cleanup and verification below, preserving working backend invariants.

## Approved scope

English-only multi-tenant Billing Software for printing businesses. Company identity, GST, address, logo and bank details come from tenant settings. Do not hardcode Niramaalai identity. User supplies a NEW Atlas URI in .env.local.

Keep customers, products/inventory with manual stock adjustments, service catalogue, mixed product/service invoices, descriptions and units on both catalogue types, payments/outstanding, sales/GST/stock/service/payment reports, settings and ALL existing invoice template styles/editor/exports. No profit display. Optional inventory reference cost is acceptable. Services never reduce inventory. Optional printing specifications: size, material, GSM, colours, sides, finishing, delivery date, notes. Keep original cash/UPI/bank/card and split/partial payment semantics.

Keep lightweight Print Jobs: Received, Designing, AwaitingApproval, Approved, Printing, Finishing, Ready, Delivered, Cancelled. Exclude suppliers/purchases, quotations, enquiries, repair jobs, warranties, reservations, expenses/cash register/daily closing/campaigns. Returns/refunds/credit/debit notes and issued invoice cancellation are deferred; do not implement them now.

## Backend changes already implemented

- Mixed invoice lines carry descriptions/details, unit and print specifications. Product/service catalogues support description/unit.
- Sales posting, account initialization and stock adjustment allow a fresh tenant without legacy openingSetups, while enforcing existing incomplete setup/cutoff records and validating ledger projections.
- server/print-job-service.ts uses Mongo transactions for atomic sequence/job/audit, tenant filtering and optimistic version updates. Invoiced jobs cannot be reassigned/cancelled or their invoice link cleared.
- Invoice draft accepts printJobId and validates job tenant/customer/status. Invoice issue links the job in the SAME transaction as stock/payment posting, rolling back conflicts.
- Mapper converts stored discount paise/basis-points by /100 and maps saved invoice seller/template snapshots. Preserve money rounding and historical snapshots.
- Removed report types are rejected by API. Database defaults are billing_dev, and production origin no longer falls back to the old domain.
- Excluded routes/screens/docs were removed; some shared legacy helpers/client branches remain because retained workflows import them. Trace dependencies before deleting more.

## Finish client integration and cleanup

1. Inspect documents, inventory, people, reports, settings, templates, print jobs, store/bootstrap and exports. Remove excluded tabs, actions, links, columns, obsolete API calls and profit/test-login credential logic. Keep legitimate signup/signin/account approval, tenant isolation, ledgers and stock allocations. No bootstrap 404 dependencies may remain.
2. Product forms: description, unit, print categories, optional reference cost, manual stock. Brand/model must not be required. Service catalogue: create/edit/archive, description, unit, price and configurable tax fields, no inventory requirement. Do not guess mandatory GST rates or HSN/SAC codes.
3. ALL invoice load/edit/duplicate/save paths must retain productId/serviceId, details, unit, printSpecifications, HSN/SAC and printJobId. Some draft mapping paths currently drop these. Preserve percent/amount discounts and mixed line pricing on reload.
4. Wire Print Job Create Invoice and ?printJob to composer: fetch authorized job, preset customer/description/specifications and persist printJobId. Open an existing linked invoice instead of creating another. Never replace transactional issue linking with a direct client patch.
5. Implement pagination/search where API results are limited; avoid silently truncating customers, catalogues or jobs at 100/500 records.
6. PrintDialog must default to issued template/seller snapshots; explicitly passing templateId currently may override saved snapshots. Preserve every original template style/editor. PDF/Excel/ZIP exports must include description/unit/printing specifications, wrapping and page breaks. Update export-zip PDF path too.
7. Reports must expose only approved sales/GST/payment/outstanding/inventory/service results. Remove dead branches, return-credit/profit columns and obsolete exports. Verify tenant/date filtering and totals.
8. Settings: identity/GST/logo/bank details and invoice template preferences must work. Restore only necessary private-storage setup for logos, using a writable Windows path; do not restore removed modules.
9. Replace computer/iTech demo seeds and branding with neutral printing examples. Keep invoice design assets. Remove unused files/imports after checking references, including supplier settlement panels only when their callers are removed. Keep shared audit/security/transaction helpers. Align package-lock root name without upgrading dependencies.

## Setup and tests delegated to you

Codex typechecked backend changes BEFORE bulk cleanup; no production build or live Atlas acceptance was completed. Focused tests were adapted to installed TypeScript but have not yet passed a rerun. Do not claim tests passed without executing them.

- Work in D:\AI\niramaalia. node_modules must be independent, not a junction to source. Run npm ci if missing. Copy .env.example to .env.local only if absent; user must supply their own new Atlas URI, random Better Auth secret (32+ characters), matching APP_ORIGIN/BETTER_AUTH_URL, and writable PRIVATE_STORAGE_ROOT. Never overwrite existing secrets or use old credentials.
- Run npm run typecheck, npm test, npm run test:core, npm run build. Fix real failures. test:core compiles tsconfig.core-tests.json to .billing-test then runs tests/billing-core.test.cjs; fake transaction tests are not proof of real Mongo concurrency.
- Start npm run dev and open localhost:3000; if occupied use npm run dev -- --port 3001 with both origin variables matching. Smoke-test every retained screen, navigation, forms, settings and all templates/exports at desktop/mobile sizes. Resolve console errors, failed API calls, hydration issues, clipped descriptions and missing links.
- Once a new disposable Atlas database is available, test two tenants for isolation of customers/catalogues/jobs/invoices/payments/reports/files. If absent, report integration checks blocked and complete independent work.
- Fresh tenant must add stock and issue mixed invoice without purchases/opening workflow. Only products consume stock. Insufficient stock must roll back invoice, payments and job link. Test partial/split payments, exact outstanding, retry behavior and percent/amount discounts with inherited GST rounding.
- Test concurrent job sequence uniqueness, stale version rejection, audit rollback, foreign tenant/customer rejection, competing invoice links and inability to clear/reassign/cancel invoiced jobs. Do not expose issued-invoice reversal.
- Change settings/template after issuing invoice: historical prints/PDFs must retain snapshots; new invoices use current settings. Verify multi-page invoices and long specifications across every template.
- Replace README with accurate setup/status. Summarize changes, actual test results, remaining blockers and start URL. Do not claim production readiness without build and live integration evidence. Avoid unrelated features or rewriting working backend architecture.
