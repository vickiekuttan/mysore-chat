-- Mysore chat: clears two Supabase Security Advisor warnings
-- ("Function Search Path Mutable"). These two helpers only use built-in
-- Postgres functions, so they get an empty search_path: nothing a user
-- creates elsewhere can stand in for what they call.
-- Changes no data. Safe to run more than once.
alter function public.new_code() set search_path = '';
alter function public.count_words(text) set search_path = '';
