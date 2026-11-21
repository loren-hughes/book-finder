-- Book Finder database schema (Supabase Postgres)
-- Run this once in the Supabase SQL Editor for a new project.

create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  query_norm text not null unique,
  status text not null default 'looking',
  best jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_results (
  query_norm text not null,
  source text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (query_norm, source)
);

create table if not exists public.hold_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  metadata_id text,
  request jsonb,
  status integer,
  response text
);

alter table public.saved_items enable row level security;
alter table public.source_results enable row level security;
alter table public.hold_log enable row level security;
