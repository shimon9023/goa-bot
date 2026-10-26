-- ========================================================
--  הטבלאות שהבוט צריך בסופהבייס
--  מדביקים את כל הקובץ הזה ב-SQL Editor שבסופהבייס ומריצים פעם אחת.
-- ========================================================

-- מצב שיחה: מה כל משתמש באמצע לעשות
create table if not exists bot_sessions (
  user_id     text primary key,
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- הגדרות הבוט: ספים, שעות שקטות, אילו התראות פעילות
create table if not exists bot_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- יומן פעולות: כל שינוי שנעשה באתר דרך הבוט
create table if not exists bot_actions (
  id            bigserial primary key,
  user_id       text not null,
  action        text not null,
  target        text,
  before_value  jsonb,
  after_value   jsonb,
  undone        boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists bot_actions_user_idx on bot_actions (user_id, created_at desc);

-- התראות שכבר נשלחו, כדי לא לשלוח פעמיים
create table if not exists bot_alerts (
  id        bigserial primary key,
  order_id  text not null,
  kind      text not null,
  sent_at   timestamptz not null default now()
);

create index if not exists bot_alerts_order_idx on bot_alerts (order_id, kind, sent_at desc);

-- הזמנות שהושתקו
create table if not exists bot_muted_orders (
  order_id  text primary key,
  muted_at  timestamptz not null default now()
);

-- התראות שהצטברו בשעות השקטות וממתינות לשליחה בבוקר
create table if not exists bot_quiet_queue (
  id          bigserial primary key,
  text        text not null,
  created_at  timestamptz not null default now()
);

-- משוב על תמונות שנוצרו: לפני, ההערה, ואחרי
create table if not exists bot_image_feedback (
  id            bigserial primary key,
  product_name  text,
  before_url    text,
  note          text,
  after_url     text,
  created_at    timestamptz not null default now()
);

-- מתחרים, לפי קטגוריה ראשית
create table if not exists bot_competitors (
  id          bigserial primary key,
  name        text not null,
  site_url    text not null,
  categories  text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- רישום הוצאות AI, לתקרה החודשית
create table if not exists bot_ai_spend (
  id             bigserial primary key,
  kind           text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  images         integer not null default 0,
  cost_usd       numeric(10,4) not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists bot_ai_spend_date_idx on bot_ai_spend (created_at desc);

-- טיוטות מוצר שנמצאות באמצע עריכה
create table if not exists bot_product_drafts (
  id          text primary key,
  user_id     text not null,
  content     jsonb not null,
  images      jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- משתמשים מורשים וההרשאות שלהם
create table if not exists bot_users (
  user_id     text primary key,
  name        text,
  areas       text[] not null default '{}',
  created_at  timestamptz not null default now()
);
