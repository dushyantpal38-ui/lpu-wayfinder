# LPU Wayfinder (Next.js + shadcn + Tailwind)

One page, like the reference screenshot:

- **Left:** the LPU Wayfinder header, a search bar, and the list of every block (number badge and name). Tap a block and the
  map highlights that building, flies to it, and shows how far it is from you.
- **Right:** the live campus map with your blue dot. It starts flat, facing you (top-down). The 3D button tilts it so buildings
  stand up. On a phone the map is on top and the list is below.

`components/ui/interactive-campus-explorer.tsx` (the scrolling globe-style list) is still in the folder but is not used on the page.

## Run it

1. Install Node.js 20 or newer from https://nodejs.org
2. In this folder:

```bash
npm install
cp .env.local.example .env.local      # on Windows: copy .env.local.example .env.local
npm run dev
```

3. Open http://localhost:3000 (your location works on localhost; on a phone you need an https address, see Deploy).

If `npm run build` or the page shows an error, run `npx tsc --noEmit` to list type problems. This project was written
without being compiled, so expect to fix a few small things on the first run.

## Deploy (free)

Push the folder to GitHub, then import it at https://vercel.com. Add the two variables from `.env.local.example`.
Vercel gives you an https address, which phones need for GPS.

## Where things are

| File | What it does |
| --- | --- |
| `components/ui/interactive-campus-explorer.tsx` | The globe component's layout, with the campus map. Search bar on top of the block list. |
| `components/live-campus-map.tsx` | The live map: location dot, search, 3D, rotate, distance to the block. |
| `components/campus-map.tsx` | The dark MapLibre map used by both. Labels, highlight, fly-to. |
| `components/campus-provider.tsx` | Loads the campus (OpenStreetMap) and the blocks (Supabase) once for the whole page. |
| `lib/campus.ts` | Campus loading, the block-number placement from the 2011 plan, search. |
| `lib/supabase.ts` | Reads `campus_blocks` and `campus_labels`. |

## Block numbers on buildings

Positions saved in the Supabase table `campus_blocks` (`lng`, `lat`) always win. Blocks without a position get a guess from the
2011 site plan, laid out from the main gate. To fix them, use the pencil edit tool in the older single-file `index.html`,
press Copy SQL, and run the SQL in Supabase (or send it to Claude). The new site then shows those positions.

Names and parks you add as text labels are stored in `campus_labels` and show on both maps.
