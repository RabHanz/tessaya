# Words in the window

All text the window draws belongs in `apps/desktop/src/tessaya/home/strings.ts`: one table per language,
English only for now. A second language is a second object with the same keys; a key it leaves out falls
back to English. A gap in a sentence is written `{name}` and filled by `text(key, { name })`.

Moved over so far: the page names, each page's introduction, the dialogs' names, the first-run guide,
the Backup area and the guide's buttons. The page script's remaining literal text (about 100 strings)
and the other row builders (Trust, Help, Now and the older pages) are not moved yet.

`strings.test.ts` keeps this honest: files on its `MOVED` list may not hold text of their own, and the
count of text written straight into the page script may only go down. A new page should be put on the
`MOVED` list on the day it is written.
