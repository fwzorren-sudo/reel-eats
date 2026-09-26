# Reel Eats

A personal catalog for restaurants you see in Instagram reels. Share a reel from Instagram, and Reel Eats works out which restaurant it shows. It finds the restaurant on Google Maps and, for chains, keeps the branch closest to your home. It then pins the place on your map.

The phone app has four views:

- **Map**: every saved place as a pin, colored by whether you've been, with your home marked.
- **List**: sorted by distance from home, distance from where you are now, newest, or name. Search matches names, dishes, cities and notes.
- **Categories**: tiles such as Pizza, Tacos & Mexican or Coffee & Cafe, with counts. Tap one to filter the list.
- **Settings**: home address, miles or kilometers, sharing setup, re-checking branches after a move, and CSV or JSON export.

Each place opens a detail card. It has Google Maps and Apple Maps links, a link back to the reel, the dishes the reel highlighted, and Google's rating and price level. You can mark a place visited, rate it, add notes, pick a different branch, or fix a wrong match.

## How it works

```
Instagram share button
  -> iPhone Shortcut (or the installed app on Android)
  -> POST /api/share on your Cloudflare Worker
       1. read the reel's caption, author and location tag from Instagram's public embed page
       2. Claude identifies the venue(s), using a few web searches if the caption only has an @handle
       3. Google Places searches near your home and in the reel's city, and keeps the closest matching branch
       4. save to a Cloudflare D1 database
  -> the phone app (a web app you add to your home screen) shows it on the map
```

A reel that lists several places ("top 5 tacos in Austin") becomes several entries. Sharing the same reel twice doesn't create duplicates. Saving a different branch of a chain you already have is treated as a duplicate too.

When the reel doesn't name the place, the share shows up in the app under "Just shared" with a box for the name. Type it and Reel Eats retries. You can also add a place by pasting a link, typing a name, or uploading a screenshot.

## What you need

| Item | Where | Cost |
| --- | --- | --- |
| Cloudflare account | dash.cloudflare.com | Free plan covers Workers and D1 for personal use |
| Anthropic API key | console.anthropic.com | Pay per use. See the estimate below |
| Google Maps Platform API key with **Places API (New)** enabled | console.cloud.google.com | Google gives a free monthly allowance per Places API SKU. A personal list uses a small part of it |
| Node.js 20 or newer | nodejs.org | Free |

**Rough Claude cost:** with the default model, Claude Opus 5 at medium effort, expect a few cents per saved reel. It can reach about 15 cents when Claude has to run web searches. Set `CLAUDE_EFFORT` to `low` to spend less. Set a monthly spend limit in the Anthropic console, and a budget alert in Google Cloud.

## Setup

Run these from this folder.

1. **Install and sign in to Cloudflare.**

   ```sh
   npm install
   npx wrangler login
   ```

2. **Create the database.** Copy the `database_id` it prints into `wrangler.jsonc`, replacing the zeros.

   ```sh
   npx wrangler d1 create reel-eats
   ```

3. **Create the Google key.** In Google Cloud, create a project, enable **Places API (New)**, and create an API key. Under the key's API restrictions, allow only Places API (New).

4. **Store the three secrets.** Each command asks you to paste the value. The access code is a password you make up. The phone app and the Shortcut both use it.

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put GOOGLE_MAPS_API_KEY
   npx wrangler secret put APP_TOKEN
   ```

   One way to generate a strong access code:

   ```sh
   openssl rand -base64 24
   ```

5. **Deploy.** This creates the tables and publishes the Worker. It prints your app's address, which looks like `https://reel-eats.<your-subdomain>.workers.dev`.

   ```sh
   npm run deploy
   ```

6. **Open the app on your phone.** Visit the address, enter the access code, then go to Settings and save your home address.
   - iPhone: in Safari, tap Share, then **Add to Home Screen**.
   - Android: in Chrome, tap the menu, then **Install app**.

## Share from Instagram on iPhone

iPhone web apps can't appear in the share menu, so a Shortcut does it. You build it once in the Shortcuts app. Settings in Reel Eats shows the share address and has a button to copy your access code.

1. Open **Shortcuts**, tap **+**, and name the shortcut **Reel Eats**.
2. Tap the **i** (details) button. Turn on **Show in Share Sheet**. Under the share sheet types, keep only **URLs** and **Text**.
3. Add the action **Get Contents of URL** and set:
   - URL: your share address, for example `https://reel-eats.<your-subdomain>.workers.dev/api/share?format=text`
   - Method: **POST**
   - Headers: add `Authorization` with the value `Bearer ` followed by your access code, with one space after "Bearer"
   - Request Body: **Form**. Add a **Text** field named `url` and set its value to the **Shortcut Input** variable.
4. Add the action **Show Notification** and set its text to **Contents of URL**.

To use it, open a reel in Instagram and tap the paper-plane Share button. Then open the iPhone share menu from the end of the bottom row and pick **Reel Eats**. A notification confirms the save, and the app shows the place a few seconds later.

**Optional name prompt.** Add **Ask for Input** before step 3 with the prompt "Restaurant name (optional)". Then add a second Text form field named `note` set to **Provided Input**. This costs one extra tap per share, but it rescues reels whose captions never name the place.

**Wait for the result.** Change the URL to end in `?format=text&wait=1`. The notification then names the restaurant and its distance from home. The share menu stays open for about 10 to 30 seconds while it works.

**Screenshots.** Make a second shortcut named **Reel Eats Screenshot** that receives **Images**. Add **Convert Image** to JPEG, then **Resize Image** to width 1280. Next, add **Get Contents of URL** with the same URL and header, and a Form body with a **File** field named `image` set to the resized image. Finish with **Show Notification**. Share a screenshot of the caption or location tag from Photos.

## Share from Instagram on Android

Install the app from Chrome as in setup step 6. After that, **Reel Eats** appears in Android's share menu. In Instagram, tap Share on a reel, then the share-menu icon at the end of the bottom row, then Reel Eats. The app opens and shows the result. It can take a minute after installing before Reel Eats shows up in the menu.

## Using the app

- **To try, Visited, All**: the switch at the top filters every view. The category menu next to it narrows further.
- **Nearest branch**: the detail card says "Closest of 3 locations found". Open **All 3 locations** to switch to another branch.
- **Wrong match**: open **Wrong place?** on the detail card, search Google Maps, and pick the right result.
- **Moving house**: save the new address in Settings. Distances update right away, and chains switch to the closest branch Reel Eats already knows about. Tap **Re-check nearest branches** to search again around the new home.
- **Backups**: Settings exports the whole list as CSV or JSON.

## Settings you can change

These live under `vars` in `wrangler.jsonc`. Redeploy after editing.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_MODEL` | `claude-opus-5` | The Claude model that identifies restaurants. |
| `CLAUDE_EFFORT` | `medium` | `low`, `medium` or `high`. Lower is cheaper and faster. Ignored for Haiku. |
| `CLAUDE_WEB_SEARCH` | `on` | Set to `off` to stop Claude from running web searches. |

On Claude Opus 5 and Claude Fable models, requests opt into Anthropic's server-side fallback, `fallbacks: "default"`. If a safety check declines a request, the API re-runs it on Anthropic's recommended fallback model instead of failing. A restaurant caption is very unlikely to trigger this. To opt out, remove the `fallbacks` line in `src/extract.ts`.

## Limits and privacy

- **Instagram can block cloud servers.** Reel Eats reads the public embed page, which usually works without logging in. When Instagram refuses, Claude sees only the link, and the app asks you for the name. The name prompt or a screenshot avoids that.
- **Private accounts and stories** can't be read.
- **Where your data goes.** The list and your home address are stored in your own Cloudflare D1 database. Captions, your notes and screenshots are sent to the Anthropic API to identify the place. Restaurant names and your home location are sent to Google Places to find branches. A screenshot is deleted from the database once its place is saved.
- **Access.** Anyone with the access code can read and change your list. Rotate it with `npx wrangler secret put APP_TOKEN`, then enter the new code on your phone and in the Shortcut.
- **Workers free plan.** The free plan limits CPU time per request. If saves fail with a "CPU time limit" error in the Cloudflare dashboard, the Workers Paid plan raises that limit.

## Development

```sh
cp .dev.vars.example .dev.vars          # fill in real keys to try the full flow
npm run db:migrate:local
npm run dev                             # http://localhost:8787
npm test                                # unit tests
npm run typecheck
```

### Testing without real API keys

`test/e2e/mock-upstreams.mjs` stands in for Claude, Google Places and a reel page. `test/e2e/smoke.mjs` then runs the whole API against `wrangler dev`: sharing, chains, multi-place reels, duplicates, retries, screenshots, branch switching and moving house.

```sh
node test/e2e/mock-upstreams.mjs 8799 &
npm run db:migrate:local
npx wrangler dev --var APP_TOKEN:test-code --var ANTHROPIC_API_KEY:sk-test \
  --var GOOGLE_MAPS_API_KEY:test-google-key \
  --var ANTHROPIC_BASE_URL:http://127.0.0.1:8799 --var PLACES_BASE_URL:http://127.0.0.1:8799 &
node test/e2e/smoke.mjs
```

### Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | API routes and access-code check |
| `src/pipeline.ts` | Processing a share from start to finish |
| `src/source.ts` | Reading captions from Instagram, TikTok and other links |
| `src/extract.ts` | The Claude request that identifies venues |
| `src/places.ts` | Google Places search and choosing the nearest branch |
| `src/db.ts`, `migrations/` | D1 tables and queries |
| `public/` | The phone app, which is plain HTML, CSS and JavaScript with no build step |
