/* Morpheps store data layer.
 *
 * One source of truth for the storefront and the admin dashboard.
 * Reads/writes Supabase when a client is configured, otherwise falls back to
 * localStorage so every page still works offline in the prototype.
 *
 * Usage from a DC logic class:
 *   const db = window.Morpheps;
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
 *   id uuid primary key default gen_random_uuid(),
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
 *   id uuid primary key default gen_random_uuid(),
 *   lot text not null, product_cat text, method text,
 *   purity text, reported_on date, file_url text, live bool default true
 * );
 * create table reviews (
 *   id uuid primary key default gen_random_uuid(),
 *   product_cat text, author text, lot text, stars int,
 *   body text, images jsonb default '[]',
 *   live bool default false, created_at timestamptz default now()
 * );
 * create table votes (
 *   id uuid primary key default gen_random_uuid(),
 *   cycle text, product_cat text, count int default 0,
 *   open bool default true, closes_on date
 * );
 * create table content (
 *   key text primary key, value jsonb          -- hero, blocks, nav, strip, promos...
 * );
 *
 * -- Row level security: public reads live rows, writes go through the service role.
 * alter table products enable row level security;
 * create policy "public read live" on products for select using (live = true);
 * create policy "admin all" on products for all using (auth.role() = 'service_role');
 * ---------------------------------------------------------------------------
 */
(function () {
  const KEY = "morpheps-store-v9";
  const CART_KEY = "morpheps-cart-v2";

  const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const pct = (n) => (n > 0 ? "−" : "") + Math.round(Math.abs(n)) + "%";
  const uid = (p) => p + "-" + Math.random().toString(36).slice(2, 8);
  const today = () => new Date().toISOString().slice(0, 10);

  function seed() {
    // "5 mg / vial" -> { doseValue: "5", doseUnit: "mg/vial" }. Anything that is not a
    // single magnitude plus one unit keeps its original string instead.
    const splitDose = (dose) => {
      const m = String(dose).match(/^\s*([\d.,]+)\s*(mg|mcg|IU|ml|mL|g)\s*\/\s*(vial|mL|ml|tablet|capsule|g)\s*$/);
      if (!m) return { doseValue: "", doseUnit: "" };
      const unit = m[2].toLowerCase() === "ml" ? "mL" : m[2];
      const per = m[3].toLowerCase() === "ml" ? "mL" : m[3];
      return { doseValue: m[1], doseUnit: unit + "/" + per };
    };

    // One lot per product: sequential batch numbers, so no two compounds share a lot.
    let lotSeq = 0;
    const lotFor = () => {
      const n = lotSeq++;
      const month = 1 + (n % 8);
      const day = 1 + Math.floor(n / 8);
      return "26-" + String(month).padStart(2, "0") + String(day).padStart(2, "0");
    };

    const NO_IMAGE = new Set(["TC1", "RB5", "UM10", "SR5", "MV25", "BL1", "ST1"]);
    const JPG = new Set(["BM7", "BS804", "DN1", "OP1"]);
    const imageFor = (cat) => NO_IMAGE.has(cat) ? [] : ["/assets/products/" + cat + (JPG.has(cat) ? ".jpg" : ".png")];

    const P = (cat, name, dose, price, list, stock, purity, lot, category, live) => ({
      id: cat.toLowerCase(), cat, name, dose, category, price, list: price, stock: 40,
      ...splitDose(dose),
      lowStockAt: 10, purity, lot: lotFor(), live: live !== false, images: imageFor(cat), sort: 0,
      body: "Supplied as a kit of 10 vials. Lyophilised powder, sealed under nitrogen. Reconstitute with bacteriostatic water and store at 2 to 8 °C once opened.",
    });
    const products = [
        P("SM10", "Somatropin", "10 IU / vial", 109, 109, 40, "99.0%", "", "compound"),
        P("SM30", "Somatropin", "30 IU / vial", 299, 299, 25, "99.0%", "", "compound"),
        P("MC1", "Mecasermin", "1 mg / vial", 149, 149, 30, "98.0%", "", "compound"),
        P("MC5", "Mecasermin", "5 mg / vial", 549, 549, 12, "98.0%", "", "compound"),
        P("IG01", "IGF-1 LR3", "0.1 mg / vial", 94, 94, 42, "99.1%", "", "compound"),
        P("IG1", "IGF-1 LR3", "1 mg / vial", 429, 429, 20, "98.9%", "", "compound"),
        P("MK25", "MK-677", "25 mg / vial", 79, 79, 60, "99.0%", "", "compound"),
        P("MK50", "MK-677", "50 mg / vial", 129, 129, 45, "99.0%", "", "compound"),
        P("IB25", "Ibutamoren", "25 mg / vial", 79, 79, 60, "99.0%", "", "compound"),
        P("IB50", "Ibutamoren", "50 mg / vial", 129, 129, 45, "99.0%", "", "compound"),
        P("DC2", "CJC-1295", "2 mg / vial", 169, 169, 40, "99.0%", "", "compound"),
        P("DC10", "CJC-1295", "10 mg / vial", 574, 574, 15, "99.0%", "", "compound"),
        P("CN2", "CJC-1295 no-DAC", "2 mg / vial", 89, 89, 40, "99.0%", "", "compound"),
        P("CN5", "CJC-1295 no-DAC", "5 mg / vial", 154, 154, 28, "99.0%", "", "compound"),
        P("PR2", "Ipamorelin", "2 mg / vial", 69, 69, 40, "99.3%", "", "compound"),
        P("PR10", "Ipamorelin", "10 mg / vial", 144, 144, 25, "99.4%", "", "compound"),
        P("RL5", "Sermorelin", "5 mg / vial", 154, 154, 40, "99.0%", "", "compound"),
        P("RL15", "Sermorelin", "15 mg / vial", 419, 419, 15, "98.9%", "", "compound"),
        P("TMR5", "Tesamorelin", "5 mg / vial", 119, 119, 40, "99.0%", "", "compound"),
        P("TMR10", "Tesamorelin", "10 mg / vial", 219, 219, 25, "99.0%", "", "compound"),
        P("G25", "GHRP-2", "5 mg / vial", 69, 69, 40, "99.0%", "", "compound"),
        P("G210", "GHRP-2", "10 mg / vial", 119, 119, 25, "99.0%", "", "compound"),
        P("G65", "GHRP-6", "5 mg / vial", 64, 64, 40, "99.0%", "", "compound"),
        P("G610", "GHRP-6", "10 mg / vial", 109, 109, 25, "99.0%", "", "compound"),
        P("HX2", "Hexarelin", "2 mg / vial", 69, 69, 40, "99.0%", "", "compound"),
        P("HX5", "Hexarelin", "5 mg / vial", 124, 124, 25, "99.0%", "", "compound"),
        P("FL1", "Follistatin-344", "1 mg / vial", 139, 139, 20, "99.0%", "", "compound"),
        P("FL2", "Follistatin-344", "2 mg / vial", 259, 259, 10, "99.0%", "", "compound"),
        P("VS05", "Vosoritide", "0.5 mg / vial", 189, 189, 20, "99.89%", "", "compound"),
        P("VS1", "Vosoritide", "1 mg / vial", 349, 349, 10, "99.89%", "", "compound"),
        P("BM05", "BMN-111", "0.5 mg / vial", 189, 189, 20, "99.89%", "", "compound"),
        P("BM1", "BMN-111", "1 mg / vial", 349, 349, 10, "99.89%", "", "compound"),
        P("TC1", "TransCon CNP", "1 mg / vial", 149, 149, 12, "", "", "compound"),
        P("CN1", "CNP", "1 mg / vial", 99, 99, 20, "98.0%", "", "compound"),
        P("TY25", "TYRA-300", "25 mg / vial", 299, 299, 10, "", "", "compound"),
        P("ER25", "Erdafitinib", "25 mg / vial", 99, 99, 30, "99.0%", "", "compound"),
        P("ER50", "Erdafitinib", "50 mg / vial", 169, 169, 18, "99.0%", "", "compound"),
        P("IN25", "Infigratinib", "25 mg / vial", 129, 129, 30, "99.0%", "", "compound"),
        P("IN50", "Infigratinib", "50 mg / vial", 199, 199, 18, "99.0%", "", "compound"),
        P("TQ25", "Truseltiq", "25 mg / vial", 129, 129, 20, "99.0%", "", "compound"),
        P("KY10", "KY19382", "10 mg / vial", 149, 149, 10, "", "", "compound"),
        P("RB5", "RBM-007", "5 mg / vial", 299, 299, 8, "", "", "compound"),
        P("UM10", "Umedaptanib pegol", "10 mg / vial", 299, 299, 8, "", "", "compound"),
        P("SR5", "SAR442501", "5 mg / vial", 149, 149, 8, "", "", "compound"),
        P("ME25", "Meclizine", "25 mg / vial", 24, 24, 60, "99.0%", "", "compound"),
        P("SG10", "SAG21k", "10 mg / vial", 149, 149, 10, "", "", "compound"),
        P("AB05", "Abaloparatide", "0.5 mg / vial", 189, 189, 20, "98.0%", "", "compound"),
        P("AB2", "Abaloparatide", "2 mg / vial", 549, 549, 10, "98.0%", "", "compound"),
        P("TP75", "Teriparatide", "0.75 mg / vial", 99, 99, 30, "98.0%", "", "compound"),
        P("TP3", "Teriparatide", "3 mg / vial", 349, 349, 12, "98.0%", "", "compound"),
        P("P134", "PTH 1-34", "1 mg / vial", 129, 129, 20, "98.0%", "", "compound"),
        P("P184", "PTH 1-84", "1 mg / vial", 299, 299, 8, "98.0%", "", "compound"),
        P("PTR1", "PTHrP", "1 mg / vial", 219, 219, 15, "98.0%", "", "compound"),
        P("OD25", "Odanacatib", "25 mg / vial", 129, 129, 25, "99.0%", "", "compound"),
        P("M082", "MK-0822", "25 mg / vial", 129, 129, 25, "99.0%", "", "compound"),
        P("BA25", "Balicatib", "25 mg / vial", 129, 129, 10, "", "", "compound"),
        P("ON25", "ONO-5334", "5 mg / vial", 199, 199, 6, "", "", "compound"),
        P("RE25", "Relacatib", "25 mg / vial", 129, 129, 6, "", "", "compound"),
        P("MV25", "MIV-711", "25 mg / vial", 129, 129, 18, "", "", "compound"),
        P("L235", "L-235", "25 mg / vial", 149, 149, 4, "", "", "compound"),
        P("L873", "L-873724", "25 mg / vial", 149, 149, 4, "", "", "compound"),
        P("RM1", "Romosozumab", "1 mg / vial", 69, 69, 10, "", "", "compound"),
        P("BL1", "Blosozumab", "1 mg / vial", 99, 99, 6, "", "", "compound"),
        P("ST1", "Setrusumab", "1 mg / vial", 99, 99, 6, "", "", "compound"),
        P("BS804", "BPS-804", "1 mg / vial", 99, 99, 6, "", "", "compound"),
        P("DN1", "Denosumab", "1 mg / vial", 69, 69, 20, "98.0%", "", "compound"),
        P("AL50", "Alendronate", "50 mg / vial", 34, 34, 60, "99.0%", "", "compound"),
        P("RS50", "Risedronate", "50 mg / vial", 34, 34, 60, "99.0%", "", "compound"),
        P("ZA10", "Zoledronic acid", "10 mg / vial", 79, 79, 30, "99.0%", "", "compound"),
        P("IBA50", "Ibandronate", "50 mg / vial", 39, 39, 45, "99.0%", "", "compound"),
        P("PM50", "Pamidronate", "50 mg / vial", 39, 39, 45, "99.0%", "", "compound"),
        P("ETD50", "Etidronate", "50 mg / vial", 34, 34, 45, "99.0%", "", "compound"),
        P("TL50", "Tiludronate", "50 mg / vial", 34, 34, 45, "99.0%", "", "compound"),
        P("CL50", "Clodronate", "50 mg / vial", 34, 34, 45, "99.0%", "", "compound"),
        P("LP25", "LP533401", "25 mg / vial", 149, 149, 12, "98.0%", "", "compound"),
        P("BM2", "rhBMP-2", "1 mg / vial", 149, 149, 8, "98.0%", "", "compound"),
        P("BM7", "BMP-7", "1 mg / vial", 149, 149, 8, "98.0%", "", "compound"),
        P("OP1", "OP-1", "1 mg / vial", 149, 149, 8, "98.0%", "", "compound"),
        P("AN30", "Anastrozole", "30 mg / vial", 44, 44, 60, "99.0%", "", "compound"),
        P("LZ30", "Letrozole", "30 mg / vial", 44, 44, 60, "99.0%", "", "compound"),
        P("EX30", "Exemestane", "30 mg / vial", 44, 44, 60, "99.0%", "", "compound"),
        P("HCG5", "HCG", "5000 IU / vial", 99, 99, 30, "99.0%", "", "compound"),
        P("TS10", "Testosterone", "10 mL / vial", 89, 89, 30, "99.0%", "", "compound"),
        P("DH100", "DHEA", "100 mg / vial", 29, 29, 60, "98.0%", "", "compound"),
        P("LV100", "Levothyroxine", "100 mcg / vial", 24, 24, 60, "99.0%", "", "compound"),
        P("C60A", "C60", "100 mg / vial", 69, 69, 30, "99.95%", "", "compound"),
        P("C60B", "C60", "500 mL / vial", 249, 249, 10, "99.95%", "", "compound"),
    ];
    const forCat = (c) => products.find((x) => x.cat === c) || {};

    return {
      products,
      discounts: [
        { id: "d-crypto", code: "", label: "Crypto payment", kind: "percent", value: 8, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 0, payMethod: "crypto", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier3", code: "", label: "Bundle tier, 3 compounds", kind: "percent", value: 15, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 3, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier5", code: "", label: "Bundle tier, 5 compounds", kind: "percent", value: 22, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 5, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
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
        storeName: "Morpheps",
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
          adminHandle: "@morpheps_support",
          greeting: "Support is on Telegram, usually replying within a few minutes during CET business hours.",
          pollSeconds: 5,
        },
        supabaseUrl: "https://nbpbnblpbeuuphqeehkd.supabase.co",
        supabaseAnonKey: "sb_publishable_UjIynmQJ9iea0S49P2kvCg_P5eXp3lD",
      },
      content: {
        qtyTiers: [
          { id: "qt1", label: "1 to 4 kits", minQty: 1, off: 0, live: true },
          { id: "qt2", label: "5 to 9 kits", minQty: 5, off: 12, live: true },
          { id: "qt3", label: "10+ kits", minQty: 10, off: 22, live: true },
        ],
        tierNote: "Bundle tiers on different compounds stack on top of these per-line rates.",
        doseUnits: [
          { id: "du1", unit: "mg/mL", label: "Injectable, mg per mL", example: "250 mg/mL", live: true },
          { id: "du2", unit: "mg/tablet", label: "Oral tablet", example: "10 mg/tablet", live: true },
          { id: "du3", unit: "mg/vial", label: "Injectable peptide", example: "5 mg/vial", live: true },
          { id: "du4", unit: "mcg/vial", label: "Injectable peptide, small dose", example: "500 mcg/vial", live: true },
          { id: "du5", unit: "mcg", label: "Small-dose peptide", example: "500 mcg", live: true },
          { id: "du6", unit: "IU/mL", label: "Insulin-like", example: "100 IU/mL", live: true },
          { id: "du7", unit: "IU/vial", label: "hCG and growth hormone", example: "5,000 IU/vial", live: true },
          { id: "du8", unit: "mg/g", label: "Topical compound", example: "5 mg/g", live: true },
          { id: "du9", unit: "mg/capsule", label: "Capsule", example: "20 mg/capsule", live: true },
        ],
        categories: [
          { id: "cat-compound", slug: "compound", label: "Single compounds", blurb: "One peptide per vial, lyophilised.", live: true },
          { id: "cat-blend", slug: "blend", label: "Blends", blurb: "Two compounds pre-mixed in one vial.", live: true },
          { id: "cat-accessory", slug: "accessory", label: "Accessories", blurb: "Water, syringes and consumables.", live: true },
        ],
        featured: [],
        lineup: [],
        hero: [
          { id: "h1", eyebrow: "New lot released", title: "Every lot is tested before it ships", body: "Each vial carries its lot number and a third-party assay you can read before you open the box.", cta: "Shop the catalogue", ctaHref: "Shop.dc.html", cta2: "View lab tests", cta2Href: "Lab-Tests.dc.html", live: true, images: [] },
          { id: "h2", eyebrow: "Bundles", title: "Order three compounds, pay less per kit", body: "The tier discount applies to the whole order. No codes and no minimum order value.", cta: "Configure a bundle", ctaHref: "Bundles.dc.html", cta2: "See pricelist", cta2Href: "Pricelist.dc.html", live: true, images: [] },
          { id: "h3", eyebrow: "Cold chain", title: "Cold chain, plain packaging", body: "Insulated packing with a temperature log from our facility to your door. Card, transfer or crypto at checkout.", cta: "How shipping works", ctaHref: "Help-Center.dc.html", cta2: "Track an order", cta2Href: "Order.dc.html", live: true, images: [] },
        ],
        blocks: [
          { id: "b1", label: "Voting offsale block", images: [], title: "You decide what goes half price", body: "One compound drops to half price each cycle. Vote from the shortlist below; the winner is live for everyone on Monday.", cta: "Get 50% off", cta2: "Vote now", note: "", images: [] },
          { id: "b2", label: "How to get discounts block", images: [], title: "How to get discounts", body: "Three discounts, and they stack. None of them need a code, the checkout price already includes everything you qualify for.", cta: "See all promotions", cta2: "", note: "01 crypto −8%, 02 bundle tiers, 03 verified result credit", images: [] },
          { id: "b3", label: "Customer results block", images: [], title: "Customer results, with lot numbers", body: "Every submission carries a date, a lot number and the protocol used. Filter by compound to read the relevant ones.", cta: "Browse results", cta2: "", note: "", images: [] },
          { id: "b4", label: "Join the community block", images: [], title: "Restocks, lab reports, the weekly vote", body: "One message a week: new assays as they land, the shortlist before it opens, and member pricing on blends.", cta: "Subscribe", cta2: "", note: "Telegram & Discord", images: [] },
        ],
        promos: [
          { id: "pr1", tag: "Headline offer", images: [], title: "Half price on the compound you vote for", body: "One compound drops to 50% for everyone each cycle, and the community picks which. Open the cycle from the admin to put the shortlist live.", cta: "Get 50% off", href: "Promotions.dc.html", live: false, images: [] },
          { id: "pr2", tag: "Always on", images: [], title: "8% off when you pay in crypto", body: "Applied automatically at checkout on ETH and USDT, on every chain we accept. Stacks with everything else on this page.", cta: "Payment methods", href: "Help-Center.dc.html", live: true, images: [] },
          { id: "pr3", tag: "New customers", images: [], title: "Free consumables on a first order", body: "Bacteriostatic water and a syringe set added to any order over $120. No code needed.", cta: "Start shopping", href: "Shop.dc.html", live: true, images: [] },
        ],
        bundles: [],
        faqs: [
          { id: "f1", q: "How is the order packed?", a: "Vials go into an insulated sleeve with a frozen gel pack, inside a plain outer box with no branding and no laboratory markings.", live: true },
          { id: "f2", q: "Which payment methods are accepted?", a: "ETH and USDT, on Ethereum, Arbitrum, Base, Optimism or Polygon. Every order takes 8% off the total automatically.", live: true },
          { id: "f3", q: "How should the vials be stored?", a: "Lyophilised vials keep at −20 °C, protected from light. Once reconstituted, refrigerate and use within the stated window.", live: true },
          { id: "f4", q: "How long does delivery take?", a: "Dispatch is same day before 14:00 CET. Two to four days inside the EU, four to seven days worldwide.", live: true },
        ],
        footer: {
          blurb: "Peptide compounds with per-lot third-party assays. Shipped cold, packed discreet, priced without coupon games.",
          newsletterTitle: "Restocks and lab reports, weekly",
          newsletterNote: "One message a week: restocks, new lab reports, and the offsale shortlist before it opens.",
          legal: "\u00a9 2026 Morpheps. All rights reserved.",
          payments: "ETH, USDT",
        },
        footerLinks: [
          { id: "fl1", column: "Shop", label: "All compounds", href: "Shop.dc.html" },
          { id: "fl2", column: "Shop", label: "Bundles", href: "Bundles.dc.html" },
          { id: "fl3", column: "Shop", label: "Pricelist", href: "Pricelist.dc.html" },
          { id: "fl4", column: "Shop", label: "Promotions", href: "Promotions.dc.html" },
          { id: "fl5", column: "Trust", label: "Lab tests", href: "Lab-Tests.dc.html" },
          { id: "fl7", column: "Trust", label: "Reviews", href: "Reviews.dc.html" },
          { id: "fl8", column: "Support", label: "Help Center", href: "Help-Center.dc.html" },
          { id: "fl9", column: "Support", label: "Track an order", href: "Order.dc.html" },
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
          { id: "n1", label: "Home", href: "Morpheps.dc.html" },
          { id: "n2", label: "Shop", href: "Shop.dc.html" },
          { id: "n3", label: "Pricelist", href: "Pricelist.dc.html" },
          { id: "n4", label: "Bundles", href: "Bundles.dc.html" },
          { id: "n5", label: "Promotions", href: "Promotions.dc.html" },
          { id: "n6", label: "Help Center", href: "Help-Center.dc.html" },
          { id: "n8", label: "Lab tests", href: "Lab-Tests.dc.html" },
          { id: "n9", label: "Reviews", href: "Reviews.dc.html" },
          { id: "n10", label: "Track order", href: "Order.dc.html" },
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
          { id: "g2", name: "Français", code: "FR" },
          { id: "g3", name: "Deutsch", code: "DE" },
          { id: "g4", name: "Español", code: "ES" },
          { id: "g5", name: "Italiano", code: "IT" },
        ],
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
      const tables = { products: "products", discounts: "discounts", orders: "orders", customers: "customers", labReports: "lab_reports", reviews: "reviews" };
      const contentTables = {
        categories: "categories", qtyTiers: "qty_tiers", doseUnits: "dose_units",
        bundles: "bundles", promos: "promotions", faqs: "help_articles",
        hero: "home_hero", blocks: "home_blocks", marquee: "home_marquee",
        nav: "nav_items", strip: "top_strip", languages: "locales",
        footerLinks: "footer_links", legalLinks: "legal_links",
      };
      for (const [key, table] of Object.entries(contentTables)) {
        const { data, error } = await c.from(table).select("*");
        if (!error && data && data.length) this.data.content[key] = data;
      }
      for (const [key, table] of Object.entries(tables)) {
        const { data, error } = await c.from(table).select("*");
        if (!error && data) this.data[key] = data;
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
      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ products: this.data.products, discounts: this.data.discounts }),
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
        const db = window.Morpheps;
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
        const db = window.Morpheps;
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
        const db = window.Morpheps;
        const c = db.connect();
        if (c) await c.auth.signOut();
        localStorage.removeItem(db.KEY + ":session");
        db.notify();
      },
      async resetPassword(email) {
        const db = window.Morpheps;
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
        const db = window.Morpheps;
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
        const db = window.Morpheps;
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
      return this.data.content.footer || {};
    },
    footerColumns() {
      const rows = (this.data.content.footerLinks || []).filter((r) => r.label);
      const order = [];
      const byCol = {};
      rows.forEach((r) => {
        const col = r.column || "More";
        if (!byCol[col]) { byCol[col] = []; order.push(col); }
        byCol[col].push({ label: r.label, href: r.href || "#" });
      });
      return order.map((title) => ({ title, items: byCol[title] }));
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
      if (p.stock <= 0) return { label: "Out of stock", tone: "out" };
      if (p.stock <= (p.lowStockAt || 10)) return { label: "Low stock, " + p.stock + " left", tone: "low" };
      return { label: "In stock, " + p.stock, tone: "ok" };
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
        if (d.kind === "percent") {
          const amt = Math.round(base * (Number(d.value) / 100) * 100) / 100;
          orderOff += amt;
          applied.push({ id: d.id, label: d.label, value: amt, kind: "percent" });
        } else if (d.kind === "fixed") {
          const amt = Math.min(Number(d.value), base, subtotal - orderOff);
          orderOff += amt;
          applied.push({ id: d.id, label: d.label, value: amt, kind: "fixed" });
        } else if (d.kind === "shipping") {
          freeShip = true;
          applied.push({ id: d.id, label: d.label, value: shipping, kind: "shipping" });
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
          return { need: upcoming.minDistinct - distinct, value: upcoming.value, label: upcoming.label };
        })(),
      };
    },

    /* ---- Orders --------------------------------------------------------- */
    statuses: ["Awaiting", "Paid", "Packed", "Shipped", "Refunded"],
    placeOrder(info) {
      const pr = this.pricing();
      const id = "MP-" + (24119 + this.data.orders.length);
      const order = {
        id, email: info.email || "guest@morpheps.store", status: "Awaiting",
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

  window.Morpheps = db;
  window.Aptera = db;

  // Each .dc.html page is a fresh full page load, not a SPA — connect() must
  // run on every load (not just when an action happens to need it) so the
  // Supabase session in localStorage gets restored into authUser here.
  // Without this, a page reached by plain navigation (not through an action
  // that calls connect() itself, like signIn()) sees authUser as null even
  // though a valid session already exists.
  if (db.supabaseConfigured) db.connect();
})();
