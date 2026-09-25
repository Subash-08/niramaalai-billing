// Run via: node --conditions=react-server --test tests/payments-no-stock.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date());

const dbModule = require('../.billing-test/server/db.js');
const {createPaidVoucher, getPaidVoucher, listPaidVouchers} = require('../.billing-test/server/payment-voucher-service.js');
const {recordCustomerReceipt} = require('../.billing-test/server/customer-ledger.js');
const {RecordCustomerReceiptSchema, IssueInvoiceSchema} = require('../.billing-test/server/sales-schema.js');
const {issueInvoice, buildSalesFilter} = require('../.billing-test/server/sales-service.js');

// --- In-Memory DB & Fixture Helpers ---

function matchesFilter(item, filter) {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(cond)) {
      const orMatched = cond.some(sub => matchesFilter(item, sub));
      if (!orMatched) return false;
      continue;
    }
    const val = item[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && (val === undefined || val < cond.$gte)) return false;
      if ('$lte' in cond && (val === undefined || val > cond.$lte)) return false;
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$regex' in cond) {
        const re = new RegExp(cond.$regex, cond.$options || '');
        if (!re.test(String(val || ''))) return false;
      }
    } else {
      if (val !== cond) return false;
    }
  }
  return true;
}

function applyUpdate(item, update) {
  if (update.$setOnInsert) {
    for (const [k, v] of Object.entries(update.$setOnInsert)) {
      if (item[k] === undefined) item[k] = v;
    }
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      item[k] = (item[k] || 0) + v;
    }
  }
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      item[k] = v;
    }
  }
  return item;
}

function createFixture(customState = {}) {
  const defaultBalances = [
    {_id: 'bal-a-cash', tenantId: 'tenant-a', account: 'Cash', balancePaise: 500000, version: 1},
    {_id: 'bal-a-bank', tenantId: 'tenant-a', account: 'Bank', balancePaise: 500000, version: 1},
    {_id: 'bal-b-cash', tenantId: 'tenant-b', account: 'Cash', balancePaise: 500000, version: 1},
    {_id: 'bal-b-bank', tenantId: 'tenant-b', account: 'Bank', balancePaise: 500000, version: 1},
  ];

  let initialBalances = defaultBalances;
  if (customState.tenantAccountBalances) {
    const customMap = new Map(customState.tenantAccountBalances.map(b => [`${b.tenantId}-${b.account}`, b]));
    initialBalances = defaultBalances.map(b => customMap.get(`${b.tenantId}-${b.account}`) || b);
    for (const b of customState.tenantAccountBalances) {
      if (!initialBalances.some(ib => ib.tenantId === b.tenantId && ib.account === b.account)) {
        initialBalances.push(b);
      }
    }
  }

  const store = {
    customers: customState.customers || [],
    invoices: customState.invoices || [],
    tenantAccountBalances: initialBalances,
    accountMovements: customState.accountMovements || [],
    customerReceipts: customState.customerReceipts || [],
    customerAllocations: customState.customerAllocations || [],
    paymentVouchers: customState.paymentVouchers || [],
    tenantCounters: customState.tenantCounters || [],
    idempotencyOperations: customState.idempotencyOperations || [],
    auditHistory: customState.auditHistory || [],
    businessClosings: customState.businessClosings || [],
    businessHolidays: customState.businessHolidays || [],
    businessDayGates: customState.businessDayGates || [],
    companySettings: customState.companySettings || [
      {
        _id: 'settings-tenant-a',
        tenantId: 'tenant-a',
        name: 'Print Shop Alpha',
        phone: '9876543210',
        email: 'shop@alpha.com',
        address: '123 Print Road',
        gst: '33AAAAA0000A1Z5',
        state: 'Tamil Nadu',
        stateCode: '33',
        bank: 'HDFC',
        account: '1234567890',
        ifsc: 'HDFC0001234',
        accountInitializationVersion: 1,
        phase3Migration: {
          status: 'Completed',
          version: 2,
        },
      },
      {
        _id: 'settings-tenant-b',
        tenantId: 'tenant-b',
        name: 'Print Shop Beta',
        phone: '9876543211',
        email: 'shop@beta.com',
        address: '456 Beta Road',
        gst: '33BBBBB0000B1Z5',
        state: 'Tamil Nadu',
        stateCode: '33',
        accountInitializationVersion: 1,
        phase3Migration: {
          status: 'Completed',
          version: 2,
        },
      },
    ],
    invoiceTemplates: customState.invoiceTemplates || [
      {
        _id: 'tmpl-1',
        tenantId: 'tenant-a',
        revision: 1,
        status: 'Active',
        snapshot: {name: 'Default Tax Invoice', defaultNotes: 'Thank you'},
      },
    ],
    templateRevisions: customState.templateRevisions || [
      {
        tenantId: 'tenant-a',
        templateId: 'tmpl-1',
        revision: 1,
        snapshot: {
          name: 'Default Tax Invoice',
          columns: ['item', 'qty', 'rate', 'tax', 'total'],
          fields: {notes: 'Thank you'},
        },
      },
    ],
    products: customState.products || [
      {
        _id: 'prod-flyer',
        tenantId: 'tenant-a',
        name: 'A4 Glossy Flyer',
        category: 'Printing',
        unit: 'Piece',
        sellingRatePaise: 500,
        priceEntryMode: 'Exclusive',
        taxRateBasisPoints: 1800,
        hsn: '4911',
        status: 'Active',
      },
    ],
    // Collections that must NEVER be accessed or modified during no-stock invoice flow
    inventoryLots: [],
    inventorySerials: [],
    inventoryMovements: [],
  };

  const session = {
    inTransaction() {
      return true;
    },
    async withTransaction(fn) {
      const snap = structuredClone(store);
      try {
        return await fn();
      } catch (err) {
        Object.keys(store).forEach(k => {
          store[k] = snap[k];
        });
        throw err;
      }
    },
    async endSession() {},
  };

  dbModule.mongo = async () => ({
    startSession: () => session,
  });

  const db = {
    databaseName: 'niramaalia-test-db',
    collection(name) {
      if (!store[name]) store[name] = [];
      const colItems = store[name];

      return {
        async findOne(filter) {
          const found = colItems.find(item => matchesFilter(item, filter));
          return found ? structuredClone(found) : null;
        },
        find(filter = {}) {
          let list = colItems.filter(item => matchesFilter(item, filter)).map(item => structuredClone(item));
          const cursor = {
            batchSize() {
              return cursor;
            },
            project() {
              return cursor;
            },
            sort(criteria) {
              const [field, dir] = Object.entries(criteria)[0] || ['_id', 1];
              list.sort((a, b) => {
                if (a[field] < b[field]) return dir === 1 ? -1 : 1;
                if (a[field] > b[field]) return dir === 1 ? 1 : -1;
                return 0;
              });
              return cursor;
            },
            skip(n) {
              list = list.slice(n);
              return cursor;
            },
            limit(n) {
              list = list.slice(0, n);
              return cursor;
            },
            async toArray() {
              return list;
            },
            async *[Symbol.asyncIterator]() {
              for (const item of list) {
                yield item;
              }
            },
          };
          return cursor;
        },
        async findOneAndUpdate(filter, update, opts = {}) {
          let item = colItems.find(i => matchesFilter(i, filter));
          if (!item && opts.upsert) {
            item = {_id: filter._id || 'gen-' + Date.now(), ...filter};
            colItems.push(item);
          }
          if (!item) return null;
          applyUpdate(item, update);
          return structuredClone(item);
        },
        async updateOne(filter, update, opts = {}) {
          const item = colItems.find(i => matchesFilter(i, filter));
          if (!item) {
            if (opts.upsert) {
              const newItem = {_id: filter._id || 'gen-' + Date.now(), ...filter};
              applyUpdate(newItem, update);
              colItems.push(newItem);
              return {matchedCount: 0, upsertedCount: 1};
            }
            return {matchedCount: 0, modifiedCount: 0};
          }
          applyUpdate(item, update);
          return {matchedCount: 1, modifiedCount: 1};
        },
        async insertOne(doc) {
          const cloned = structuredClone(doc);
          colItems.push(cloned);
          return {insertedId: cloned._id};
        },
        async countDocuments(filter = {}) {
          return colItems.filter(item => matchesFilter(item, filter)).length;
        },
        aggregate(pipeline = []) {
          let docs = colItems.map(item => structuredClone(item));
          for (const stage of pipeline) {
            if (stage.$match) {
              docs = docs.filter(item => matchesFilter(item, stage.$match));
            } else if (stage.$group) {
              const [outputField, expression] = Object.entries(stage.$group).find(([key]) => key !== '_id') || ['total', {$sum: '$amountPaise'}];
              const totalField = expression?.$sum?.replace('$', '') || 'amountPaise';
              const total = docs.reduce((sum, item) => sum + (Number(item[totalField]) || 0), 0);
              docs = [{ _id: null, [outputField]: total }];
            }
          }
          return {
            async toArray() {
              return docs;
            },
            async next() {
              return docs[0] || null;
            },
          };
        },
      };
    },
  };

  return {db, store, session};
}

const tenantA = {tenantId: 'tenant-a', userId: 'user-a'};
const tenantB = {tenantId: 'tenant-b', userId: 'user-b'};

// ==========================================
// 1. Single-Invoice Receipt Schema Tests
// ==========================================

test('RecordCustomerReceiptSchema allows exactly one invoice allocation', () => {
  const parsed = RecordCustomerReceiptSchema.parse({
    customerId: 'cust-1',
    date: BUSINESS_DATE,
    components: [{account: 'Cash', method: 'Cash', amountPaise: 15000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-1', amountPaise: 15000}],
    idempotencyKey: 'rcp-valid-1',
  });
  assert.equal(parsed.allocations.length, 1);
  assert.equal(parsed.allocations[0].targetId, 'inv-1');
  assert.equal(parsed.allocations[0].amountPaise, 15000);
});

test('RecordCustomerReceiptSchema rejects multi-invoice allocations', () => {
  assert.throws(
    () => {
      RecordCustomerReceiptSchema.parse({
        customerId: 'cust-1',
        date: BUSINESS_DATE,
        components: [{account: 'Cash', method: 'Cash', amountPaise: 30000}],
        allocations: [
          {targetType: 'Invoice', targetId: 'inv-1', amountPaise: 15000},
          {targetType: 'Invoice', targetId: 'inv-2', amountPaise: 15000},
        ],
        idempotencyKey: 'rcp-multi-inv',
      });
    },
    /Select exactly one invoice/
  );
});

test('RecordCustomerReceiptSchema rejects zero invoice allocations', () => {
  assert.throws(
    () => {
      RecordCustomerReceiptSchema.parse({
        customerId: 'cust-1',
        date: BUSINESS_DATE,
        components: [{account: 'Cash', method: 'Cash', amountPaise: 10000}],
        allocations: [],
        idempotencyKey: 'rcp-empty-inv',
      });
    },
    /Select exactly one invoice/
  );
});

// ==========================================
// 2. Customer Receipt Ledger Execution Tests
// ==========================================

test('one receipt applies to one invoice and updates paymentStatus and duePaise to Paid', async () => {
  const {db, store} = createFixture({
    customers: [{_id: 'cust-1', tenantId: 'tenant-a', status: 'Active', name: 'John Doe', phone: '9999999999'}],
    invoices: [
      {
        _id: 'inv-1',
        tenantId: 'tenant-a',
        customerId: 'cust-1',
        status: 'Issued',
        paymentStatus: 'Unpaid',
        duePaise: 25000,
        allocatedPaidPaise: 0,
        allocatedReceiptPaise: 0,
        totalPaise: 25000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 100000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 100000, version: 1},
    ],
  });

  const res = await recordCustomerReceipt(db, tenantA, {
    customerId: 'cust-1',
    date: BUSINESS_DATE,
    components: [{account: 'Cash', method: 'Cash', amountPaise: 25000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-1', amountPaise: 25000}],
    idempotencyKey: 'rcp-full-pay',
  });

  assert.equal(res.totalAmountPaise, 25000);
  assert.equal(res.receiptNumber.startsWith('RCP-'), true);

  // Invoice is now fully paid
  const inv = store.invoices.find(i => i._id === 'inv-1');
  assert.equal(inv.duePaise, 0);
  assert.equal(inv.paymentStatus, 'Paid');

  // Receipt records the invoice payment without maintaining a cash ledger.
  const cash = store.tenantAccountBalances.find(b => b.tenantId === 'tenant-a' && b.account === 'Cash');
  assert.equal(cash.balancePaise, 100000);
  assert.equal(store.accountMovements.length, 0);
});

test('partial payment reduces invoice due and marks invoice PartlyPaid', async () => {
  const {db, store} = createFixture({
    customers: [{_id: 'cust-1', tenantId: 'tenant-a', status: 'Active', name: 'John Doe'}],
    invoices: [
      {
        _id: 'inv-partial',
        tenantId: 'tenant-a',
        customerId: 'cust-1',
        status: 'Issued',
        paymentStatus: 'Unpaid',
        duePaise: 10000,
        allocatedPaidPaise: 0,
        allocatedReceiptPaise: 0,
        totalPaise: 10000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 50000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 50000, version: 1},
    ],
  });

  const res = await recordCustomerReceipt(db, tenantA, {
    customerId: 'cust-1',
    date: BUSINESS_DATE,
    components: [{account: 'Bank', method: 'UPI', amountPaise: 4000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-partial', amountPaise: 4000}],
    idempotencyKey: 'rcp-partial-1',
  });

  assert.equal(res.totalAmountPaise, 4000);
  const inv = store.invoices.find(i => i._id === 'inv-partial');
  assert.equal(inv.duePaise, 6000);
  assert.equal(inv.paymentStatus, 'PartlyPaid');
});

test('receipt amount above invoice due is rejected', async () => {
  const {db} = createFixture({
    customers: [{_id: 'cust-1', tenantId: 'tenant-a', status: 'Active', name: 'John Doe'}],
    invoices: [
      {
        _id: 'inv-small',
        tenantId: 'tenant-a',
        customerId: 'cust-1',
        status: 'Issued',
        paymentStatus: 'PartlyPaid',
        duePaise: 3000,
        totalPaise: 10000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 10000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 10000, version: 1},
    ],
  });

  await assert.rejects(
    recordCustomerReceipt(db, tenantA, {
      customerId: 'cust-1',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 5000}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-small', amountPaise: 5000}],
      idempotencyKey: 'rcp-overpay',
    }),
    /insufficient due/
  );
});

test('receipt amount and allocation mismatch is rejected', async () => {
  const {db} = createFixture({
    customers: [{_id: 'cust-1', tenantId: 'tenant-a', status: 'Active', name: 'John Doe'}],
    invoices: [
      {
        _id: 'inv-mismatch',
        tenantId: 'tenant-a',
        customerId: 'cust-1',
        status: 'Issued',
        paymentStatus: 'Unpaid',
        duePaise: 10000,
        totalPaise: 10000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 10000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 10000, version: 1},
    ],
  });

  await assert.rejects(
    recordCustomerReceipt(db, tenantA, {
      customerId: 'cust-1',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 5000}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-mismatch', amountPaise: 4000}],
      idempotencyKey: 'rcp-mismatch',
    }),
    /Receipt amount must exactly match the payment applied/
  );
});

test('cross-tenant customer receipt is rejected (tenant isolation)', async () => {
  const {db} = createFixture({
    customers: [{_id: 'cust-tenant-b', tenantId: 'tenant-b', status: 'Active', name: 'Tenant B Customer'}],
    invoices: [
      {
        _id: 'inv-tenant-b',
        tenantId: 'tenant-b',
        customerId: 'cust-tenant-b',
        status: 'Issued',
        paymentStatus: 'Unpaid',
        duePaise: 10000,
        totalPaise: 10000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 50000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 50000, version: 1},
    ],
  });

  // tenant-a tries to record receipt against tenant-b's customer & invoice
  await assert.rejects(
    recordCustomerReceipt(db, tenantA, {
      customerId: 'cust-tenant-b',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 10000}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-tenant-b', amountPaise: 10000}],
      idempotencyKey: 'rcp-cross-tenant',
    }),
    /Customer not found or archived/
  );
});

test('duplicate receipt idempotency retry returns cached response without double-crediting', async () => {
  const {db, store} = createFixture({
    customers: [{_id: 'cust-1', tenantId: 'tenant-a', status: 'Active', name: 'John Doe'}],
    invoices: [
      {
        _id: 'inv-idem',
        tenantId: 'tenant-a',
        customerId: 'cust-1',
        status: 'Issued',
        paymentStatus: 'Unpaid',
        duePaise: 10000,
        allocatedPaidPaise: 0,
        allocatedReceiptPaise: 0,
        totalPaise: 10000,
        version: 1,
      },
    ],
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 20000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 20000, version: 1},
    ],
  });

  const payload = {
    customerId: 'cust-1',
    date: BUSINESS_DATE,
    components: [{account: 'Cash', method: 'Cash', amountPaise: 5000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-idem', amountPaise: 5000}],
    idempotencyKey: 'rcp-idem-key',
  };

  const first = await recordCustomerReceipt(db, tenantA, payload);
  const second = await recordCustomerReceipt(db, tenantA, payload);

  assert.equal(first._id, second._id);
  assert.equal(first.receiptNumber, second.receiptNumber);

  // Retry creates one receipt and never maintains a cash ledger.
  const cash = store.tenantAccountBalances.find(b => b.tenantId === 'tenant-a' && b.account === 'Cash');
  assert.equal(cash.balancePaise, 20000);
  assert.equal(store.customerReceipts.length, 1);
  assert.equal(store.accountMovements.length, 0);
});

// ==========================================
// 3. Payment Voucher Tests
// ==========================================

test('createPaidVoucher generates PV numbering and audit without maintaining account balances', async () => {
  const {db, store} = createFixture({
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 500000, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 500000, version: 1},
    ],
  });

  const voucher1 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Paper Mills Ltd',
    amountPaise: 120000, // ₹1200
    account: 'Bank',
    method: 'BankTransfer',
    purpose: 'Raw paper rolls for brochures',
    reference: 'NEFT-99120',
    notes: 'Urgent delivery order',
    idempotencyKey: 'pv-001',
  });

  assert.equal(voucher1.voucherNumber.startsWith('PV-'), true);
  assert.equal(voucher1.amountPaise, 120000);
  assert.equal(voucher1.method, 'BankTransfer');
  assert.equal(voucher1.account, undefined);

  // Verify second voucher sequence
  const voucher2 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Ink Depot',
    amountPaise: 50000,
    account: 'Bank',
    method: 'UPI',
    purpose: 'Cyan ink cartridge refill',
    reference: 'UPI-77123',
    notes: '',
    idempotencyKey: 'pv-002',
  });

  assert.notEqual(voucher1.voucherNumber, voucher2.voucherNumber);

  // Voucher register does not debit an internal cash or bank balance.
  const bank = store.tenantAccountBalances.find(b => b.tenantId === 'tenant-a' && b.account === 'Bank');
  assert.equal(bank.balancePaise, 500000);
  assert.equal(store.accountMovements.length, 0);

  // Verify audit history
  assert.equal(store.auditHistory.length, 2);
  assert.equal(store.auditHistory[0].entityType, 'paymentVoucher');
});

test('payment voucher does not require a maintained cash or bank balance', async () => {
  const {db, store} = createFixture({
    tenantAccountBalances: [
      {tenantId: 'tenant-a', account: 'Cash', balancePaise: 0, version: 1},
      {tenantId: 'tenant-a', account: 'Bank', balancePaise: 0, version: 1},
    ],
  });

  const voucher = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Delivery Agent',
    amountPaise: 25000,
    method: 'Cash',
    purpose: 'Courier charges',
    idempotencyKey: 'pv-no-balance-required',
  });

  assert.equal(voucher.amountPaise, 25000);
  assert.equal(voucher.method, 'Cash');
  assert.equal(store.paymentVouchers.length, 1);
  assert.equal(store.accountMovements.length, 0);
  assert.equal(store.tenantAccountBalances[0].balancePaise, 0);
});

test('payment method is recorded without requiring an account selection', async () => {
  const {db} = createFixture({});
  const upi = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE, payeeName: 'Vendor', amountPaise: 1000,
    method: 'UPI', purpose: 'Test payment', idempotencyKey: 'pv-method-upi',
  });
  const cash = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE, payeeName: 'Technician', amountPaise: 2000,
    method: 'Cash', purpose: 'Service charge', idempotencyKey: 'pv-method-cash',
  });
  assert.equal(upi.method, 'UPI');
  assert.equal(cash.method, 'Cash');
  assert.equal(upi.account, undefined);
  assert.equal(cash.account, undefined);
});

test('cross-tenant payment voucher GET and listing isolation', async () => {
  const {db} = createFixture({
    paymentVouchers: [
      {
        _id: 'pv-ten-a',
        tenantId: 'tenant-a',
        voucherNumber: 'PV-2026-0001',
        payeeName: 'Vendor A',
        amountPaise: 10000,
        account: 'Cash',
        method: 'Cash',
        purpose: 'Alpha Supplies',
        date: BUSINESS_DATE,
        isReversed: false,
        createdAt: new Date(),
      },
      {
        _id: 'pv-ten-b',
        tenantId: 'tenant-b',
        voucherNumber: 'PV-2026-0002',
        payeeName: 'Vendor B',
        amountPaise: 20000,
        account: 'Bank',
        method: 'UPI',
        purpose: 'Beta Supplies',
        date: BUSINESS_DATE,
        isReversed: false,
        createdAt: new Date(),
      },
    ],
  });

  // Tenant-a can read its own voucher
  const voucherA = await getPaidVoucher(db, tenantA, 'pv-ten-a');
  assert.equal(voucherA._id, 'pv-ten-a');

  // Tenant-a cannot read Tenant-b voucher
  await assert.rejects(
    getPaidVoucher(db, tenantA, 'pv-ten-b'),
    /Payment voucher not found/
  );

  // Tenant-a list only returns its own voucher
  const listA = await listPaidVouchers(db, tenantA, {page: 1, limit: 10});
  assert.equal(listA.total, 1);
  assert.equal(listA.items[0]._id, 'pv-ten-a');
});

// ==========================================
// 4. Product Invoice No-Stock Invariant Tests
// ==========================================

test('product invoice issues without stock records and never modifies stock collections', async () => {
  const {db, store} = createFixture({
    customers: [
      {
        _id: 'cust-1',
        tenantId: 'tenant-a',
        status: 'Active',
        name: 'Flyer Customer',
        phone: '9876543210',
        state: 'Tamil Nadu',
        stateCode: '33',
      },
    ],
    invoices: [
      {
        _id: 'inv-draft-nostock',
        tenantId: 'tenant-a',
        version: 1,
        status: 'Draft',
        invoiceDate: BUSINESS_DATE,
        dueDate: BUSINESS_DATE,
        customerId: 'cust-1',
        customerSnapshot: {name: 'Flyer Customer', phone: '9876543210'},
        billTo: {name: 'Flyer Customer', phone: '9876543210', address: '', state: 'Tamil Nadu', stateCode: '33', postalCode: ''},
        invoiceKind: 'Sale',
        businessCategory: 'NewGoods',
        inclusive: true,
        taxMode: 'Intra-state',
        placeOfSupply: 'Tamil Nadu',
        templateId: 'tmpl-1',
        templateRevision: 1,
        lines: [
          {
            lineId: 'line-1',
            clientLineKey: 'key-1',
            lineType: 'Product',
            productId: 'prod-flyer',
            hsn: '4911',
            productSnapshot: {name: 'A4 Glossy Flyer', hsn: '4911', category: 'Printing', brand: '', model: '', isSerialTracked: false, condition: 'New'},
            description: 'A4 Glossy Flyer',
            details: '',
            unit: 'Piece',
            quantity: 500, // strictly for arithmetic!
            unitRatePaise: 500,
            discountType: 'Percentage',
            discountValue: 0,
            taxBasisPoints: 1800,
            taxTreatment: 'Taxable',
            inclusive: true,
            grossPaise: 250000,
            discountPaise: 0,
            taxableBasePaise: 211864,
            taxPaise: 38136,
            cgstPaise: 19068,
            sgstPaise: 19068,
            igstPaise: 0,
            totalPaise: 250000,
            returnedQuantity: 0,
            creditedReturnPaise: 0,
            stockAllocations: [], // Zero stock allocation
          },
        ],
        subtotalPaise: 211864,
        discountPaise: 0,
        taxPaise: 38136,
        cgstPaise: 19068,
        sgstPaise: 19068,
        igstPaise: 0,
        roundOffPaise: 0,
        totalPaise: 250000,
        duePaise: 250000,
      },
    ],
  });

  // Issue the invoice
  const issued = await issueInvoice(db, tenantA, {
    draftId: 'inv-draft-nostock',
    expectedVersion: 1,
    idempotencyKey: 'issue-nostock-1',
    paymentComponents: [{account: 'Cash', method: 'Cash', amountPaise: 50000, reference: ''}],
  });

  // Invoice is successfully issued
  const inv = store.invoices.find(i => i._id === 'inv-draft-nostock');
  assert.equal(inv.status, 'Issued');
  assert.equal(inv.invoiceNumber.startsWith('INV-'), true);
  assert.equal(inv.totalPaise, 250000);
  assert.equal(inv.duePaise, 200000);
  assert.equal(inv.paymentStatus, 'PartlyPaid');

  const issueReceipt = store.customerReceipts[0];
  assert.ok(issueReceipt.receiptSnapshot);
  assert.equal(issueReceipt.receiptSnapshot.invoiceId, 'inv-draft-nostock');
  assert.equal(issueReceipt.receiptSnapshot.invoiceNumber, inv.invoiceNumber);
  assert.equal(issueReceipt.receiptSnapshot.invoiceTotalPaise, 250000);
  assert.equal(issueReceipt.receiptSnapshot.dueBeforePaise, 250000);
  assert.equal(issueReceipt.receiptSnapshot.amountAppliedPaise, 50000);
  assert.equal(issueReceipt.receiptSnapshot.dueAfterPaise, 200000);

  // Invariant verification: Stock collections were NEVER touched
  assert.equal(store.inventoryLots.length, 0);
  assert.equal(store.inventorySerials.length, 0);
  assert.equal(store.inventoryMovements.length, 0);

  // Product catalogue record remains unchanged
  const product = store.products.find(p => p._id === 'prod-flyer');
  assert.equal(product.status, 'Active');
  assert.equal(product.sellingRatePaise, 500);
});

test('sales payment-status filters map to issued invoice balances', () => {
  assert.deepEqual(
    buildSalesFilter(tenantA, {status: 'Unpaid'}, 'invoices').filter,
    {tenantId: 'tenant-a', status: 'Issued', duePaise: {$gt: 0}}
  );
  assert.deepEqual(
    buildSalesFilter(tenantA, {status: 'PartlyPaid'}, 'invoices').filter,
    {tenantId: 'tenant-a', status: 'Issued', paymentStatus: 'PartlyPaid'}
  );
  assert.deepEqual(
    buildSalesFilter(tenantA, {status: 'Paid'}, 'invoices').filter,
    {tenantId: 'tenant-a', status: 'Issued', duePaise: 0}
  );
});

// ==========================================
// 5. Additional Edge-case & Invariant Tests
// ==========================================

test('wrong-customer invoice allocation is rejected', async () => {
  const {db} = createFixture({
    customers: [
      {_id: 'cust-1', tenantId: 'tenant-a', name: 'Cust 1', status: 'Active'},
      {_id: 'cust-2', tenantId: 'tenant-a', name: 'Cust 2', status: 'Active'},
    ],
    invoices: [
      {
        _id: 'inv-cust-2',
        tenantId: 'tenant-a',
        customerId: 'cust-2',
        status: 'Issued',
        totalPaise: 50000,
        duePaise: 50000,
      },
    ],
  });

  // Attempting to record receipt for cust-1 allocating cust-2's invoice must fail
  await assert.rejects(
    recordCustomerReceipt(db, tenantA, {
      customerId: 'cust-1',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 50000}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-cust-2', amountPaise: 50000}],
      idempotencyKey: 'rcp-wrong-cust',
    }),
    /does not belong to this customer|cannot accept allocation/
  );
});

test('RecordCustomerReceiptSchema rejects zero or negative amounts', () => {
  assert.throws(() => {
    RecordCustomerReceiptSchema.parse({
      customerId: 'cust-1',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 0}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-1', amountPaise: 0}],
      idempotencyKey: 'rcp-zero',
    });
  });

  assert.throws(() => {
    RecordCustomerReceiptSchema.parse({
      customerId: 'cust-1',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: -500}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-1', amountPaise: -500}],
      idempotencyKey: 'rcp-neg',
    });
  });
});

test('receipt snapshot contains correct before/after balances', async () => {
  const {db} = createFixture({
    customers: [
      {_id: 'cust-snap', tenantId: 'tenant-a', name: 'Snap Customer', phone: '9998887776', status: 'Active'},
    ],
    invoices: [
      {
        _id: 'inv-snap',
        invoiceNumber: 'INV-2026-0099',
        tenantId: 'tenant-a',
        customerId: 'cust-snap',
        status: 'Issued',
        totalPaise: 100000,
        duePaise: 100000,
      },
    ],
  });

  const receipt = await recordCustomerReceipt(db, tenantA, {
    customerId: 'cust-snap',
    date: BUSINESS_DATE,
    components: [{account: 'Cash', method: 'Cash', amountPaise: 40000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-snap', amountPaise: 40000}],
    idempotencyKey: 'rcp-snap-test',
  });

  assert.ok(receipt.receiptSnapshot);
  assert.equal(receipt.receiptSnapshot.invoiceId, 'inv-snap');
  assert.equal(receipt.receiptSnapshot.invoiceNumber, 'INV-2026-0099');
  assert.equal(receipt.receiptSnapshot.invoiceTotalPaise, 100000);
  assert.equal(receipt.receiptSnapshot.dueBeforePaise, 100000);
  assert.equal(receipt.receiptSnapshot.amountAppliedPaise, 40000);
  assert.equal(receipt.receiptSnapshot.dueAfterPaise, 60000);
  assert.equal(receipt.receiptSnapshot.customerOutstandingAfterPaise, 60000);
  assert.equal(receipt.receiptSnapshot.customer.name, 'Snap Customer');
  assert.equal(receipt.receiptSnapshot.company.name, 'Print Shop Alpha');
});

test('voucher numbering generates sequential tenant-scoped PV numbers', async () => {
  const {db} = createFixture({});

  const v1 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Paper Vendor Ltd',
    amountPaise: 15000,
    account: 'Bank',
    method: 'BankTransfer',
    purpose: 'Paper stock order',
    idempotencyKey: 'pv-seq-1',
  });

  const v2 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Ink Supplier Corp',
    amountPaise: 25000,
    account: 'Cash',
    method: 'Cash',
    purpose: 'Ink purchase',
    idempotencyKey: 'pv-seq-2',
  });

  assert.equal(v1.voucherNumber, 'PV-2026-0001');
  assert.equal(v2.voucherNumber, 'PV-2026-0002');
});

test('voucher idempotency returns one voucher without account movements', async () => {
  const {db, store} = createFixture({});

  const initialMovements = store.accountMovements.length;

  const v1 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Vendor Unique',
    amountPaise: 10000,
    account: 'Bank',
    method: 'UPI',
    purpose: 'Delivery fees',
    idempotencyKey: 'pv-idem-unique',
  });

  assert.equal(store.accountMovements.length, initialMovements);

  // Retry with same idempotency key
  const v2 = await createPaidVoucher(db, tenantA, {
    date: BUSINESS_DATE,
    payeeName: 'Vendor Unique',
    amountPaise: 10000,
    account: 'Bank',
    method: 'UPI',
    purpose: 'Delivery fees',
    idempotencyKey: 'pv-idem-unique',
  });

  assert.equal(v2._id, v1._id);
  assert.equal(v2.voucherNumber, v1.voucherNumber);
  // No additional account movement created
  assert.equal(store.accountMovements.length, initialMovements);
});

test('two concurrent receipts cannot overpay the invoice', async () => {
  const {db} = createFixture({
    customers: [
      {_id: 'cust-concur', tenantId: 'tenant-a', name: 'Concur Customer', status: 'Active'},
    ],
    invoices: [
      {
        _id: 'inv-concur',
        tenantId: 'tenant-a',
        customerId: 'cust-concur',
        status: 'Issued',
        totalPaise: 100000,
        duePaise: 100000,
      },
    ],
  });

  // First receipt takes 80000 of 100000 due
  await recordCustomerReceipt(db, tenantA, {
    customerId: 'cust-concur',
    date: BUSINESS_DATE,
    components: [{account: 'Cash', method: 'Cash', amountPaise: 80000}],
    allocations: [{targetType: 'Invoice', targetId: 'inv-concur', amountPaise: 80000}],
    idempotencyKey: 'rcp-concur-1',
  });

  // Second receipt tries to take 50000 (only 20000 remains due), must be rejected
  await assert.rejects(
    recordCustomerReceipt(db, tenantA, {
      customerId: 'cust-concur',
      date: BUSINESS_DATE,
      components: [{account: 'Cash', method: 'Cash', amountPaise: 50000}],
      allocations: [{targetType: 'Invoice', targetId: 'inv-concur', amountPaise: 50000}],
      idempotencyKey: 'rcp-concur-2',
    }),
    /insufficient due|cannot accept allocation/
  );
});

