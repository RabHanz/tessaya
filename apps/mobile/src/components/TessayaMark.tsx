import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const MARK =
  "M96.18 35.37L144.26 83.45L128.71 99.01L80.62 50.93ZM172.55 111.74L220.63 159.82L205.07 175.38L156.99 127.29ZM130.12 19.81L145.68 35.37L127.29 53.75L111.74 38.20ZM175.38 65.07L190.93 80.62L127.29 144.26L111.74 128.71ZM83.45 156.99L99.01 172.55L80.62 190.93L65.07 175.38ZM220.63 110.32L236.19 125.88L217.80 144.26L202.25 128.71ZM173.96 156.99L189.52 172.55L125.88 236.19L110.32 220.63ZM82.04 111.74L144.26 173.96L128.71 189.52L66.48 127.29ZM83.45 66.48L99.01 82.04L35.37 145.68L19.81 130.12Z";

/** Tessaya's woven mark (assets/baton/logo.svg), one colour, square. */
export function TessayaMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Tessaya"
      height={props.height}
      width={props.height}
      viewBox="0 0 256 256"
    >
      <ThemedPath
        d={MARK}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
