#!/usr/bin/env node
/**
 * eLOGiPay fee-portal test.
 *
 *   API_URL=http://localhost:3000 FEES_USER=<enrollment> FEES_PASS='<pw>' \
 *     node examples/test-fees.mjs
 *
 * Asserts what the fee portal actually exposes: invoice lines, dues totals,
 * payment (RECEIPT) lines, and that fee tokens cannot touch ERP endpoints.
 */
const API = process.env.API_URL || 'http://localhost:3000';
const USER = process.env.FEES_USER || process.env.ERP_USER;
const PASS = process.env.FEES_PASS || process.env.ERP_PASS;

if (!USER || !PASS) {
  console.error('Set FEES_USER and FEES_PASS (never hardcode credentials).');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const call = async (path, token, opts = {}) => {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`▸ eLOGiPay fee portal  (${API})\n`);

// ---------------------------------------------------------------- login
const login = await call('/v1/fees/login', null, {
  method: 'POST',
  body: JSON.stringify({ enrollmentNo: USER, password: PASS }),
});
check('POST /v1/fees/login → 200', login.status === 200, `HTTP ${login.status}`);
if (!login.body?.ok) {
  console.error('login failed:', JSON.stringify(login.body?.error));
  process.exit(1);
}
const key = login.body.data.apiKey;
check('token is namespaced pay_', String(key).startsWith('pay_'), `${String(key).slice(0, 8)}…`);
check('login returns the student identity', !!login.body.data.user?.name, login.body.data.user?.name);
const expires = login.body.data.expiresInSeconds;
check('session TTL is reported', Number(expires) > 600, `${Math.round(expires / 60)} min`);

try {
  // ------------------------------------------------------------ dashboard
  const dash = await call('/v1/fees/dashboard', key);
  const d = dash.body?.data;
  check('GET /v1/fees/dashboard → 200', dash.status === 200, `HTTP ${dash.status}`);
  check('dashboard carries student + totals', !!d?.student?.enrollmentNo && !!d?.dues?.totals,
    d?.student?.name);
  check('outstanding balance is a real number', typeof d?.dues?.totals?.outstanding === 'number',
    `₹${d?.dues?.totals?.outstanding}`);
  check('settled flag agrees with the balance',
    d?.dues?.settled === (d?.dues?.totals?.outstanding <= 0), `settled=${d?.dues?.settled}`);
  check('dashboard includes invoice lines', Array.isArray(d?.invoices) && d.invoices.length > 0,
    `${d?.invoices?.length} lines`);
  check('dashboard includes payment lines', Array.isArray(d?.payments), `${d?.payments?.length} payments`);

  // ---------------------------------------------------------------- dues
  const dues = await call('/v1/fees/dues', key);
  const du = dues.body?.data;
  check('GET /v1/fees/dues → 200', dues.status === 200, `HTTP ${dues.status}`);
  check('totals expose charged/receipts/discounts',
    ['charged', 'receipts', 'discounts'].every((k) => typeof du?.totals?.[k] === 'number'),
    `charged ₹${du?.totals?.charged}, receipts ₹${du?.totals?.receipts}, discounts ₹${du?.totals?.discounts}`);
  check('byHead groups the invoices',
    Array.isArray(du?.byHead) && du.byHead.length > 0, `${du?.byHead?.length} fee heads`);
  check('pendingHeads only lists heads with a balance',
    Array.isArray(du?.pendingHeads) && du.pendingHeads.every((h) => h.balance > 0),
    du?.pendingHeads?.map((h) => `${h.head}=₹${h.balance}`).join(', '));

  // head-level figures must reconcile with the row-level totals
  const headCharged = (du?.byHead || []).reduce((a, h) => a + (h.charged || 0), 0);
  const headReceipts = (du?.byHead || []).reduce((a, h) => a + (h.receipts || 0), 0);
  check('byHead charged sums to totals.charged', headCharged === du?.totals?.charged,
    `₹${headCharged} vs ₹${du?.totals?.charged}`);
  check('byHead receipts sums to totals.receipts', headReceipts === du?.totals?.receipts,
    `₹${headReceipts} vs ₹${du?.totals?.receipts}`);

  // ------------------------------------------------------------ invoices
  const inv = await call('/v1/fees/invoices', key);
  check('GET /v1/fees/invoices → 200', inv.status === 200, `HTTP ${inv.status}`);
  check('every line has a type and a head',
    inv.body?.data?.invoices?.every((r) => r.invoiceType && r.invoiceHead),
    `${inv.body?.data?.count} lines`);
  const types = [...new Set((inv.body?.data?.invoices || []).map((r) => r.invoiceType))];
  check('lines cover FEE and RECEIPT', types.includes('FEE') && types.includes('RECEIPT'), types.join('/'));
  check('FEE lines carry an amount',
    (inv.body?.data?.invoices || []).filter((r) => r.invoiceType === 'FEE').every((r) => r.amount >= 0));

  const onlyFee = await call('/v1/fees/invoices?type=FEE', key);
  check('?type=FEE filters the lines',
    (onlyFee.body?.data?.invoices || []).every((r) => r.invoiceType === 'FEE'),
    `${onlyFee.body?.data?.count} FEE lines`);

  // ------------------------------------------------------------ receipts
  const rec = await call('/v1/fees/receipts', key);
  check('GET /v1/fees/receipts → 200', rec.status === 200, `HTTP ${rec.status}`);
  const payments = (inv.body?.data?.invoices || []).filter((r) => r.invoiceType === 'RECEIPT');
  const paidSum = payments.reduce((a, r) => a + (r.receiptAmount || 0), 0);
  check('RECEIPT lines add up to totals.receipts', paidSum === du?.totals?.receipts,
    `₹${paidSum} vs ₹${du?.totals?.receipts}`);
  check('receipts answer explains an empty table when it is empty',
    rec.body?.data?.count > 0 || typeof rec.body?.data?.note === 'string',
    rec.body?.data?.count > 0 ? `${rec.body.data.count} receipts` : 'note provided');

  // ------------------------------------------------- session separation
  const erpWithPayToken = await call('/v1/student/profile', key);
  check('fee token is rejected by ERP endpoints',
    erpWithPayToken.status === 401, erpWithPayToken.body?.error?.code);

  const payWithErpToken = await call('/v1/fees/me', 'erp_notarealtoken');
  check('ERP-prefixed token is rejected by fee endpoints',
    payWithErpToken.status === 401 && payWithErpToken.body?.error?.code === 'WRONG_SYSTEM',
    payWithErpToken.body?.error?.code);

  const noToken = await call('/v1/fees/dues', null);
  check('no token → 401 NO_TOKEN', noToken.status === 401 && noToken.body?.error?.code === 'NO_TOKEN',
    noToken.body?.error?.code);

  // --------------------------------------------------------- bad login
  const badLogin = await call('/v1/fees/login', null, {
    method: 'POST',
    body: JSON.stringify({ enrollmentNo: USER, password: 'definitely-wrong' }),
  });
  check('wrong password → 401', badLogin.status === 401, badLogin.body?.error?.code);

  const missing = await call('/v1/fees/login', null, {
    method: 'POST',
    body: JSON.stringify({ enrollmentNo: USER }),
  });
  check('missing password → 400 BAD_REQUEST',
    missing.status === 400 && missing.body?.error?.code === 'BAD_REQUEST', missing.body?.error?.code);
} finally {
  await call('/v1/fees/logout', key, { method: 'POST' });
}

// token must be dead after logout
const afterLogout = await call('/v1/fees/me', key);
check('token invalid after logout', afterLogout.status === 401, afterLogout.body?.error?.code);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
