import { tessayaPlaceOf } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { guestLinkOut, isEmbedSrc, placeInArgs } from "./links.ts";
import { openState } from "./pageStates.ts";

describe("tessaya:// links", () => {
  it("names a place from a link, a path or a bare id, and nothing else", () => {
    expect(tessayaPlaceOf("tessaya://settings/hardware")).toBe("hardware");
    expect(tessayaPlaceOf("TESSAYA://homeassistant/")).toBe("homeassistant");
    expect(tessayaPlaceOf("settings/voice?x=1")).toBe("voice");
    expect(tessayaPlaceOf("tessaya://settings/nowhere")).toBeNull();
    expect(tessayaPlaceOf("https://example.com/settings/hardware")).toBeNull();
  });

  it("finds the link among a second launch's arguments", () => {
    expect(placeInArgs(["Tessaya.exe", "--flag", "tessaya://settings/apis"])).toBe("apis");
    expect(placeInArgs(["Tessaya.exe"])).toBeNull();
  });

  it("shows T3's pages inline by their hash route, never T3's home and its first-run wizard", async () => {
    const page = await openState("empty");
    page.exec("embedUrl = 't3code://app/'; render(S);");
    page.show("hardware");
    const view = page
      .elements()
      .find((e) => (e as unknown as { tagName: string }).tagName === "webview");
    const src = view?.attrs.get("src") ?? null;
    expect(src).toBe("t3code://app/?tessayaGuest=1#/tessaya/hardware");
    expect(isEmbedSrc("t3code://app/", src ?? "")).toBe(true);
    expect(isEmbedSrc("t3code://app/", "t3code://app/tessaya/hardware")).toBe(false);
    expect(isEmbedSrc("t3code://app/", "t3code://app/#/welcome")).toBe(false);
    // Without the flag it would be a second whole T3.
    expect(isEmbedSrc("t3code://app/", "t3code://app/#/tessaya/hardware")).toBe(false);
    expect(isEmbedSrc("t3code://app/", "https://evil.example/#/tessaya/hardware")).toBe(false);
    expect(page.errors).toEqual([]);
  });

  it("sends a guest page's link to the rest of T3 to T3's window, and keeps its own pages", () => {
    const app = "t3code://app/";
    expect(guestLinkOut(app, `${app}?tessayaGuest=1#/settings/voice`)).toBe("/settings/voice");
    expect(guestLinkOut(app, `${app}?tessayaGuest=1#/settings/providers?environmentId=e`)).toBe(
      "/settings/providers",
    );
    expect(guestLinkOut(app, `${app}?tessayaGuest=1#/tessaya/hardware`)).toBeNull();
    expect(guestLinkOut(app, "https://evil.example/?tessayaGuest=1#/settings/voice")).toBeNull();
  });
});
