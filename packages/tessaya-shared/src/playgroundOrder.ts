/** The model a playground opens on. */
export interface OfferedModel {
  readonly id?: string | null;
  readonly url?: string;
  readonly name: string;
  readonly from: string;
}

/**
 * Which models a body tries first, in order: the one he used last, then what his layer offers in its own order (her
 * worn body, then his library's). There is no stand-in: he turned the stock body down for good (20 Nov), so with none
 * of his a page shows her face or asks for a model.
 */
export const modelOrder = <M extends OfferedModel>(
  offered: ReadonlyArray<M>,
  last: string | null,
): ReadonlyArray<M> => {
  const key = (m: OfferedModel) => m.id ?? m.url;
  return [...offered.filter((m) => key(m) === last), ...offered.filter((m) => key(m) !== last)];
};
