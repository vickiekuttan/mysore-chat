# Pazhampori chat

An invite-only chatroom that looks and feels like 1998. One Global chat, groups anyone can make or join, and friend chats that need both people to say yes.

Built with plain HTML, CSS and JavaScript (no build step) on top of [Supabase](https://supabase.com) for accounts, messages, live updates and image storage.

## The rules

These are enforced by the database itself (`supabase/schema.sql`), so nobody can skip them by poking at the page.

| Rule | Default |
| --- | --- |
| Words per message in Global chat and groups | 8 (and 160 characters) |
| Flood control | 10 messages within 60 seconds means a 5-minute wait |
| Images | Allowed in Global chat and groups. After sending one, you can't send anything for 10 minutes |
| The big wipe | When Global chat and all groups together reach 1,000,000 words, every message in them is erased and everyone starts on a blank page. Groups themselves stay. Friend chats are not counted or erased |
| Friends | Send a request, the other person accepts, then you get a private chat. Up to 200 words per message, no images |
| Joining | Invite code only. Every member can make up to 5 unused codes at a time |

Every number above lives in the `settings` table. Change it there (Supabase > Table Editor > settings) and it takes effect immediately, no code change.

## Try it without setting anything up

Download the repo and double-click `index.html`. With no Supabase details in `js/config.js`, it runs in **demo mode**: pretend people, pretend messages, the same rules, nothing saved.

## Put it online (about 30 minutes, no coding)

### 1. Create the database

1. Sign up at [supabase.com](https://supabase.com) and click **New project**. Pick the region closest to your friends (for Kerala, **Mumbai**). Save the database password somewhere safe.
2. When the project is ready, open **SQL Editor** > **New query**.
3. Open `supabase/schema.sql` from this repo, copy all of it, paste it in, and click **Run**.
4. The result at the bottom shows `your_first_invite_code`. Copy it. The first account created with it becomes the room operator **[OP]**.

### 2. Turn off email confirmation (recommended)

Supabase's built-in email sender only sends a few emails per hour, which breaks sign-ups when several friends join at once. Since nobody can join without an invite code anyway, it is simpler to skip confirmation:

**Authentication** > **Sign In / Providers** > **Email** > switch off **Confirm email** > **Save**.

(If you keep it on, people must click the link in their email before signing in.)

### 3. Connect the page to the database

1. In Supabase open **Project Settings** > **API** (or **API Keys**). Copy the **Project URL** and the **anon / publishable** key.
2. On GitHub, open `js/config.js`, click the pencil icon, paste both values between the quotes, and click **Commit changes**.

The anon key is designed to be public. The rules in the database are what keep the chat safe. Never paste the **service_role / secret** key anywhere in this repo.

### 4. Publish it

**GitHub Pages** (free, same place as the code):

1. In the repo, go to **Settings** > **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the page shows your site's address, like `https://yourname.github.io/pazhampori-chat/`.
4. Back in Supabase: **Authentication** > **URL Configuration** > set **Site URL** to that address.

### 5. Sign on

Open your site, choose **I have an invite**, and use the code from step 1. Then press **Invite** in the toolbar to make codes for your friends.

## Free plan limits to know about

Checked against [supabase.com/pricing](https://supabase.com/pricing) in September 2026:

- 500 MB database. 1,000,000 words of chat is roughly 125,000 messages, which fits comfortably.
- **1 GB of image storage.** See the note on images below.
- 200 people connected at the same time.
- **Free projects pause after a week with no activity.** Open the Supabase dashboard and click **Restore** if that happens.

## Known limitations

- **Images are not deleted by the big wipe.** Files in Supabase Storage can't be removed from inside the database, so the wipe lists them in the `orphaned_images` table instead. Delete them from **Storage** > `chat-images` now and then, or storage will eventually fill up. Automating this (with a Supabase Edge Function) is a good first contribution.
- **Who is online is not private.** "Online" and "typing" signals use a Supabase Realtime channel that anyone holding the public key could listen to. They carry only random account IDs and room IDs, never names or messages.
- **The OP badge is cosmetic for now.** There are no moderation tools yet (deleting messages, muting people, removing groups).
- **Nobody can delete a group** in this version.
- A "word" is any run of characters between spaces, so `a-b-c-d` counts as one word.

## Check the rules yourself

The database rules come with 64 automated checks that run on your computer in an in-memory copy of Postgres. You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm test
```

## What's where

```
index.html                 the page
css/style.css              the 90s look
js/config.js               your Supabase URL and key (empty = demo mode)
js/rules.js                word counting + friendly error messages
js/app.js                  everything you see and click
js/backend-supabase.js     talks to Supabase
js/backend-demo.js         the pretend server for demo mode
supabase/schema.sql        tables, rules, permissions (run once in Supabase)
supabase/tests/            automated checks for the rules
assets/pazhampori.svg      the logo, a banana fritter
```

## Contributing

Issues and pull requests are welcome. If you change a rule, change it in `supabase/schema.sql` first (that's where it is enforced), mirror it in `js/rules.js` and `js/backend-demo.js`, and add a check to `supabase/tests/rules.test.mjs`.

## License

[MIT](LICENSE)
