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
  const KEY = "morpheps-store-v8";
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

    const P = (cat, name, dose, price, list, stock, purity, lot, category, live) => ({
      id: cat.toLowerCase(), cat, name, dose, category, price, list: price, stock: 40,
      ...splitDose(dose),
      lowStockAt: 10, purity, lot: lotFor(), live: live !== false, images: [], sort: 0,
      body: "Supplied as a kit of 10 vials. Lyophilised powder, sealed under nitrogen. Reconstitute with bacteriostatic water and store at 2 to 8 °C once opened.",
    });
    const products = [
        P("TR5", "Tirzepatide", "5 mg / vial", 84, 84, 80, "99.0%", "26-0811", "compound"),
        P("TR10", "Tirzepatide", "10 mg / vial", 119, 149, 34, "98.4%", "26-0814", "compound"),
        P("TR15", "Tirzepatide", "15 mg / vial", 144, 144, 0, "98.5%", "26-0719", "compound"),
        P("TR20", "Tirzepatide", "20 mg / vial", 169, 169, 65, "98.8%", "26-0811", "compound"),
        P("TR30", "Tirzepatide", "30 mg / vial", 214, 214, 6, "99.2%", "26-0806", "compound"),
        P("TR40", "Tirzepatide", "40 mg / vial", 264, 264, 37, "98.5%", "26-0802", "compound"),
        P("TR50", "Tirzepatide", "50 mg / vial", 309, 309, 0, "98.9%", "26-0722", "compound"),
        P("TR60", "Tirzepatide", "60 mg / vial", 359, 359, 9, "99.2%", "26-0719", "compound"),
        P("TR100", "Tirzepatide", "100 mg / vial", 549, 549, 82, "99.4%", "26-0802", "compound"),
        P("LT2", "Semaglutide", "2 mg / vial", 59, 59, 11, "99.3%", "26-0715", "compound"),
        P("LT5", "Semaglutide", "5 mg / vial", 84, 84, 14, "99.3%", "26-0704", "compound"),
        P("LT10", "Semaglutide", "10 mg / vial", 119, 119, 0, "99.0%", "26-0708", "compound"),
        P("LT15", "Semaglutide", "15 mg / vial", 144, 144, 63, "99.1%", "26-0605", "compound"),
        P("LT20", "Semaglutide", "20 mg / vial", 169, 169, 89, "99.4%", "26-0704", "compound"),
        P("LT30", "Semaglutide", "30 mg / vial", 214, 214, 30, "98.7%", "26-0701", "compound"),
        P("RT5", "Retatrutide", "5 mg / vial", 129, 129, 0, "98.8%", "26-0811", "compound"),
        P("RT10", "Retatrutide", "10 mg / vial", 189, 229, 64, "99.3%", "26-0814", "compound"),
        P("RT15", "Retatrutide", "15 mg / vial", 239, 239, 69, "99.3%", "26-0719", "compound"),
        P("RT20", "Retatrutide", "20 mg / vial", 289, 289, 5, "98.5%", "26-0811", "compound"),
        P("RT30", "Retatrutide", "30 mg / vial", 384, 384, 0, "98.9%", "26-0806", "compound"),
        P("RT40", "Retatrutide", "40 mg / vial", 479, 479, 67, "99.3%", "26-0802", "compound"),
        P("RT50", "Retatrutide", "50 mg / vial", 574, 574, 8, "98.6%", "26-0722", "compound"),
        P("RT60", "Retatrutide", "60 mg / vial", 669, 669, 39, "99.0%", "26-0719", "compound"),
        P("RT100", "Retatrutide", "100 mg / vial", 1009, 1009, 22, "99.4%", "26-0802", "compound"),
        P("TMB5", "TB-500 (TB4)", "5 mg / vial", 154, 154, 81, "98.9%", "26-0806", "compound"),
        P("TMB10", "TB-500 (TB4)", "10 mg / vial", 289, 289, 65, "98.7%", "26-0811", "compound"),
        P("TMB20", "TB-500 (TB4)", "20 mg / vial", 479, 479, 6, "99.1%", "26-0806", "compound"),
        P("B10F", "TB-500 FRAG", "10 mg / vial", 214, 214, 64, "99.4%", "26-0814", "compound"),
        P("BP5", "BPC 157", "5 mg / vial", 84, 84, 90, "98.7%", "26-0701", "compound"),
        P("BP10", "BPC 157", "10 mg / vial", 129, 174, 74, "99.0%", "26-0704", "compound"),
        P("BP20", "BPC 157", "20 mg / vial", 229, 229, 15, "99.4%", "26-0701", "compound"),
        P("2AD", "AOD9604", "2 mg / vial", 109, 109, 14, "98.8%", "26-0704", "compound"),
        P("5AD", "AOD9604", "5 mg / vial", 214, 214, 17, "98.6%", "26-0619", "compound"),
        P("10AD", "AOD9604", "10 mg / vial", 359, 359, 61, "99.4%", "26-0627", "compound"),
        P("CDD5", "CJC-1295 without DAC", "5 mg / vial", 169, 169, 27, "99.3%", "26-0711", "compound"),
        P("CDD10", "CJC-1295 without DAC", "10 mg / vial", 274, 274, 11, "99.3%", "26-0715", "compound"),
        P("DC2", "CJC-1295 with DAC", "2 mg / vial", 169, 169, 76, "98.9%", "26-0627", "compound"),
        P("DC5", "CJC-1295 with DAC", "5 mg / vial", 309, 309, 79, "98.9%", "26-0814", "compound"),
        P("DC10", "CJC-1295 with DAC", "10 mg / vial", 574, 574, 93, "99.1%", "26-0605", "compound"),
        P("CGL5", "Cagrilintide", "5 mg / vial", 169, 199, 8, "98.8%", "26-0722", "compound"),
        P("CGL10", "Cagrilintide", "10 mg / vial", 289, 289, 52, "99.3%", "26-0802", "compound"),
        P("CGL20", "Cagrilintide", "20 mg / vial", 529, 529, 83, "98.5%", "26-0722", "compound"),
        P("CBL60", "Cerebrolysin", "60 mg / vial", 119, 119, 22, "99.4%", "26-0802", "compound"),
        P("DS5", "DSIP", "5 mg / vial", 94, 94, 35, "98.5%", "26-0811", "compound"),
        P("DS10", "DSIP", "10 mg / vial", 144, 144, 79, "98.8%", "26-0814", "compound"),
        P("DS15", "DSIP", "15 mg / vial", 189, 189, 84, "98.9%", "26-0719", "compound"),
        P("DR5", "Dermorphin", "5 mg / vial", 129, 129, 4, "99.3%", "26-0814", "compound"),
        P("NET5", "N-Acetyl Epitalon Amidate", "5 mg / vial", 109, 109, 55, "98.6%", "26-0718", "compound"),
        P("NET10", "N-Acetyl Epitalon Amidate", "10 mg / vial", 189, 189, 69, "98.6%", "26-0719", "compound"),
        P("ET10", "Epithalon", "10 mg / vial", 94, 94, 0, "99.3%", "26-0806", "compound"),
        P("ET40", "Epithalon", "40 mg / vial", 324, 324, 54, "99.4%", "26-0719", "compound"),
        P("ET50", "Epithalon", "50 mg / vial", 359, 359, 85, "98.7%", "26-0718", "compound"),
        P("F410", "FOXO4", "10 mg / vial", 754, 754, 80, "99.4%", "26-0811", "compound"),
        P("AU100", "AHK-CU", "100 mg / vial", 154, 154, 36, "99.4%", "26-0806", "compound"),
        P("GH50", "GHK Basic", "50 mg / vial", 84, 84, 0, "98.7%", "26-0701", "compound"),
        P("CU50", "GHK-CU", "50 mg / vial", 69, 69, 54, "98.5%", "26-0719", "compound"),
        P("CU100", "GHK-CU", "100 mg / vial", 109, 109, 8, "98.5%", "26-0722", "compound"),
        P("G25", "GHRP-2 Acetate", "5 mg / vial", 69, 69, 5, "98.7%", "26-0811", "compound"),
        P("G210", "GHRP-2 Acetate", "10 mg / vial", 119, 119, 0, "99.1%", "26-0814", "compound"),
        P("G65", "GHRP-6 Acetate", "5 mg / vial", 69, 69, 0, "99.1%", "26-0719", "compound"),
        P("G610", "GHRP-6 Acetate", "10 mg / vial", 119, 119, 23, "98.7%", "26-0722", "compound"),
        P("GTT", "Glutathione", "1500 mg / vial", 214, 214, 10, "99.1%", "26-0718", "compound"),
        P("GND2", "Gonadorelin", "2 mg / vial", 84, 84, 8, "98.5%", "26-0722", "compound"),
        P("HU10", "Humanin", "10 mg / vial", 429, 429, 25, "98.8%", "26-0718", "compound"),
        P("HX2", "Hexarelin", "2 mg / vial", 84, 84, 71, "99.0%", "26-0715", "compound"),
        P("HX5", "Hexarelin", "5 mg / vial", 179, 179, 74, "99.0%", "26-0704", "compound"),
        P("FR2", "HGH Fragment 176-191", "2 mg / vial", 109, 109, 33, "99.0%", "26-0605", "compound"),
        P("FR5", "HGH Fragment 176-191", "5 mg / vial", 204, 204, 36, "99.1%", "26-0806", "compound"),
        P("HA5", "Hyaluronic acid", "5 mg / vial", 69, 69, 0, "98.9%", "26-0806", "compound"),
        P("PR2", "Ipamorelin", "2 mg / vial", 69, 69, 13, "99.3%", "26-0708", "compound"),
        P("PR5", "Ipamorelin", "5 mg / vial", 84, 84, 16, "99.3%", "26-0627", "compound"),
        P("PR10", "Ipamorelin", "10 mg / vial", 144, 144, 30, "99.4%", "26-0701", "compound"),
        P("IG01", "IGF-1 LR3", "0.1 mg / vial", 94, 94, 42, "99.1%", "26-0711", "compound"),
        P("IG1", "IGF-1 LR3", "1 mg / vial", 429, 429, 54, "98.9%", "26-0719", "compound"),
        P("KS5", "KissPeptin-10", "5 mg / vial", 109, 109, 12, "99.0%", "26-0711", "compound"),
        P("KS10", "KissPeptin-10", "10 mg / vial", 169, 169, 86, "98.5%", "26-0715", "compound"),
        P("KP5", "KPV", "5 mg / vial", 94, 94, 9, "99.0%", "26-0719", "compound"),
        P("KP10", "KPV", "10 mg / vial", 129, 129, 0, "98.8%", "26-0722", "compound"),
        P("KP30", "KPV", "30 mg / vial", 359, 359, 55, "98.5%", "26-0718", "compound"),
        P("375", "LL-37", "5 mg / vial", 214, 214, 20, "99.1%", "26-0811", "compound"),
        P("LL5", "Liraglutide", "5 mg / vial", 189, 189, 36, "98.4%", "26-0806", "compound"),
        P("LL10", "Liraglutide", "10 mg / vial", 264, 264, 20, "98.6%", "26-0811", "compound"),
        P("LL30", "Liraglutide", "30 mg / vial", 409, 409, 82, "99.4%", "26-0802", "compound"),
        P("MT1", "MT-1", "10 mg / vial", 109, 109, 0, "99.2%", "26-0715", "compound"),
        P("ML10", "MT-2", "10 mg / vial", 109, 109, 21, "99.2%", "26-0806", "compound"),
        P("MS10", "MOTS-C", "10 mg / vial", 129, 129, 88, "98.6%", "26-0708", "compound"),
        P("MS40", "MOTS-C", "40 mg / vial", 409, 409, 91, "98.7%", "26-0627", "compound"),
        P("FM2", "MGF", "2 mg / vial", 109, 109, 58, "99.3%", "26-0708", "compound"),
        P("FMP2", "PEG-MGF", "2 mg / vial", 179, 179, 48, "99.4%", "26-0605", "compound"),
        P("MDT5", "Mazdutide", "5 mg / vial", 264, 264, 0, "99.2%", "26-0722", "compound"),
        P("MDT10", "Mazdutide", "10 mg / vial", 444, 444, 37, "98.5%", "26-0802", "compound"),
        P("MA10", "Matrixyl", "10 mg / vial", 84, 84, 70, "99.1%", "26-0718", "compound"),
        P("NJ3100", "NAD+", "100 mg / vial", 84, 84, 43, "98.4%", "26-0708", "compound"),
        P("NJ250", "NAD+", "250 mg / vial", 119, 144, 14, "98.4%", "26-0704", "compound"),
        P("NJ500", "NAD+", "500 mg / vial", 169, 169, 42, "98.4%", "26-0711", "compound"),
        P("NJ1000", "NAD+", "1000 mg / vial", 289, 289, 70, "98.4%", "26-0718", "compound"),
        P("OT2", "Oxytocin Acetate", "2 mg / vial", 84, 84, 14, "99.0%", "26-0704", "compound"),
        P("OT5", "Oxytocin Acetate", "5 mg / vial", 109, 109, 17, "99.1%", "26-0619", "compound"),
        P("OT10", "Oxytocin Acetate", "10 mg / vial", 144, 144, 61, "98.6%", "26-0627", "compound"),
        P("PTD5", "PTD-DBM", "5 mg / vial", 469, 469, 26, "98.9%", "26-0715", "compound"),
        P("P210", "P21", "10 mg / vial", 129, 129, 58, "98.9%", "26-0708", "compound"),
        P("PP10", "P21-adamantane", "10 mg / vial", 709, 709, 88, "98.4%", "26-0708", "compound"),
        P("PE10", "PE 22-28", "10 mg / vial", 129, 129, 47, "99.4%", "26-0619", "compound"),
        P("P41", "PT-141", "10 mg / vial", 119, 119, 72, "98.6%", "26-0711", "compound"),
        P("PIN5", "Pinealon", "5 mg / vial", 94, 94, 25, "99.3%", "26-0718", "compound"),
        P("PIN10", "Pinealon", "10 mg / vial", 144, 144, 39, "99.4%", "26-0719", "compound"),
        P("PIN20", "Pinealon", "20 mg / vial", 214, 214, 70, "98.7%", "26-0718", "compound"),
        P("PN5", "PNC 27", "5 mg / vial", 204, 204, 72, "98.9%", "26-0711", "compound"),
        P("PN10", "PNC 27", "10 mg / vial", 359, 359, 56, "98.6%", "26-0715", "compound"),
        P("SUR10", "Survodutide", "10 mg / vial", 504, 504, 28, "99.2%", "26-0708", "compound"),
        P("NP810", "SNAP-8", "10 mg / vial", 94, 94, 0, "98.7%", "26-0802", "compound"),
        P("2S10", "SS-31", "10 mg / vial", 189, 189, 61, "99.2%", "26-0627", "compound"),
        P("2S50", "SS-31", "50 mg / vial", 744, 744, 5, "98.6%", "26-0811", "compound"),
        P("SK5", "Selank", "5 mg / vial", 84, 84, 72, "98.5%", "26-0711", "compound"),
        P("SK10", "Selank", "10 mg / vial", 129, 164, 56, "98.4%", "26-0715", "compound"),
        P("SK30", "Selank", "30 mg / vial", 289, 289, 28, "99.2%", "26-0708", "compound"),
        P("NSK30", "NA Selank amidate", "30 mg / vial", 309, 309, 46, "98.5%", "26-0627", "compound"),
        P("XA5", "Semax", "5 mg / vial", 84, 84, 67, "98.6%", "26-0802", "compound"),
        P("XA10", "Semax", "10 mg / vial", 129, 129, 81, "98.9%", "26-0806", "compound"),
        P("XA30", "Semax", "30 mg / vial", 289, 289, 53, "98.6%", "26-0722", "compound"),
        P("NXA30", "NA Semax amidate", "30 mg / vial", 309, 309, 71, "99.0%", "26-0715", "compound"),
        P("RL5", "Sermorelin Acetate", "5 mg / vial", 154, 154, 42, "99.0%", "26-0711", "compound"),
        P("RL10", "Sermorelin Acetate", "10 mg / vial", 264, 264, 26, "98.9%", "26-0715", "compound"),
        P("RL15", "Sermorelin Acetate", "15 mg / vial", 419, 419, 31, "98.9%", "26-0627", "compound"),
        P("TMR2", "Tesamorelin", "2 mg / vial", 119, 119, 34, "98.5%", "26-0814", "compound"),
        P("TMR5", "Tesamorelin", "5 mg / vial", 189, 229, 37, "98.5%", "26-0802", "compound"),
        P("TMR10", "Tesamorelin", "10 mg / vial", 334, 334, 51, "98.4%", "26-0806", "compound"),
        P("TMR20", "Tesamorelin", "20 mg / vial", 624, 624, 82, "98.8%", "26-0802", "compound"),
        P("TY10", "Thymalin", "10 mg / vial", 129, 129, 11, "98.9%", "26-0715", "compound"),
        P("TA5", "Thymosin Alpha-1", "5 mg / vial", 179, 179, 93, "99.0%", "26-0605", "compound"),
        P("TA10", "Thymosin Alpha-1", "10 mg / vial", 309, 309, 77, "98.8%", "26-0619", "compound"),
        P("VP5", "VIP", "5 mg / vial", 189, 189, 50, "99.1%", "26-0811", "compound"),
        P("VP10", "VIP", "10 mg / vial", 334, 334, 4, "98.7%", "26-0814", "compound"),
        P("5AM", "5-amino-1MQ", "5 mg / vial", 84, 109, 0, "98.7%", "26-0715", "compound"),
        P("10AM", "5-amino-1MQ", "10 mg / vial", 129, 129, 70, "98.4%", "26-0718", "compound"),
        P("50AM", "5-amino-1MQ", "50 mg / vial", 179, 179, 0, "98.5%", "26-0704", "compound"),
        P("ADA5", "Adamax", "5 mg / vial", 264, 264, 22, "99.1%", "26-0802", "compound"),
        P("AR50", "Aicar", "50 mg / vial", 154, 154, 49, "98.7%", "26-0814", "compound"),
        P("AR100", "Aicar", "100 mg / vial", 214, 214, 33, "98.8%", "26-0605", "compound"),
        P("AE1", "ACE-031", "1 mg / vial", 189, 189, 44, "98.8%", "26-0704", "compound"),
        P("AP2", "Adipotide", "2 mg / vial", 154, 154, 0, "98.7%", "26-0715", "compound"),
        P("AP5", "Adipotide", "5 mg / vial", 334, 334, 29, "98.7%", "26-0704", "compound"),
        P("RA10", "ARA-290", "10 mg / vial", 129, 129, 75, "98.7%", "26-0701", "compound"),
        P("BR20", "Bronchogen", "20 mg / vial", 239, 239, 47, "99.2%", "26-0619", "compound"),
        P("CA20", "Cardiogen", "20 mg / vial", 239, 239, 91, "99.1%", "26-0627", "compound"),
        P("COR20", "Cortagen", "20 mg / vial", 239, 239, 7, "99.4%", "26-0802", "compound"),
        P("CH20", "Chonluten", "20 mg / vial", 239, 239, 68, "98.5%", "26-0722", "compound"),
        P("CRY20", "Crystagen", "20 mg / vial", 239, 239, 77, "98.4%", "26-0619", "compound"),
        P("LAX20", "Cartalax", "20 mg / vial", 239, 239, 8, "98.4%", "26-0722", "compound"),
        P("Li20", "Livagen", "20 mg / vial", 239, 239, 20, "98.7%", "26-0811", "compound"),
        P("OV20", "Ovagen", "20 mg / vial", 239, 239, 34, "98.8%", "26-0814", "compound"),
        P("PA20", "Pancragen", "20 mg / vial", 239, 239, 14, "99.0%", "26-0704", "compound"),
        P("MAX20", "Prostamax", "20 mg / vial", 239, 239, 39, "99.0%", "26-0719", "compound"),
        P("VE20", "Vesugen", "20 mg / vial", 239, 239, 84, "98.9%", "26-0719", "compound"),
        P("VI20", "Vilon", "20 mg / vial", 239, 239, 58, "98.6%", "26-0708", "compound"),
        P("TG20", "Testagen", "20 mg / vial", 239, 239, 24, "98.7%", "26-0719", "compound"),
        P("TER10", "Teriparatide", "10 mg / vial", 429, 429, 43, "99.2%", "26-0708", "compound"),
        P("B76", "B7-33", "6 mg / vial", 429, 429, 36, "98.9%", "26-0806", "compound"),
        P("TPR2", "Triptorelin", "2 mg / vial", 94, 94, 37, "99.3%", "26-0802", "compound"),
        P("PPB10", "BPC157 5mg + TB500 5mg", "10 mg / vial", 214, 269, 13, "99.2%", "26-0814", "blend"),
        P("PPB20", "BPC157 10mg + TB500 10mg", "20 mg / vial", 359, 359, 4, "98.8%", "26-0811", "blend"),
        P("BBK30", "BPC157 10mg + TB500 10mg + KPV 10mg", "30 mg / vial", 429, 429, 36, "98.2%", "26-0619", "blend"),
        P("BBG50", "GLOW, GHK-CU 35mg + TB500 10mg + BPC157 5mg", "50 mg / vial", 359, 359, 14, "98.4%", "26-0701", "blend"),
        P("BBG70", "GLOW, GHK-CU 50mg + TB500 10mg + BPC157 10mg", "70 mg / vial", 409, 409, 36, "98.8%", "26-0619", "blend"),
        P("KL80", "KLOW, GHK-CU 50mg + TB500 10mg + BPC157 10mg + KPV 10mg", "80 mg / vial", 454, 454, 0, "98.6%", "26-0715", "blend"),
        P("KG60", "GHK-CU 50mg + KPV 10mg", "60 mg / vial", 189, 189, 8, "99.3%", "26-0814", "blend"),
        P("Ti17", "Tesamorelin 11mg + Ipamorelin 6mg", "17 mg / vial", 409, 409, 13, "98.6%", "26-0814", "blend"),
        P("CS10", "Cagrilintide 5mg + Semaglutide 5mg", "10 mg / vial", 264, 314, 17, "99.1%", "26-0605", "blend"),
        P("RC10", "Retatrutide 5mg + Cagrilintide 5mg", "10 mg / vial", 334, 334, 26, "98.3%", "26-0619", "blend"),
        P("XS20", "Selank 10mg + Semax 10mg", "20 mg / vial", 214, 214, 0, "98.2%", "26-0718", "blend"),
        P("NM120", "NAD+ 100mg + MOTS-C 10mg + 5-amino-1MQ 10mg", "120 mg / vial", 334, 334, 12, "98.4%", "26-0708", "blend"),
        P("CPP10", "CJC-1295 no DAC 5mg + Ipamorelin 5mg", "10 mg / vial", 214, 214, 14, "99.2%", "26-0811", "blend"),
        P("CPP20", "CJC-1295 no DAC 10mg + Ipamorelin 10mg", "20 mg / vial", 384, 384, 5, "98.8%", "26-0806", "blend"),
        P("BA10", "Bacteriostatic water 10 ml", "10 mL / vial", 24, 24, 240, "", "", "accessory"),
        P("BA03", "Bacteriostatic water 3 ml", "3 mL / vial", 24, 24, 300, "", "", "accessory"),
        P("AA10", "Acetic acid water 10 ml", "10 mL / vial", 24, 24, 160, "", "", "accessory"),
        P("AC-SYR", "Insulin syringe set ×20", "0.5 mL / vial", 34, 34, 180, "", "", "accessory"),
    ];
    const forCat = (c) => products.find((x) => x.cat === c) || {};

    return {
      products,
      discounts: [
        { id: "d-crypto", code: "", label: "Crypto payment", kind: "percent", value: 8, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 0, payMethod: "crypto", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier3", code: "", label: "Bundle tier, 3 compounds", kind: "percent", value: 15, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 3, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-tier5", code: "", label: "Bundle tier, 5 compounds", kind: "percent", value: 22, scope: "order", scopeValue: "", minSubtotal: 0, minDistinct: 5, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-ship", code: "", label: "Free cold chain over $250", kind: "shipping", value: 100, scope: "order", scopeValue: "", minSubtotal: 250, minDistinct: 0, payMethod: "", stackable: true, auto: true, uses: 0, maxUses: null, startsAt: "", endsAt: "", live: true },
        { id: "d-vote", code: "", label: "Offsale winner, TR5 half price", kind: "percent", value: 50, scope: "product", scopeValue: "TR5", minSubtotal: 0, minDistinct: 0, payMethod: "", stackable: false, auto: true, uses: 0, maxUses: null, startsAt: today(), endsAt: "", live: false },
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
        options: [
          { cat: "TR5", count: 0 },
          { cat: "BP5", count: 0 },
          { cat: "PPB10", count: 0 },
          { cat: "RT5", count: 0 },
        ],
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
        featured: ["TR5", "BP5", "RT5", "PPB10"],
        lineup: ["LT5", "TMB5", "ET10", "CS10", "CGL5"],
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
        bundles: [
          { id: "bu1", name: "Starter set", images: [], save: "−18%", price: 299, was: 369, body: "Three kits for a first pass, with bacteriostatic water included.", contents: "BP5, LT2, BA10", live: true },
          { id: "bu2", name: "Standard set", images: [], save: "−24%", price: 594, was: 779, body: "The most ordered combination. Four kits across two compound families plus consumables.", contents: "TR5, BP5, PPB10, BA10", live: true },
          { id: "bu3", name: "Full protocol", images: [], save: "−29%", price: 989, was: 1389, body: "Six kits, full consumable set and priority dispatch on every restock.", contents: "TR10, BP10, CGL5, CS10, SK10, AC-SYR", live: true },
        ],
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
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return { lines: [{ cat: "TR5", qty: 2 }, { cat: "BP5", qty: 1 }, { cat: "PPB10", qty: 1 }], code: "", payMethod: "crypto", wishlist: ["RT5"] };
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
            options: { data: { name: fields.name || "", country: fields.country || "" } },
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
          const { error } = await c.auth.resetPasswordForEmail(String(email).trim());
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
