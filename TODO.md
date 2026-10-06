# TODO

Things decided on but deliberately not started. Newest at the top of each section.

## Very low priority

### Shrink archived podcast episodes on the way to pCloud (added 2026-10-06)

Joseph's call: "leave it for now". Only worth doing if whole back catalogues start being archived. pCloud had 144 GB used of 2 TB on 2026-10-06, and a weekly show is about 3 GB a year.

- **Today:** archiving never touches the bytes. `archivePump` (src/lib/podcasts.ts) resolves the enclosure's redirect chain and calls pCloud's `downloadfileasync`, so pCloud pulls straight from the publisher. Nothing can convert anything on that path.
- **The idea:** an optional per-show "save space" archive that re-encodes on a wharf node. Download, ffmpeg, then upload. Same shape as the Audible sync: stage in R2 and let pCloud pull, because uploads from the home link ran at 37 KB/s. wharf-syd-1 can push to pCloud directly.
- **Format: AAC in a fast-start M4A (about 64 kbps mono for speech), not Opus.**
  - The AAC would be about half a 128 kbps MP3: TAL's 58 MB episode would be about 30 MB.
  - Opus would be about a quarter, but Ogg/Opus has no seek index, so iOS scans the file to start (about 40 requests, up to 17 s over cellular on the Opus audiobooks).
  - The WebM remux that fixed start-up broke seeking and was reverted (see the "Opus in Ogg" section of CLAUDE.md).
- **Costs:**
  - archiving starts depending on a wharf node being healthy;
  - each archive downloads and uploads the whole episode, where pCloud's own fetch takes about a minute;
  - archive_state needs a "converting" step, and `size_bytes`/mime/ext must change to the converted file's.
