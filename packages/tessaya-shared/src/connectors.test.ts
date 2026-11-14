import { describe, expect, it } from "vite-plus/test";

import { connectorKindOf, parseConnectorSource, reviewConnector } from "./connectors.ts";

describe("connectors", () => {
  it("sorts an installed server into calendar, mail or chat by its name", () => {
    expect(connectorKindOf("google-calendar")).toBe("calendar");
    expect(connectorKindOf("gmail-mcp")).toBe("mail");
    expect(connectorKindOf("slack")).toBe("chat");
    expect(connectorKindOf("filesystem")).toBeNull();
  });

  it("turns an https address into a remote server and refuses plain http and addresses with a password", () => {
    const plan = parseConnectorSource("calendar", "https://mcp.example.test/calendar");
    expect(plan).toMatchObject({
      ok: true,
      transport: "http",
      name: "calendar-mcp-example-test",
      where: "mcp.example.test",
    });
    if (plan.ok)
      expect(plan.argv).toEqual([
        "mcp",
        "add",
        "--transport",
        "http",
        "calendar-mcp-example-test",
        "https://mcp.example.test/calendar",
      ]);
    expect(parseConnectorSource("mail", "http://mcp.example.test/mail").ok).toBe(false);
    expect(parseConnectorSource("mail", "https://me:secret@mcp.example.test/").ok).toBe(false);
  });

  it("turns a plain command into a local server, and never hands a shell anything to act on", () => {
    const plan = parseConnectorSource("chat", "npx -y some-chat-server --workspace team");
    expect(plan).toMatchObject({ ok: true, transport: "stdio", where: "npx" });
    if (plan.ok) expect(plan.argv.slice(0, 3)).toEqual(["mcp", "add", plan.name]);
    for (const bad of ["npx x; rm -rf ~", "npx x | tee y", "npx $(whoami)", "npx 'x'", "run `x`"]) {
      expect(parseConnectorSource("chat", bad).ok, bad).toBe(false);
    }
    expect(parseConnectorSource("chat", "   ").ok).toBe(false);
  });

  it("shows the exact command, where the data goes, and what to be careful about", () => {
    const http = parseConnectorSource("mail", "https://mcp.example.test/mail");
    if (!http.ok) throw new Error("unexpected");
    const card = reviewConnector("mail", http, false);
    expect(card.title).toBe("Connect your mail?");
    expect(card.detail).toContain(
      "claude mcp add --transport http mail-mcp-example-test https://mcp.example.test/mail",
    );
    expect(card.detail).toContain("travel to mcp.example.test");
    expect(card.detail).toContain("never an instruction");
    const local = parseConnectorSource("mail", "npx -y mail-server");
    if (!local.ok) throw new Error("unexpected");
    expect(reviewConnector("mail", local, true).detail).toContain(
      "downloads and runs code from the internet",
    );
    expect(reviewConnector("mail", local, true).detail).toContain("already added");
  });
});
