# Product tour recorder

A small, app-agnostic scaffold for the final silent product tour. It records a
Playwright-driven browser session at 1440x900, renders narrative captions as an
in-page overlay while recording, and writes a WebM plus stills and an action
log. Captions are therefore burned into the video at exactly the moment they
are shown; no separate SRT timing pass is required.

This is tooling only. It contains no slipmem selectors or claims about the UI.
The final tour script must be written against the implemented interface.

## Requirements

- Bun 1.4.x (the repository uses Bun).
- Playwright 1.64.1 and its Chromium build. `bun install` in this directory
  installs Playwright from `scripts/tour/package.json`. If the browser is
  missing, run `bunx playwright install chromium`.
- A running slipmem web instance to record. This scaffold does not start, seed,
  or reset the app or its storage.

## Tooling in this environment

Checked on 2026-11-17:

- Bun `1.4.4`.
- Playwright `1.64.1`; Chromium revision `1248` (Chrome for Testing
  `156.0.8078.4`) is installed under `~/.cache/ms-playwright/chromium-1248`.
  Headless launch works, so no display or Xvfb is needed.
- No `ffmpeg` on `PATH`. Playwright's bundled
  `~/.cache/ms-playwright/ffmpeg-1013/ffmpeg-linux` is a reduced build: it can
  write VP9/WebM and nothing else useful here, and it has no H.264 or libass
  support. Do not use it for the final MP4.
- A static FFmpeg 7.0.2 with `libx264`, `libass`, `libfreetype`, and
  fontconfig was extracted from Bun's download cache for verification at
  `/tmp/opencode/tour-tools/ffmpeg-static`. `/tmp` is disposable, so install
  FFmpeg (`apt install ffmpeg`, a static build, etc.) or point `FFMPEG` at any
  binary with `libx264` for the real encode.

## Start the web app

For the current SQLite-based app, the development host was verified with:

```sh
SLIPMEM_DB_PATH=/tmp/slipmem-tour.db \
  bun run web -- --port 3317 --strictPort
```

Vite binds to `localhost` (`::1`) in development, so use
`http://localhost:3317/`. `http://127.0.0.1:3317/` is refused unless the host is
passed explicitly. Readiness was verified with:

```sh
curl -fsS http://localhost:3317/api/health
# {"ok":true,"service":"slipmem"}
```

The production path is `bun run web:build` followed by
`PORT=3000 bun run web:serve`; that binds `127.0.0.1` by default. When the MVP
implementation changes storage or startup, follow its README and record against
a disposable data root, not real notes.

## Record

```sh
cd scripts/tour
bun install
cp example.script.json tour.script.json
# Edit tour.script.json with selectors from the implemented UI.
bun record.mjs tour.script.json
```

The recorder opens `url`, waits 500 ms, then runs the steps. Output defaults to
`scripts/tour/output/`, which is gitignored.

- `output/<name>.webm` - silent VP9 recording at 25 fps.
- `output/stills/` - PNGs from `screenshot` steps, plus `error.png` on failure.
- `output/<name>.actions.json` - the executed steps and approximate timings.

Review the WebM and stills before encoding. The action log is driver-relative;
the video begins slightly later than the first logged step, so use the burned-in
captions rather than the log for frame-accurate editing.

## Encode

```sh
cd scripts/tour
FFMPEG=/path/to/ffmpeg ./encode.sh output/slipmem-tour.webm output/slipmem-tour.mp4
```

`encode.sh` only transcodes to H.264/yuv420p with `+faststart`; it drops audio
and does not add subtitles because the captions are already in the picture. It
also ensures even dimensions, which H.264 requires.

## Script format

```json
{
  "url": "http://localhost:3000/",
  "output": "output/slipmem-tour.webm",
  "width": 1440,
  "height": 900,
  "steps": [
    { "wait": 800 },
    { "caption": "This section explains what to look at." },
    { "click": "<Playwright selector>" },
    { "wait": 600 }
  ]
}
```

`url`, `output`, `width`, and `height` are optional; the values above are the
defaults. All paths in the script are relative to this directory. Width and
height must be even.

| Step | Meaning |
| --- | --- |
| `{ "caption": "text" }` | Show a caption and leave it visible. |
| `{ "caption": "text", "hold": 2500 }` | Show it for 2500 ms, then hide it. |
| `{ "caption": null }` | Hide the current caption. |
| `{ "goto": "/notes" }` | Navigate, resolved against `url`. Optional `waitUntil`. |
| `{ "click": "..." }` | Move the synthetic cursor to the element and click it. |
| `{ "hover": "..." }` | Move the cursor to the element. |
| `{ "fill": { "selector": "...", "value": "..." } }` | Replace a field value instantly. |
| `{ "type": { "selector": "...", "text": "...", "delay": 55 } }` | Focus and type visibly. |
| `{ "press": "Enter" }` | Press a key globally. |
| `{ "press": { "selector": "...", "key": "Enter" } }` | Press a key on an element. |
| `{ "waitFor": "..." }` | Wait for a selector. Object form accepts `state` and `timeout`. |
| `{ "wait": 800 }` | Hold the current frame for 800 ms. |
| `{ "screenshot": "name" }` | Save a viewport PNG; visible captions are included. Object form accepts `fullPage`. |
| `{ "scroll": 400 }` | Wheel down 400 px. Object form accepts `dx` and `dy`. |

Use selectors that describe the finished UI (CSS, `text=`, or Playwright
role/name selectors). Keep captions short enough to fit one or two lines at
1440x900.

## Practical notes

- The tour is silent by design. There is no audio track to remove later.
- The cursor and click pulses are visual overlays; the real app is not modified.
- A full document navigation (`goto` or a link that reloads) clears the overlay;
  set the next caption after navigating. Client-side route changes that do not
  reload keep it.
- The overlay is inserted under `<html>` with inline styles so application
  re-renders do not remove it. A future strict Content-Security-Policy that
  forbids inline styles would require adjusting `overlay.js`.
- Record the actual implemented flow only. This scaffold was verified with a
  synthetic fixture page; no current slipmem UI was recorded.
