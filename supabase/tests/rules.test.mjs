// Automated checks for the chat rules in ../schema.sql.
// Runs the schema in PGlite (Postgres compiled to WebAssembly) with small
// stand-ins for Supabase's auth and storage schemas, then acts as different
// signed-in people to prove each rule holds. Run with: npm test
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const db = new PGlite();
const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const stubs = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth; create schema storage;
grant usage on schema auth, storage, public to anon, authenticated, supabase_auth_admin;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
grant insert, select on auth.users to supabase_auth_admin;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant select, insert on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant execute on function storage.foldername(text) to authenticated;
create publication supabase_realtime;
-- Supabase default: API roles get table privileges; RLS gates rows.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

async function as(uid, sql, params) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid || ''}'; set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
async function expectErr(name, uid, sql, params, code) {
  try { await as(uid, sql, params); ok(name, false, '(no error)'); }
  catch (e) { ok(name, !code || e.message.includes(code), `got: ${e.message}`); }
}
// Signing in creates an auth user; joining needs an invite and a Google account.
async function signIn(email, provider = 'google') {
  return (await db.query(`insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id`,
    [email, JSON.stringify({ provider, providers: [provider] })])).rows[0].id;
}
async function signup(username, code) {
  const id = await signIn(username + '@x.test');
  await as(id, 'select public.join_with_invite($1, $2)', [code, username]);
  return id;
}
const invite = async (uid) => (await as(uid, 'select public.create_invite() c')).rows[0].c.code;
const su = (sql, p) => db.query(sql, p);
const NBSP = String.fromCharCode(0xa0), ZWSP = String.fromCharCode(0x200b);
const words = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');

await db.exec(stubs);
const res = await db.exec(schema);
const first = res[res.length - 1].rows[0].your_first_invite_code;
console.log('schema loaded; first code', first);

console.log('# word counting');
for (const [t, n] of [['', 0], ['   ', 0], ['hi', 1], ['  a  b\tc\n d ', 4], ['a' + NBSP + 'b' + NBSP + 'c', 3], ['a' + ZWSP + 'b', 2], [null, 0]]) {
  const r = await su('select public.count_words($1) n', [t]);
  ok(`count_words(${JSON.stringify(t)}) = ${n}`, r.rows[0].n === n, `got ${r.rows[0].n}`);
}

console.log('# joining with invite links');
try { await signup('baduser', 'NOPE'); ok('bad invite rejected', false); } catch (e) { ok('bad invite rejected', e.message.includes('INVITE_INVALID'), e.message); }
const A = await signup('star_gazer', first);
let pa = (await su('select * from profiles where id=$1', [A])).rows[0];
ok('first user is admin (OP)', pa.is_admin === true);
await expectErr('joining twice rejected', A, 'select public.join_with_invite($1,$2)', [first, 'star_again'], 'ALREADY_MEMBER');
const code2 = await invite(A);
ok('invite link lasts 7 days', (await su(`select round(extract(epoch from expires_at - now())/86400) d from invites where code=$1`, [code2])).rows[0].d == 7);
ok('check_signup: taken username', (await as(null, 'select public.check_signup($1,$2) r', [code2, 'STAR_GAZER'])).rows[0].r === 'USERNAME_TAKEN');
ok('check_signup: ok', (await as(null, 'select public.check_signup($1,$2) r', [code2.toLowerCase(), 'cyberSuze'])).rows[0].r === 'OK');
ok('check_signup: link only', (await as(null, 'select public.check_signup($1) r', [code2])).rows[0].r === 'OK');
const B = await signup('cyberSuze', code2);
const C = await signup('pixel_pete', code2);
ok('one link brings in several people', (await su('select uses from invites where code=$1', [code2])).rows[0].uses === 2);
ok('invited_by recorded', (await su('select invited_by from profiles where id=$1', [C])).rows[0].invited_by === A);
ok('second user not admin', (await su('select is_admin from profiles where id=$1', [B])).rows[0].is_admin === false);
const emailUser = await signIn('password@x.test', 'email');
await expectErr('email/password accounts cannot join', emailUser, 'select public.join_with_invite($1,$2)', [code2, 'pw_person'], 'GOOGLE_ONLY');
const stranger = await signIn('stranger@gmail.test');
ok('signed in without invite: sees no messages', (await as(stranger, 'select * from messages')).rows.length === 0);
ok('signed in without invite: sees no rooms', (await as(stranger, 'select * from rooms')).rows.length === 0);
await expectErr('signed in without invite: cannot post', stranger, 'select public.send_message($1,$2)', [(await su(`select id from rooms where kind='global'`)).rows[0].id, 'hi'], 'NOT_A_MEMBER');
await expectErr('signed in without invite: cannot make invites', stranger, 'select public.create_invite()', [], 'NOT_A_MEMBER');
const oldCode = await invite(B);
await su(`update invites set expires_at = now() - interval '1 minute' where code=$1`, [oldCode]);
ok('check_signup: expired link', (await as(null, 'select public.check_signup($1) r', [oldCode])).rows[0].r === 'INVITE_EXPIRED');
await expectErr('expired link rejected', stranger, 'select public.join_with_invite($1,$2)', [oldCode, 'late_larry'], 'INVITE_EXPIRED');
const revCode = await invite(B);
await expectErr('others cannot revoke your link', C, 'select public.revoke_invite($1)', [revCode], 'INVITE_INVALID');
await as(B, 'select public.revoke_invite($1)', [revCode]);
await expectErr('revoked link rejected', stranger, 'select public.join_with_invite($1,$2)', [revCode, 'late_larry'], 'INVITE_INVALID');
const adminRev = await invite(C);
await as(A, 'select public.revoke_invite($1)', [adminRev]);
ok('admin can revoke anyone\'s link', (await as(null, 'select public.check_signup($1) r', [adminRev])).rows[0].r === 'INVITE_INVALID');
for (let i = 0; i < 5; i++) await invite(C);
await expectErr('max 5 live links each', C, 'select public.create_invite()', [], 'TOO_MANY_INVITES');
await su(`update invites set revoked_at = now() where created_by = $1`, [C]);
await expectErr('anon cannot create invite', null, 'select public.create_invite()', [], 'permission denied');
ok('anon sees no messages', (await as(null, 'select * from messages')).rows.length === 0);
ok('anon sees no profiles', (await as(null, 'select * from profiles')).rows.length === 0);

const G = (await su(`select id from rooms where kind='global'`)).rows[0].id;
const send = (uid, room, body, img = null) => as(uid, 'select public.send_message($1,$2,$3) r', [room, body, img]);

console.log('# 8-word rule');
ok('8 words OK', (await send(A, G, words(8))).rows[0].r.id > 0);
await expectErr('9 words rejected', A, 'select public.send_message($1,$2)', [G, words(9)], 'TOO_MANY_WORDS');
await expectErr('NBSP-glued 9 words rejected', A, 'select public.send_message($1,$2)', [G, words(9).replaceAll(' ', NBSP)], 'TOO_MANY_WORDS');
await expectErr('161 chars rejected', A, 'select public.send_message($1,$2)', [G, 'x'.repeat(161)], 'TOO_LONG');
await expectErr('empty rejected', A, 'select public.send_message($1,$2)', [G, '   '], 'EMPTY');
await expectErr('direct insert blocked', A, `insert into messages (room_id, user_id, body) values ($1,$2,'hax')`, [G, A]);
await expectErr('cannot make self admin', B, `update profiles set is_admin = true where id = $1`, [B], 'permission denied');
await as(B, `update profiles set status_text = 'headphones' where id = $1`, [B]);
ok('can edit own status', (await su('select status_text from profiles where id=$1', [B])).rows[0].status_text === 'headphones');
await as(B, `update profiles set status_text = 'hacked' where id = $1`, [A]);
ok('cannot edit someone else', (await su('select status_text from profiles where id=$1', [A])).rows[0].status_text === '');

console.log('# spam rule');
for (let i = 0; i < 10; i++) await send(C, G, 'msg ' + i);
ok('muted after 10 in a minute', (await su('select muted_until > now() m from profiles where id=$1', [C])).rows[0].m === true);
await expectErr('11th rejected', C, 'select public.send_message($1,$2)', [G, 'one more'], 'SPAM_WAIT');
await su(`update profiles set muted_until = now() - interval '1 second' where id=$1`, [C]);
await su(`update messages set created_at = now() - interval '2 minutes' where user_id=$1`, [C]);
ok('can send after wait', (await send(C, G, 'back again')).rows[0].r.id > 0);

console.log('# image rule');
await expectErr('upload into someone else\'s folder blocked', B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [A + '/x.png']);
await as(B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [B + '/cat.png']);
await expectErr('image path of another user rejected', A, 'select public.send_message($1,$2,$3)', [G, '', B + '/cat.png'], 'BAD_IMAGE');
await expectErr('image that was never uploaded rejected', B, 'select public.send_message($1,$2,$3)', [G, '', B + '/ghost.png'], 'BAD_IMAGE');
ok('image sends', (await send(B, G, 'my cat', B + '/cat.png')).rows[0].r.id > 0);
await expectErr('text blocked for 30 seconds after image', B, 'select public.send_message($1,$2)', [G, 'hello?'], 'IMAGE_LOCKED');
const lockSecs = (await su(`select round(extract(epoch from image_locked_until - now())) s from profiles where id=$1`, [B])).rows[0].s;
ok('lock is 30 seconds', Number(lockSecs) >= 28 && Number(lockSecs) <= 30, lockSecs);
await expectErr('upload blocked while locked', B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [B + '/dog.png']);

console.log('# friends');
ok('request sent', (await as(A, 'select public.send_friend_request($1) r', [B])).rows[0].r === 'SENT');
ok('duplicate says already sent', (await as(A, 'select public.send_friend_request($1) r', [B])).rows[0].r === 'ALREADY_SENT');
const reqId = (await as(B, 'select id from friend_requests where to_user = auth.uid()')).rows[0].id;
ok('outsider cannot see request', (await as(C, 'select * from friend_requests')).rows.length === 0);
await expectErr('sender cannot accept own request', A, 'select public.respond_friend_request($1, true)', [reqId], 'REQUEST_NOT_FOUND');
const dm = (await as(B, 'select public.respond_friend_request($1, true) r', [reqId])).rows[0].r;
ok('accept creates friend chat', !!dm);
await su(`update profiles set image_locked_until = null where id=$1`, [B]);
ok('friends can send 50 words', (await send(A, dm, words(50))).rows[0].r.id > 0);
await expectErr('201 words rejected in friend chat', A, 'select public.send_message($1,$2)', [dm, words(201)], 'TOO_MANY_WORDS');
await as(A, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [A + '/pic.png']);
await expectErr('no images between friends', A, 'select public.send_message($1,$2,$3)', [dm, '', A + '/pic.png'], 'NO_IMAGES_FOR_FRIENDS');
ok('outsider cannot see friend chat room', (await as(C, 'select * from rooms where id=$1', [dm])).rows.length === 0);
ok('outsider cannot read friend chat', (await as(C, 'select * from messages where room_id=$1', [dm])).rows.length === 0);
await expectErr('outsider cannot post in friend chat', C, 'select public.send_message($1,$2)', [dm, 'hi'], 'NOT_IN_ROOM');
ok('friend can read friend chat', (await as(B, 'select * from messages where room_id=$1', [dm])).rows.length === 1);
// reverse-direction request auto-accepts
ok('C requests A', (await as(C, 'select public.send_friend_request($1) r', [A])).rows[0].r === 'SENT');
ok('A requesting C back auto-accepts', (await as(A, 'select public.send_friend_request($1) r', [C])).rows[0].r === 'ACCEPTED');

console.log('# groups');
const grp = (await as(A, `select public.create_group('after_school', '#') g`)).rows[0].g;
await expectErr('duplicate group name', B, `select public.create_group('After_School')`, [], 'GROUP_NAME_TAKEN');
await expectErr('bad group name', B, `select public.create_group('no spaces allowed')`, [], 'GROUP_NAME_INVALID');
ok('non-member sees group in list', (await as(C, 'select * from rooms where id=$1', [grp])).rows.length === 1);
await send(A, grp, 'welcome to after school');
ok('non-member cannot read group messages', (await as(C, 'select * from messages where room_id=$1', [grp])).rows.length === 0);
await expectErr('non-member cannot post', C, 'select public.send_message($1,$2)', [grp, 'hi'], 'NOT_IN_ROOM');
await as(C, 'select public.join_room($1)', [grp]);
ok('after join can read', (await as(C, 'select * from messages where room_id=$1', [grp])).rows.length >= 2);
ok('join posts "entered" line', (await su(`select count(*)::int n from messages where room_id=$1 and kind='system' and body='JOINED'`, [grp])).rows[0].n === 1);

console.log('# 1M-word wipe (threshold lowered to 60 for the test)');
await su(`update settings set wipe_at_words = 60`);
await su(`update profiles set muted_until = null, image_locked_until = null`);
await su(`update messages set created_at = now() - interval '5 minutes'`);
const before = (await su(`select total_words t from settings`)).rows[0].t;
console.log('  words so far:', before);
let wiped = false, n = 0;
while (!wiped && n < 20) {
  const who = [A, B, C][n % 3];
  const r = (await send(who, n % 2 ? G : grp, words(8))).rows[0].r;
  wiped = r.wiped; n++;
}
ok('wipe triggered', wiped);
const pub = (await su(`select count(*)::int n from messages m join rooms r on r.id=m.room_id where r.kind<>'dm' and m.kind<>'system'`)).rows[0].n;
ok('Global + groups erased', pub === 0, pub);
ok('friend chat kept', (await su(`select count(*)::int n from messages where room_id=$1`, [dm])).rows[0].n === 1);
ok('counter reset', Number((await su(`select total_words t from settings`)).rows[0].t) === 0);
ok('groups still exist', (await su(`select count(*)::int n from rooms where id=$1`, [grp])).rows[0].n === 1);
ok('image listed for cleanup', (await su(`select count(*)::int n from orphaned_images`)).rows[0].n === 1);
ok('WIPE notice in Global', (await su(`select count(*)::int n from messages where room_id=$1 and body='WIPE'`, [G])).rows[0].n === 1);

console.log('# admins and bans');
ok('first user is the founder', (await su('select is_owner from profiles where id=$1', [A])).rows[0].is_owner === true);
await expectErr('regular cannot promote', B, 'select public.set_admin($1, true)', [C], 'NOT_ADMIN');
await expectErr('regular cannot ban', B, 'select public.ban_user($1, true)', [C], 'NOT_ADMIN');
await expectErr('cannot make self admin via profile edit', B, `update profiles set is_admin = true where id = auth.uid()`, [], 'permission denied');
await as(A, 'select public.set_admin($1, true)', [B]);
ok('founder promotes B', (await su('select is_admin from profiles where id=$1', [B])).rows[0].is_admin === true);
ok('promotion announced in Global', (await su(`select count(*)::int n from messages where room_id=$1 and body='PROMOTED' and target_id=$2`, [G, B])).rows[0].n === 1);
await expectErr('admin cannot demote founder', B, 'select public.set_admin($1, false)', [A], 'CANNOT_CHANGE_OWNER');
await expectErr('admin cannot ban founder', B, 'select public.ban_user($1, true)', [A], 'CANNOT_CHANGE_OWNER');
await expectErr('founder cannot ban self', A, 'select public.ban_user($1, true)', [A], 'NOT_YOURSELF');
await expectErr('admin must be demoted before ban', A, 'select public.ban_user($1, true)', [B], 'DEMOTE_FIRST');
const cInvite = await invite(C);
const D = await signup('laser_liz', await invite(A));
await as(D, 'select public.send_friend_request($1)', [C]);
await as(B, 'select public.ban_user($1, true)', [C]);
ok('admin B bans C', (await su('select banned_at is not null b from profiles where id=$1', [C])).rows[0].b === true);
ok('ban announced in Global', (await su(`select count(*)::int n from messages where body='BANNED' and target_id=$1`, [C])).rows[0].n === 1);
await expectErr('banned cannot post', C, 'select public.send_message($1,$2)', [G, 'let me back'], 'BANNED');
ok('banned cannot read Global', (await as(C, 'select * from messages where room_id=$1', [G])).rows.length === 0);
ok('banned cannot read friend chat', (await as(C, 'select * from messages')).rows.length === 0);
ok('banned sees only own profile', (await as(C, 'select id from profiles')).rows.map((r) => r.id).join() === C);
await expectErr('banned cannot invite', C, 'select public.create_invite()', [], 'NOT_A_MEMBER');
await expectErr('banned cannot upload', C, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [C + '/x.png']);
await as(C, `update profiles set status_text = 'unban me' where id = auth.uid()`);
ok('banned cannot edit profile', (await su('select status_text from profiles where id=$1', [C])).rows[0].status_text !== 'unban me');
ok('banned user\'s invite links stop working', (await as(null, 'select public.check_signup($1) r', [cInvite])).rows[0].r === 'INVITE_INVALID');
ok('pending requests with banned user deleted', (await su(`select count(*)::int n from friend_requests where status='pending' and (from_user=$1 or to_user=$1)`, [C])).rows[0].n === 0);
await expectErr('cannot friend a banned user', D, 'select public.send_friend_request($1)', [C], 'USER_BANNED');
await expectErr('cannot promote a banned user', A, 'select public.set_admin($1, true)', [C], 'USER_BANNED');
await as(A, 'select public.set_admin($1, false)', [B]);
ok('founder demotes B', (await su('select is_admin from profiles where id=$1', [B])).rows[0].is_admin === false);
await expectErr('demoted B loses admin tools', B, 'select public.ban_user($1, false)', [C], 'NOT_ADMIN');
await as(A, 'select public.ban_user($1, false)', [C]);
ok('unbanned C can post again', (await send(C, G, 'thanks for the unban')).rows[0].r.id > 0);
ok('unban announced in Global', (await su(`select count(*)::int n from messages where body='UNBANNED' and target_id=$1`, [C])).rows[0].n === 1);
await as(A, 'select public.set_admin($1, true)', [D]);
await as(D, 'select public.set_admin($1, false)', [D]);
ok('admin can step down', (await su('select is_admin from profiles where id=$1', [D])).rows[0].is_admin === false);

console.log('# locked groups');
const E = await signup('net_angel', await invite(A));
await expectErr('regulars cannot create locked groups', B, `select public.create_group('secret_club', '#', true)`, [], 'NOT_ADMIN');
const L = (await as(A, `select public.create_group('secret_club', '#', true) g`)).rows[0].g;
ok('admin creates locked group', (await su('select locked from rooms where id=$1', [L])).rows[0].locked === true);
ok('everyone can see it exists', (await as(E, 'select * from rooms where id=$1', [L])).rows.length === 1);
await expectErr('cannot just join a locked group', E, 'select public.join_room($1)', [L], 'GROUP_LOCKED');
ok('ask to join', (await as(E, 'select public.request_to_join($1) r', [L])).rows[0].r === 'REQUESTED');
ok('asking twice is fine', (await as(E, 'select public.request_to_join($1) r', [L])).rows[0].r === 'ALREADY_REQUESTED');
ok('admins see the request', (await as(A, 'select * from room_requests where room_id=$1', [L])).rows.length === 1);
ok('other members do not', (await as(B, 'select * from room_requests where room_id=$1', [L])).rows.length === 0);
await expectErr('regulars cannot approve', B, 'select public.answer_join_request($1,$2,true)', [L, E], 'NOT_ADMIN');
await as(A, 'select public.answer_join_request($1,$2,true)', [L, E]);
ok('approved member can read', (await as(E, 'select * from messages where room_id=$1', [L])).rows.length >= 1);
ok('request cleared after approval', (await su('select count(*)::int n from room_requests where room_id=$1', [L])).rows[0].n === 0);
await expectErr('regulars cannot invite into locked group', E, 'select public.invite_to_group($1,$2)', [L, B], 'NOT_ADMIN');
ok('admin invites B', (await as(A, 'select public.invite_to_group($1,$2) r', [L, B])).rows[0].r === 'INVITED');
ok('B sees own invitation', (await as(B, 'select kind from room_requests where room_id=$1', [L])).rows[0].kind === 'invite');
await as(B, 'select public.join_room($1)', [L]);
ok('invited member joins', (await su('select count(*)::int n from room_members where room_id=$1 and user_id=$2', [L, B])).rows[0].n === 1);
await as(A, 'select public.invite_to_group($1,$2)', [L, D]);
await as(D, 'select public.dismiss_room_request($1)', [L]);
await expectErr('declined invitation no longer works', D, 'select public.join_room($1)', [L], 'GROUP_LOCKED');
ok('request + admin invite = straight in', (await as(D, 'select public.request_to_join($1) r', [L])).rows[0].r === 'REQUESTED'
  && (await as(A, 'select public.invite_to_group($1,$2) r', [L, D])).rows[0].r === 'ADDED');
await as(C, 'select public.request_to_join($1)', [L]);
await as(A, 'select public.answer_join_request($1,$2,false)', [L, C]);
ok('turned-down request removed', (await su('select count(*)::int n from room_requests where room_id=$1 and user_id=$2', [L, C])).rows[0].n === 0);
await expectErr('outsiders still cannot read', C, 'select public.send_message($1,$2)', [L, 'let me in'], 'NOT_IN_ROOM');
await as(C, 'select public.request_to_join($1)', [L]);
await as(A, 'select public.set_group_locked($1,false)', [L]);
ok('unlocking clears requests', (await su('select count(*)::int n from room_requests where room_id=$1', [L])).rows[0].n === 0);
await as(C, 'select public.join_room($1)', [L]);
ok('anyone can join once unlocked', (await su('select count(*)::int n from room_members where room_id=$1 and user_id=$2', [L, C])).rows[0].n === 1);
await expectErr('no requests on open groups', stranger, 'select public.request_to_join($1)', [L], 'NOT_A_MEMBER');
await expectErr('regulars cannot lock groups', C, 'select public.set_group_locked($1,true)', [L], 'NOT_ADMIN');
const L2 = (await as(E, `select public.create_group('open_mic') g`)).rows[0].g;
await as(A, 'select public.set_group_locked($1,true)', [L2]);
await as(A, 'select public.join_room($1)', [L2]);
ok('admins can walk into locked groups', (await su('select count(*)::int n from room_members where room_id=$1 and user_id=$2', [L2, A])).rows[0].n === 1);
await expectErr('helper functions are private', B, 'select public.add_to_room($1,$2)', [L, B], 'permission denied');

console.log('# inviting into open groups');
const OG = (await as(C, `select public.create_group('open_house') g`)).rows[0].g;
await expectErr('regulars cannot invite', C, 'select public.invite_to_group($1,$2)', [OG, B], 'NOT_ADMIN');
ok('admin invites someone to an open group', (await as(A, 'select public.invite_to_group($1,$2) r', [OG, B])).rows[0].r === 'INVITED');
ok('they see the invitation', (await as(B, 'select kind from room_requests where room_id=$1', [OG])).rows[0]?.kind === 'invite');
ok('inviting again is fine', (await as(A, 'select public.invite_to_group($1,$2) r', [OG, B])).rows[0].r === 'INVITED');
await as(B, 'select public.join_room($1)', [OG]);
ok('they join', (await su('select count(*)::int n from room_members where room_id=$1 and user_id=$2', [OG, B])).rows[0].n === 1);
ok('invitation cleared once in', (await su('select count(*)::int n from room_requests where room_id=$1 and user_id=$2', [OG, B])).rows[0].n === 0);
ok('inviting a member says so', (await as(A, 'select public.invite_to_group($1,$2) r', [OG, B])).rows[0].r === 'ALREADY_IN');
await as(A, 'select public.set_group_locked($1,true)', [OG]);
await as(A, 'select public.invite_to_group($1,$2)', [OG, D]);
await as(E, 'select public.request_to_join($1)', [OG]);
await as(A, 'select public.set_group_locked($1,false)', [OG]);
ok('unlocking keeps invitations', (await su(`select count(*)::int n from room_requests where room_id=$1 and kind='invite'`, [OG])).rows[0].n === 1);
ok('but clears requests', (await su(`select count(*)::int n from room_requests where room_id=$1 and kind='request'`, [OG])).rows[0].n === 0);

console.log('# cooldowns per group');
await su(`update profiles set muted_until = null, image_locked_until = null`);
const upload = (uid, name) => as(uid, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [name]);
const coolOf = async (room) => (await su('select cooldowns from rooms where id=$1', [room])).rows[0].cooldowns;
const lockOf = async (uid) => (await su('select image_locked_until > now() l, muted_until > now() m from profiles where id=$1', [uid])).rows[0];
const CG = (await as(C, `select public.create_group('free_zone') g`)).rows[0].g;
await as(B, 'select public.join_room($1)', [CG]);
ok('groups start with cooldowns on', await coolOf(CG) === true);
await expectErr('regulars cannot switch cooldowns off', C, 'select public.set_group_cooldowns($1,false)', [CG], 'NOT_ADMIN');
await as(A, 'select public.set_group_cooldowns($1,false)', [CG]);
ok('admin switches cooldowns off', await coolOf(CG) === false);
ok('the group is told', (await su(`select count(*)::int n from messages where room_id=$1 and kind='system' and body='COOLDOWNS_OFF'`, [CG])).rows[0].n === 1);
await as(A, 'select public.set_group_cooldowns($1,false)', [G]);
ok('Global always keeps cooldowns', await coolOf(G) === true);
await upload(B, `${B}/${CG}/free.png`);
await send(B, CG, 'look', `${B}/${CG}/free.png`);
ok('image in cooldown-free group does not lock', !(await lockOf(B)).l);
await upload(B, `${B}/${G}/g.png`);
await send(B, G, '', `${B}/${G}/g.png`);
ok('image in Global still locks', (await lockOf(B)).l === true);
await expectErr('lock applies in Global', B, 'select public.send_message($1,$2)', [G, 'hi'], 'IMAGE_LOCKED');
await expectErr('and in groups with cooldowns on', B, 'select public.send_message($1,$2)', [L, 'hi'], 'IMAGE_LOCKED');
ok('locked person can post in cooldown-free group', (await send(B, CG, 'still here')).rows[0].r.id > 0);
await upload(B, `${B}/${CG}/two.png`);
ok('and upload images for it', (await su('select count(*)::int n from storage.objects where name=$1', [`${B}/${CG}/two.png`])).rows[0].n === 1);
await expectErr('but not upload for Global while locked', B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [`${B}/${G}/x.png`]);
await expectErr('nor with an old-style path', B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [`${B}/y.png`]);
await su(`update profiles set image_locked_until = now() + interval '1 minute' where id=$1`, [D]);
await expectErr('nor for a free group they are not in', D, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [`${D}/${CG}/z.png`]);
await su(`update profiles set image_locked_until = null where id=$1`, [D]);
ok('friend chats are free while locked', (await send(B, dm, 'hey friend')).rows[0].r.id > 0);

const F = await signup('flood_fan', await invite(A));
await as(F, 'select public.join_room($1)', [CG]);
for (let i = 0; i < 10; i++) await send(F, G, 'global ' + i);
ok('flood in Global still means a wait', (await lockOf(F)).m === true);
ok('waiting person can post in cooldown-free group', (await send(F, CG, 'over here')).rows[0].r.id > 0);
await expectErr('but not in Global', F, 'select public.send_message($1,$2)', [G, 'again'], 'SPAM_WAIT');
await su(`delete from messages where user_id=$1 and room_id=$2`, [F, G]);
await su(`update profiles set muted_until = null where id=$1`, [F]);
for (let i = 0; i < 12; i++) await send(F, CG, 'free ' + i);
ok('no flood wait in cooldown-free group', !(await lockOf(F)).m);
await send(F, G, 'back in global');
ok('free-group messages do not count toward the flood limit', !(await lockOf(F)).m);

await as(A, 'select public.set_group_cooldowns($1,true)', [CG]);
ok('admin switches cooldowns back on', await coolOf(CG) === true
  && (await su(`select count(*)::int n from messages where room_id=$1 and body='COOLDOWNS_ON'`, [CG])).rows[0].n === 1);
await expectErr('lock applies in the group again', B, 'select public.send_message($1,$2)', [CG, 'hi'], 'IMAGE_LOCKED');
await expectErr('uploads for it are blocked again', B, `insert into storage.objects (bucket_id, name) values ('chat-images', $1)`, [`${B}/${CG}/three.png`]);
await su(`update profiles set image_locked_until = null where id=$1`, [B]);
await upload(B, `${B}/${CG}/four.png`);
await send(B, CG, '', `${B}/${CG}/four.png`);
ok('images lock again once cooldowns are back', (await lockOf(B)).l === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
