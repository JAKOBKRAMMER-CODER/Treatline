# Threadline v2 — Groups, files, voice, reactions & more

Builds on the earlier GitHub Pages + Supabase version. New: group chats (with invite links), image/file attachments, voice messages, edit/delete, emoji reactions, and online/typing status.

## If you already have Threadline v1 set up

You only need to run **one more SQL file** and update your three frontend files — your existing Supabase project, users, and messages are kept.

### 1. Run the migration

1. Supabase dashboard → **SQL Editor** → **New query**.
2. Open `schema_v2.sql` from this project, copy everything, paste it in.
3. Click **Run**. This adds the new tables/columns and updates security rules — it's safe, your existing data stays intact.

### 2. Check Realtime is on for the new tables

Dashboard → **Database** → **Replication** → confirm `conversation_members`, `message_reactions`, `presence`, and `typing_status` are toggled on (the SQL script does this automatically, but worth a glance).

### 3. Replace your frontend files

Upload these three files to your GitHub repo, overwriting the old ones:
- `index.html`
- `app.js`
- `style.css`

`config.js` stays exactly as it is — same Supabase URL and key as before.

### 4. Hard-refresh

Ctrl+Shift+R (or Cmd+Shift+R on Mac) after GitHub Pages redeploys (~1-2 min), since browsers cache these files aggressively.

## Starting fresh (no v1 yet)

1. Follow the original setup: create a Supabase project, run `schema.sql`, then run `schema_v2.sql` on top of it.
2. Fill in `config.js` with your project URL and anon key.
3. Upload everything to GitHub, enable GitHub Pages.

Full original steps are in the earlier README if you need the Supabase account/project walkthrough again.

## What's new

- **Group chats** — tap 👥+ to create one, add members by username. Existing members can generate a shareable invite link (🔗 in the chat header) that lets anyone with the link join.
- **Attachments** — 📎 sends images or files (PDF, Word, txt, zip), stored in Supabase Storage.
- **Voice messages** — 🎤 records from your microphone, sends as a playable audio clip. Needs microphone permission in the browser.
- **Edit / delete** — hover your own message to see the options. Deleted messages show "Message deleted" for everyone instead of disappearing silently.
- **Reactions** — hover any message, tap ☺ to react; tap an existing reaction to add/remove yours.
- **Online status & typing** — green dot on a contact's avatar when they're online; "is typing…" appears live while someone types.

## Known limitations

- Typing/online status use short polling (every 2 seconds) layered on Supabase Realtime events, not a dedicated presence protocol — there can be a second or two of lag, which is normal.
- Invite links don't expire unless you add that yourself (the `expires_at` column exists in the schema but isn't enforced yet).
- No read receipts *within* group chats (read/unread only tracked per-user at the message level, no "seen by" list).
- No push notifications when the browser tab is closed.
- File size limits follow Supabase Storage's defaults (50MB per file on the free plan).

## Files in this project

```
index.html      Page markup: auth, chat UI, group creation panel
style.css        All styling, including v2 additions at the bottom
app.js           All frontend logic
config.js        Your Supabase URL + anon key (fill this in)
schema.sql       Original database schema (run first, if starting fresh)
schema_v2.sql    Migration adding groups/attachments/reactions/presence (run second)
```
