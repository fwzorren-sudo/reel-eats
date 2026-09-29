# Reel Eats

A personal catalog for restaurants you see in Instagram reels. Share a reel from Instagram, and Reel Eats works out which restaurant it shows. It finds the restaurant on Google Maps and, for chains, keeps the branch closest to your home. It then pins the place on your map.

It runs on free tiers. You don't need a Claude or OpenAI key.

The phone app has four views:

- **Map**: every saved place as a pin, colored by whether you've been, with your home marked. A button shows where you are now.
- **List**: each place with the reel's cover image, open or closed right now, how far it is, and Google's price range. Sort by distance from home, distance from where you are, newest, or name. Search matches names, dishes, cities, tags and notes. A row of filter icons (Go soon, Date night, Coffee, Cocktails, Brunch, Outdoor, Late night, Under $20) narrows the list; pick several to see places that have them all.
- **Browse**: tiles by category (Pizza, Coffee & Cafe), by city, or by occasion (date night, outdoor seating, and "Go soon" for new openings and pop-ups). Tap one to filter the list.
- **Settings**: home address, a color theme (Berry, Ocean, Teal, Grape, Espresso or Slate, light, dark or matching the phone, kept on each phone), sharing setup, partner codes, read-only links, Apify credit, and exports to CSV, JSON or Google My Maps.

**Open now** at the top filters every view to places open at this moment, in each place's own time zone. Together with the location button or "Nearest me", that's "what's open near me".

Each place opens a detail card:

- every reel that recommended it, with the creator and date ("Recommended by 3 creators")
- Google Maps, Apple Maps, the restaurant's Instagram account and website
- **Menu**: a link to the menu, found on the restaurant's own website. Where the site has none, **Menu on Google Maps** opens the place in Google Maps, whose Menu tab has the menu photos people post
- today's hours and the full week, Google's rating, price level and price range per person, and the phone number
- Google's **Review summary** of what people say, and what Google lists the place as having (outdoor seating, live music, good for groups and so on)
- occasion tags and a "go soon" note when the reel says it just opened, is a pop-up, or has something for a limited time
- links to book a table on OpenTable or Resy

You can mark a place visited, rate it, add notes, edit its tags, pick a different branch, fix a wrong match, or archive it.

## How it works

```
Instagram share button
  -> iPhone Shortcut (or the installed app on Android)
  -> POST /api/share on your Cloudflare Worker
       1. read the reel through Apify, two readers side by side:
            - Post Details: caption, poster, tagged accounts, post date, cover image,
              and the location tag with its coordinates
            - Transcripts: what's said in the video
          Apify's own Instagram Scraper takes over if Post Details fails.
          Without an Apify token, Instagram's public page is used.
       2. collect likely venue names:
            - a name you typed
            - "📍" lines in the caption
            - the location tag
            - Cloudflare Workers AI reading the caption and transcript
            - if none of those work: tagged accounts, @mentions and the poster
       3. Google Places checks each name around where the reel was filmed, keeps only
          real food and drink businesses, and picks the branch closest to your home
       4. save to a Cloudflare D1 database, with the reel's cover image and the raw
          Apify results
  -> the phone app shows it on the map
```

Google does the checking, so a wrong guess from the caption usually just finds nothing. An @mention of a friend or a food blogger doesn't match a restaurant and is skipped.

A reel that pins several places ("top 5 tacos in Austin") becomes several entries. Sharing the same reel twice doesn't create duplicates. Saving a different branch of a chain you already have counts as a duplicate too. When a second creator's reel points at a place you already have, the reel is added to that place instead, so you can see how many creators recommend it.

When nothing in the reel leads to a restaurant, the share waits in the app under "Just shared" with a box for the name. Type it and Reel Eats retries.

## What you need

| Item | Needed? | Cost |
| --- | --- | --- |
| Cloudflare account | Yes | The free plan covers the Worker, the database and Workers AI for personal use |
| Google Maps Platform key with **Places API (New)** | Yes | Google gives a free monthly allowance per Places API SKU. A personal list uses a small part of it |
| Apify account and API token | Recommended | Apify charges per result, about $0.01 per reel for post details and transcript together. The free plan's $5 a month covers roughly 500 reels. Check each actor's page for current pricing |
| Node.js 20 or newer | Yes, to deploy | Free |
| Anthropic API key | No | Optional upgrade, see below |

**Why Apify helps.** Instagram often refuses requests from cloud servers. When that happens, Reel Eats only has the link, so it asks you for the name. Apify fetches the caption, location tag, tagged accounts and transcript reliably. The app warns you when 80% of the month's Apify credit is used, and again if it runs out.

**Google allowance.** Opening hours and the price range come from the same Google Places price tier as the rating and phone number Reel Eats already uses, so they add no cost of their own. The daily job re-checks each place about once a month, which uses one Place Details request per place.

**Review summaries.** The review summary and Google's list of features are in Google's Atmosphere tier (Place Details Enterprise + Atmosphere: 1,000 free a month, then $25 per 1,000). Google's terms don't allow storing them, so they're fetched each time a place is opened, once per visit to the app. `GOOGLE_EXTRAS_PER_DAY` (default 30) caps them a day, which keeps a month inside the free 1,000; past the cap, places open without them until the next day. Google's rules also require the "Review summary" heading, its "Summarized with Gemini" note, and the See reviews, About this summary and Report summary links, which the app shows.

**Menu links** come from each restaurant's website, not from Google, so they cost nothing. A site is searched the first time its place is opened and by the daily job, then again after a month. The Google Places API only hands out 10 photos per place and doesn't say which are menus; in a test of 14 places none of the 135 photos was one, so the app doesn't use them.

**Workers AI allowance.** Cloudflare includes 10,000 Workers AI "neurons" a day for free. With the default Llama 3.3 70B model, one reel with its transcript uses about 25 to 55, so the free allowance covers well over 100 reels a day.

**Choosing a model.** In September 2026, 14 saved reels were run through the pipeline with every larger model the free plan offers: gpt-oss 120B and 20B, Llama 4 Scout, Llama 3.1 8B, Mistral Small 3.1, Qwen3 30B, Qwen 3.8 27B (with `chat_template_kwargs: { enable_thinking: false }`), Gemma 4 26B, GLM 4.7 Flash and Granite 4.0 Micro. None found more restaurants or needed fewer fixes than Llama 3.3, which was also among the fastest (about 3 seconds). Gemma 4 and GLM 4.7 Flash usually took longer than the 15 seconds the app waits. Kimi K2.6, DeepSeek V4 and GLM 5.3 need the Workers Paid plan. Other models don't all accept the same request: some need OpenAI-style `response_format` and `reasoning_effort`, so changing `AI_MODEL` alone may not work.

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

3. **Create the Google key.** In Google Cloud, create a project, enable **Places API (New)**, and create an API key. Under the key's API restrictions, allow only Places API (New). Adding a budget alert is a good idea.

4. **Get an Apify token.** Sign up at apify.com. In Apify Console, open **Settings**, then **API & Integrations**, and copy your personal API token. Reel Eats uses three actors from the Apify Store: **Instagram Post Details** (`data-slayer~instagram-post-details`), **Instagram Transcripts** (`apple_yang~instagram-transcripts-scraper`), and Apify's own **Instagram Scraper** as a fallback. You don't need to set them up in Apify first. Each run has a spending cap of a few cents.

5. **Store the secrets.** Each command asks you to paste the value. The access code is a password you make up. The phone app and the Shortcut both use it.

   ```sh
   npx wrangler secret put GOOGLE_MAPS_API_KEY
   npx wrangler secret put APIFY_TOKEN
   npx wrangler secret put APP_TOKEN
   ```

   One way to generate a strong access code:

   ```sh
   openssl rand -base64 24
   ```

6. **Deploy.** This creates the tables and publishes the Worker. It prints your app's address, which looks like `https://reel-eats.<your-subdomain>.workers.dev`.

   ```sh
   npm run deploy
   ```

7. **Open the app on your phone.** Visit the address, enter the access code, then go to Settings and save your home address.
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

To use it, open a reel in Instagram and tap the paper-plane Share button. Then open the iPhone share menu from the end of the bottom row and pick **Reel Eats**. A notification confirms the save, and the app shows the place shortly after.

**Optional name prompt.** Add **Ask for Input** before step 3 with the prompt "Restaurant name (optional)". Then add a second Text form field named `note` set to **Provided Input**. This costs one extra tap per share. A typed name always wins, which rescues reels whose captions never name the place.

**Wait for the result.** Change the URL to end in `?format=text&wait=1`. The notification then names the restaurant and its distance from home. The share menu stays open for about 10 to 40 seconds while it works.

**Screenshots.** Your iPhone can read the text in a screenshot, so no AI service is needed for this. Make a second shortcut named **Reel Eats Screenshot** that receives **Images**. Add **Extract Text from Image** with the Shortcut Input. Then add **Get Contents of URL** with the same URL, method and header. Use a Form body with a **Text** field named `text` set to **Extracted Text**, and finish with **Show Notification**. Share a screenshot of the caption or location tag from Photos.

## Share from Instagram on Android

Install the app from Chrome as in setup step 7. After that, **Reel Eats** appears in Android's share menu. In Instagram, tap Share on a reel, then the share-menu icon at the end of the bottom row, then Reel Eats. The app opens and shows the result. It can take a minute after installing before Reel Eats shows up in the menu.

## Using the app

- **To try, Visited, All**: the switch at the top filters every view. **Open now** and the category menu next to it narrow further.
- **Browse**: switch between Categories, Cities and Occasions. "Go soon" collects new openings, pop-ups and limited-time items. The note fades after a few months, since "just opened" stops being true.
- **Nearest branch**: the detail card says "Closest of 3 locations found". Open **All 3 locations** to see every branch Google found and switch to another. A branch you pick stays put when you move house; **Use the closest branch** goes back.
- **Pop-ups and events**: when a reel is about a pop-up, takeover, seasonal menu or limited-time event, Reel Eats keeps the branch in the reel instead of the one nearest home, since that's where it's happening.
- **Wrong match**: open **Wrong place?** on the detail card, search Google Maps, and pick the right result.
- **Tags**: open **Edit details** on a place to add or remove occasions, or change the "go soon" note.
- **Archive**: for places you've decided against, that closed, or that are too far. Tap **Archive** on a place and optionally pick a reason: Not for me, Closed, Too far or Other. Archived places leave the map, the list, Browse, shared links and the monthly re-check, but keep their rating and notes. Sharing another reel of one doesn't save it again. They're under **Archived** at the bottom of the list, where **Unarchive** puts one back. **Delete** removes a place for good.
- **Moving house**: save the new address in Settings. Distances update right away, and chains switch to the closest branch Reel Eats already knows about. Tap **Re-check nearest branches** to search again around the new home.
- **Closures**: once a day the Worker re-checks places that haven't been checked for a month, updating hours, ratings and whether Google lists them as closed. A place that closed for good gets a red label, and the list shows a notice with a button to archive it. **Refresh hours and closures** in Settings runs the check now.
- **A partner's own code**: in Settings, under **Partner access**, type their name and tap **Make a code**. They sign in with that code, and it also works in their own iPhone Shortcut. What they save shows "Added by" with their name. They can't see or change partner codes or links. **Turn off** stops a code right away.
- **Read-only links**: under **Share a read-only list**, pick To try, Visited or All, and optionally one category. Anyone with the link sees those places on a map and list, without your notes, your home address or distances. **Turn off** disables the link.
- **Google My Maps**: **Google My Maps (KML)** in Settings downloads a file. In Google My Maps, create a map, tap **Import**, and pick it. Each pin has the category, status, tags, reel and Google Maps link, so My Maps can color pins by category.
- **Backups**: Settings also exports the whole list as CSV or JSON. Both include every other location found; JSON has each one's address, coordinates, phone and Google Maps link.
- **Debugging details**: at the bottom of each place, the owner can open a log of every attempt to process the reels behind it: what started it, which outside calls were made (Apify, Instagram, Google, Workers AI, Claude, the cover image), how long each took, what came back, and how it ended. A failed share in "Just shared" has a **Details** button with the same log. **Copy log** copies it as JSON. The last five attempts per reel are kept.

Every minute the Worker also finishes any share whose background job was cut short, so a reel you shared still lands within a minute or two even if you never open the app. Background work gets only 30 seconds on Cloudflare, so when Apify is slow to read a reel, the rest of the work is handed to that job instead of being cut off halfway.

### What's kept for each reel

Everything goes into your D1 database:

- the caption, poster, post date, location tag with coordinates, and transcript
- the raw results from both Apify readers, so reels can be reprocessed later without paying again
- a log of each attempt to process it, with timings and errors
- every other location Google found for the place
- a copy of the cover image, since Instagram's image links stop working after a few days
- every place the reel led to, with a link back to the reel

`POST /api/shares/<id>/reread`, with the owner's access code, runs a saved reel through the current rules and Workers AI again and fills in what its places are missing, such as dishes and tags. It reuses the stored Apify results, so it's free. Add the JSON body `{"fresh": true}` to read the reel from Apify again, which costs one Apify read; reels saved before raw results were kept need that.

## Settings you can change

These live under `vars` in `wrangler.jsonc`. Redeploy after editing.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model that reads captions. Set it to `off` to use only pins, tags and mentions. |
| `GOOGLE_EXTRAS_PER_DAY` | `30` | Most Google review summaries fetched a day. `0` turns them off. |
| `APIFY_POST_ACTOR` | `data-slayer~instagram-post-details` | Main Apify reader. Set it to `off` to use only the fallback. |
| `APIFY_ACTOR` | `apify~instagram-scraper` | Fallback reader when the main one fails. `apify~instagram-reel-scraper` also works. |
| `APIFY_TRANSCRIPT_ACTOR` | `apple_yang~instagram-transcripts-scraper` | Reads what's said in the video. |
| `APIFY_TRANSCRIPTS` | `on` | Set to `off` to skip transcripts and save about half the Apify cost. |

The Apify variables aren't in `wrangler.jsonc`. Add them under `vars` only to change them. Results for a different reel than the one shared are ignored. The daily job's time is in `triggers` in `wrangler.jsonc` and `DAILY_CRON` in `src/upkeep.ts`; change both together.

### Optional: use Claude instead

With an Anthropic API key, Claude replaces Workers AI. Claude is better at captions that describe a place without naming it, and it can read uploaded screenshots in the app. Add the key with `npx wrangler secret put ANTHROPIC_API_KEY` and redeploy. A Claude.ai subscription doesn't include API access. The key comes from console.anthropic.com and is billed per use.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_MODEL` | `claude-opus-5` | The Claude model used when a key is set. |
| `CLAUDE_EFFORT` | `medium` | `low`, `medium` or `high`. Lower is cheaper and faster. |
| `CLAUDE_WEB_SEARCH` | `on` | Set to `off` to stop Claude from running web searches. |

With Claude Opus 5, requests opt into Anthropic's server-side fallback, `fallbacks: "default"`. If a safety check declines a request, the API re-runs it on a fallback model instead of failing. To opt out, remove the `fallbacks` line in `src/extract.ts`.

## Limits and privacy

- **Captions that never name the place.** Without Claude, Reel Eats relies on what the post points at: pins, the location tag, tagged accounts and mentions, plus Workers AI's reading of the caption. A reel that only says "best tacos ever" needs you to type the name.
- **Private accounts and stories** can't be read.
- **Where your data goes.** The list and your home address are stored in your own Cloudflare D1 database. Reel links go to Apify if you set a token, including to the two third-party actors named above. Captions and transcripts go to Cloudflare Workers AI, which runs on Cloudflare's network under your account. Restaurant names, your home location and the reel's location go to Google Places. The Worker also opens each restaurant's own website to look for a menu link. Nothing goes to Anthropic unless you add a Claude key.
- **Access.** Anyone with the owner's access code can read and change your list and its settings. Rotate it with `npx wrangler secret put APP_TOKEN`, then enter the new code on your phone and in the Shortcut. Partner codes can read and change places but not settings; only a hash of each is stored, so a lost code can't be shown again. Make a new one instead.
- **Read-only links** are long random addresses. Anyone who has one can see that list until you turn it off. Cover images are served at unguessable addresses without a code, so shared lists can show them.
- **Workers free plan.** The free plan limits CPU time per request. If saves fail with a "CPU time limit" error in the Cloudflare dashboard, the Workers Paid plan raises that limit.

## Development

```sh
cp .dev.vars.example .dev.vars          # fill in real keys to try the full flow
npm run db:migrate:local
npm run dev                             # http://localhost:8787, Workers AI needs `wrangler login`
npm test                                # unit tests
npm run typecheck
```

### Testing without real API keys

`test/e2e/mock-upstreams.mjs` stands in for the three Apify actors, Google Places, Claude and a web page. `test/e2e/smoke.mjs` runs the whole API against `wrangler dev`. It covers mentions, location tags, pins, chains, list reels, duplicates, a second creator's reel, the fallback reader, transcripts, tags, hours, cover images, retries, typed names, branch switching, moving house, partner codes, read-only links, the monthly re-check, price ranges, review summaries and their daily cap, and menu links. `test/e2e/wrangler.e2e.jsonc` is the same Worker without the Workers AI binding, because that binding always needs a Cloudflare login.

```sh
node test/e2e/mock-upstreams.mjs 8799 &
npx wrangler d1 migrations apply reel-eats --local -c test/e2e/wrangler.e2e.jsonc
npx wrangler dev -c test/e2e/wrangler.e2e.jsonc --test-scheduled --var APP_TOKEN:test-code \
  --var GOOGLE_MAPS_API_KEY:test-google-key --var PLACES_BASE_URL:http://127.0.0.1:8799 \
  --var APIFY_TOKEN:test-apify --var APIFY_BASE_URL:http://127.0.0.1:8799 &
MODE=rules node test/e2e/smoke.mjs
```

To test the Claude path, add `--var ANTHROPIC_API_KEY:sk-test --var ANTHROPIC_BASE_URL:http://127.0.0.1:8799` to `wrangler dev`, start with a fresh local database, and run with `MODE=claude`.

To run the scheduled jobs locally, open `http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+8+*+*+*` for the daily job, or `?cron=*+*+*+*+*` for the every-minute one.

### Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | API routes, access codes, read-only links and the scheduled jobs |
| `src/pipeline.ts` | Processing a share from start to finish |
| `src/upkeep.ts` | The daily job: Google re-checks, cover-image backfill, menu links, Apify credit |
| `src/menu.ts` | Finding the menu link on a restaurant's website |
| `src/source.ts` | Reading reels through Apify, Instagram's public page, TikTok and other links |
| `src/tags.ts` | Occasion tags and "go soon" notes found in captions and transcripts |
| `src/media.ts` | Keeping copies of reel cover images |
| `src/identify.ts` | Finding venue names in pins, tags, mentions and typed notes |
| `src/workersai.ts` | The Workers AI request that reads captions |
| `src/extract.ts` | The optional Claude request |
| `src/places.ts` | Google Places search, food filtering, categories and choosing the nearest branch |
| `src/db.ts`, `migrations/` | D1 tables and queries |
| `public/` | The phone app, which is plain HTML, CSS and JavaScript with no build step. `hours.js` works out "open now"; `kml.js` writes the Google My Maps file |
