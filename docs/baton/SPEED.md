# The window's speed

Measured 2026-11-03 on a Linux box with the page script run in Node against a stand-in browser
(`home/fakeDom.ts`). That measures the script's own work, not painting; a real first-paint time on the
laptop is still to be taken.

| What                                                    | Before                                                       | After                                                                        | Budget (test) |
| ------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------- |
| Page script                                             | 82,761 characters                                            | same                                                                         | under 128,500 |
| Stylesheet without the three embedded fonts             | 27,719                                                       | same                                                                         | under 45,000  |
| Whole document (fonts included)                         | 525,549                                                      | same                                                                         | under 420,000 |
| Text given to the window as a `data:` URL               | 603,348 characters, percent-encoded and parsed on every open | none: the page is a file in the state folder, rewritten only when it changes |               |
| Elements built for the first draw (Home)                | 218                                                          | same                                                                         | under 300     |
| Elements built for the heaviest tab switch (Trust, 131) | 131                                                          | same                                                                         | under 200     |
| Tab switch time in the stand-in browser                 | about 1.5 ms                                                 | same                                                                         | under 40 ms   |

What is big: three embedded fonts are 226 KB. Since 2026-11-06 the logo animation is no longer in the page: there is
one per palette and theme (six, 110 to 150 KB each) in `apps/desktop/resources/tessaya`, and the main process reads
only the one in use when a sting plays, so the document went from about 720,000 to 384,000 characters and its
budget from 740,000 to 420,000. Subsetting the fonts further is the next real saving.

The page script budget is 112,000 since 2026-11-05: the greeting picker and its 50 lines added about 4,400 characters. It was 113,000 from 2026-11-06 for the marks that play on click (about 900 characters), was 116,000 from the tour (an offer on Home, resuming, facts per step, about 3,600), was 118,000 from the merges of 2026-11-06 (#539, #548 and others), and is 128,500 since History's redesign (plain-language rows, inline actions, a day summary) took main to about 127,600.

The stylesheet budget is 41,500 since 2026-11-05: the Damson and Madder palettes add a light and a dark accent rule each. It is 42,500 since 2026-11-06: the glass tokens, the marks' hover and click breaths, and the Settings window's larger frame. It is 45,000 since History's redesign (about 1,600 for its rows).

`speedBudget.test.ts` fails when a number goes over its budget. Raise a budget only with a reason
written in this table.
