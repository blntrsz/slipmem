# MVP product tour evidence

Status: **final recording complete**. The recording is a real production-build
run of the disposable scenario, not a rehearsal.

- Recorded: 2026-11-18 00:51–00:53 UTC.
- Source commit at recording:
  `e408e474d3088b691f834574d8e5b5e5b78666ed` (`e408e47`, app/web source at
  the recorded head).
- Evidence head before this document was committed:
  `5703fd6b6e3789eb9a6816882c3da48aa4f7acda` (`5703fd6`). That commit is
  docs-only; `git diff e408e47 5703fd6 -- packages scripts/tour` is empty.
- Recording command: `bash scripts/tour/run-product-tour.sh` with the product
  tour runner described in `scripts/tour/README.md`. The command built the web
  bundle, seeded notes through the real CLI, started the production server,
  submitted the MCP proposal, recorded the browser, and ran the scenario
  postcondition check.

## Artifacts

Media is gitignored under `scripts/tour/output/`. These paths are relative to
the repository root.

| Artifact | Path | Size | SHA256 |
| --- | --- | ---: | --- |
| Final MP4 | `scripts/tour/output/slipmem-product-tour.mp4` | 3,018,971 B | `a429e44bf936f0f4f0ed394e0af8f3642f1338ab9863fa33536ab5f4d7cb96a0` |
| Source WebM | `scripts/tour/output/slipmem-product-tour.webm` | 14,102,328 B | `41a714d847d3b36cdffa08995f8c9da665c69fcc647abe886e17407655469f9c` |
| Poster | `scripts/tour/output/slipmem-product-tour-poster.png` | 508,102 B | `f7bc2c08d3234040fffd1927f2e5c0eaac440b22d6ae90ce4f0d9f52033d883d` |
| Verification JSON | `scripts/tour/output/verification.json` | generated | local, not committed |

Absolute MP4 path:
`/home/dev/src/slipmem/scripts/tour/output/slipmem-product-tour.mp4`.

The poster is a real frame from the final MP4 at 4.2 s (`-ss 4.2`), not a
separate screenshot. Extracted scene-check frames are in
`scripts/tour/output/stills/final-*.png`.

## Final encode

The final container was produced from the recorded WebM with the static FFmpeg
7.0.2 build and the repository encoder:

```sh
FFMPEG=/tmp/opencode/tour-tools/ffmpeg-static ./scripts/tour/encode.sh \
  scripts/tour/output/slipmem-product-tour.webm \
  scripts/tour/output/slipmem-product-tour.mp4
```

Confirmed from the final MP4:

- container MP4, H.264 (`h264`, High profile, `avc1`);
- `yuv420p`, progressive, 1440x900, SAR 1:1, DAR 8:5;
- 25 fps, duration **107.96 s** (inside the required 90–150 s);
- **zero audio streams**, no subtitle stream, faststart (`moov` near the start);
- narrative captions are burned into the picture by `scripts/tour/overlay.js`;
  there is no separate caption file or player toggle.

The source WebM is VP9, `yuv420p`, 1440x900, 25 fps, 107.96 s, also silent.

## Scenario and postconditions

The work root is `/tmp/opencode/slipmem-tour`; the note root is
`/tmp/opencode/slipmem-tour/.slipmem`. All notes are disposable demo data and
all titles begin with `Demo`.

Actual checks after the recording:

- five notes seeded through the real `slipmem` CLI, each with `source: cli`;
- one permanent proposal submitted through the real HTTP MCP endpoint;
- before approval the proposal was `pending_approval`, no note file existed,
  and its diff contained `source: mcp`;
- the browser expanded the real diff and clicked **Approve**;
- after approval the note
  `20261118005131-demo-proposal-recall-should-cite-its-sources` exists as a
  flat permanent note with `source: mcp`;
- six flat notes total, empty pending queue, no type directories, `.state/` is
  the only directory in the note root;
- `bun scripts/tour/scenario.mjs verify` exited 0 with
  `verified 6 flat notes, MCP approval applied, no pending proposals`;
- the server started by the runner was stopped on exit; a post-run
  `curl http://127.0.0.1:3317/api/health` was refused.

## Scene list and frame checks

Timestamps are seconds in the final MP4. The full timestamp/check record is in
`scripts/tour/output/verification.json`. Each listed frame was extracted from
the final MP4 and inspected directly.

| Scene | Window | Checked frame | Caption / check |
| --- | --- | ---: | --- |
| Start | 0–8.6 s | 4.2 s | “This is a disposable demo repository…” — Notes list, demo titles, readable caption. |
| CLI capture | 9.0–16.9 s | 12.5 s | “Fleeting notes are a low-trust inbox…” — fleeting detail with note ID, file, hash, CLI provenance. |
| Search | 36.9–43.0 s | 39.0 s | “Search is bounded…” — real results for `recall` with note IDs and files. |
| Topic wiki | 51.8–58.3 s | 54.0 s | “Every wiki section quotes its source…” — `Topic: agent-memory` from 4 notes with citations. |
| Review pending | 60.2–66.3 s | 62.5 s | “An MCP agent proposed a permanent note…” — pending proposal, no file yet. |
| Review diff | 67.9–74.5 s | 69.5 s | “Inspect the real diff…” — expanded diff includes `source: mcp`. |
| Approved | 80.4–85.6 s | 83.0 s | “Approved…” — no pending proposals after the browser approval. |
| Approved note | 86.9–92.1 s | 89.0 s | “The new note is already visible…” — approved note first in Notes. |
| Closing | 99.9–104.9 s | 103.0 s | “Local-first memory for you and your agents.” |
| End hold | 105.0–107.96 s | 107.2 s | Final product frame; not blank or an error frame. |

No credentials, tokens, or real notes appear in the inspected frames. The only
filesystem path shown is the disposable `/tmp/opencode/slipmem-tour` demo root.

## Verification commands

```sh
bash scripts/tour/run-product-tour.sh
cd scripts/tour && bun test
bun scripts/tour/scenario.mjs verify

# Final properties and hashes
/tmp/opencode/tour-tools/ffmpeg-static -hide_banner \
  -i scripts/tour/output/slipmem-product-tour.mp4
sha256sum scripts/tour/output/slipmem-product-tour.mp4 \
  scripts/tour/output/slipmem-product-tour.webm \
  scripts/tour/output/slipmem-product-tour-poster.png

# Poster from the final MP4
/tmp/opencode/tour-tools/ffmpeg-static -y -ss 4.2 \
  -i scripts/tour/output/slipmem-product-tour.mp4 \
  -frames:v 1 -update 1 \
  scripts/tour/output/slipmem-product-tour-poster.png
```

Tour tests: **20 pass, 0 fail**, 66 `expect()` calls across 2 files.

## Limits

- The recording proves the demonstrated flow and scenario postconditions; it
  does not replace the full release gate or the clean-clone quickstart.
- Frame checks were visual inspections at the listed timestamps, not automated
  OCR.
- `scripts/tour/**` source was not changed for this recording, and no
  application code was edited.
- Media and `verification.json` remain generated, ignored output.
