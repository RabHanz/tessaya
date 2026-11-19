/** A soft colour of its own per name, so exported cards and persona avatars are told apart at a glance. Browser-safe. */
export const colourOf = (name: string): readonly [number, number, number] => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return [128 + (h % 96), 128 + ((h >>> 8) % 96), 128 + ((h >>> 16) % 96)];
};
