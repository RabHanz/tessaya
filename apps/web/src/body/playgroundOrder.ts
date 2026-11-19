/** The model a playground opens on. */
export interface OfferedModel {
  readonly id?: string | null;
  readonly url?: string;
  readonly name: string;
  readonly from: string;
}

export const EVERYDAY = {
  name: "Everyday",
  url: "/tessaya/playground/everyday.vrm",
  from: "default",
  why: "The default body (free licence, CC0)",
} as const;

/**
 * Which models the playground tries first, in order: the one he used last, then what his layer offers in its own order
 * (her worn body, then his library's), and the CC0 Everyday only when nothing of his exists. He has turned Everyday
 * down as her body, so it never comes before a model of his.
 */
export const modelOrder = <M extends OfferedModel>(
  offered: ReadonlyArray<M>,
  last: string | null,
): ReadonlyArray<M | typeof EVERYDAY> => {
  const key = (m: OfferedModel) => m.id ?? m.url;
  const his = [
    ...offered.filter((m) => key(m) === last),
    ...offered.filter((m) => key(m) !== last),
  ];
  return his.length === 0 ? [EVERYDAY] : his;
};
