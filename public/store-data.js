/* Funchems store data layer.
 *
 * One source of truth for the storefront and the admin dashboard.
 * Reads/writes Supabase when a client is configured, otherwise falls back to
 * localStorage so every page still works offline in the prototype.
 *
 * Usage from a DC logic class:
 *   const db = window.Funchems;
 *   db.subscribe(() => this.forceUpdate());
 *   db.products()            -> product rows
 *   db.cart.lines()          -> cart lines joined to products
 *   db.pricing(opts)         -> full price breakdown incl. discounts
 *
 * ---------------------------------------------------------------------------
 * SUPABASE SCHEMA (run once in the SQL editor)
 * ---------------------------------------------------------------------------
 * create table products (
 *   id uuid primary key default gen_random_uuid(),
 *   cat text unique not null, name text not null, dose text,
 *   category text default 'compound',      -- compound | blend | accessory
 *   price numeric not null, list_price numeric,
 *   stock int default 0, low_stock_at int default 10,
 *   purity text, lot text, live bool default false,
 *   sort int default 0, images jsonb default '[]',
 *   body text, created_at timestamptz default now()
 * );
 * create table discounts (
 *   id text primary key,                   -- client-generated, see uid()
 *   code text unique,                      -- null = automatic rule
 *   label text not null,
 *   kind text not null,                    -- percent | fixed | shipping | bogo
 *   value numeric default 0,
 *   scope text default 'order',            -- order | product | category | bundle
 *   scope_value text,
 *   min_subtotal numeric default 0,
 *   min_distinct int default 0,
 *   pay_method text,                       -- crypto | card | null (any)
 *   stackable bool default true,
 *   auto bool default false,               -- applied without a code
 *   uses int default 0, max_uses int,
 *   starts_at date, ends_at date,
 *   live bool default true
 * );
 * create table orders (
 *   id text primary key, customer_id uuid references customers(id),
 *   email text, status text default 'awaiting',
 *   pay_method text, subtotal numeric, discount numeric,
 *   shipping numeric, total numeric,
 *   lines jsonb default '[]', tracking text, note text,
 *   country text, created_at timestamptz default now()
 * );
 * create table customers (
 *   id uuid primary key default gen_random_uuid(),
 *   email text unique not null, name text, country text,
 *   orders_count int default 0, spent numeric default 0,
 *   credit numeric default 0, tier text default 'standard',
 *   flagged bool default false, created_at timestamptz default now()
 * );
 * create table lab_reports (
 *   id text primary key,                   -- client-generated, see uid()
 *   lot text not null, product_cat text, method text,
 *   purity text, reported_on date, file_url text, file_name text, live bool default true
 * );
 * create table reviews (
 *   id text primary key,                   -- client-generated, see uid()
 *   product_cat text, author text, role text, lot text, stars int, date date,
 *   body text, avatar text, images jsonb default '[]',
 *   live bool default false, created_at timestamptz default now()
 * );
 * create table content (
 *   key text primary key, value jsonb      -- hero, blocks, nav, strip, promos, votes...
 * );
 *
 * -- Row level security: public reads live rows, writes go through the service role.
 * alter table products enable row level security;
 * create policy "public read live" on products for select using (live = true);
 * create policy "admin all" on products for all using (auth.role() = 'service_role');
 * ---------------------------------------------------------------------------
 */
(function () {
  // Every .dc.html component on a page carries its own <script src="./store-data.js">
  // tag, so this file's setup code runs once per imported component, not once per
  // page. Without this guard each run replaces window.Funchems with a brand-new
  // object and an empty listener set, so a change made through one component (e.g.
  // the language dropdown) never reaches components that subscribed earlier —
  // only a full page reload re-syncs everyone from localStorage. First run wins;
  // every later run of this same script on the same page is a no-op.
  if (window.Funchems) return;

  const KEY = "funchems-store-v9";
  const CART_KEY = "funchems-cart-v2";

  const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const pct = (n) => (n > 0 ? "−" : "") + Math.round(Math.abs(n)) + "%";
  const uid = (p) => p + "-" + Math.random().toString(36).slice(2, 8);
  const today = () => new Date().toISOString().slice(0, 10);

  /* ---- Supabase row <-> in-app shape --------------------------------- *
   * The dashboard edits camelCase fields; every Supabase column is
   * snake_case. These are the only two places that translation happens.
   */
  function toProductRow(p) {
    return {
      cat: p.cat, name: p.name,
      dose: (p.doseValue || p.doseUnit) ? [p.doseValue, p.doseUnit].filter(Boolean).join(" ") : (p.dose || ""),
      category: p.category || "compound", price: Number(p.price) || 0,
      list_price: p.list != null && p.list !== "" ? Number(p.list) : null,
      stock: Number(p.stock) || 0, low_stock_at: Number(p.lowStockAt) || 10,
      purity: p.purity || null, lot: p.lot || null, live: !!p.live,
      sort: Number(p.sort) || 0, images: p.images || [], body: p.body || null,
    };
  }
  function fromProductRow(row) {
    const { list_price, low_stock_at, ...rest } = row;
    return { ...rest, list: list_price, lowStockAt: low_stock_at };
  }

  function toDiscountRow(d) {
    return {
      id: d.id, code: d.code ? d.code : null, label: d.label, kind: d.kind,
      value: Number(d.value) || 0, scope: d.scope || "order",
      scope_value: d.scopeValue || null,
      min_subtotal: Number(d.minSubtotal) || 0, min_distinct: Number(d.minDistinct) || 0,
      pay_method: d.payMethod || null, stackable: !!d.stackable, auto: !!d.auto,
      uses: Number(d.uses) || 0, max_uses: d.maxUses != null && d.maxUses !== "" ? Number(d.maxUses) : null,
      starts_at: d.startsAt || null, ends_at: d.endsAt || null, live: !!d.live,
    };
  }
  function fromDiscountRow(row) {
    return {
      id: row.id, code: row.code || "", label: row.label, kind: row.kind, value: row.value,
      scope: row.scope, scopeValue: row.scope_value || "", minSubtotal: row.min_subtotal,
      minDistinct: row.min_distinct, payMethod: row.pay_method || "", stackable: row.stackable,
      auto: row.auto, uses: row.uses, maxUses: row.max_uses, startsAt: row.starts_at || "",
      endsAt: row.ends_at || "", live: row.live,
    };
  }

  function toLabReportRow(r) {
    return {
      id: r.id, lot: r.lot, product_cat: r.productCat || null, method: r.method || null,
      purity: r.purity || null, reported_on: r.reportedOn || null,
      file_url: r.fileUrl || null, file_name: r.fileName || null, live: !!r.live,
    };
  }
  function fromLabReportRow(row) {
    return {
      id: row.id, lot: row.lot, productCat: row.product_cat || "", method: row.method || "",
      purity: row.purity || "", reportedOn: row.reported_on || "", fileUrl: row.file_url || "",
      fileName: row.file_name || "", live: row.live,
    };
  }

  function toReviewRow(r) {
    return {
      id: r.id, product_cat: r.productCat || null, author: r.author || null, role: r.role || null,
      lot: r.lot || null, stars: Number(r.stars) || 0, date: r.date || null,
      body: r.body || null, avatar: r.avatar || null, images: r.images || [], live: !!r.live,
    };
  }
  function fromReviewRow(row) {
    return {
      id: row.id, productCat: row.product_cat || "", author: row.author || "", role: row.role || "",
      lot: row.lot || "", stars: row.stars, date: row.date || "", body: row.body || "",
      avatar: row.avatar || "", images: row.images || [], live: row.live,
    };
  }

  function seed() {
    const products = [];
    const forCat = (c) => products.find((x) => x.cat === c) || {};

    return {
      products,
      discounts: [
        { id: "d-crypto", code: "", label: "Crypto payment", kind: "percent", value: 8, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 0, payMethod: "crypto", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier3", code: "", label: "Quantity tier, 3 compounds", kind: "percent", value: 15, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 3, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier5", code: "", label: "Quantity tier, 5 compounds", kind: "percent", value: 22, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 5, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-ship", code: "", label: "Free cold chain over $250", kind: "shipping", value: 100, scope: "order", scopeValue: "", minSubtotal: 250, minDistinct: 0, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-vote", code: "", label: "Offsale winner, half price", kind: "percent", value: 50, scope: "product", scopeValue: "", minSubtotal: 0, minDistinct: 0, payMethod: "", stackable: false, auto: true, uses: 0, maxUses: null, startsAt: today(), endsAt: "", live: false },
        { id: "d-first", code: "FIRSTLOT", label: "First order, 10% off", kind: "percent", value: 10, scope: "order", scopeValue: "", minSubtotal: 60, minDistinct: 0, payMethod: "", stackable: true, auto: false, uses: 0, maxUses: 1000, startsAt: "", endsAt: "", live: true },
        { id: "d-lab", code: "LAB20", label: "Institutional, 20% off", kind: "percent", value: 20, scope: "order", scopeValue: "", minSubtotal: 400, minDistinct: 0, payMethod: "", stackable: false, auto: false, uses: 0, maxUses: 200, startsAt: "", endsAt: "2026-12-31", live: true },
        { id: "d-blend", code: "BLEND25", label: "Blends −25%", kind: "percent", value: 25, scope: "category", scopeValue: "blend", minSubtotal: 0, minDistinct: 0, payMethod: "", stackable: true, auto: false, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-cons", code: "", label: "Free consumables over $120", kind: "fixed", value: 26, scope: "order", scopeValue: "", minSubtotal: 120, minDistinct: 0, payMethod: "", stackable: true, auto: false, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: false },
      ],
      customers: [],
      orders: [],
      labReports: [],
      reviews: [],
      votes: {
        cycle: "Cycle 1", open: false, closesOn: "", target: 6500,
        options: [],
      },
      settings: {
        storeName: "Funchems",
        currency: "USD",
        shippingFlat: 18,
        freeShippingOver: 250,
        cryptoDiscount: 8,
        lowStockThreshold: 10,
        holdOverStock: true,
        showStockCounts: true,
        dispatchCutoff: "14:00 CET",
        wallets: { EVM: "" },
        walletHoldMinutes: 30,
        telegram: {
          enabled: true,
          botToken: "",
          chatId: "",
          adminHandle: "@funchems_support",
          greeting: "Support is on Telegram, usually replying within a few minutes during CET business hours.",
          pollSeconds: 5,
        },
        supabaseUrl: "https://zdqzkzeczmjgjnnmljev.supabase.co",
        supabaseAnonKey: "sb_publishable_rYXuGq26SJuMng1VpvAOxw_rfhIu5FF",
      },
      content: {
        qtyTiers: [
          { id: "qt1", label: "1 to 4 kits", minQty: 1, off: 0, live: true },
          { id: "qt2", label: "5 to 9 kits", minQty: 5, off: 12, live: true },
          { id: "qt3", label: "10+ kits", minQty: 10, off: 22, live: true },
        ],
        tierNote: "Quantity tiers on different compounds stack on top of these per-line rates.",
        doseUnits: [
          { id: "du1", unit: "mg/mL", label: "Injectable, mg per mL", example: "250 mg/mL", live: true },
          { id: "du2", unit: "mg/tablet", label: "Oral tablet", example: "10 mg/tablet", live: true },
          { id: "du3", unit: "mg/vial", label: "Injectable compound", example: "5 mg/vial", live: true },
          { id: "du4", unit: "mcg/vial", label: "Injectable compound, small dose", example: "500 mcg/vial", live: true },
          { id: "du5", unit: "mcg", label: "Small-dose compound", example: "500 mcg", live: true },
          { id: "du6", unit: "IU/mL", label: "International units per mL", example: "100 IU/mL", live: true },
          { id: "du7", unit: "IU/vial", label: "International units per vial", example: "5,000 IU/vial", live: true },
          { id: "du8", unit: "mg/g", label: "Topical compound", example: "5 mg/g", live: true },
          { id: "du9", unit: "mg/capsule", label: "Capsule", example: "20 mg/capsule", live: true },
        ],
        categories: [
          { id: "cat-compound", slug: "compound", label: "Single compounds", blurb: "One compound per vial, lyophilised.", live: true },
          { id: "cat-blend", slug: "blend", label: "Blends", blurb: "Two compounds pre-mixed in one vial.", live: true },
          { id: "cat-accessory", slug: "accessory", label: "Accessories", blurb: "Water, syringes and consumables.", live: true },
        ],
        featured: [],
        lineup: [],
        hero: [
          { id: "h1", eyebrow: "New lot released", title: "Every lot is tested before it ships", body: "Each catalogue number carries its lot number and a third-party assay you can read before you open the box.", cta: "Shop the catalogue", ctaHref: "Shop.dc.html", cta2: "", cta2Href: "", live: true, images: [] },
          { id: "h3", eyebrow: "Cold chain", title: "Cold chain, plain packaging", body: "Insulated packing with a temperature log from our facility to your door. Card, transfer or crypto at checkout.", cta: "How shipping works", ctaHref: "Help-Center.dc.html", cta2: "", cta2Href: "", live: true, images: [] },
        ],
        blocks: [
          { id: "b1", label: "Voting offsale block", images: [], title: "You decide what goes half price", body: "One compound drops to half price each cycle. Vote from the shortlist below; the winner is live for everyone on Monday.", cta: "Get 50% off", cta2: "Vote now", note: "", images: [] },
          { id: "b2", label: "How to get discounts block", images: [], title: "How to get discounts", body: "Three discounts, and they stack. None of them need a code, the checkout price already includes everything you qualify for.", cta: "See all promotions", cta2: "", note: "01 crypto −8%, 02 quantity tiers, 03 account credit", images: [] },
          { id: "b4", label: "Join the community block", images: [], title: "Restocks, lab reports, the weekly vote", body: "One message a week: new assays as they land, the shortlist before it opens, and member pricing on blends.", cta: "Subscribe", cta2: "", note: "Telegram & Discord", images: [] },
        ],
        promos: [
          { id: "pr1", tag: "Headline offer", images: [], title: "Half price on the compound you vote for", body: "One compound drops to 50% for everyone each cycle, and the community picks which. Open the cycle from the admin to put the shortlist live.", cta: "Get 50% off", href: "Promotions.dc.html", live: false, images: [] },
          { id: "pr2", tag: "Always on", images: [], title: "8% off when you pay in crypto", body: "Applied automatically at checkout on ETH and USDT, on every chain we accept. Stacks with everything else on this page.", cta: "Payment methods", href: "Help-Center.dc.html", live: true, images: [] },
          { id: "pr3", tag: "New customers", images: [], title: "Free starter consumables on a first order", body: "Consumables added to any order over $120. No code needed.", cta: "Start shopping", href: "Shop.dc.html", live: true, images: [] },
        ],
        bundles: [],
        faqs: [
          { id: "f2", q: "Which payment methods are accepted?", a: "ETH and USDT, on Ethereum, Arbitrum, Base, Optimism or Polygon. Every order takes 8% off the total automatically.", live: true },
          { id: "f4", q: "How long does delivery take?", a: "Dispatch is same day before 14:00 CET. Two to four days inside the EU, four to seven days worldwide.", live: true },
          { id: "f5", q: "Is the packaging discreet?", a: "Yes. Orders go out in a plain outer box with no branding and no indication of what is inside.", live: true },
          { id: "f6", q: "Can I track my order?", a: "The dispatch email includes a tracking link, and the order number also works from the account page.", live: true },
          { id: "f7", q: "Is there a discount for paying in crypto?", a: "Yes, 8% off the total, applied automatically at checkout on ETH and USDT. No code needed.", live: true },
          { id: "f8", q: "Do prices include tax?", a: "Prices are shown in USD and do not include any import duties or local tax, which are the buyer's responsibility.", live: true },
          { id: "f9", q: "Can I change my order after placing it?", a: "Contact support right away with your order number. We can usually adjust quantities before the lot leaves the facility.", live: true },
          { id: "f10", q: "What if something arrives damaged?", a: "Email support with your order number and a photo. A replacement or refund goes out within one business day.", live: true },
          { id: "f11", q: "How do I cancel an order?", a: "Message support within an hour of placing it and we will cancel before it is prepared.", live: true },
        ],
        footer: {
          blurb: "Research chemicals with per-lot third-party assays. Shipped cold, packed discreet, priced without coupon games.",
          newsletterTitle: "Restocks and lab reports, weekly",
          newsletterNote: "One message a week: restocks, new lab reports, and the offsale shortlist before it opens.",
          legal: "\u00a9 2026 Funchems. All rights reserved.",
          payments: "ETH, USDT",
        },
        footerLinks: [
          { id: "fl1", column: "Shop", label: "All compounds", href: "Shop.dc.html" },
          { id: "fl4", column: "Shop", label: "Promotions", href: "Promotions.dc.html" },
          { id: "fl8", column: "Support", label: "Help Center", href: "Help-Center.dc.html" },
          { id: "fl10", column: "Support", label: "Your account", href: "Account.dc.html" },
          { id: "fl12", column: "Support", label: "Sign in", href: "Sign-In.dc.html" },
          { id: "fl11", column: "Support", label: "Search catalogue", href: "Search.dc.html" },
        ],
        legalLinks: [
          { id: "ll1", label: "Terms", href: "#" },
          { id: "ll2", label: "Privacy", href: "#" },
          { id: "ll3", label: "Shipping", href: "#" },
        ],
        nav: [
          { id: "n1", label: "Home", href: "Funchems.dc.html" },
          { id: "n2", label: "Shop", href: "Shop.dc.html" },
          { id: "n5", label: "Promotions", href: "Promotions.dc.html" },
          { id: "n6", label: "Help Center", href: "Help-Center.dc.html" },
        ],
        strip: [
          { id: "s1", text: "Discreet shipping worldwide" },
          { id: "s2", text: "Crypto payments accepted" },
        ],
        marquee: [
          { id: "m1", text: "Find your best deal", href: "Promotions.dc.html" },
          { id: "m2", text: "Explore all available promos", href: "Promotions.dc.html" },
        ],
        languages: [
          { id: "g1", name: "English", code: "EN" },
          { id: "g2", name: "Nederlands", code: "NL" },
        ],
      },
      lang: "en",
      i18nNL: {
        nav: {
          n1: { label: "Home" },
          n2: { label: "Shop" },
          n5: { label: "Aanbiedingen" },
          n6: { label: "Helpcentrum" },
        },
        footerLinks: {
          fl1: { label: "Alle verbindingen" },
          fl4: { label: "Aanbiedingen" },
          fl8: { label: "Helpcentrum" },
          fl10: { label: "Mijn account" },
          fl12: { label: "Inloggen" },
          fl11: { label: "Catalogus doorzoeken" },
        },
        legalLinks: {
          ll1: { label: "Voorwaarden" },
          ll2: { label: "Privacy" },
          ll3: { label: "Verzending" },
        },
        hero: {
          h1: {
            eyebrow: "Nieuwe partij beschikbaar",
            title: "Elke partij wordt getest voor verzending",
            body: "Elk catalogusnummer draagt een partijnummer en een onafhankelijke analyse die u kunt inzien voordat u de doos opent.",
            cta: "Bekijk de catalogus",
          },
          h3: {
            eyebrow: "Koelketen",
            title: "Koelketen, neutrale verpakking",
            body: "Geïsoleerde verpakking met een temperatuurlogboek van ons magazijn tot aan uw deur. Betalen met kaart, overschrijving of crypto bij het afrekenen.",
            cta: "Hoe verzending werkt",
          },
        },
        blocks: {
          b1: {
            title: "U bepaalt wat halve prijs wordt",
            body: "Elke cyclus gaat één verbinding naar de halve prijs. Stem op de shortlist hieronder; de winnaar is maandag voor iedereen live.",
            cta: "Krijg 50% korting",
            cta2: "Stem nu",
          },
          b2: {
            title: "Hoe u korting krijgt",
            body: "Drie kortingen, en ze zijn stapelbaar. Geen van alle heeft een code nodig, de prijs bij het afrekenen bevat al alles waarvoor u in aanmerking komt.",
            cta: "Bekijk alle aanbiedingen",
            note: "01 crypto −8%, 02 hoeveelheidskorting, 03 accounttegoed",
          },
          b4: {
            title: "Nieuwe voorraad, labrapporten, de wekelijkse stemming",
            body: "Eén bericht per week: nieuwe analyses zodra ze binnenkomen, de shortlist voordat die opent, en ledenprijzen op mixen.",
            cta: "Aanmelden",
            note: "Telegram & Discord",
          },
        },
        promos: {
          pr1: {
            title: "Halve prijs op de verbinding waarop u stemt",
            body: "Elke cyclus gaat één verbinding naar 50% voor iedereen, en de community bepaalt welke. Open de cyclus vanuit het beheer om de shortlist live te zetten.",
            cta: "Krijg 50% korting",
          },
          pr2: {
            title: "8% korting bij betalen met crypto",
            body: "Automatisch toegepast bij het afrekenen met ETH en USDT, op elke chain die wij accepteren. Stapelbaar met alles anders op deze pagina.",
            cta: "Betaalmethoden",
          },
          pr3: {
            title: "Gratis starterbenodigdheden bij uw eerste bestelling",
            body: "Benodigdheden toegevoegd aan elke bestelling boven $120. Geen code nodig.",
            cta: "Begin met shoppen",
          },
        },
        faqs: {
          f2: { q: "Welke betaalmethoden worden geaccepteerd?", a: "ETH en USDT, op Ethereum, Arbitrum, Base, Optimism of Polygon. Elke bestelling krijgt automatisch 8% korting op het totaal." },
          f4: { q: "Hoe lang duurt de levering?", a: "Verzending is dezelfde dag voor 14:00 CET. Twee tot vier dagen binnen de EU, vier tot zeven dagen wereldwijd." },
          f5: { q: "Is de verpakking discreet?", a: "Ja. Bestellingen gaan in een neutrale doos zonder merk en zonder aanduiding van de inhoud." },
          f6: { q: "Kan ik mijn bestelling volgen?", a: "De verzendbevestiging bevat een trackinglink, en het bestelnummer werkt ook vanuit de accountpagina." },
          f7: { q: "Is er korting voor betalen met crypto?", a: "Ja, 8% korting op het totaal, automatisch toegepast bij het afrekenen met ETH en USDT. Geen code nodig." },
          f8: { q: "Zijn prijzen inclusief belasting?", a: "Prijzen worden weergegeven in USD en zijn exclusief invoerrechten of lokale belasting, die voor rekening van de koper zijn." },
          f9: { q: "Kan ik mijn bestelling wijzigen na het plaatsen?", a: "Neem direct contact op met support met uw bestelnummer. We kunnen meestal hoeveelheden aanpassen voordat de partij het magazijn verlaat." },
          f10: { q: "Wat als er iets beschadigd aankomt?", a: "Mail support met uw bestelnummer en een foto. Een vervanging of terugbetaling wordt binnen één werkdag verstuurd." },
          f11: { q: "Hoe annuleer ik een bestelling?", a: "Stuur support binnen een uur na plaatsing een bericht en we annuleren voordat de bestelling wordt klaargemaakt." },
        },
        categories: {
          "cat-compound": { label: "Losse verbindingen", blurb: "Eén verbinding per injectieflacon, gevriesdroogd." },
          "cat-blend": { label: "Mixen", blurb: "Twee verbindingen voorgemengd in één injectieflacon." },
          "cat-accessory": { label: "Accessoires", blurb: "Water, spuiten en benodigdheden." },
        },
        doseUnits: {
          du1: { label: "Injecteerbaar, mg per mL" },
          du2: { label: "Orale tablet" },
          du3: { label: "Injecteerbare verbinding" },
          du4: { label: "Injecteerbare verbinding, kleine dosis" },
          du5: { label: "Verbinding, kleine dosis" },
          du6: { label: "Internationale eenheden per mL" },
          du7: { label: "Internationale eenheden per injectieflacon" },
          du8: { label: "Uitwendige verbinding" },
          du9: { label: "Capsule" },
        },
        footer: {
          blurb: "Research chemicals met onafhankelijke analyses per partij. Koel verzonden, discreet verpakt, geprijsd zonder couponspelletjes.",
          newsletterTitle: "Nieuwe voorraad en labrapporten, wekelijks",
          newsletterNote: "Eén bericht per week: nieuwe voorraad, nieuwe labrapporten, en de afprijslijst voordat die opent.",
          legal: "© 2026 Funchems. Alle rechten voorbehouden.",
          payments: "ETH, USDT",
        },
        strip: {
          s1: { text: "Discrete verzending wereldwijd" },
          s2: { text: "Crypto betalingen geaccepteerd" },
        },
        marquee: {
          m1: { text: "Vind uw beste deal" },
          m2: { text: "Bekijk alle beschikbare aanbiedingen" },
        },
        qtyTiers: {
          qt1: { label: "1 tot 4 sets" },
          qt2: { label: "5 tot 9 sets" },
          qt3: { label: "10+ sets" },
        },
        tierNote: "Hoeveelheidskorting op verschillende verbindingen wordt gestapeld op deze regelprijzen.",
        discounts: {
          "d-crypto": { label: "Cryptobetaling" },
          "d-tier3": { label: "Hoeveelheidskorting, 3 verbindingen" },
          "d-tier5": { label: "Hoeveelheidskorting, 5 verbindingen" },
          "d-ship": { label: "Gratis koelverzending boven $250" },
          "d-vote": { label: "Winnaar van de stemming, halve prijs" },
          "d-first": { label: "Eerste bestelling, 10% korting" },
          "d-lab": { label: "Instelling, 20% korting" },
          "d-blend": { label: "Mixen −25%" },
          "d-cons": { label: "Gratis benodigdheden boven $120" },
        },
      },
    };
  }

  function merge(base, saved) {
    const out = { ...base, ...saved };
    out.content = { ...base.content, ...(saved && saved.content) };
    out.settings = { ...base.settings, ...(saved && saved.settings) };
    out.votes = { ...base.votes, ...(saved && saved.votes) };
    return out;
  }

  const listeners = new Set();

  const db = {
    KEY, CART_KEY,
    money, pct, uid, today,
    seedData: seed,

    data: (function () {
      try {
        const raw = window.localStorage.getItem(KEY);
        if (raw) return merge(seed(), JSON.parse(raw));
      } catch (e) {}
      return seed();
    })(),

    cartState: (function () {
      try {
        const raw = window.localStorage.getItem(CART_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          // One-time cleanup: browsers that loaded the site before the
          // pre-filled sample cart was removed have this exact combination
          // saved to disk. No real cart can match it, so it's safe to wipe.
          const isOldDummyCart = Array.isArray(saved.lines) && saved.lines.length === 3
            && saved.lines[0]?.cat === "TR5" && saved.lines[0]?.qty === 2
            && saved.lines[1]?.cat === "BP5" && saved.lines[1]?.qty === 1
            && saved.lines[2]?.cat === "PPB10" && saved.lines[2]?.qty === 1
            && Array.isArray(saved.wishlist) && saved.wishlist.length === 1 && saved.wishlist[0] === "RT5";
          if (!isOldDummyCart) return saved;
        }
      } catch (e) {}
      return { lines: [], code: "", payMethod: "crypto", wishlist: [] };
    })(),

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    notify() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); },

    save() {
      try { window.localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) {}
      this.push();
      this.notify();
    },
    saveCart() {
      try { window.localStorage.setItem(CART_KEY, JSON.stringify(this.cartState)); } catch (e) {}
      this.notify();
    },
    edit(fn) {
      fn(this.data);
      this.save();
    },
    reset() {
      this.data = seed();
      this.save();
    },

    /* ---- Language --------------------------------------------------------
     * Two-language prototype: English is the single source of truth stored
     * directly on content.* (and edited as such from the admin). Dutch lives
     * in a parallel i18nNL lookup keyed by [section][id][field], so admin
     * edits never need to touch two copies of the same array.
     * tr() is for content.* items; t() is for a page's own local {en,nl}
     * dictionary of static strings that aren't part of content.*.
     * ------------------------------------------------------------------- */
    lang() { return this.data.lang || "en"; },
    setLang(code) {
      this.data.lang = code === "nl" ? "nl" : "en";
      this.save();
    },
    tr(section, id, field, fallback) {
      if (this.lang() !== "nl") return fallback;
      const sec = (this.data.i18nNL || {})[section] || {};
      const row = sec[id] || (section === "footer" ? sec : null);
      const val = row ? row[field] : undefined;
      return val !== undefined && val !== "" ? val : fallback;
    },
    t(dict, key) {
      const row = dict[this.lang()] || dict.en || {};
      return row[key] !== undefined ? row[key] : key;
    },

    /* ---- Supabase bridge ------------------------------------------------ */
    get supabaseConfigured() {
      const s = this.data.settings;
      return Boolean(s.supabaseUrl && s.supabaseAnonKey);
    },
    client: null,
    authUser: null,
    connect() {
      if (!this.supabaseConfigured || !window.supabase) return null;
      if (!this.client) {
        this.client = window.supabase.createClient(this.data.settings.supabaseUrl, this.data.settings.supabaseAnonKey);
        this.client.auth.getSession().then(({ data }) => {
          this.authUser = data.session ? data.session.user : null;
          this.notify();
        });
        this.client.auth.onAuthStateChange((_event, session) => {
          this.authUser = session ? session.user : null;
          this.notify();
        });
      }
      return this.client;
    },
    async pull() {
      const c = this.connect();
      if (!c) return { ok: false, reason: "local" };

      // Every content.* section (hero, nav, faqs, promos, ...) and votes
      // live as one row each in the single `content` table — not their own
      // tables, so this schema never needs to grow a table per section.
      const { data: contentRows, error: contentError } = await c.from("content").select("*");
      if (!contentError && contentRows) {
        for (const row of contentRows) {
          if (row.key === "votes") this.data.votes = row.value;
          else this.data.content[row.key] = row.value;
        }
      }

      const tables = { products: "products", discounts: "discounts", orders: "orders", customers: "customers", labReports: "lab_reports", reviews: "reviews" };
      const fromRow = { products: fromProductRow, discounts: fromDiscountRow, labReports: fromLabReportRow, reviews: fromReviewRow };
      for (const [key, table] of Object.entries(tables)) {
        const { data, error } = await c.from(table).select("*");
        if (!error && data) this.data[key] = fromRow[key] ? data.map(fromRow[key]) : data;
      }
      this.save();
      return { ok: true };
    },
    async push() {
      const c = this.client;
      if (!c) return { ok: false, reason: "local" };
      // Writes need the service role key, which never ships to the browser —
      // this goes through a server route that re-checks the caller is an
      // admin before touching Postgres. See app/api/admin/sync/route.js.
      const { data } = await c.auth.getSession();
      const token = data.session && data.session.access_token;
      if (!token) return { ok: false, reason: "signed-out" };
      const content = Object.entries(this.data.content).map(([key, value]) => ({ key, value }));
      content.push({ key: "votes", value: this.data.votes });
      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          products: this.data.products.map(toProductRow),
          discounts: this.data.discounts.map(toDiscountRow),
          labReports: this.data.labReports.map(toLabReportRow),
          reviews: this.data.reviews.map(toReviewRow),
          content,
        }),
      });
      const body = await res.json();
      return body;
    },

    /* ---- Products ------------------------------------------------------- */
    doseOf(p) {
      if (!p) return "";
      if (p.doseValue || p.doseUnit) return [p.doseValue, p.doseUnit].filter(Boolean).join(" ");
      return p.dose || "";
    },
    products(opts) {
      const o = opts || {};
      let list = this.data.products.map((p) => (p.doseValue || p.doseUnit ? { ...p, dose: this.doseOf(p) } : p));
      if (o.liveOnly) list = list.filter((p) => p.live);
      if (o.category) list = list.filter((p) => p.category === o.category);
      if (o.query) {
        const q = o.query.toLowerCase();
        list = list.filter((p) => (p.name + " " + p.cat + " " + p.dose).toLowerCase().includes(q));
      }
      if (o.inStock) list = list.filter((p) => p.stock > 0);
      if (o.sort === "price-asc") list.sort((a, b) => this.effectivePrice(a) - this.effectivePrice(b));
      if (o.sort === "price-desc") list.sort((a, b) => this.effectivePrice(b) - this.effectivePrice(a));
      if (o.sort === "discount") list.sort((a, b) => this.discountPct(b) - this.discountPct(a));
      return list;
    },
    /* ---- Quantity tiers -------------------------------------------------- */
    qtyTiers() {
      return (this.data.content.qtyTiers || [])
        .filter((t) => t.live !== false)
        .slice()
        .sort((a, b) => Number(a.minQty) - Number(b.minQty));
    },
    tierPrice(p, minQty) {
      const t = this.qtyTiers().filter((x) => Number(x.minQty) <= Number(minQty)).pop();
      const off = t ? Number(t.off) || 0 : 0;
      return this.effectivePrice(p) * (1 - off / 100);
    },
    doseUnits() {
      return (this.data.content.doseUnits || []).filter((u) => u.live !== false);
    },

    /* ---- Accounts --------------------------------------------------------
     * Supabase mode (supabaseConfigured): auth.users is the source of truth.
     * this.authUser is kept in sync by the onAuthStateChange listener set up
     * in connect(), so session()/currentUser() stay synchronous for callers.
     * Local mode (no Supabase): falls back to the old localStorage session,
     * used only for offline prototyping — never stores a real password.
     * ------------------------------------------------------------------- */
    session() {
      if (this.supabaseConfigured) {
        return this.authUser ? { email: this.authUser.email, at: 0 } : null;
      }
      try { return JSON.parse(localStorage.getItem(this.KEY + ":session") || "null"); } catch (e) { return null; }
    },
    currentUser() {
      const s = this.session();
      if (!s || !s.email) return null;
      const c = this.data.customers.find((x) => x.email.toLowerCase() === s.email.toLowerCase());
      if (c) return c;
      if (this.supabaseConfigured && this.authUser) {
        const meta = this.authUser.user_metadata || {};
        return { email: this.authUser.email, name: meta.name || "", country: meta.country || "" };
      }
      return null;
    },
    auth: {
      async signIn(email, password) {
        const db = window.Funchems;
        const c = db.connect();
        if (c) {
          const { error } = await c.auth.signInWithPassword({ email: String(email).trim(), password });
          return error ? { ok: false, error: error.message } : { ok: true };
        }
        const local = db.data.customers.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase());
        if (!local) return { ok: false, error: "No account uses that email address." };
        if (local.password && password && local.password !== password) return { ok: false, error: "That password does not match our records." };
        localStorage.setItem(db.KEY + ":session", JSON.stringify({ email: local.email, at: Date.now() }));
        db.notify();
        return { ok: true };
      },
      async signUp(fields) {
        const db = window.Funchems;
        const email = String(fields.email || "").trim();
        if (!email.includes("@")) return { ok: false, error: "Enter a valid email address." };
        if (String(fields.password || "").length < 8) return { ok: false, error: "Use at least eight characters for the password." };

        const c = db.connect();
        if (c) {
          const { error } = await c.auth.signUp({
            email, password: fields.password,
            options: {
              data: { name: fields.name || "", country: fields.country || "" },
              emailRedirectTo: location.origin + "/Email-Confirmed.dc.html",
            },
          });
          return error ? { ok: false, error: error.message } : { ok: true, note: "Check your email to confirm your account." };
        }

        if (db.data.customers.some((x) => x.email.toLowerCase() === email.toLowerCase())) {
          return { ok: false, error: "That email already has an account. Sign in instead." };
        }
        db.edit((x) => {
          x.customers.unshift({
            id: "c" + Date.now(), email, name: fields.name || "", country: fields.country || "",
            ordersCount: 0, spent: 0, credit: 0, tier: "standard",
            flagged: false, createdAt: db.today(),
          });
        });
        localStorage.setItem(db.KEY + ":session", JSON.stringify({ email, at: Date.now() }));
        db.notify();
        return { ok: true };
      },
      async signOut() {
        const db = window.Funchems;
        const c = db.connect();
        if (c) await c.auth.signOut();
        localStorage.removeItem(db.KEY + ":session");
        db.notify();
      },
      async resetPassword(email) {
        const db = window.Funchems;
        const c = db.connect();
        if (c) {
          const { error } = await c.auth.resetPasswordForEmail(String(email).trim(), {
            redirectTo: location.origin + "/Reset-Password.dc.html",
          });
          return error ? { ok: false, error: error.message } : { ok: true, note: "Reset link sent to " + email + " if an account exists." };
        }
        const local = db.data.customers.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase());
        return local
          ? { ok: true, note: "Reset link sent to " + local.email + ". It expires in one hour." }
          : { ok: false, error: "No account uses that email address." };
      },
      async changePassword(next) {
        const db = window.Funchems;
        if (String(next || "").length < 8) return { ok: false, error: "Use at least eight characters." };
        const c = db.connect();
        if (c) {
          const { error } = await c.auth.updateUser({ password: next });
          return error ? { ok: false, error: error.message } : { ok: true, note: "Password updated." };
        }
        const me = db.currentUser();
        if (!me) return { ok: false, error: "Sign in first." };
        db.edit((x) => {
          const localC = x.customers.find((y) => y.email === me.email);
          if (localC) localC.password = next;
        });
        return { ok: true, note: "Password updated." };
      },
      async deleteAccount() {
        const db = window.Funchems;
        const me = db.currentUser();
        if (!me) return { ok: false, error: "Sign in first." };
        const c = db.connect();
        if (c) {
          const { data } = await c.auth.getSession();
          const token = data.session && data.session.access_token;
          if (token) {
            const res = await fetch("/api/delete-account", {
              method: "POST",
              headers: { Authorization: "Bearer " + token },
            });
            const body = await res.json();
            if (!body.ok) return { ok: false, error: body.error || "Could not delete account." };
          }
        }
        db.edit((x) => { x.customers = x.customers.filter((c) => c.email !== me.email); });
        if (c) await c.auth.signOut();
        localStorage.removeItem(db.KEY + ":session");
        db.notify();
        return { ok: true };
      },
    },

    /* ---- Footer ---------------------------------------------------------- */
    footer() {
      const f = this.data.content.footer || {};
      return {
        ...f,
        blurb: this.tr("footer", null, "blurb", f.blurb),
        newsletterTitle: this.tr("footer", null, "newsletterTitle", f.newsletterTitle),
        newsletterNote: this.tr("footer", null, "newsletterNote", f.newsletterNote),
        legal: this.tr("footer", null, "legal", f.legal),
        payments: this.tr("footer", null, "payments", f.payments),
      };
    },
    footerColumns() {
      const colNames = { en: { Shop: "Shop", Support: "Support", More: "More" }, nl: { Shop: "Shop", Support: "Ondersteuning", More: "Overig" } };
      const rows = (this.data.content.footerLinks || []).filter((r) => r.label);
      const order = [];
      const byCol = {};
      rows.forEach((r) => {
        const col = r.column || "More";
        if (!byCol[col]) { byCol[col] = []; order.push(col); }
        byCol[col].push({ label: this.tr("footerLinks", r.id, "label", r.label), href: r.href || "#" });
      });
      return order.map((col) => ({ title: this.t(colNames, col) || col, items: byCol[col] }));
    },

    product(cat) {
      const p = this.data.products.find((x) => x.cat === cat || x.id === cat);
      return p && (p.doseValue || p.doseUnit) ? { ...p, dose: this.doseOf(p) } : p;
    },

    /* ---- Families -------------------------------------------------------
     * Products that share a name are strengths of one compound. The storefront
     * shows one card per family; the product page picks the strength.
     */
    variantsOf(cat) {
      const p = this.product(cat);
      if (!p) return [];
      return this.products({ liveOnly: true })
        .filter((x) => x.name === p.name)
        .sort((a, b) => (parseFloat(a.doseValue) || 0) - (parseFloat(b.doseValue) || 0));
    },
    families(opts) {
      const list = this.products(opts || { liveOnly: true });
      const map = new Map();
      list.forEach((p) => {
        if (!map.has(p.name)) map.set(p.name, []);
        map.get(p.name).push(p);
      });
      return Array.from(map.values()).map((vs) => {
        const sorted = vs.slice().sort((a, b) => (parseFloat(a.doseValue) || 0) - (parseFloat(b.doseValue) || 0));
        const prices = vs.map((v) => this.effectivePrice(v));
        const lead = sorted.find((v) => v.stock > 0) || sorted[0];
        return {
          name: lead.name,
          cat: lead.cat,
          category: lead.category,
          variants: sorted,
          count: sorted.length,
          from: Math.min.apply(null, prices),
          inStock: vs.some((v) => v.stock > 0),
        };
      });
    },

    /* ---- Categories ----------------------------------------------------- */
    categories(opts) {
      const o = opts || {};
      const list = (this.data.content.categories || []).filter((c) => c.slug);
      return o.liveOnly ? list.filter((c) => c.live) : list;
    },
    categorySlugs() { return this.categories().map((c) => c.slug); },
    categoryLabel(slug) {
      const c = this.categories().find((x) => x.slug === slug);
      return c ? c.label : slug;
    },
    categoryCount(slug) { return this.data.products.filter((p) => p.category === slug).length; },

    /* Automatic product-level discounts (offsale winner, category rules). */
    productRules(p) {
      return this.data.discounts.filter((d) =>
        d.live && d.auto && d.kind === "percent" &&
        ((d.scope === "product" && d.scopeValue === p.cat) ||
         (d.scope === "category" && d.scopeValue === p.category)));
    },
    effectivePrice(p) {
      const rules = this.productRules(p);
      const best = rules.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0);
      return Math.round(p.price * (1 - best / 100) * 100) / 100;
    },
    discountPct(p) {
      const eff = this.effectivePrice(p);
      if (!p.list || p.list <= eff) return 0;
      return Math.round((1 - eff / p.list) * 100);
    },
    stockLabel(p) {
      const nl = this.lang() === "nl";
      if (p.stock <= 0) return { label: nl ? "Niet op voorraad" : "Out of stock", tone: "out" };
      if (p.stock <= (p.lowStockAt || 10)) return { label: (nl ? "Beperkte voorraad, nog " : "Low stock, ") + p.stock + (nl ? "" : " left"), tone: "low" };
      return { label: (nl ? "Op voorraad, " : "In stock, ") + p.stock, tone: "ok" };
    },

    /* ---- Cart ----------------------------------------------------------- */
    cart: {
      get raw() { return db.cartState; },
      count() { return db.cartState.lines.reduce((t, l) => t + l.qty, 0); },
      lines() {
        return db.cartState.lines.map((l) => {
          const p = db.product(l.cat) || { name: l.cat, dose: "", price: 0, list: 0, stock: 0, lot: "" };
          const unit = db.effectivePrice(p);
          return {
            cat: l.cat, qty: l.qty, product: p, unit,
            list: p.list || unit,
            lineTotal: unit * l.qty,
            lineList: (p.list || unit) * l.qty,
          };
        });
      },
      add(cat, qty) {
        const n = qty || 1;
        const line = db.cartState.lines.find((l) => l.cat === cat);
        if (line) line.qty += n;
        else db.cartState.lines.push({ cat, qty: n });
        db.saveCart();
      },
      setQty(cat, qty) {
        const line = db.cartState.lines.find((l) => l.cat === cat);
        if (!line) return;
        const p = db.product(cat);
        const cap = p && db.data.settings.holdOverStock ? Math.max(1, p.stock) : 99;
        line.qty = Math.max(1, Math.min(cap, qty));
        db.saveCart();
      },
      remove(cat) {
        db.cartState.lines = db.cartState.lines.filter((l) => l.cat !== cat);
        db.saveCart();
      },
      clear() { db.cartState.lines = []; db.cartState.code = ""; db.saveCart(); },
      setCode(code) { db.cartState.code = (code || "").trim().toUpperCase(); db.saveCart(); },
      setPay(method) { db.cartState.payMethod = method; db.saveCart(); },
      toggleWish(cat) {
        const w = db.cartState.wishlist || [];
        db.cartState.wishlist = w.includes(cat) ? w.filter((x) => x !== cat) : [...w, cat];
        db.saveCart();
      },
      wished(cat) { return (db.cartState.wishlist || []).includes(cat); },
    },

    /* ---- Pricing engine -------------------------------------------------
     * Order of operations: automatic product/category rules are already in the
     * unit price (see productRules). Then order-level automatic rules, then one
     * code, which may itself be scoped to a product or a category, in which
     * case it discounts only the matching lines, then shipping.
     */
    pricing(opts) {
      const o = opts || {};
      const lines = o.lines || this.cart.lines();
      const payMethod = o.payMethod || this.cartState.payMethod || "card";
      const code = (o.code !== undefined ? o.code : this.cartState.code) || "";
      const s = this.data.settings;
      const isCrypto = ["crypto", "eth", "usdt"].includes(String(payMethod).toLowerCase());

      const listTotal = lines.reduce((t, l) => t + l.lineList, 0);
      const subtotal = lines.reduce((t, l) => t + l.lineTotal, 0);
      const distinct = lines.length;
      const applied = [];
      let orderOff = 0;
      let shipping = subtotal > 0 ? Number(s.shippingFlat) || 0 : 0;
      let freeShip = false;

      /* Subtotal of the lines a rule actually covers. Order-scoped rules cover
         everything; scoped rules cover only their product or category. */
      const scopeBase = (d) => {
        if (d.scope === "product") {
          return lines.filter((l) => l.cat === d.scopeValue).reduce((t, l) => t + l.lineTotal, 0);
        }
        if (d.scope === "category") {
          return lines.filter((l) => l.product && l.product.category === d.scopeValue).reduce((t, l) => t + l.lineTotal, 0);
        }
        return subtotal;
      };

      const eligible = (d, opts2) => {
        const allowScoped = opts2 && opts2.allowScoped;
        if (!d.live) return false;
        if (d.maxUses && d.uses >= d.maxUses) return false;
        if (d.endsAt && d.endsAt < today()) return false;
        if (d.startsAt && d.startsAt > today()) return false;
        if (Number(d.minSubtotal) > subtotal) return false;
        if (Number(d.minDistinct) > distinct) return false;
        if (d.payMethod === "crypto" && !isCrypto) return false;
        if (d.payMethod === "card" && isCrypto) return false;
        // Automatic scoped rules are already priced into the unit; only a typed
        // code may claim a scoped discount here.
        if (!allowScoped && (d.scope === "product" || d.scope === "category")) return false;
        return true;
      };

      // Automatic rules: for percent tiers take the single best, others stack.
      const autos = this.data.discounts.filter((d) => d.auto && eligible(d));
      const tiers = autos.filter((d) => d.kind === "percent" && Number(d.minDistinct) > 0);
      const bestTier = tiers.sort((a, b) => b.value - a.value)[0];
      const rest = autos.filter((d) => !tiers.includes(d));

      const applyRule = (d) => {
        const base = scopeBase(d);
        const label = this.tr("discounts", d.id, "label", d.label);
        if (d.kind === "percent") {
          const amt = Math.round(base * (Number(d.value) / 100) * 100) / 100;
          orderOff += amt;
          applied.push({ id: d.id, label, value: amt, kind: "percent" });
        } else if (d.kind === "fixed") {
          const amt = Math.min(Number(d.value), base, subtotal - orderOff);
          orderOff += amt;
          applied.push({ id: d.id, label, value: amt, kind: "fixed" });
        } else if (d.kind === "shipping") {
          freeShip = true;
          applied.push({ id: d.id, label, value: shipping, kind: "shipping" });
        }
      };

      if (bestTier) applyRule(bestTier);
      rest.forEach(applyRule);

      // Code, a scoped code discounts only the lines it covers.
      let codeState = code ? "invalid" : "";
      if (code) {
        const d = this.data.discounts.find((x) => (x.code || "").toUpperCase() === code);
        if (d && d.live && (Number(d.minSubtotal) > subtotal || Number(d.minDistinct) > distinct)) {
          codeState = "unmet";
        } else if (d && d.live && (d.maxUses && d.uses >= d.maxUses)) {
          codeState = "spent";
        } else if (d && d.live && ((d.endsAt && d.endsAt < today()) || (d.startsAt && d.startsAt > today()))) {
          codeState = "expired";
        } else if (d && eligible(d, { allowScoped: true })) {
          if (d.kind !== "shipping" && scopeBase(d) <= 0) codeState = "notapplicable";
          else if (!d.stackable && applied.length > 0) codeState = "exclusive";
          else { applyRule(d); codeState = "applied"; }
        }
      }

      if (freeShip || (s.freeShippingOver && subtotal >= Number(s.freeShippingOver))) shipping = 0;

      const promoSavings = Math.max(0, listTotal - subtotal);
      const total = Math.max(0, subtotal - orderOff) + shipping;
      return {
        lines, listTotal, subtotal, distinct, applied, orderOff, shipping, total,
        promoSavings, savings: promoSavings + orderOff,
        isCrypto, code, codeState,
        nextTier: (function () {
          const upcoming = db.data.discounts
            .filter((d) => d.live && d.auto && Number(d.minDistinct) > distinct)
            .sort((a, b) => a.minDistinct - b.minDistinct)[0];
          if (!upcoming) return null;
          return { need: upcoming.minDistinct - distinct, value: upcoming.value, label: db.tr("discounts", upcoming.id, "label", upcoming.label) };
        })(),
      };
    },

    /* ---- Orders --------------------------------------------------------- */
    statuses: ["Awaiting", "Paid", "Packed", "Shipped", "Refunded"],
    placeOrder(info) {
      const pr = this.pricing();
      const id = "MP-" + (24119 + this.data.orders.length);
      const order = {
        id, email: info.email || "guest@funchems.store", status: "Awaiting",
        payMethod: info.payMethod || "ETH",
        chain: info.chain || "Ethereum",
        subtotal: pr.subtotal, discount: pr.orderOff, shipping: pr.shipping, total: pr.total,
        country: info.country || "", tracking: "", note: info.note || "",
        createdAt: today(),
        lines: pr.lines.map((l) => ({ cat: l.cat, qty: l.qty, unit: l.unit })),
      };
      this.edit((d) => {
        d.orders.unshift(order);
        order.lines.forEach((l) => {
          const p = d.products.find((x) => x.cat === l.cat);
          if (p) p.stock = Math.max(0, p.stock - l.qty);
        });
        const c = d.customers.find((x) => x.email === order.email);
        if (c) {
          c.ordersCount = (c.ordersCount || 0) + 1;
          c.spent = Math.round(((c.spent || 0) + order.total) * 100) / 100;
        }
        pr.applied.forEach((a) => {
          const disc = d.discounts.find((x) => x.id === a.id);
          if (disc) disc.uses = (disc.uses || 0) + 1;
        });
      });
      this.cart.clear();
      return order;
    },
    orderTotalOf(o) {
      return Math.max(0, (Number(o.subtotal) || 0) - (Number(o.discount) || 0)) + (Number(o.shipping) || 0);
    },

    /* ---- Metrics -------------------------------------------------------- */
    metrics() {
      const o = this.data.orders.filter((x) => x.status !== "Refunded");
      const revenue = o.reduce((t, x) => t + this.orderTotalOf(x), 0);
      const crypto = o.filter((x) => ["ETH", "USDT"].includes(x.payMethod));
      const lowStock = this.data.products.filter((p) => p.stock > 0 && p.stock <= (p.lowStockAt || 10));
      const out = this.data.products.filter((p) => p.stock <= 0);
      const unitsByCat = {};
      this.data.orders.forEach((x) => (x.lines || []).forEach((l) => { unitsByCat[l.cat] = (unitsByCat[l.cat] || 0) + l.qty; }));
      const best = Object.entries(unitsByCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return {
        revenue, orders: o.length,
        aov: o.length ? revenue / o.length : 0,
        cryptoShare: o.length ? Math.round((crypto.length / o.length) * 100) : 0,
        awaiting: this.data.orders.filter((x) => x.status === "Awaiting").length,
        toPack: this.data.orders.filter((x) => x.status === "Paid").length,
        lowStock, outOfStock: out,
        pendingReviews: this.data.reviews.filter((r) => !r.live).length,
        hiddenProducts: this.data.products.filter((p) => !p.live).length,
        best: best.map(([cat, units]) => ({ cat, units, product: this.product(cat) })),
        inventoryValue: this.data.products.reduce((t, p) => t + p.price * p.stock, 0),
        customers: this.data.customers.length,
        voteTotal: (this.data.votes.options || []).reduce((t, v) => t + v.count, 0),
      };
    },
  };

  window.Funchems = db;
  window.Aptera = db;

  // Each .dc.html page is a fresh full page load, not a SPA — connect() must
  // run on every load (not just when an action happens to need it) so the
  // Supabase session in localStorage gets restored into authUser here.
  // Without this, a page reached by plain navigation (not through an action
  // that calls connect() itself, like signIn()) sees authUser as null even
  // though a valid session already exists.
  if (db.supabaseConfigured) db.connect();
})();
