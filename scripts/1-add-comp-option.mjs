#!/usr/bin/env node
// 1-add-comp-option.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-09-08 (published 2026-10-06)
// Deploy:  Run once from your computer (README Step 2). Node 20+.
// What:    Adds a "Comp Ticket" option to the `purchase_type` dropdown on your
//          orders custom object.
// Why:     HubSpot rejects the whole record write when a dropdown value isn't
//          defined, so the workflow action fails on every comp until this exists.
// ---------------------------------------------------------------------------
//
// Why a new option rather than filing free tickets as "New Ticket": a $0 ticket
// with purchase_type "New Ticket" is indistinguishable from a paid one in every
// report that counts rows. Comps would silently inflate "tickets sold" while
// contributing no revenue. A distinct option makes them filterable.
//
// The script GETs the property first and PATCHes back the existing options plus
// the new one. HubSpot REPLACES the options array on PATCH, so sending only the
// new option would delete every existing option and orphan the records using them.
//
// Usage:
//   node scripts/1-add-comp-option.mjs --dry-run
//   node scripts/1-add-comp-option.mjs
//
// Env:
//   HUBSPOT_TOKEN   pat-na1-...   private app token with crm.schemas.custom.write

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const OBJECT_TYPE = '2-12345678'; // your custom object id (README Step 1)
const PROPERTY = 'purchase_type';
const NEW_OPTION = 'Comp Ticket';

const DRY_RUN = process.argv.includes('--dry-run');

if (OBJECT_TYPE.includes('12345678')) {
  console.error('Set OBJECT_TYPE at the top of this file to your custom object id (README Step 1).');
  process.exit(1);
}

if (!HUBSPOT_TOKEN) {
  console.error('Missing HUBSPOT_TOKEN in the environment.');
  process.exit(1);
}

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

const property = await hubspot(`/crm/v3/properties/${OBJECT_TYPE}/${PROPERTY}`);
const existing = property.options ?? [];

console.log(`Current options on ${PROPERTY}:`);
for (const option of existing) console.log(`  ${option.value}`);

if (existing.some((option) => option.value === NEW_OPTION)) {
  console.log(`\n"${NEW_OPTION}" already exists. Nothing to do.`);
  process.exit(0);
}

const options = [
  ...existing.map((option, index) => ({
    label: option.label,
    value: option.value,
    displayOrder: option.displayOrder ?? index,
    hidden: option.hidden ?? false,
  })),
  {
    label: NEW_OPTION,
    value: NEW_OPTION,
    displayOrder: existing.length,
    hidden: false,
  },
];

console.log(`\nWill PATCH ${PROPERTY} with ${options.length} options (adding "${NEW_OPTION}").`);

if (DRY_RUN) {
  console.log('\n--dry-run: nothing written to HubSpot.');
  console.log(JSON.stringify(options, null, 2));
  process.exit(0);
}

await hubspot(`/crm/v3/properties/${OBJECT_TYPE}/${PROPERTY}`, {
  method: 'PATCH',
  body: JSON.stringify({ options }),
});

console.log(`\nDone. "${NEW_OPTION}" added to ${PROPERTY}.`);
