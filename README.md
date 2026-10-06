<!--
  README.md -- $0 Stripe Checkout orders into HubSpot
  Author:  Jibril Sulaiman
  Date:    2026-10-06
  What:    Click-by-click guide for writing free and 100%-off Stripe Checkout orders
           into a HubSpot custom object: a webhook-triggered workflow with one custom
           code action, plus a backfill script for orders from before it existed.
  Why:     A $0 Checkout Session creates no PaymentIntent and no charge, so HubSpot's
           native Stripe sync never sees it. Comp tickets and 100%-off orders simply
           don't exist in HubSpot until something writes them.
-->

# $0 Stripe Checkout orders → HubSpot

Get free and 100%-off Stripe Checkout orders into HubSpot. When someone checks out with
a 100%-off promotion code (a comp ticket, a giveaway, a free tier), Stripe sends
`checkout.session.completed`. A HubSpot workflow catches it, keeps only the $0 ones,
and a custom code action fetches the order from Stripe and writes it as a record on
your orders custom object, linked to the buyer's contact. A backfill script does the
same for orders from before the workflow existed.

It reuses the trigger built in
[stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events);
this repo adds the branch, the code and the backfill.

## Why it exists

HubSpot's Stripe sync copies **PaymentIntents**. A Checkout Session that totals $0
(a 100%-off promotion code, or a $0 price) creates **no PaymentIntent and no charge**.
That breaks things in two places:

1. **The order never reaches HubSpot.** No PaymentIntent means nothing to copy. In
   production, neither the synced Stripe payments object nor the orders object held a
   single $0 row: the comps had never been in HubSpot at all.
2. **Anything keyed on the payment can't key on it.** An automation that builds order
   records from `pi_...` ids has nothing to build from.

So comp attendees are missing from attendee counts, from follow-up workflows, and from
the contact's own history. The only record Stripe keeps is the Checkout Session, so
that's what this keys on.

Things the build turned up, all handled in the code:

- **`payment_status` is not a comp signal.** A real 100%-off checkout came back with
  `payment_status: paid`, not `no_payment_required`. Only `amount_total === 0` (plus
  `payment_intent` being empty) is reliable.
- **`checkout.session.completed` fires for every checkout, paid ones too.** Without a
  $0 filter you'd write a second record for every paid order. It's filtered twice: once
  in the workflow branch (cheap) and once in the code (safe if someone edits the branch).
- **The event doesn't include line items.** The ticket tier and quantity live on line
  items, so the code always fetches the session from Stripe. That also makes the
  webhook body a pointer rather than trusted data (see [Security](#security)).

## How it works

```text
 Stripe  checkout.session.completed      (every completed checkout, paid and free)
    │
    ▼
 HubSpot workflow: "Webhook event is received"   (unconnected event, < 50 properties)
    │
    ├── Branch 1: payment_intent is unknown AND amount_total = 0 ──► Custom code
    └── Fallback (every paid checkout) ──► end
                                              │  input: session_id ← data.object.id
                                              │  re-fetches the session + line items
                                              │  guards: complete, payment mode, live,
                                              │          $0, no PaymentIntent, a ticket
                                              ▼
                              orders custom object record  ──► associated to the contact
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/`](workflow-action/) | The custom code action | Pasted into the workflow (Step 5) |
| [`scripts/`](scripts/) | The one-off dropdown-option script and the backfill | Run on your computer (Steps 2 and 7) |
| [`test/`](test/) | Offline tests with Stripe and HubSpot faked | `npm test` (Step 5f) |

## Table of contents

- [1. Requirements](#1-requirements)
- [2. Setup, step by step](#2-setup-step-by-step)
  - [Step 1: The orders custom object](#step-1-the-orders-custom-object)
  - [Step 2: Add the "Comp Ticket" option](#step-2-add-the-comp-ticket-option)
  - [Step 3: A restricted Stripe key](#step-3-a-restricted-stripe-key)
  - [Step 4: A HubSpot token and two secrets](#step-4-a-hubspot-token-and-two-secrets)
  - [Step 5: The workflow](#step-5-the-workflow)
  - [Step 6: Test with a real free checkout](#step-6-test-with-a-real-free-checkout)
  - [Step 7: Backfill older orders](#step-7-backfill-older-orders)
  - [Step 8: Keep comps out of ad conversions](#step-8-keep-comps-out-of-ad-conversions)
- [What a comp record looks like](#what-a-comp-record-looks-like)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Security](#security)
- [Related repos: Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce)

## 1. Requirements

| Need | Why |
|---|---|
| HubSpot with custom objects and workflows with custom code (Enterprise for custom objects; Operations Hub / Data Hub Professional or above for custom code at the time of writing) | The record and the action |
| The **Webhook event is received** trigger | Set up in [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) |
| Stripe access that can create restricted keys and event destinations | Step 3 and the trigger |
| Node.js 20 or later on your computer | The two scripts (Steps 2 and 7) and the tests |
| One promotion code that takes a product to $0 | To make a real test order (Step 6) |

## 2. Setup, step by step

### Step 1: The orders custom object

About 15 minutes if you don't have one; skip to 1c if you do.

**1a.** If you already have a custom object that holds one record per order (for
example "Ticket Purchases"), use it. Otherwise create one in **Settings → Data
Management → Objects → Custom Objects** (wording may differ), associated to
**Contacts**, with **Purchase Reference** as its primary display property.

**1b.** Make sure it has every property the code writes. HubSpot rejects the **whole**
record when even one property is missing, so all of these must exist with these
internal names:

| Internal name | Type | Written as |
|---|---|---|
| `purchase_reference` | Single-line text | The session id, `cs_live_...`. Also the record's display name, so comps read differently from paid orders. |
| `purchase_reference_1` | Single-line text | A copy of the session id (delete the line in the code if you don't want it) |
| `event_id` | Single-line text | `purchase_<session id>`, for Meta Conversions API deduplication |
| `event_class` | Single-line text | Your event's name (`EVENT_CLASS` in the code) |
| `purchase_type` | Dropdown select | `Comp Ticket` (Step 2 adds it) |
| `ticket_tier` | Dropdown select: `GA`, `VIP`, `Platinum`, `Diamond`, `Day Pass` | The highest tier on the order |
| `amount` | Number | `0` |
| `currency` | Single-line text | `USD` |
| `quantity` | Number | Tickets on the order |
| `purchase_date` | Date and time | When the session was created |
| `email` | Single-line text | What the buyer typed at checkout |
| `phone_number` | Single-line text | If Checkout collected it |
| `description__stripe` | Single-line text | Every line item, `; `-separated |
| `order_bump__stripe` | Single-line text | Line items that aren't tickets |
| `refunded` | Single checkbox | `false` |
| `capi_sent` | Single checkbox | `false` (see Step 8) |
| `utm_source__stripe`, `utm_medium__stripe`, `utm_campaign__stripe`, `utm_content__stripe`, `utm_term__stripe` | Single-line text | From the session's success URL, when present |

**1c.** Copy the object's type id (it looks like `2-12345678`): it's in the URL of the
object's records page, or under **Settings → Objects**. Paste it as `OBJECT_TYPE` at
the top of [`workflow-action/comp-checkout-action.js`](workflow-action/comp-checkout-action.js)
and both files in [`scripts/`](scripts/).

**1d. Association type (optional but recommended).** If the object → Contact
association uses a label (for example "Ticket purchase"), find its numeric type id in
**Settings → Objects → your object → Associations** (wording may differ), or from the
API at `GET /crm/v4/associations/<object>/contacts/labels`. Put it in
`ASSOCIATION_TYPE_ID` in the action and the backfill. Production needed the typed
association; with `null` the code creates HubSpot's default, unlabelled one.

> ⚠️ **Change the tier names and event to yours.** In the action and the backfill,
> `TIER_PATTERN` / `TIER_ORDER` decide what counts as a ticket (a line item named
> `... VIP Ticket`), and `EVENT_PATTERN` / `EVENT_CLASS` decide which event it's for.
> A ticket for an event that doesn't match `EVENT_PATTERN` is skipped on purpose
> (`unrecognised_event`), so another event's tickets never get the wrong label.

✅ **Check:** every property in the table exists on the object, and `OBJECT_TYPE` is set
in all three files.

### Step 2: Add the "Comp Ticket" option

About 3 minutes.

**2a.** `purchase_type` needs a **Comp Ticket** option. Until it exists, HubSpot rejects
every comp write. By hand: **Settings → Properties**, pick your object, open
**Purchase Type**, add the option **Comp Ticket**, save.

**2b.** Or run the script. It reads the existing options and sends them all back plus
the new one, because HubSpot **replaces** a dropdown's whole option list on update:
sending only the new option would delete the others.

```powershell
$env:HUBSPOT_TOKEN = "<token from Step 4>"
node scripts/1-add-comp-option.mjs --dry-run
node scripts/1-add-comp-option.mjs
```

Runs [`scripts/1-add-comp-option.mjs`](scripts/1-add-comp-option.mjs).

The dry run lists the current options and prints the full list it would send. The real
run ends with `Done. "Comp Ticket" added to purchase_type.` and is safe to re-run
(`already exists. Nothing to do.`).

✅ **Check:** **Comp Ticket** shows in the Purchase Type dropdown, and the other
options are still there.

### Step 3: A restricted Stripe key

About 3 minutes.

**3a.** In Stripe (live mode), open **Developers → API keys**. Under **Restricted keys**,
click **Create restricted key**.

**3b.** At *"How will you be using this key?"*, choose **Powering an integration you
built**, then **Continue**.

**3c.** At **Choose a permission template**, click **Choose your own →**.

**3d.** Give it a name you'll recognize (for example `HubSpot Comp Sync`) and set
**Read** on **Checkout Sessions**, **Products** and **Prices**. Leave everything else
at **None**. Create the key and copy it (`rk_live_...`).

> ⚠️ **It must be a live key.** Comps are live orders. A test key signs in fine and then
> returns "not found" for every live session, which looks like a missing session rather
> than a wrong key. The action and the backfill both refuse anything that isn't
> `rk_live_` / `sk_live_`.

✅ **Check:** the key starts with `rk_live_` and has three Read permissions.

### Step 4: A HubSpot token and two secrets

About 5 minutes.

**4a.** Create a private app (or service key) for this, with these scopes:

| Scope | Why |
|---|---|
| `crm.objects.custom.read` / `crm.objects.custom.write` | Find and write the order record |
| `crm.objects.contacts.read` | Find the buyer's contact |
| `crm.objects.contacts.write` | Create the association |
| `crm.schemas.custom.write` | Only for the Step 2 script |

> ⚠️ **Check the association scope before you go live.** Without contacts write, the
> association fails with a 403 on the **last** call, after the record is already
> created, leaving an unlinked record behind.

**4b.** Create two secrets, named exactly as below. The quickest way is from the custom
code action's **Secrets** dropdown in Step 5c, which has an option to add a new secret
(wording may differ):

| Secret name | Value |
|---|---|
| `HUBSPOT_TICKETS_TOKEN` | The HubSpot token from 4a |
| `STRIPE_COMP_SYNC_KEY` | The restricted key from Step 3 |

The names become environment variables in the code; to use different names, change
`TOKEN_SECRET_NAME` and `STRIPE_SECRET_NAME` at the top of the action.

✅ **Check:** both secrets exist with those exact names.

### Step 5: The workflow

About 20 minutes.

**5a. The trigger.** Follow
[stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events)
for `checkout.session.completed`, with these choices:

- **Unconnected** (Step 1 there). A comp recipient who isn't a contact yet would never
  enroll in a contact-linked event, and nothing can create the contact before the
  match runs. The first production build was contact-linked and was rebuilt as
  unconnected for exactly this reason.
- Keep at least `data.object.id`, `data.object.amount_total` (**Number**),
  `data.object.payment_intent`, `data.object.status`, `data.object.mode`,
  `data.object.livemode` (**Boolean**) and `data.object.customer_details.email`.
  Production kept 25.
- Make the sample a **real free checkout** (Step 6a), so `payment_intent` is in the
  property list. `stripe trigger` won't run in live mode.

Name the workflow (for example `Comp Ticket Purchase Writer (Stripe $0 Checkout)`).

**5b. The branch.** Add a **Branch** step, **Branch on: Conditions**. In **Branch 1**,
**Group 1**, add two filters (both must match):

| Filter | Condition |
|---|---|
| `data.object.payment_intent` | **is unknown** |
| `data.object.amount_total` | **is equal to** `0` |

Leave **Fallback** empty, so every paid checkout ends there.

> ⚠️ **Put the $0 path behind the conditions, not on "Fallback".** In production the
> free path was first wired to the side that catches everything else, and paid
> checkouts started coming through. The amount was also typed as text, so "equal to 0"
> didn't compare as a number. Type `amount_total` as **Number** when you create the
> event.

**5c. The custom code action.** Under **Branch 1**, click **+** and add **Custom
code**.
1. **Language:** Node.js 20.x
2. **Secrets:** choose `HUBSPOT_TICKETS_TOKEN` and `STRIPE_COMP_SYNC_KEY`.
3. **Property to include in code**, one row:

   | Input name (left box) | Value (right box) |
   |---|---|
   | `session_id` | **Trigger data → your webhook event → `data.object.id`** |

   Delete any other empty row, or saving fails with *"Property selection is required"*.
4. Delete the sample code and paste in **all** of
   [`workflow-action/comp-checkout-action.js`](workflow-action/comp-checkout-action.js),
   with `OBJECT_TYPE`, `ASSOCIATION_TYPE_ID`, `EVENT_PATTERN` and `EVENT_CLASS` set
   (Step 1).
5. **Data outputs**, one row each:

   | Output | Type |
   |---|---|
   | `status` | String |
   | `recordId` | String |
   | `ticketTier` | String |
   | `quantity` | String |
   | `email` | String |
   | `associated` | String |

**5d.** Read `status` in run history to see what happened to each session:

| `status` | Meaning |
|---|---|
| `created` / `updated` | Record written (updated means it already existed, for example a Stripe retry) |
| `no_session_id` | The input wasn't a `cs_...` id: a malformed or forged post |
| `session_not_complete` | The session isn't `complete` |
| `not_payment_mode` | A subscription or setup session |
| `test_mode_session` | A test-mode session reached the live workflow |
| `not_comp_paid_order` | It wasn't $0 (the branch should have stopped it) |
| `not_comp_has_payment_intent` | $0 but with a PaymentIntent: not a comp |
| `no_ticket_line_item` | No line item named like a ticket |
| `unrecognised_event` | A ticket for an event that doesn't match `EVENT_PATTERN` |

**5e.** Publish the workflow.

**5f. Optional: run the tests.** From the repo folder:

```powershell
npm test
```

Runs [`test/action.test.mjs`](test/action.test.mjs): 12 checks of the guards, the
create, update and association paths, with Stripe and HubSpot faked. Nothing touches
a real account.

✅ **Check:** the workflow is published, the trigger names your webhook event, and
Branch 1 has both conditions.

### Step 6: Test with a real free checkout

About 5 minutes.

**6a.** Check out on one of your live payment links with a 100%-off promotion code.

**6b.** In the workflow, open **Run History**. The run reads *"Triggered from: <your
event name>"*, goes down **Branch 1**, and the custom code shows `status: created`,
`associated: true` (if the buyer is a contact).

**6c.** Open the orders object: a new record named `cs_live_...`, **Purchase Type**
*Comp Ticket*, **Amount** 0, linked to the contact.

**6d.** Buy something paid (or watch the next real sale): its run ends at **Fallback**
and writes nothing.

✅ **Check:** one free order, one record; one paid order, no new record from this
workflow.

### Step 7: Backfill older orders

About 10 minutes. The webhook only covers orders from the moment it's live. For older
ones, and for any buyer who never enrolled:

```powershell
$env:STRIPE_LIVE_KEY = "rk_live_..."   # the restricted key from Step 3
$env:HUBSPOT_TOKEN = "pat-..."         # the token from Step 4
node scripts/2-backfill-comp-checkouts.mjs --since 2026-06-01 --dry-run
node scripts/2-backfill-comp-checkouts.mjs --since 2026-06-01
```

Runs [`scripts/2-backfill-comp-checkouts.mjs`](scripts/2-backfill-comp-checkouts.mjs).

| Flag | Effect |
|---|---|
| `--dry-run` | Prints every record it would write and every skip reason. Writes nothing. |
| `--since YYYY-MM-DD` | Only sessions created on or after that date. Much faster. |
| `--limit 10` | Stop after 10 free sessions, for a cautious first run |

Stripe can't filter Checkout Sessions by amount, so the script pages through every
completed session in the range and keeps the $0, payment-mode ones without a
PaymentIntent. Use `--since`.

The dry run marks buyers with no HubSpot contact `[no contact]` and lists their emails
at the end. Their records are still written, just unlinked; the script doesn't create
contacts. That list is also how to measure how many comps the webhook misses.

The action and the backfill are safe to overlap: both look the session up by
`purchase_reference` and update instead of duplicating.

✅ **Check:** the dry-run count looks right, then the real run ends with
`Done. N created, N updated, N associated to a contact`.

### Step 8: Keep comps out of ad conversions

About 2 minutes, if you send purchases to Meta or Google from this object.

A $0 Purchase event teaches the ad platform that free orders are what you want. If a
workflow sends records from this object as conversions (for example
[hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google)),
add **Purchase Type is none of Comp Ticket** to its enrollment. Comps are written with
`capi_sent = false`, so otherwise they'd queue up like any other purchase.

✅ **Check:** the conversion workflow's enrollment excludes **Comp Ticket**.

## What a comp record looks like

| Field | Paid order | Comp order |
|---|---|---|
| `purchase_reference` | `pi_...` | `cs_live_...` |
| `stripe_payment_intent_id` | set | **empty**: no payment exists |
| `stripe_charge_id` | set | **empty**: no charge exists |
| `event_id` | `purchase_pi_...` | `purchase_cs_live_...` |
| `purchase_type` | your paid types | **Comp Ticket** |
| `amount` | the price | 0 |

The empty payment ids are deliberate. Inventing one would break any join back to Stripe
payment records.

## Troubleshooting

| You got | Cause | Fix |
|---|---|---|
| Every comp fails with a 400 on the create | `Comp Ticket` isn't a `purchase_type` option, or a property in the Step 1 table is missing | Step 2; Step 1b |
| `... -> 403` on the association call, record created but unlinked | Token lacks contacts write | Step 4a |
| `... is not a live key` | Test key in `STRIPE_COMP_SYNC_KEY` | Step 3 |
| `No secret found. Attach a secret named ...` | Secret missing or named differently | Step 4b |
| Paid checkouts reach the custom code | Branch on the wrong side, or `amount_total` typed as text | Step 5b |
| Nothing enrolls for buyers who aren't contacts | Contact-linked event | Rebuild the event unconnected (Step 5a) |
| `unrecognised_event` on real tickets | `EVENT_PATTERN` doesn't match your product names | Step 1 |
| `no_ticket_line_item` | `TIER_PATTERN` doesn't match your product names | Step 1 |
| `Set OBJECT_TYPE at the top of this file...` | Placeholder still in a script | Step 1c |
| Backfill: `Refusing to run: STRIPE_LIVE_KEY is not a live key` | Test key in the environment | Step 7 |

## Limits

- **One record per order, one tier per record.** A mixed-tier order records the highest
  tier; the full list is in `description__stripe`.
- **No contacts are created.** A buyer who isn't a contact gets an unlinked record.
- **Fields other automations copy onto your order records** (registration or
  attribution details) aren't written here; run those automations on comp records too
  if you need them.
- **No landing-page URL.** The only page URL on a session is Stripe's own checkout
  page, not the page the buyer came from, so none is written. Wrong data is worse than
  none.

## Security

- **The webhook URL takes posts from anyone.** HubSpot can't check Stripe's signature,
  so the action reads only the session id from the body and re-fetches the session from
  Stripe. A forged post has to name a real, complete, live, $0 session to get through.
- **Use the restricted key** from Step 3: read-only, three permissions.
- **Never paste keys into the code.** They live in HubSpot secrets and environment
  variables only. Anyone who can edit the action can use its secrets, so limit who can
  edit the workflow.

## Related repos: Stripe beyond HubSpot Commerce

This repo is one of a set of guides for taking Stripe payments without HubSpot
Commerce, and for getting the Stripe data that HubSpot's native Stripe
integration leaves out into HubSpot. Each one stands alone.

| Repo | What it adds |
|---|---|
| [hubspot-order-form-stripe-checkout-link-integration](https://github.com/carljibrilsulaimanii/hubspot-order-form-stripe-checkout-link-integration) | A HubSpot order form that hands buyers to a Stripe Payment Link, and writes the UTMs back onto the payment record |
| [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) | Any Stripe event into a HubSpot workflow through the "Webhook event is received" trigger, no middleware |
| [hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google) | Stripe purchases sent server-side from HubSpot workflows to Meta and Google |
| **hubspot-stripe-zero-dollar-checkout-sync** (this repo) | Free and 100%-off Stripe Checkout orders, which create no payment, written into a HubSpot custom object, plus a backfill |
| **Product names on payment records** (coming) | Which product each Stripe payment was for, and routing buyers by product |
| **Stripe test mode mirror** (coming) | Test payments in the same HubSpot object as live ones, so workflows can be tested without real charges |

---

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
