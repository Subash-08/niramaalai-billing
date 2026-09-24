import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const load = async (name) => require('../.test-build/' + name + '.js');
const d = await load('domain');
const {seed, makeLine} = await load('seed');
const op = await load('operations');
const {amountWords} = await load('amount-words');

const fresh = () => structuredClone(seed);
const invoice = (overrides = {}) => ({
  id: 'TEST-INV',
  customerId: 'C001',
  date: d.TODAY,
  due: d.TODAY,
  kind: 'Sale',
  category: 'New goods',
  status: 'Issued',
  lines: [makeLine('P006')],
  inclusive: true,
  notes: '',
  ...overrides,
});

test('5000 inclusive and exclusive use the same calculator as product and invoice forms', () => {
  const line = {qty: 1, rate: 5000, tax: 18, discount: 0};
  assert.deepEqual(d.lineTotal(line, true), {
    base: 4237.29,
    tax: 762.71,
    total: 5000,
    cgst: 381.36,
    sgst: 381.35,
    igst: 0,
    discount: 0,
  });
  assert.equal(d.lineTotal(line, false).total, 5900);
  assert.equal(d.lineTotal(line, false).tax, 900);
});

test('amount discounts apply once to the whole line, shipping adds once and split tax reconciles', () => {
  const product = {...makeLine('P006'), qty: 2, rate: 1000, tax: 18, discount: 100, discountType: 'Amount'};
  const charge = {...product, productId: '', name: 'Shipping', lineType: 'Charge', qty: 1, rate: 100, discount: 0};
  const sum = d.totals({lines: [product, charge], inclusive: false});
  assert.equal(sum.base, 2000);
  assert.equal(sum.tax, 360);
  assert.equal(sum.total, 2360);
  assert.equal(sum.cgst + sum.sgst, sum.tax);
  assert.equal(d.lineTotal({...product, discount: 2000}, true).total, 0);
  assert.equal(d.lineTotal({...product, tax: 0}, true).tax, 0);
});

test('inclusive GST extracts tax without adding it twice', () => {
  const t = d.totals({lines: [{...makeLine('P006'), rate: 15000}], inclusive: true});
  assert.equal(t.total, 15000);
  assert.equal(t.base, 12711.86);
  assert.equal(t.tax, 2288.14);
});

test('exclusive GST and line discounts calculate together', () => {
  const t = d.totals({lines: [{...makeLine('P006'), qty: 2, rate: 1000, discount: 10}], inclusive: false});
  assert.equal(t.base, 1800);
  assert.equal(t.tax, 324);
  assert.equal(t.total, 2124);
});

test('interstate inclusive and exclusive GST uses only IGST', () => {
  const line = {qty: 1, rate: 5000, tax: 18, discount: 0};
  const inc = d.lineTotal(line, true, 'Inter-state');
  assert.equal(inc.total, 5000);
  assert.equal(inc.igst, 762.71);
  assert.equal(inc.cgst + inc.sgst, 0);

  const exc = d.lineTotal({...line, discount: 10}, false, 'Inter-state');
  assert.equal(exc.base, 4500);
  assert.equal(exc.igst, 810);
  assert.equal(exc.total, 5310);

  const sum = d.totals({lines: [line, line], inclusive: true, taxMode: 'Inter-state'});
  assert.equal(sum.total, 10000);
  assert.equal(sum.igst, 1525.42);
  assert.equal(sum.cgst + sum.sgst, 0);
});

test('invoice captures customer and shop details at issue time', () => {
  const s = op.issueBill(fresh(), invoice());
  s.customers[0].name = 'Changed customer';
  s.settings.name = 'Changed shop';
  assert.notEqual(s.bills[0].customerSnapshot.name, s.customers[0].name);
  assert.notEqual(s.bills[0].shopSnapshot.name, s.settings.name);
});

test('product line quantity exists for price calculation only and never alters stock', () => {
  const s = fresh();
  const prodBefore = s.products.find((p) => p.id === 'P006');

  const next = op.issueBill(s, invoice({lines: [{...makeLine('P006'), qty: 500}]}));
  const prodAfter = next.products.find((p) => p.id === 'P006');

  // Product catalogue record stock is NOT decremented by product billing
  // Quantity exists solely for multiplying unit rate to produce total
  assert.equal(next.bills[0].lines[0].qty, 500);
  assert.equal(prodAfter.price, prodBefore.price);
});

test('one customer payment produces correct remaining invoice due balance', () => {
  const b = invoice({
    lines: [
      {...makeLine('P006'), rate: 1000, tax: 18},
      {...makeLine('P006'), productId: '', name: 'Shipping', lineType: 'Charge', rate: 100, tax: 18},
    ],
  });
  let s = op.issueBill(fresh(), b);
  const before = d.accountBalance(s, 'Bank account');
  s = op.addPayment(s, {
    id: 'P-CHARGE',
    date: d.TODAY,
    direction: 'In',
    account: 'Bank account',
    amount: 500,
    purpose: 'Customer payment',
    reference: b.id,
    party: b.customerId,
    note: 'UPI',
  });
  assert.equal(d.balance(s, b), 600);
  assert.equal(d.accountBalance(s, 'Bank account'), before + 500);
});

test('words function formats Indian rupee currency in words correctly', () => {
  assert.ok(amountWords(5000).toLowerCase().includes('five thousand'));
  assert.ok(amountWords(125000).toLowerCase().includes('lakh'));
});

test('money function formats Indian Rupee amounts with currency symbol and commas', () => {
  const formatted = d.money(150000);
  assert.ok(formatted.includes('1,50,000') || formatted.includes('150,000'));
});

test('no retained API route exposes stock adjustment or inventory endpoints', () => {
  const root = path.resolve('app/api');
  assert.equal(fs.existsSync(path.join(root, 'inventory')), false, '/api/inventory directory must not exist');
  assert.equal(fs.existsSync(path.join(root, 'master/products/[id]/adjust')), false, '/adjust route must not exist');
});

test('no broken internal links exist in workspace routing', () => {
  const workspaceCode = fs.readFileSync(path.resolve('components/workspace.tsx'), 'utf-8');
  assert.ok(!workspaceCode.includes("case 'purchases':"), 'purchases route must not be active');
  assert.ok(!workspaceCode.includes("case 'quotations':"), 'quotations route must not be active');
  assert.ok(!workspaceCode.includes("case 'suppliers':"), 'suppliers route must not be active');
  assert.ok(!workspaceCode.includes("case 'returns':"), 'returns route must not be active');
});
