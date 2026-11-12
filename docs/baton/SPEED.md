# The window's speed

Measured 2026-11-03 on a Linux box with the page script run in Node against a stand-in browser
(`home/fakeDom.ts`). That measures the script's own work, not painting; a real first-paint time on the
laptop is still to be taken.

| What                                                    | Before                                                       | After                                                                        | Budget (test) |
| ------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------- |
| Page script                                             | 82,761 characters                                            | same                                                                         | under 164,000 |
| Stylesheet without the three embedded fonts             | 27,719                                                       | same                                                                         | under 48,000  |
| Whole document (fonts included)                         | 525,549                                                      | same                                                                         | under 438,000 |
| Text given to the window as a `data:` URL               | 603,348 characters, percent-encoded and parsed on every open | none: the page is a file in the state folder, rewritten only when it changes |               |
| Elements built for the first draw (Home)                | 218                                                          | same                                                                         | under 300     |
| Elements built for the heaviest tab switch (Trust, 131) | 131                                                          | same                                                                         | under 200     |
| Tab switch time in the stand-in browser                 | about 1.5 ms                                                 | same                                                                         | under 40 ms   |

What is big: three embedded fonts are 226 KB. Since 2026-11-06 the logo animation is no longer in the page: there is
one per palette and theme (six, 110 to 150 KB each) in `apps/desktop/resources/tessaya`, and the main process reads
only the one in use when a sting plays, so the document went from about 720,000 to 384,000 characters and its
budget from 740,000 to 420,000, raised to 432,000 for the tips and Learn Tessaya. Subsetting the fonts further is the next real saving.

The page script budget is 112,000 since 2026-11-05: the greeting picker and its 50 lines added about 4,400 characters. It was 113,000 from 2026-11-06 for the marks that play on click (about 900 characters), was 116,000 from the tour (an offer on Home, resuming, facts per step, about 3,600), was 118,000 from the merges of 2026-11-06 (#539, #548 and others), and is 128,500 since History's redesign (plain-language rows, inline actions, a day summary) took main to about 127,600, and is 138,000 since Memory's People area (private stores under a PIN, about 9,500 with their words) took it to about 136,400, and is 148,000 since the sidebar areas, one grouped Settings, the places search across both windows and the inline T3 pages took it to about 146,000, and is 158,000 since the tips and Learn Tessaya (about 7,000, most of it the tips' words) took it to about 155,000. It is 164,000 since Voice ID's guided read card (about 5,600).

The stylesheet budget is 41,500 since 2026-11-05: the Damson and Madder palettes add a light and a dark accent rule each. It is 42,500 since 2026-11-06: the glass tokens, the marks' hover and click breaths, and the Settings window's larger frame. It is 45,000 since History's redesign (about 1,600 for its rows), and 46,000 since the tip card. It is 48,000 since Voice ID's guided read card.

`speedBudget.test.ts` fails when a number goes over its budget. Raise a budget only with a reason
written in this table.
