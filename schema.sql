-- RETIRED (2026-08-09): this project now stores books in a Firebase Realtime
-- Database rather than Supabase. Kept because the policy below is the design the
-- Firebase rules copied: public read, public insert, and deliberately NO update
-- or delete policy, so a shelf is append-only and there is no ownership to spoof.
-- See app.js for the current backend.
-- Run this once in your Supabase project's SQL editor (Project -> SQL Editor -> New query).

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  author text not null check (char_length(author) between 1 and 200),
  added_by text check (char_length(added_by) <= 100),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);

alter table books enable row level security;

-- Anyone (including anonymous visitors using the public anon key) can read the list.
create policy "public can read books"
  on books for select
  using (true);

-- Anyone can add a book. No update/delete policies exist, so those
-- operations are denied by default for the anon role.
create policy "public can insert books"
  on books for insert
  with check (true);
