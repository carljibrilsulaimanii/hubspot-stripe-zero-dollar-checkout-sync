#!/usr/bin/env node
// 2-backfill-comp-checkouts.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-09-10 (published 2026-10-06)
// Deploy:  Run from your computer (README Step 7). Node 20+.
// What:    Writes $0 ("comp") Stripe Checkout Sessions that happened BEFORE the
//          webhook workflow existed into the same HubSpot custom object.
// Why:     A webhook is forward-only. This is the one-off sweep for history, and
//          the only route for buyers who aren't HubSpot contacts yet.
// ---------------------------------------------------------------------------
//
// Why this script has to exist
// ----------------------------
// A Stripe Checkout Session that totals $0 -- a 100%-off promotion code, or a
// $0 price -- creates NO PaymentIntent and NO Charge. HubSpot Data Sync mirrors
// PaymentIntents, so a comp order is invisible to it, and anything keyed on
// `pi_...` has nothing to key on. In production neither the Stripe payments
// object nor the orders object held a single $0 row. The Checkout Session is the only record of
// these orders, so it is what we read and what we key on.
//
// Consequences of that, visible in the data:
//   * `purchase_reference` holds a `cs_...` id, not `pi_...`. This is also the
//     record's display name, so comps read differently in the UI on purpose.
//   * `stripe_payment_intent_id` and `stripe_charge_id` stay empty. There is no
//     payment to link back to. Do not "fix" this by inventing an id.
//   * `event_id` follows the convention `purchase_<reference>`, so a Meta
//     Conversions API step dedupes comps the same way it dedupes paid orders.
//
// Scope: Stripe-sourced fields plus the Contact association. Anything your other
// automations copy onto the record (registration or attribution fields) is left
// to them -- this script deliberately does not reimplement logic it cannot see.
//
// Idempotent: each session is looked up by `purchase_reference` and PATCHed if
// present, created if not. Safe to re-run. It never clears a field it has no
// value for, so enrichment written by the other automation survives a re-run.
//
// Usage:
//   node scripts/2-backfill-comp-checkouts.mjs --dry-run
//   node scripts/2-backfill-comp-checkouts.mjs --since 2026-06-01 --dry-run
//   node scripts/2-backfill-comp-checkouts.mjs
//
// Env:
//   STRIPE_LIVE_KEY   rk_live_... (restricted, read-only) or sk_live_...
//   HUBSPOT_TOKEN     pat-na1-...  needs crm.objects.custom.write,
//                                  crm.objects.contacts.read, crm.associations.write

const STRIPE_KEY = process.env.STRIPE_LIVE_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

const OBJECT_TYPE = '2-12345678'; // your custom object id (README Step 1)

// Association type id for record -> Contact (README Step 1d). null = HubSpot's
// default association. Keep it the same as in the workflow action.
const ASSOCIATION_TYPE_ID = null;

// Pinned deliberately. A call with no Stripe-Version header uses the ACCOUNT
// DEFAULT version, and the live checkout.session.completed event on this account
// can report api_version 2017-08-15 - old enough that expand[]=line_items on a
// Checkout Session is not guaranteed to behave. Every field read here is stable
// from 2019 onward, so pinning costs nothing. Bump it freely; do not remove it.
const STRIPE_VERSION = '2024-06-20';

// A line item is a ticket if it names a tier. Everything else on the session is
// treated as an order bump.
const TIER_PATTERN = /\b(GA|VIP|Platinum|Diamond|Day Pass)\s+Ticket\b/i;

// And the session only counts if it is for the event we know how to label. A
// tier match against some future event would otherwise be stamped with the
// wrong `event_class`, so those are skipped loudly instead.
const EVENT_PATTERN = /your event name/i;
const EVENT_CLASS = 'Your Event 2026';

const PURCHASE_TYPE = 'Comp Ticket';

if (OBJECT_TYPE.includes('12345678')) {
  console.error('Set OBJECT_TYPE at the top of this file to your custom object id (README Step 1).');
  process.exit(1);
}

if (!STRIPE_KEY || !HUBSPOT_TOKEN) {
  console.error('Missing STRIPE_LIVE_KEY or HUBSPOT_TOKEN in the environment.');
  process.exit(1);
}

// Comps live in live mode. A test key here would write test orders in as real
// ones, with no marker on the record to tell them apart afterwards.
if (!/^(rk|sk)_live_/.test(STRIPE_KEY)) {
  console.error(`Refusing to run: STRIPE_LIVE_KEY is not a live key (${STRIPE_KEY.slice(0, 8)}...).`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number(flag('limit') ?? 0) || Infinity;
const SINCE = flag('since') ? Math.floor(new Date(flag('since')).getTime() / 1000) : undefined;

// ---------------------------------------------------------------- Stripe

async function stripeGet(path, params = {}) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
    else url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Stripe-Version': STRIPE_VERSION },
  });
  if (!res.ok) throw new Error(`Stripe ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Stripe cannot filter Checkout Sessions by amount, so we page through completed
// sessions and keep the $0 ones. `expand[]=data.line_items` saves a call per
// session, but caps at 10 items each -- refetched in full below when truncated.
async function fetchFreeSessions() {
  const free = [];
  let startingAfter;
  let scanned = 0;

  for (;;) {
    const page = await stripeGet('checkout/sessions', {
      limit: 100,
      status: 'complete',
      starting_after: startingAfter,
      'created[gte]': SINCE,
      'expand[]': ['data.line_items'],
    });

    scanned += page.data.length;
    for (const session of page.data) {
      if (session.amount_total === 0 && session.mode === 'payment' && !session.payment_intent) {
        free.push(session);
      }
    }

    if (!page.has_more || page.data.length === 0) break;
    if (free.length >= LIMIT) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  console.log(`Scanned ${scanned} completed session(s); ${free.length} totalled $0.`);
  return LIMIT === Infinity ? free : free.slice(0, LIMIT);
}

async function lineItemsFor(session) {
  const embedded = session.line_items;
  if (embedded && !embedded.has_more) return embedded.data ?? [];

  const items = [];
  let startingAfter;
  for (;;) {
    const page = await stripeGet(`checkout/sessions/${session.id}/line_items`, {
      limit: 100,
      starting_after: startingAfter,
    });
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return items;
}

// Payment-link UTMs reach the API only inside the session's success_url -- see
// the hubspot-order-form-stripe-checkout-link-integration repo. Same trick here.
function utmsFromSuccessUrl(successUrl) {
  if (!successUrl) return {};
  let params;
  try {
    params = new URL(successUrl).searchParams;
  } catch {
    return {};
  }
  const utms = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const value = params.get(`utm_${key}`);
    if (value) utms[`utm_${key}__stripe`] = value;
  }
  return utms;
}

// ---------------------------------------------------------------- mapping

function classify(items) {
  const tickets = items.filter((li) => TIER_PATTERN.test(li.description ?? ''));
  const bumps = items.filter((li) => !TIER_PATTERN.test(li.description ?? ''));
  return { tickets, bumps };
}

function tierOf(items) {
  // A session with mixed tiers is not something the current data model can
  // express (one `ticket_tier` per record), so take the highest-value tier
  // present and let the description carry the full truth.
  const order = ['Diamond', 'Platinum', 'VIP', 'GA', 'Day Pass'];
  const found = new Set();
  for (const li of items) {
    const match = TIER_PATTERN.exec(li.description ?? '');
    if (!match) continue;
    const tier = order.find((t) => t.toLowerCase() === match[1].toLowerCase());
    if (tier) found.add(tier);
  }
  return order.find((tier) => found.has(tier));
}

function toProperties(session, tickets, bumps) {
  const details = session.customer_details ?? {};
  const email = details.email ?? session.customer_email ?? undefined;
  const all = [...tickets, ...bumps];

  const properties = {
    purchase_reference: session.id,
    purchase_reference_1: session.id,
    event_id: `purchase_${session.id}`,
    event_class: EVENT_CLASS,
    purchase_type: PURCHASE_TYPE,
    ticket_tier: tierOf(tickets),
    amount: 0,
    currency: (session.currency ?? 'usd').toUpperCase(),
    quantity: tickets.reduce((sum, li) => sum + (li.quantity ?? 1), 0),
    purchase_date: new Date(session.created * 1000).toISOString(),
    email,
    phone_number: details.phone ?? undefined,
    // Line item names joined with "; ", no prices.
    description__stripe: all.map((li) => li.description).filter(Boolean).join('; '),
    order_bump__stripe: bumps.map((li) => li.description).filter(Boolean).join('; '),
    refunded: 'false',
    capi_sent: 'false',
    ...utmsFromSuccessUrl(session.success_url),
  };

  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value === undefined || value === null || value === '') delete properties[key];
  }
  return properties;
}

// ---------------------------------------------------------------- HubSpot

async function hubspot(path, init = {}) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${res.status} on ${path}: ${body}`);
  return body ? JSON.parse(body) : {};
}

const chunk = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// Read-then-write rather than batch/upsert: `purchase_reference` is not
// confirmed to carry a unique-value constraint, and batch/upsert requires one.
async function findExisting(references) {
  const found = new Map();
  for (const group of chunk(references, 100)) {
    const page = await hubspot(`/crm/v3/objects/${OBJECT_TYPE}/search`, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'purchase_reference', operator: 'IN', values: group }] }],
        properties: ['purchase_reference'],
        limit: 100,
      }),
    });
    for (const record of page.results ?? []) {
      found.set(record.properties.purchase_reference, record.id);
    }
  }
  return found;
}

async function findContacts(emails) {
  const found = new Map();
  const unique = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))];
  for (const group of chunk(unique, 100)) {
    const page = await hubspot('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: group }] }],
        properties: ['email'],
        limit: 100,
      }),
    });
    for (const contact of page.results ?? []) {
      const email = contact.properties.email?.toLowerCase();
      if (email) found.set(email, contact.id);
    }
  }
  return found;
}

async function associateContact(recordId, contactId) {
  if (ASSOCIATION_TYPE_ID) {
    // Typed association: needed when the record -> Contact association uses a label.
    await hubspot(`/crm/v4/objects/${OBJECT_TYPE}/${recordId}/associations/contacts/${contactId}`, {
      method: 'PUT',
      body: JSON.stringify([
        { associationCategory: 'USER_DEFINED', associationTypeId: Number(ASSOCIATION_TYPE_ID) },
      ]),
    });
    return;
  }
  // v4 "default" association -- creates the unlabeled association without
  // needing to look up a numeric association type id.
  await hubspot(
    `/crm/v4/objects/${OBJECT_TYPE}/${recordId}/associations/default/contacts/${contactId}`,
    { method: 'PUT' },
  );
}

// ---------------------------------------------------------------- run

const sessions = await fetchFreeSessions();

const staged = [];
const skipped = [];

for (const session of sessions) {
  const items = await lineItemsFor(session);
  const { tickets, bumps } = classify(items);

  if (tickets.length === 0) {
    skipped.push([session.id, 'no ticket line item']);
    continue;
  }
  if (!items.some((li) => EVENT_PATTERN.test(li.description ?? ''))) {
    const names = items.map((li) => li.description).join('; ');
    skipped.push([session.id, `tier matched but event did not: ${names}`]);
    continue;
  }

  staged.push({ session, properties: toProperties(session, tickets, bumps) });
}

console.log(`\n${staged.length} comp ticket order(s) to sync, ${skipped.length} skipped.\n`);

if (skipped.length) {
  console.log('Skipped:');
  for (const [id, reason] of skipped) console.log(`  ${id}  ${reason}`);
  console.log('');
}

if (staged.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const existing = await findExisting(staged.map((row) => row.properties.purchase_reference));
const contacts = await findContacts(staged.map((row) => row.properties.email));

const unmatched = [];
for (const { properties } of staged) {
  const email = properties.email?.toLowerCase();
  const action = existing.has(properties.purchase_reference) ? 'update' : 'create';
  const contactId = email ? contacts.get(email) : undefined;
  if (email && !contactId) unmatched.push(email);

  console.log(
    `  ${action.padEnd(6)} ${properties.purchase_reference}  ${(properties.ticket_tier ?? '?').padEnd(8)}` +
      `  qty ${properties.quantity}  ${email ?? '(no email)'}${contactId ? '' : '  [no contact]'}`,
  );
  console.log(`         ${properties.description__stripe}`);
}

if (unmatched.length) {
  console.log(
    `\n${unmatched.length} order(s) have no matching HubSpot contact. The record is still ` +
      `written, just unassociated -- this script does not create contacts:`,
  );
  for (const email of [...new Set(unmatched)]) console.log(`  ${email}`);
}

if (DRY_RUN) {
  console.log('\n--dry-run: nothing written to HubSpot.');
  process.exit(0);
}

let created = 0;
let updated = 0;
let associated = 0;

for (const { properties } of staged) {
  const reference = properties.purchase_reference;
  let recordId = existing.get(reference);

  if (recordId) {
    await hubspot(`/crm/v3/objects/${OBJECT_TYPE}/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    updated += 1;
  } else {
    const record = await hubspot(`/crm/v3/objects/${OBJECT_TYPE}`, {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    recordId = record.id;
    created += 1;
  }

  const contactId = properties.email ? contacts.get(properties.email.toLowerCase()) : undefined;
  if (contactId) {
    await associateContact(recordId, contactId);
    associated += 1;
  }

  console.log(`  ${recordId}  ${reference}`);
}

console.log(
  `\nDone. ${created} created, ${updated} updated, ${associated} associated to a contact ` +
    `in ${OBJECT_TYPE}.`,
);
