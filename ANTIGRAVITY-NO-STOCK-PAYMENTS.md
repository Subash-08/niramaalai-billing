# Paste this entire prompt into Antigravity

Continue the existing project in `D:\AI\niramaalia`. Never edit, delete, build, install into, or use credentials from `D:\AI\itech`; it is read-only reference material. Read `AGENTS.md` and the installed Next.js documentation before editing. Preserve tenant isolation, MongoDB transactions, idempotency, paise integer arithmetic, GST calculations, invoice snapshots and audit records. Do not add profit, purchases, suppliers, stock, returns/refunds, credit/debit notes, warranties, repair jobs, quotations, enquiries, reservations, expenses dashboard, cash closing or campaigns.

The user has changed the product scope: products are catalogue items only. There must be no stock quantity, availability, lot, serial, reservation, opening stock, low-stock, stock adjustment or inventory movement experience. Products and services are selectable invoice catalogue entries. Invoice quantity is for billing calculation only.

## Complex backend work already completed by Codex

- `server/master-schema.ts`: product brand and HSN are optional.
- `server/master-service.ts`: product listing/detail no longer aggregates stock collections and returns catalogue records with compatibility values `stock: 0`, `serials: []`.
- `server/sales-service.ts`: product lines validate the tenant's active catalogue record but discard stock allocations. Invoice issue no longer requires/decrements lots, transitions serials or writes stock movements. Do not restore stock posting.
- Existing customer receipt backend provides transactional receipt numbering, Cash/UPI/Bank Transfer/Card components, customer/account ledger updates, tenant checks, audit and idempotency. Codex simplified its schema to exactly one invoice per receipt, with the receipt amount exactly matching the amount applied to that invoice. Do not expose multi-invoice allocation or receipt-created advances.
- New `server/payment-voucher-service.ts` and `/api/payments/vouchers` routes implement tenant-scoped transactional outgoing payment vouchers. POST contract:
  `{date, payeeName, amountPaise, account:'Cash'|'Bank', method:'Cash'|'UPI'|'BankTransfer'|'Card'|'Cheque', purpose, reference, notes, idempotencyKey}`.
  Cash must use Cash; non-cash methods use Bank. It initializes/validates account projections, prevents overdraft, assigns a `PV` voucher number, writes `paymentVouchers`, posts an account movement and audit in one transaction. GET supports page, limit, dateFrom, dateTo and search. GET `/api/payments/vouchers/[id]` returns one tenant-owned voucher.
- Do not create a second receipt/voucher backend. Use `/api/sales/receipts`, `/api/sales/receipts/[id]`, customer receivables/statement routes, and the new voucher API.

## Build the Payments UI

Add a prominent sidebar item named `Payments & receipts` and route `/payments`. Build a polished page with summary cards and two clear tabs:

1. `Money received` lists customer receipts with search, date range, customer, receipt number, payment mode, amount, allocated amount, advance amount and action buttons. Add `Record receipt`.
2. `Money paid` lists payment vouchers with search, date range, payee, voucher number, payment mode/account, purpose, reference and amount. Add `Record payment voucher`.

Keep customer receipt entry deliberately simple. Use an accessible searchable customer combobox, then load that customer's unpaid invoices and show a searchable invoice selector/list with invoice number, date, total and current due. The user must select exactly one invoice. Prefill Amount with that invoice's full due, but allow a smaller positive amount for a partial payment. Never allow more than the selected invoice due. Do not show allocation tables, percentages, oldest-first allocation, customer advances or multi-invoice payment controls. Support Cash, UPI, Bank Transfer or Card; a single receipt uses one method. Clearly show `Balance on this invoice after payment`. On success, open the receipt preview and offer Print/Download PDF.

The outgoing voucher form needs date, searchable/free-text payee, amount, Cash/Bank, compatible method, purpose/category, external reference and notes. Display available account balance before submit and show a clear insufficient-balance error. Reuse the idempotency key for retries; regenerate only after success/cancel.

## Professional printable documents

Create separate semantic documents:

- **Money Received Receipt**: heading `RECEIPT`; receipt number/date; `Received from`; customer address/phone/GST; amount numeric and Indian amount-in-words; Cash/UPI/Bank/Card details and transaction reference; the single invoice number; amount applied; balance remaining on that invoice; total customer outstanding after this receipt; notes; company details/logo; `Authorised Signatory`.
- **Money Paid Voucher**: heading `PAYMENT VOUCHER`; voucher number/date; `Paid to`; amount numeric and Indian amount-in-words; `By {method} towards {purpose}`; account/reference; notes; company details/logo; recipient signature and authorised signature. Use the attached sample only for its compact bordered hierarchy. Do not copy KAANDHAL or any business identity.

Business identity must always come from current tenant settings; do not hardcode Niramaalai. Use the saved logo only when available. Keep a professional black/white layout that works on A4 and half-A4, with strong borders, spacing and readable typography. Browser Print must print only the document. PDF Download must be a real high-quality vector/text PDF through jsPDF (or the project’s established PDF helper), not a screenshot/JPEG. Embed the logo at adequate resolution, use Indian currency formatting/amount words, wrap long addresses/purpose/notes, prevent clipping, and produce deterministic filenames such as `receipt-RCP-....pdf` and `payment-voucher-PV-....pdf`. Provide preview, Print and Download PDF from list and detail views.

## Product/service/customer search and no-stock cleanup

Create one reusable accessible `SearchSelect`/combobox with keyboard navigation, escape-to-close, visible selected value, clear button, empty/loading state and case-insensitive matching. Debounce live API search by about 250–350 ms and cancel stale requests. Use it for:

- customer selection in invoice, receipt, print-job and relevant filter forms;
- product selection in invoice composer;
- service selection in invoice composer;
- any product/service/customer selector currently implemented as a long `<select>`.

Search by customer name/phone/GST, product name/category/description/HSN, and service name/category/description/SAC. Preserve server pagination and selected items even if they are outside the current result page.

Rename sidebar `Inventory` to `Products` and route it to the existing product catalogue URL unless a route rename is done completely. Rewrite `components/inventory.tsx` as a simple catalogue page/form. Product fields: name, description, category, unit, selling rate, price entry mode, GST rate, optional HSN, optional brand/specification and active/archive. Remove cost, supplier, condition, warranty, stock, low-stock, serials, lots, movements, quarantine, restore stock, reservations and stock exports. Remove wording such as “inventory product”, “on hand”, “stock product” and “stock item”. Invoice product options must show name, description/unit and price—never stock.

Remove stock allocation/serial modals, buttons, validations and payload generation from invoice UI. Always send product `stockAllocations: []`, no warranty, and no reservation. Remove `/api/inventory/*` and product adjust UI/routes only after confirming no retained caller depends on them. Shared historical server files may remain unexposed if deleting them would break imports; do not spend time rewriting unrelated legacy internals.

## Customer statement, reminder and delivery challan

The customer profile already has a paginated account statement and PDF/Excel export. Add a clear `Account statement` section/button and `Create payment reminder`. Reminder text must include tenant name, customer name, current outstanding, overdue invoice numbers/amounts/due dates, payment details from settings and a polite configurable message. Provide Copy and `Open WhatsApp` actions; opening WhatsApp is user initiated and must not send automatically. Never expose another tenant’s details.

Add a professional `Delivery Challan` preview/print/PDF action for an issued invoice or print job. It is non-financial: challan number, date, customer/bill-to/ship-to, linked invoice/job, item/service descriptions, quantity/unit and print specifications, delivery notes, receiver and authorised signatures. Do not show rates, GST or totals. It does not change payment or invoice state. Derive a deterministic display reference from the issued invoice/job unless you add a persisted sequence transactionally; do not fake database persistence.

## Usability and optimization

Make the page feel like a focused billing application: quick actions for New invoice, Receive money and Pay money; clear Received/Paid/Due labels; responsive tables that become cards or scroll safely on mobile; sticky invoice totals/actions where helpful; inline validation; disabled double-submit; loading skeleton/state; success action to print; meaningful empty states. Remove dead links (`/dues`, `/communication`, removed modules), supplier/service-job timelines and stock notifications. Global search should include customers, products, services and invoices, with a useful no-results state.

Avoid loading entire datasets. Paginate long lists, debounce queries, abort stale fetches, memoize derived filtering where useful, and avoid repeated bootstrap calls. Maintain accessible labels, focus handling, keyboard usage and adequate colour contrast. English only.

## Verification delegated to Antigravity

First run `npm run typecheck`; Codex could not run it in its staging copy because dependencies were only installed in `D:\AI\niramaalia`. Fix any errors from the new voucher service/routes and remove unused stock imports if required. Then run `npm test`, `npm run test:core`, and `npm run build`.

Add meaningful tests for: product invoice issues without stock records; product invoice never changes stock collections; one receipt applies to one invoice; multi-invoice receipt rejection; partial payment; amount above invoice due rejection; receipt amount/allocation mismatch rejection; tenant isolation; duplicate idempotency retry; payment voucher numbering and audit; account debit and insufficient balance rollback; incompatible payment method rejection; cross-tenant voucher GET/list isolation. Test Mongo transaction behavior with a disposable database only when the user supplies a NEW Atlas URI. Never use credentials from `D:\AI\itech`.

Start the app and manually verify all retained routes. Test search with hundreds of records, keyboard selection, mobile layout, long Tamil/English names even though UI labels remain English, large amounts, full and partial single-invoice payments, PDF text selection, print preview, logo/address wrapping, A4 and half-A4 output, customer statement/reminder, delivery challan, and both document types. Confirm no multi-invoice allocation UI and no stock UI, stock API call, stock error or stock mutation remains.

Update README with the changed no-stock scope and exact checks actually run. At the end report changed files, commands/results, start URL, and any Atlas-only blocker. Do not claim live multi-tenant acceptance without testing against the user’s new database.
