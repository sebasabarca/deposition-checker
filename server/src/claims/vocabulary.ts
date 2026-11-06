// The canonical predicates a claim can use, each with one meaning, so that different wording for
// the same kind of fact lands on the same predicate ("authorized the deal", "signed off on it",
// "gave final approval" are all `approve`). No two predicates overlap; where two look close, the
// distinction is written next to them. The descriptions go into the extraction prompt verbatim.

export const PREDICATES = {
  approve: "gave or refused permission or sign-off for something someone else proposed (authorize, sign off, OK, green-light, veto)",
  decide: "chose a course of action themselves (decide, determine, choose); not permission for someone else's proposal, which is approve",
  agree: "entered into or committed to an agreement, contract or deal, including signing one",
  know: "was or was not aware of a fact (know, be aware, be told, learn, understand)",
  communicate: "told, asked, discussed, wrote to or talked with someone about something (discuss, email, call, raise, mention)",
  attend: "was or was not present at a meeting, event or place",
  review: "read, saw or examined a document, report or data",
  buy: "obtained something by paying for it: a product, service, license or company (buy, acquire, purchase, license)",
  sell: "provided something for payment: a product, service or license (sell, offer, license out)",
  price: "set, charged, quoted or discounted a price, fee or discount",
  compete: "who competes with whom, in what market, and how strongly",
  plan: "intended, planned or had a strategy to do something in the future",
  own: "owned, controlled or had something (a company, product, asset, team)",
  role: "a person's job, title, responsibilities or reporting line",
  support: "a product or system works with, runs on, supports or provides a function",
  measure: "states an amount, size, count, share, revenue or other figure about something",
  other: "none of the above",
} as const;

export type Predicate = keyof typeof PREDICATES;
export const PREDICATE_NAMES = Object.keys(PREDICATES) as [Predicate, ...Predicate[]];

// What the witness's words say about the proposition, and how the witness holds it.
export const POLARITIES = ["affirms", "denies"] as const;
// does_not_know (never knew) and does_not_recall (can't remember) stay distinct, and neither is a
// denial that the thing happened.
export const EPISTEMIC = ["asserted", "qualified", "does_not_know", "does_not_recall", "hypothetical", "reported_by_other"] as const;
// Statement cards (claims/cards.ts): the card's stance on its statement, and how the witness holds it.
export const CARD_STANCES = ["asserts", "denies", "not_answered", "unclear"] as const;
export const CARD_EPISTEMIC = EPISTEMIC;
export const CLAIM_SOURCES = ["answer", "adopted_question"] as const;

export type Polarity = (typeof POLARITIES)[number];
