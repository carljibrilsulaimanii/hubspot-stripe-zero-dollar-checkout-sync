// action.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-10-06
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs workflow-action/comp-checkout-action.js in a sandbox with a fake
//          fetch, so every guard and the create/update/associate path can be checked
//          without a Stripe or HubSpot account.
// Why:     The guards are what stop paid orders being written twice; they need to
//          stay right when the file is edited.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../workflow-action/comp-checkout-action.js', import.meta.url), 'utf8');

const SECRETS = { HUBSPOT_TICKETS_TOKEN: 'pat-test-token', STRIPE_COMP_SYNC_KEY: 'rk_live_test' };

function comp(overrides = {}) {
  return {
    id: 'cs_live_TEST1',
    status: 'complete',
    mode: 'payment',
    livemode: true,
    amount_total: 0,
    payment_intent: null,
    currency: 'usd',
    created: 1789000000,
    customer_details: { email: 'Alex.Rivera@example.com', phone: '+15550100' },
    success_url: 'https://www.example.com/thanks?utm_source=newsletter&utm_medium=email',
    line_items: {
      has_more: false,
      data: [
        { description: 'Your Event Name - VIP Ticket', quantity: 2 },
        { description: 'Replay Bundle', quantity: 1 },
      ],
    },
    ...overrides,
  };
}

// Runs the action once. `session` is what Stripe returns; `existing` is a record id
// the HubSpot search should find (or null); `contact` a contact id (or null).
async function run({ session, sessionId = 'cs_live_TEST1', existing = null, contact = 'c-1', config = '' }) {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    let body = {};
    if (String(url).startsWith('https://api.stripe.com/')) body = session;
    else if (url.endsWith('/contacts/search')) body = { results: contact ? [{ id: contact }] : [] };
    else if (url.endsWith('/search')) body = { results: existing ? [{ id: existing }] : [] };
    else if (method === 'POST') body = { id: 'r-new' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const ctx = {
    exports: {},
    fetch: fakeFetch,
    process: { env: { ...SECRETS } },
    URL,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE.replace(/const ASSOCIATION_TYPE_ID = null;/, config || '$&'), ctx);
  const result = await new Promise((resolve, reject) => {
    ctx.exports
      .main({ inputFields: { session_id: sessionId } }, resolve)
      .catch(reject);
  });
  // Round-trip so objects made inside the sandbox compare cleanly.
  return { out: JSON.parse(JSON.stringify(result.outputFields)), calls: JSON.parse(JSON.stringify(calls)) };
}

test('a $0 comp creates a record and associates the contact', async () => {
  const { out, calls } = await run({ session: comp() });
  assert.equal(out.status, 'created');
  assert.equal(out.ticketTier, 'VIP');
  assert.equal(out.quantity, '2');
  assert.equal(out.associated, 'true');

  const create = calls.find((c) => c.method === 'POST' && /\/objects\/2-12345678$/.test(c.url));
  assert.ok(create, 'record created');
  const p = create.body.properties;
  assert.equal(p.purchase_reference, 'cs_live_TEST1');
  assert.equal(p.purchase_type, 'Comp Ticket');
  assert.equal(p.amount, 0);
  assert.equal(p.order_bump__stripe, 'Replay Bundle');
  assert.equal(p.utm_source__stripe, 'newsletter');
  assert.equal(p.stripe_payment_intent_id, undefined, 'no invented payment id');

  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/associations/default/contacts/c-1')));
});

test('an existing record is updated, not duplicated', async () => {
  const { out, calls } = await run({ session: comp(), existing: 'r-9' });
  assert.equal(out.status, 'updated');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/2-12345678/r-9')));
  assert.ok(!calls.some((c) => c.method === 'POST' && /\/objects\/2-12345678$/.test(c.url)));
});

test('a typed association is used when ASSOCIATION_TYPE_ID is set', async () => {
  const { calls } = await run({ session: comp(), config: 'const ASSOCIATION_TYPE_ID = 408;' });
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/associations/contacts/c-1'));
  assert.deepEqual(put.body, [{ associationCategory: 'USER_DEFINED', associationTypeId: 408 }]);
});

const GUARDS = [
  ['a paid checkout', { amount_total: 9700 }, 'not_comp_paid_order'],
  ['a $0 session that still has a PaymentIntent', { payment_intent: 'pi_123' }, 'not_comp_has_payment_intent'],
  ['an incomplete session', { status: 'open' }, 'session_not_complete'],
  ['a subscription session', { mode: 'subscription' }, 'not_payment_mode'],
  ['a test-mode session', { livemode: false }, 'test_mode_session'],
  ['a session with no ticket', { line_items: { has_more: false, data: [{ description: 'Replay Bundle', quantity: 1 }] } }, 'no_ticket_line_item'],
  ['another event\'s ticket', { line_items: { has_more: false, data: [{ description: 'Other Conference - GA Ticket', quantity: 1 }] } }, 'unrecognised_event'],
];

for (const [name, overrides, status] of GUARDS) {
  test(`${name} writes nothing (${status})`, async () => {
    const { out, calls } = await run({ session: comp(overrides) });
    assert.equal(out.status, status);
    assert.ok(!calls.some((c) => c.url.startsWith('https://api.hubapi.com')), 'no HubSpot calls');
  });
}

test('a forged or malformed id never reaches Stripe', async () => {
  const { out, calls } = await run({ session: comp(), sessionId: 'pi_not_a_session' });
  assert.equal(out.status, 'no_session_id');
  assert.equal(calls.length, 0);
});

test('a buyer who is not a contact still gets a record, unassociated', async () => {
  const { out } = await run({ session: comp(), contact: null });
  assert.equal(out.status, 'created');
  assert.equal(out.associated, 'false');
});
