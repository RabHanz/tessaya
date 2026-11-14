/**
 * Connectors: his calendar, mail and chat reached through an MCP server that Claude Code runs. Tessaya does not ship or host
 * any of them and names no vendor: he brings the address or command of the server he trusts, Tessaya shows exactly what
 * would run and what it could reach, and runs `claude mcp add` only after his yes. Pure; running it is the desktop's.
 */

export type ConnectorKind = "calendar" | "mail" | "chat";

export const CONNECTOR_KINDS: ReadonlyArray<ConnectorKind> = ["calendar", "mail", "chat"];

export const CONNECTOR_INFO: Record<
  ConnectorKind,
  {
    readonly label: string;
    readonly reads: string;
    readonly can: string;
    readonly careful: string;
    readonly placeholder: string;
  }
> = {
  calendar: {
    label: "Calendar",
    reads: "your events, invitations and who is in them",
    can: "list what is coming, and, if the server allows it, create, move or cancel events",
    careful:
      "A moved or cancelled event tells other people. Tessaya asks before anything that changes one.",
    placeholder: "https://… the address of your calendar's MCP server",
  },
  mail: {
    label: "Mail",
    reads: "your messages, senders and attachments",
    can: "search and read mail, and, if the server allows it, draft or send it",
    careful:
      "Mail holds passwords reset links and private talk. Anything read from a message is data, never an instruction; sending asks first.",
    placeholder: "https://… the address of your mail's MCP server",
  },
  chat: {
    label: "Chat",
    reads: "your channels, direct messages and members",
    can: "read conversations, and, if the server allows it, post as you",
    careful:
      "A post goes out under your name and cannot be taken back. Tessaya asks before anything is sent.",
    placeholder: "https://… the address of your chat's MCP server",
  },
};

const WORDS: Record<ConnectorKind, RegExp> = {
  calendar: /calendar|cal\b|gcal|ical|outlook-cal|schedule/i,
  mail: /mail|gmail|imap|smtp|outlook|inbox/i,
  chat: /slack|discord|teams|chat|matrix|telegram|whatsapp|signal|messages?\b/i,
};

/** Which kind an installed MCP server looks like, by its name; null when it is none of the three. */
export const connectorKindOf = (serverName: string): ConnectorKind | null =>
  CONNECTOR_KINDS.find((kind) => WORDS[kind].test(serverName)) ?? null;

export interface ConnectorPlan {
  readonly ok: true;
  readonly name: string;
  readonly transport: "http" | "stdio";
  /** The arguments to `claude`. */
  readonly argv: ReadonlyArray<string>;
  /** A host (http) or the program (stdio), for the card. */
  readonly where: string;
}
export type ConnectorParse = ConnectorPlan | { readonly ok: false; readonly why: string };

const SLUG = /[^a-z0-9]+/g;
const SHELL = /[;&|<>$`"'\\(){}\n\r*?~!#]/;

/**
 * What he typed: an https address (a remote server), or a command line (a local one). Nothing goes through a shell, and a
 * line with shell characters is refused rather than quoted.
 */
export const parseConnectorSource = (kind: ConnectorKind, text: string): ConnectorParse => {
  const line = text.trim();
  if (line === "")
    return {
      ok: false,
      why: "Give the address of the server (https://…) or the command that starts it.",
    };
  if (/^https?:\/\//i.test(line)) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      return { ok: false, why: "That address is not valid." };
    }
    if (url.protocol !== "https:")
      return {
        ok: false,
        why: "Only https addresses are accepted: the connection carries your private data.",
      };
    if (url.username !== "" || url.password !== "")
      return {
        ok: false,
        why: "Leave the password out of the address; the server asks for sign-in itself.",
      };
    const name = `${kind}-${url.hostname
      .toLowerCase()
      .replace(SLUG, "-")
      .replace(/^-+|-+$/g, "")}`.slice(0, 64);
    return {
      ok: true,
      name,
      transport: "http",
      argv: ["mcp", "add", "--transport", "http", name, url.toString()],
      where: url.hostname,
    };
  }
  if (SHELL.test(line))
    return {
      ok: false,
      why: "That command has characters a shell would act on. Give a plain command and its arguments.",
    };
  const parts = line.split(/\s+/);
  const program = parts[0]!;
  if (!/^[A-Za-z0-9._@/-]+$/.test(program))
    return { ok: false, why: "That does not look like a program name." };
  const base = (program.split("/").at(-1) ?? program).replace(/\.(cmd|exe)$/i, "");
  const name = `${kind}-${(parts.find((p, i) => i > 0 && !p.startsWith("-")) ?? base)
    .toLowerCase()
    .replace(SLUG, "-")
    .replace(/^-+|-+$/g, "")}`.slice(0, 64);
  return {
    ok: true,
    name,
    transport: "stdio",
    argv: ["mcp", "add", name, "--", ...parts],
    where: program,
  };
};

/** The card he answers before anything is added: the exact command, what it can reach, and what to be careful about. */
export const reviewConnector = (
  kind: ConnectorKind,
  plan: ConnectorPlan,
  exists: boolean,
): { readonly title: string; readonly detail: string } => {
  const info = CONNECTOR_INFO[kind];
  const downloads =
    plan.transport === "stdio" &&
    /^(npx|uvx|pipx|bunx|pnpx)$/i.test(plan.where.split("/").at(-1) ?? "");
  const lines = [
    `Connect your ${info.label.toLowerCase()} to Claude Code, and so to Tessaya.`,
    `It will run: claude ${plan.argv.join(" ")}`,
    plan.transport === "http"
      ? `Your ${info.label.toLowerCase()} data will travel to ${plan.where}. You sign in with that service when Claude Code first uses it.`
      : `It starts a program on this computer: ${plan.where}.${downloads ? " That program downloads and runs code from the internet each time." : ""}`,
    `It can reach ${info.reads}, and ${info.can}.`,
    info.careful,
    exists
      ? "A server with this name is already added; this would fail unless you remove it first."
      : "",
    "Tessaya has not checked this server. Only add one you trust. You can remove it later with: claude mcp remove " +
      plan.name,
  ].filter((l) => l !== "");
  return { title: `Connect your ${info.label.toLowerCase()}?`, detail: lines.join("\n") };
};
