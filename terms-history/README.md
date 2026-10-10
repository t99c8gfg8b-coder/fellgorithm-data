# Agreement card versions

Every version of the agreement cards (terms.json) that has gone out to phones since LAUNCH is kept here, one file per version: `v1.json`, `v2.json`, …

- **v1 = the wording in the first live app** (owner, 9 Oct). Until launch, terms.json carries `"prelaunch": true`, the version stays at 1 and `v1.json` is simply rewritten whenever the wording changes. At launch, delete the `prelaunch` line — from then on v1 is frozen.
- **After launch, never edit or delete a file in this folder.** It is the record of exactly what people agreed to, and when. Match a user's acceptance date (shown on their itinerary under *View agreement*) to the version that was live that day — the daily audit records which version was in use each day.
- The hourly job copies terms.json here automatically (signals.mjs). The Mac app's Agreement cards screen lists these versions and can show any two side by side.
- `pre-launch/` holds drafts from before launch (7–9 Oct 2026: the 13 cards, and briefly a 14th bus-change card that was removed). Nobody outside testing ever agreed to them.
