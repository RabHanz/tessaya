import { tessayaPlaceOf, type TessayaPlaceId } from "@t3tools/baton-contracts";

export const TESSAYA_SCHEME = "tessaya";

export const isTessayaLink = (value: string): boolean => /^tessaya:\/\//i.test(value);

/** The place a launch asks for, from `tessaya://settings/hardware` among its arguments; null for none or an unknown one. */
export const placeInArgs = (argv: ReadonlyArray<string>): TessayaPlaceId | null => {
  const link = argv.find(isTessayaLink);
  return link === undefined ? null : tessayaPlaceOf(link);
};
