// comp-checkout-action.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-09-10 (published 2026-10-06)
// Deploy:  HubSpot workflow custom code action (Node.js 20.x), on the $0 path of a
//          workflow triggered by the Stripe event `checkout.session.completed`
//          (README Steps 3-5). Paste the whole file.
// What:    Writes a $0 ("comp") Stripe Checkout Session into a HubSpot custom object
//          (one record per order) and associates it with the buyer's contact.
// Why:     A $0 Checkout Session creates no PaymentIntent and no Charge, so HubSpot's
//          native Stripe sync never sees it, and anything keyed on `pi_...` has nothing
//          to key on. `checkout.session.completed` DOES fire for a $0 session.
// ---------------------------------------------------------------------------
//
// THE PAYLOAD IS A POINTER, NOT DATA
// This action reads ONE field off the webhook - the session id - then re-fetches
// the session from Stripe and works only from that. Two reasons:
//   1. HubSpot cannot verify a Stripe webhook signature, so the workflow's webhook
//      URL is an unauthenticated write endpoint. Re-reading Stripe closes that hole:
//      a forged POST has to name a session that really exists, really totals $0,
//      and really is complete, or it fails the guards below.
//   2. `checkout.session.completed` does NOT include line items. Tier, quantity and
//      order bump all come from line items, so a Stripe call is needed anyway.
//
// THE $0 GUARD IS LOAD-BEARING
// `checkout.session.completed` fires for EVERY completed checkout, paid ones too.
// Without the `amount_total === 0` guard this action would write a second record
// for every paid order your paid-order automation already writes. Don't relax it.
// `payment_status` is NOT a comp signal: it read "paid" on a 100%-off checkout.
//
// Idempotent: looks the session up by `purchase_reference` and PATCHes if present,
// creates if not, so a Stripe retry or a workflow re-enrolment updates rather than
// duplicating. It only sends fields it has values for, so fields written by other
// automations survive a re-run.

// ---------------------------------------------------------------- config

// Your custom object's type id (Settings > Objects > your object, or the URL of its
// records page). README Step 1.
const OBJECT_TYPE = '2-12345678';

// Association type id for "this record -> Contact" (README Step 1d). Set it if your
// object uses an association label; production needed the typed association. Leave
// null to create HubSpot's default (unlabelled) association instead.
const ASSOCIATION_TYPE_ID = null;

const BASE = 'https://api.hubapi.com';
const STRIPE_BASE = 'https://api.stripe.com/v1/';

// Pinned deliberately. A call with no Stripe-Version header uses the ACCOUNT DEFAULT
// version, which can be old enough (2017-08-15 in production) that
// expand[]=line_items on a Checkout Session isn't guaranteed to behave. Every field
// read here is stable from 2019 onward. Bump it freely; don't remove it.
const STRIPE_VERSION = '2024-06-20';

// A line item is a ticket if it names a tier. Everything else on the session is
// treated as an order bump. Match these to your ticket product names.
const TIER_PATTERN = /\b(GA|VIP|Platinum|Diamond|Day Pass)\s+Ticket\b/i;

// Highest value first - `ticket_tier` holds a single value, so a mixed-tier session
// records the top tier and lets description__stripe carry the detail.
const TIER_ORDER = ['Diamond', 'Platinum', 'VIP', 'GA', 'Day Pass'];

// The session only counts if it is for the event you know how to label. A tier
// match against some future event would otherwise be stamped with the wrong
// `event_class`, so those bail out with a distinct status instead.
const EVENT_PATTERN = /your event name/i;
const EVENT_CLASS = 'Your Event 2026';

// Must match the `purchase_type` dropdown option exactly. HubSpot rejects the whole
// write when an enumeration value is not defined, so if this action starts failing
// on every session, check that the option still exists (README Step 2).
const PURCHASE_TYPE = 'Comp Ticket';

// A HubSpot secret's NAME becomes its env var name, so these must match the secrets
// attached to the action (README Step 5b).
//
// The HubSpot token needs crm.objects.custom.read/write plus
// crm.objects.contacts.read and crm.objects.contacts.write. A missing association
// scope surfaces as a 403 on the LAST call, after the record is already created,
// leaving an unassociated record behind.
const TOKEN_SECRET_NAME = 'HUBSPOT_TICKETS_TOKEN';

// Live-mode credential. Comps are live orders; a test key authenticates fine and then
// 404s on every live session, which reads as "session not found" rather than a bad
// secret - so it is rejected up front.
const STRIPE_SECRET_NAME = 'STRIPE_COMP_SYNC_KEY';

function getSecret(name, expectation) {
  const value = (process.env[name] || '').trim();

  if (!value) {
    throw new Error(`No secret found. Attach a secret named ${name} holding ${expectation}.`);
  }

  // Never log or echo the value itself - action logs are widely readable.
  if (/^https?:\/\//i.test(value) || /\s/.test(value)) {
    throw new Error(
      `Secret "${name}" looks like a URL or contains whitespace, so it is not a bearer ` +
        'credential. Attach the credential itself instead.'
    );
  }

  return value;
}

function getStripeKey() {
  const key = getSecret(STRIPE_SECRET_NAME, 'a live Stripe secret or restricted key');

  if (!/^(rk|sk)_live_/.test(key)) {
    throw new Error(
      `Secret "${STRIPE_SECRET_NAME}" is not a live key. A test key 404s on every live ` +
        'session, which is indistinguishable from a missing session in the logs.'
    );
  }

  return key;
}

async function request(url, options, label) {
  const res = await fetch(url, options);
  const body = await res.text();

  if (!res.ok) {
    // Include the label so a failure says WHICH call broke, not just a status.
    throw new Error(`${label} -> ${res.status} ${body}`);
  }

  return body ? JSON.parse(body) : {};
}

const stripeGet = (path, key, label) =>
  request(
    STRIPE_BASE + path,
    { headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION } },
    label
  );

const hubspot = (path, token, init = {}) =>
  request(
    BASE + path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    },
    `${init.method || 'GET'} ${path}`
  );

// ---------------------------------------------------------------- derivation

function classify(items) {
  const tickets = [];
  const bumps = [];

  for (const item of items) {
    if (TIER_PATTERN.test(item.description || '')) tickets.push(item);
    else bumps.push(item);
  }

  return { tickets, bumps };
}

function tierOf(tickets) {
  const found = new Set();

  for (const item of tickets) {
    const match = TIER_PATTERN.exec(item.description || '');
    if (!match) continue;
    const tier = TIER_ORDER.find((t) => t.toLowerCase() === match[1].toLowerCase());
    if (tier) found.add(tier);
  }

  return TIER_ORDER.find((tier) => found.has(tier));
}

// Payment-link UTMs reach the API only inside the session's success_url (see the
// hubspot-order-form-stripe-checkout-link-integration repo).
function utmsFromSuccessUrl(successUrl) {
  if (!successUrl) return {};

  let params;
  try {
    params = new URL(successUrl).searchParams;
  } catch (err) {
    return {};
  }

  const utms = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const value = params.get(`utm_${key}`);
    if (value) utms[`utm_${key}__stripe`] = value;
  }
  return utms;
}

function toProperties(session, tickets, bumps) {
  const details = session.customer_details || {};
  const all = [...tickets, ...bumps];

  const properties = {
    purchase_reference: session.id,
    purchase_reference_1: session.id,
    event_id: `purchase_${session.id}`,
    event_class: EVENT_CLASS,
    purchase_type: PURCHASE_TYPE,
    ticket_tier: tierOf(tickets),
    amount: 0,
    currency: (session.currency || 'usd').toUpperCase(),
    quantity: tickets.reduce((sum, item) => sum + (item.quantity || 1), 0),
    purchase_date: new Date(session.created * 1000).toISOString(),
    email: details.email || session.customer_email || undefined,
    phone_number: details.phone || undefined,
    // Line item names joined with "; ", no prices.
    description__stripe: all.map((i) => i.description).filter(Boolean).join('; '),
    order_bump__stripe: bumps.map((i) => i.description).filter(Boolean).join('; '),
    refunded: 'false',
    capi_sent: 'false',
    ...utmsFromSuccessUrl(session.success_url),
  };

  // `stripe_payment_intent_id` and `stripe_charge_id` are deliberately absent.
  // There is no payment and no charge behind a comp, and inventing an id would
  // break any join back to Stripe payment records.

  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value === undefined || value === null || value === '') delete properties[key];
  }

  return properties;
}

// ---------------------------------------------------------------- HubSpot I/O

async function findExisting(reference, token) {
  const found = await hubspot(`/crm/v3/objects/${OBJECT_TYPE}/search`, token, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: 'purchase_reference', operator: 'EQ', value: reference }] },
      ],
      properties: ['purchase_reference'],
      limit: 1,
    }),
  });

  const record = (found.results || [])[0];
  return record ? record.id : undefined;
}

async function findContact(email, token) {
  if (!email) return undefined;

  const found = await hubspot('/crm/v3/objects/contacts/search', token, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }] },
      ],
      properties: ['email'],
      limit: 1,
    }),
  });

  const contact = (found.results || [])[0];
  return contact ? contact.id : undefined;
}

async function associate(recordId, contactId, token) {
  if (ASSOCIATION_TYPE_ID) {
    // Typed association: needed when the object -> Contact association uses a label.
    await hubspot(
      `/crm/v4/objects/${OBJECT_TYPE}/${recordId}/associations/contacts/${contactId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify([
          { associationCategory: 'USER_DEFINED', associationTypeId: Number(ASSOCIATION_TYPE_ID) },
        ]),
      }
    );
    return;
  }

  // v4 "default" association - no association type id to look up.
  await hubspot(
    `/crm/v4/objects/${OBJECT_TYPE}/${recordId}/associations/default/contacts/${contactId}`,
    token,
    { method: 'PUT' }
  );
}

// ---------------------------------------------------------------- entry point

exports.main = async (event, callback) => {
  const token = getSecret(TOKEN_SECRET_NAME, 'a HubSpot private app or service key token');
  const stripeKey = getStripeKey();

  // The one field taken off the webhook body. Map the Stripe event's
  // `data.object.id` to this input (README Step 5c).
  const sessionId = (event.inputFields['session_id'] || '').trim();

  if (!/^cs_/.test(sessionId)) {
    // Not a Checkout Session id - a malformed or forged POST. Nothing to do.
    return callback({ outputFields: { status: 'no_session_id', recordId: '' } });
  }

  const session = await stripeGet(
    `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
    stripeKey,
    `GET /v1/checkout/sessions/${sessionId}`
  );

  // Guards, cheapest first. Each returns a distinct status so the workflow's run
  // history says WHY a session was ignored.
  if (session.status !== 'complete') {
    return callback({ outputFields: { status: 'session_not_complete', recordId: '' } });
  }

  // Subscription and setup sessions are never ticket orders.
  if (session.mode !== 'payment') {
    return callback({ outputFields: { status: 'not_payment_mode', recordId: '' } });
  }

  // Belt and braces with the live key: a test-mode destination pointed at this
  // workflow must never write test orders in as real ones.
  if (!session.livemode) {
    return callback({ outputFields: { status: 'test_mode_session', recordId: '' } });
  }

  // The load-bearing one. See the header note.
  if (session.amount_total !== 0) {
    return callback({ outputFields: { status: 'not_comp_paid_order', recordId: '' } });
  }

  // Second, independent comp signal. A $0 session has no PaymentIntent; a paid one
  // always does. Checking both means one mistyped or missing property can't let a
  // paid order through and duplicate a record another automation already wrote.
  if (session.payment_intent) {
    return callback({ outputFields: { status: 'not_comp_has_payment_intent', recordId: '' } });
  }

  // Expanding line_items caps at 10. A ticket order has one or two, but a truncated
  // list would silently under-report quantity, so fetch the rest.
  let items = (session.line_items && session.line_items.data) || [];
  if (session.line_items && session.line_items.has_more) {
    const full = await stripeGet(
      `checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`,
      stripeKey,
      `GET /v1/checkout/sessions/${sessionId}/line_items`
    );
    items = full.data || items;
  }

  const { tickets, bumps } = classify(items);

  if (tickets.length === 0) {
    return callback({ outputFields: { status: 'no_ticket_line_item', recordId: '' } });
  }

  if (!items.some((item) => EVENT_PATTERN.test(item.description || ''))) {
    // A tier matched but the event did not. Stamping EVENT_CLASS here would file
    // another event's tickets under this one, so bail loudly. When a new event
    // starts selling, update EVENT_PATTERN / EVENT_CLASS.
    return callback({ outputFields: { status: 'unrecognised_event', recordId: '' } });
  }

  const properties = toProperties(session, tickets, bumps);

  const existingId = await findExisting(properties.purchase_reference, token);
  let recordId = existingId;
  let action;

  if (existingId) {
    await hubspot(`/crm/v3/objects/${OBJECT_TYPE}/${existingId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    action = 'updated';
  } else {
    const created = await hubspot(`/crm/v3/objects/${OBJECT_TYPE}`, token, {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    recordId = created.id;
    action = 'created';
  }

  // Association last, and non-fatal. The record is the deliverable; a comp
  // recipient who is not yet a contact should not fail the whole action and
  // trigger a Stripe retry against a record that already exists.
  let associated = false;
  const contactId = await findContact(properties.email, token);

  if (contactId) {
    await associate(recordId, contactId, token);
    associated = true;
  }

  callback({
    outputFields: {
      status: action,
      recordId: String(recordId),
      ticketTier: properties.ticket_tier || '',
      quantity: String(properties.quantity),
      email: properties.email || '',
      associated: String(associated),
    },
  });
};
