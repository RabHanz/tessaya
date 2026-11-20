/**
 * A device his words name but the recogniser misheard ("turn off the battle van", 20 Nov 09:28: his bedroom fan),
 * put right against the house's own device names. Only in a sentence that asks a device to do something, only to the
 * one name it sounds like (never when two names sound alike), and never over a name said right.
 */

/** A request to a device: what makes a near name worth fixing. */
const DEVICE_ASK =
  /\b(?:turn|switch|put|set|dim|brighten|raise|lower|open|close|start|stop|pause|play|increase|decrease|speed|slow)\b/i;

/** Voiced and unvoiced alike, as a recogniser swaps them (b/p, d/t, v/f, g/k, z/s). */
const SOUND: Readonly<Record<string, string>> = {
  b: "p",
  d: "t",
  v: "f",
  g: "k",
  z: "s",
  c: "k",
  q: "k",
  x: "ks",
};

/** A word's sound skeleton: its first letter's class, then its consonants, doubled ones once. */
const skeleton = (word: string): string => {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w === "") return "";
  const mapped = [...w].map((c) => SOUND[c] ?? c);
  const head = mapped[0]!;
  const rest = mapped.slice(1).filter((c) => !"aeiouyhw".includes(c));
  return [head, ...rest].filter((c, i, all) => i === 0 || c !== all[i - 1]).join("");
};

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = here;
    }
  }
  return row[b.length]!;
};

/** How far a run of heard words is from a name, by sound; null when any word is not close. */
const soundGap = (heard: ReadonlyArray<string>, name: ReadonlyArray<string>): number | null => {
  let gap = 0;
  for (const [k, word] of heard.entries()) {
    const a = skeleton(word);
    const b = skeleton(name[k]!);
    if (a === "" || b === "" || a[0] !== b[0]) return null;
    const d = distance(a, b);
    if (d > Math.max(1, Math.floor(b.length / 2))) return null;
    gap += d;
  }
  return gap;
};

/**
 * `text` with a misheard device name replaced by the house's own (`names`, as Home Assistant calls them). Two-word
 * names and longer only: a one-word near miss is too often another word.
 */
export const fixHouseNames = (text: string, names: ReadonlyArray<string>): string => {
  if (!DEVICE_ASK.test(text)) return text;
  const lower = text.toLowerCase();
  // A name and its last words as he says them ("bedroom fan" for "Master Bedroom Fan"), two words or more.
  const multi = [
    ...new Set(
      names.flatMap((n) => {
        const parts = n.trim().split(/\s+/);
        return parts
          .slice(0, -1)
          .map((_, k) => parts.slice(k).join(" "))
          .filter((x) => x.split(" ").length >= 2);
      }),
    ),
  ];
  // A name said right is left alone, and so are its words.
  if (multi.some((n) => lower.includes(n.toLowerCase()))) return text;
  const tokens = [...text.matchAll(/[\p{L}']+/gu)].map((m) => ({ word: m[0], at: m.index }));
  for (let i = 0; i < tokens.length; i++) {
    const near = multi.flatMap((name) => {
      const parts = name.split(/\s+/);
      const run = tokens.slice(i, i + parts.length);
      if (run.length < parts.length) return [];
      const gap = soundGap(
        run.map((t) => t.word),
        parts,
      );
      const same = run.every((t, k) => t.word.toLowerCase() === parts[k]!.toLowerCase());
      return gap === null || same ? [] : [{ name, gap, run }];
    });
    if (near.length === 0) continue;
    const best = Math.min(...near.map((n) => n.gap));
    const winners = near.filter((n) => n.gap === best);
    // Two names sound the same here ("bedroom fan", "bathroom fan"): not ours to pick.
    if (winners.length !== 1) continue;
    const { name, run } = winners[0]!;
    const from = run[0]!.at;
    const to = run.at(-1)!.at + run.at(-1)!.word.length;
    return `${text.slice(0, from)}${name.toLowerCase()}${text.slice(to)}`;
  }
  return text;
};
