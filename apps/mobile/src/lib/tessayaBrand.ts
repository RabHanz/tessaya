import Constants from "expo-constants";

/** The Tessaya build (APP_VARIANT=tessaya): its own name and mark, no T3 badge. */
export const IS_TESSAYA_APP = Constants.expoConfig?.extra?.appVariant === "tessaya";
