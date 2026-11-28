/** Her own woad look (logo kit, approved welcome and Sleeve mocks): one place, so the welcome and the Sleeve match. */
import { useFonts } from "expo-font";
import { StyleSheet } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

export const WOAD = "#14505A";
export const WOAD_LIGHT = "#1F6C77";
export const WOAD_DEEP = "#0A2F36";
export const PAPER = "#EEEDE4";
export const DYE = "#5FB3B3";
export const SERIF = "Newsreader";

export const useSerif = () => useFonts({ [SERIF]: require("../welcome/Newsreader-Regular.ttf") });

/** The woad glow behind her, lightest a third of the way down where her face sits. */
export function WoadGlow(props: { readonly id: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no">
      <Defs>
        <RadialGradient id={props.id} cx="50%" cy="34%" rx="75%" ry="55%">
          <Stop offset="0%" stopColor={WOAD_LIGHT} />
          <Stop offset="55%" stopColor={WOAD} />
          <Stop offset="100%" stopColor={WOAD_DEEP} />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${props.id})`} />
    </Svg>
  );
}
