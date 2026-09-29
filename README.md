# Pazhampori chat

An invite-only chatroom that looks and feels like 1998. One Global chat, groups anyone can make or join, and friend chats that need both people to say yes.

Built with plain HTML, CSS and JavaScript (no build step) on top of [Supabase](https://supabase.com) for accounts, messages, live updates and image storage.

## The rules

These are enforced by the database itself (`supabase/schema.sql`), so nobody can skip them by poking at the page.

| Rule | Default |
| --- | --- |
| Words per message in Global chat and groups | 8 (and 160 characters) |
| Flood control | 10 messages within 60 seconds means a 5-minute wait |
| Images | Allowed in Global chat and groups. After sending one, you can't send anything for 2 minutes |
| Where cooldowns apply | The image cooldown and flood control always apply in Global chat, and in groups unless an admin switches them off for that group. Friend chats never have them. A cooldown from Global doesn't stop you posting in a group that has them off |
| The big wipe | When Global chat and all groups together reach 1,000,000 words, every message in them is erased and everyone starts on a blank page. Groups themselves stay. Friend chats are not counted or erased |
| Friends | Send a request, the other person accepts, then you get a private chat. Up to 200 words per message, no images |
| Joining | Invite links only. Any member can make one: it works for 7 days, for any number of people, until its creator or an admin switches it off. Up to 5 live links per member |
| Signing in | Google only. New people get in only by opening an invite link and signing in with Google |

Every number above lives in the `settings` table. Change it there (Supabase > Table Editor > settings) and it takes effect immediately, no code change.

## Friends, admins and bans

- **Click any username** (in Global chat, a group, or the people list) to open their member card. Inside a group, the people list's ALL tab shows only that group's members, and the online count at the top counts only them. From there you can send a friend request, accept one, or open your private chat.
- **Admins** show as **[OP]**. The first account ever created is the **founder**: an admin nobody can demote or ban.
- **Admins can:** make someone an admin, make an admin a regular again (including stepping down themselves), ban and unban. These buttons appear on the member card under **Admin tools · whole chat**, and making someone an admin asks you to confirm first. Admins run all of Pazhampori chat; there are no group-only admins.
- **Invite to group:** on anyone's member card, admins can invite them to any group, open or locked. They see **invited** next to the group and press **Join room**.
- **A ban** locks the person out right away: they can't read, post, upload, invite or send friend requests. Their unused invite codes and pending friend requests are deleted. An admin can unban them at any time.
- **Admins can't be banned directly.** Make them a regular first. The founder can never be banned.
- **Every admin action is announced** in Global chat, IRC style: `*** ADMIN_Jen sets mode +o cyberSuze (now an admin)`.

## Groups without cooldowns

- **Admins can switch cooldowns off in any group** with the **Cooldowns off** button at the top of it (an hourglass on phones). Press it again to switch them back on.
- In that group, sending an image doesn't lock you and there's no flood wait. The 8-word limit still applies, and messages still count toward the big wipe.
- The group is told when it happens (`*** ADMIN_Jen switched off cooldowns in #skate_spot`).
- Global chat always keeps its cooldowns.

## Locked groups

- **Only admins can create locked groups** (tick "Locked group" in Create group), or lock an existing group with the **Lock group** button at the top of it.
- Everyone can see a locked group exists (it has a small padlock), but only members can read it.
- **To get in**, someone presses **Ask to join**, and any admin can **Let in** or say **No** from a bar at the top of the group. Or an admin invites them from their member card (**Invite to group**), and they press **Join room**.
- Admins can walk into any locked group. Unlocking a group lets anyone join and clears waiting requests.

## Try it without setting anything up

Download the repo and double-click `index.html`. With no Supabase details in `js/config.js`, it runs in **demo mode**: pretend people, pretend messages, the same rules, nothing saved. In the demo you are the founder, so you can try every admin tool.

## Put it online (about 45 minutes, no coding)

### 1. Create the database

1. Sign up at [supabase.com](https://supabase.com) and click **New project**. Pick the region closest to your friends (for Kerala, **Mumbai**). Save the database password somewhere safe.
2. When the project is ready, open **SQL Editor** > **New query**.
3. Open `supabase/schema.sql` from this repo, copy all of it, paste it in, and click **Run**.
4. The result at the bottom shows `your_first_invite_code` (valid for 30 days). Copy it. The first person to join with it becomes the **founder**.

### 2. Switch off email sign-in

Pazhampori chat is Google-only. In Supabase open **Authentication** > **Sign In / Providers** > **Email** and switch the Email provider **off**, then **Save**. The database also refuses to make a member out of anything but a Google account, so this is a second lock on the same door.

### 3. Switch on Google sign-in

In **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)):

1. Create a project (any name, e.g. "Pazhampori chat").
2. Open **Google Auth Platform** (or **APIs & Services** > **OAuth consent screen**) and set it up: app name "Pazhampori chat", your email as support email, audience **External**.
3. Under **Data Access / Scopes**, keep only the basic ones: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
4. Under **Audience**, press **Publish app** so it's **In production**. With only those basic scopes Google doesn't require a review, and people don't see a warning ([Google's rules](https://support.google.com/cloud/answer/15549945)). If you leave it in Testing, only 100 people you list by hand can sign in.
5. Under **Clients** (or **Credentials**), create an **OAuth client ID** of type **Web application**.
   - **Authorized JavaScript origins:** your site, e.g. `https://vickiekuttan.github.io`
   - **Authorized redirect URIs:** the **Callback URL** shown on Supabase's Google provider page. It looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
6. Copy the **Client ID** and **Client secret**.

Then in Supabase: **Authentication** > **Sign In / Providers** > **Google** > switch it on, paste the Client ID and Client secret, and **Save**.

### 4. Connect the page to the database

1. In Supabase open **Project Settings** > **API** (or **API Keys**). Copy the **Project URL** and the **anon / publishable** key.
2. On GitHub, open `js/config.js`, click the pencil icon, paste both values between the quotes, and click **Commit changes**.

The anon key is designed to be public. The rules in the database are what keep the chat safe. Never paste the **service_role / secret** key anywhere in this repo.

### 5. Publish it

**GitHub Pages** (free, same place as the code):

1. In the repo, go to **Settings** > **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the page shows your site's address: `https://vickiekuttan.github.io/Pazhampori-Chat/`.
4. Back in Supabase: **Authentication** > **URL Configuration**. Set **Site URL** to that address, and add the same address under **Redirect URLs**. Without this, Google sign-in sends people to the wrong place.

### 6. Join as the founder

Open your site with your first invite code on the end:

`https://vickiekuttan.github.io/Pazhampori-Chat/#invite=YOUR_CODE`

Pick your screen name and join with Google. Then press **Invite** in the toolbar to make links for your friends.

## Free plan limits to know about

Checked against [supabase.com/pricing](https://supabase.com/pricing) in September 2026:

- 500 MB database. 1,000,000 words of chat is roughly 125,000 messages, which fits comfortably.
- **1 GB of image storage.** See the note on images below.
- 200 people connected at the same time.
- **Free projects pause after a week with no activity.** Open the Supabase dashboard and click **Restore** if that happens.

## Known limitations

- **Images are not deleted by the big wipe.** Files in Supabase Storage can't be removed from inside the database, so the wipe lists them in the `orphaned_images` table instead. Delete them from **Storage** > `chat-images` now and then, or storage will eventually fill up. Automating this (with a Supabase Edge Function) is a good first contribution.
- **Who is online is not private.** "Online" and "typing" signals use a Supabase Realtime channel that anyone holding the public key could listen to. They carry only random account IDs and room IDs, never names or messages.
- **Bans are per account, not per person.** A banned person could come back with a different Google account if someone sends them a fresh invite link.
- **No message deleting yet.** Admins can ban people but can't remove individual messages or groups.
- **Anyone can sign in with Google, but only invited people become members.** Someone without an invite just sees "you need an invite link". Their empty sign-in still appears under **Authentication** > **Users**; delete those now and then if you like.
- **Invite links are reusable for 7 days.** If a link gets posted somewhere public, switch it off from the **Invite** window. The member card doesn't show who invited whom yet, but it's recorded (`profiles.invited_by`).
- A "word" is any run of characters between spaces, so `a-b-c-d` counts as one word.

## Check the rules yourself

The database rules come with 164 automated checks that run on your computer in an in-memory copy of Postgres. You need [Node.js](https://nodejs.org) 18 or newer.

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
supabase/migrations/       updates for a database set up from an older schema.sql
supabase/tests/            automated checks for the rules
assets/logo*.png           the logo (fritter + lettering) at 1x, 2x and full size
assets/favicon.png         the browser-tab icon
```

## Contributing

Issues and pull requests are welcome. If you change a rule, change it in `supabase/schema.sql` first (that's where it is enforced), mirror it in `js/rules.js` and `js/backend-demo.js`, and add a check to `supabase/tests/rules.test.mjs`.

When you change anything in `css/` or `js/`, bump the `?v=` number on the links at the bottom and top of `index.html`. Browsers keep old copies of those files for a few minutes, and a new number makes everyone load the new ones together with the new page.

## License

[MIT](LICENSE)
