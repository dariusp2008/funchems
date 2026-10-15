create table customers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null, name text, country text,
  orders_count int default 0, spent numeric default 0,
  credit numeric default 0, tier text default 'standard',
  flagged bool default false, created_at timestamptz default now()
);
create table products (
  id uuid primary key default gen_random_uuid(),
  cat text unique not null, name text not null, dose text,
  category text default 'compound',      -- compound | blend | accessory
  price numeric not null, list_price numeric,
  stock int default 0, low_stock_at int default 10,
  purity text, lot text, live bool default false,
  sort int default 0, images jsonb default '[]',
  body text, created_at timestamptz default now()
);
create table discounts (
  id text primary key,
  code text unique,                      -- null = automatic rule
  label text not null,
  kind text not null,                    -- percent | fixed | shipping | bogo
  value numeric default 0,
  scope text default 'order',            -- order | product | category | bundle
  scope_value text,
  min_subtotal numeric default 0,
  min_distinct int default 0,
  pay_method text,                       -- crypto | card | null (any)
  stackable bool default true,
  auto bool default false,               -- applied without a code
  uses int default 0, max_uses int,
  starts_at date, ends_at date,
  live bool default true
);
create table orders (
  id text primary key, customer_id uuid references customers(id),
  email text, status text default 'awaiting',
  pay_method text, subtotal numeric, discount numeric,
  shipping numeric, total numeric,
  lines jsonb default '[]', tracking text, note text,
  country text, created_at timestamptz default now()
);
-- id is text, not uuid: the dashboard generates its own client-side ids
-- (see uid() in store-data.js) and upserts on them directly.
create table lab_reports (
  id text primary key,
  lot text not null, product_cat text, method text,
  purity text, reported_on date, file_url text, file_name text, live bool default true
);
create table reviews (
  id text primary key,
  product_cat text, author text, role text, lot text, stars int, date date,
  body text, avatar text, images jsonb default '[]',
  live bool default false, created_at timestamptz default now()
);
-- Unused: the dashboard's vote-cycle editor doesn't match this per-row shape,
-- so votes are stored as one row in `content` (key 'votes') instead. Table
-- kept for backward compatibility, not written to.
create table votes (
  id uuid primary key default gen_random_uuid(),
  cycle text, product_cat text, count int default 0,
  open bool default true, closes_on date
);
create table content (
  key text primary key, value jsonb          -- hero, blocks, nav, strip, promos, votes...
);
create table help_chat_messages (
  id bigserial primary key,
  update_id bigint unique,               -- set for rows pulled from the relay bot, null for visitor-sent rows
  from_role text not null,               -- visitor | support
  text text not null,
  created_at timestamptz default now()
);

-- Row level security: public reads only "live" rows; all writes go through
-- the service role key from a server route, never from the browser.
alter table products enable row level security;
create policy "public read live" on products for select using (live = true);
create policy "admin all products" on products for all using (auth.role() = 'service_role');

alter table discounts enable row level security;
create policy "public read live" on discounts for select using (live = true);
create policy "admin all discounts" on discounts for all using (auth.role() = 'service_role');

alter table lab_reports enable row level security;
create policy "public read live" on lab_reports for select using (live = true);
create policy "admin all lab_reports" on lab_reports for all using (auth.role() = 'service_role');

alter table reviews enable row level security;
create policy "public read live" on reviews for select using (live = true);
create policy "admin all reviews" on reviews for all using (auth.role() = 'service_role');

alter table votes enable row level security;
create policy "public read all" on votes for select using (true);
create policy "admin all votes" on votes for all using (auth.role() = 'service_role');

alter table content enable row level security;
create policy "public read all" on content for select using (true);
create policy "admin all content" on content for all using (auth.role() = 'service_role');

-- orders and customers hold PII (email). No public policy at all — default
-- deny for anon key. Service role (server-side only) bypasses RLS.
alter table orders enable row level security;
create policy "admin all orders" on orders for all using (auth.role() = 'service_role');

alter table customers enable row level security;
create policy "admin all customers" on customers for all using (auth.role() = 'service_role');

-- Help-page chat log. The browser never talks to Supabase for this table —
-- only the server route (service role) reads and writes it.
alter table help_chat_messages enable row level security;
create policy "admin all help_chat_messages" on help_chat_messages for all using (auth.role() = 'service_role');

-- Admin allowlist. Replaces the old ADMIN_EMAILS env var — rows are managed
-- live from the Telegram bot's /start menu as well as directly here.
create table admins (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  telegram_id bigint unique,
  added_by text,
  created_at timestamptz default now()
);
alter table admins enable row level security;
create policy "admin all admins" on admins for all using (auth.role() = 'service_role');

-- One-time bootstrap seed — the first admin, so the bot has someone to show
-- the menu to. Run once; safe to re-run (upsert on email).
insert into admins (email, telegram_id, added_by)
values ('kajal46788467@gmail.com', 8241162979, 'seed')
on conflict (email) do update set telegram_id = excluded.telegram_id;

-- One-time migration — discounts/lab_reports/reviews originally had uuid ids;
-- the dashboard generates its own string ids client-side (see uid() in
-- store-data.js) and upserts on them directly, so these need to be text.
-- Safe to run on an empty table; skip if already migrated.
alter table discounts alter column id type text, alter column id drop default;
alter table lab_reports alter column id type text, alter column id drop default;
alter table reviews alter column id type text, alter column id drop default;
alter table lab_reports add column file_name text;
alter table reviews add column role text, add column date date, add column avatar text;
