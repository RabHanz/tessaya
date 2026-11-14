/* oxlint-disable unicorn/no-useless-spread -- Baton file predating the rule (D82) */
/**
 * A small stand-in for the browser, enough to run the window's page script in Node and read what it
 * drew. It is not a DOM: no layout, no selectors beyond what the script uses, events are recorded and
 * never fired. Used by the states test to prove no page shows 'undefined' or a raw error.
 */
import * as NodeVM from "node:vm";

class FakeNode {
  parent: FakeElement | null = null;
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
}

const VOID = new Set(["input", "img", "br", "hr"]);

export class FakeElement extends FakeNode {
  children: Array<FakeElement | FakeText> = [];
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  raw: string | null = null;
  value = "";
  disabled = false;
  tabIndex = 0;
  offsetParent: object | null = {};
  scrollTop = 0;
  className = "";
  tagName: string;
  readonly doc: FakeDocument;
  constructor(tagName: string, doc: FakeDocument) {
    super();
    this.tagName = tagName;
    this.doc = doc;
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => void (self.className = [...new Set([...list(), ...c])].join(" ")),
      remove: (...c: string[]) =>
        void (self.className = list()
          .filter((x) => !c.includes(x))
          .join(" ")),
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => {
        const has = list().includes(c);
        const want = force ?? !has;
        self.className = (want ? [...new Set([...list(), c])] : list().filter((x) => x !== c)).join(
          " ",
        );
        return want;
      },
    };
  }
  setAttribute(k: string, v: string) {
    if (k === "class") this.className = String(v);
    else this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return k === "class" ? this.className : (this.attrs.get(k) ?? null);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  private adopt(n: FakeElement | FakeText | string) {
    const node = typeof n === "string" ? new FakeText(n) : n;
    const at = node.parent === null ? -1 : node.parent.children.indexOf(node);
    if (at >= 0) node.parent!.children.splice(at, 1);
    node.parent = this;
    return node;
  }
  appendChild<T extends FakeElement | FakeText>(n: T): T {
    if (n instanceof FakeFragment) {
      for (const c of [...n.children]) this.children.push(this.adopt(c));
      n.children = [];
      return n;
    }
    this.raw = null;
    this.children.push(this.adopt(n));
    return n;
  }
  append(...ns: Array<FakeElement | FakeText | string>) {
    for (const n of ns) {
      if (typeof n === "string") this.children.push(this.adopt(n));
      else this.appendChild(n);
    }
  }
  replaceChildren(...ns: Array<FakeElement | FakeText | string>) {
    this.children = [];
    this.raw = null;
    this.append(...ns);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeElement | FakeText | null {
    return this.children.at(-1) ?? null;
  }
  get parentNode() {
    return this.parent;
  }
  get nextSibling(): FakeElement | FakeText | null {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): FakeElement | FakeText | null {
    const i = this.parent === null ? -1 : this.parent.children.indexOf(this);
    return i > 0 ? this.parent!.children[i - 1]! : null;
  }
  get childNodes() {
    return [...this.children];
  }
  insertBefore(n: FakeElement | FakeText, ref: FakeElement | FakeText | null) {
    const at = ref === null ? this.children.length : this.children.indexOf(ref);
    this.children.splice(at, 0, this.adopt(n));
    return n;
  }
  remove() {
    const at = this.parent === null ? -1 : this.parent.children.indexOf(this);
    if (at >= 0) this.parent!.children.splice(at, 1);
    this.parent = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c instanceof FakeElement && c.contains(n));
  }
  set textContent(v: string) {
    this.children = [];
    this.raw = null;
    if (v !== "") this.children.push(this.adopt(String(v)));
  }
  get textContent(): string {
    return this.raw !== null
      ? this.raw.replace(/<[^>]*>/g, "")
      : this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join("");
  }
  set innerHTML(v: string) {
    this.children = [];
    this.raw = String(v);
  }
  get innerHTML(): string {
    if (this.raw !== null) return this.raw;
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.outerHTML)).join("");
  }
  get outerHTML(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
    const cls = this.className === "" ? "" : ` class="${this.className}"`;
    return VOID.has(this.tagName)
      ? `<${this.tagName}${cls}${attrs}>`
      : `<${this.tagName}${cls}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  focus() {
    this.doc.activeElement = this;
  }
  blur() {}
  click() {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  scrollIntoView() {}
  setSelectionRange() {}
  find(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const c of this.children) {
      const f = c instanceof FakeElement ? c.find(id) : null;
      if (f !== null) return f;
    }
    return null;
  }
}

class FakeFragment extends FakeElement {}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  /** Elements made so far: the work a draw costs. */
  created = 0;
  documentElement: FakeElement;
  body: FakeElement;
  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
    for (const [tag, id, parent] of [
      ["div", "app", "body"],
      ["aside", "side", "app"],
      ["div", "main", "app"],
      ["header", "top", "main"],
      ["main", "panel", "main"],
      ["div", "page", "panel"],
    ] as const) {
      const el = this.createElement(tag);
      el.id = id;
      (parent === "body" ? this.body : this.documentElement.find(parent)!).appendChild(el);
    }
  }
  createElement(tag: string) {
    this.created += 1;
    return new FakeElement(tag.toLowerCase(), this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, this);
  }
  createTextNode(t: string) {
    return new FakeText(String(t));
  }
  createDocumentFragment() {
    return new FakeFragment("#fragment", this);
  }
  getElementById(id: string) {
    return this.documentElement.find(id);
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  querySelector(): null {
    return null;
  }
  addEventListener() {}
  hidden = false;
  hasFocus() {
    return true;
  }
}

/** Runs the page script against `state` and returns a way to switch tabs and read each page's text. */
export const openWindowPage = async (script: string, state: unknown) => {
  const doc = new FakeDocument();
  const store = new Map<string, string>();
  const errors: string[] = [];
  const context = NodeVM.createContext({
    document: doc,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    // What the page uses to replay the sting from its own bytes.
    atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
    Blob,
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => undefined },
    addEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console: { error: (m: unknown) => errors.push(String(m)), log() {} },
    Intl,
    Date,
    JSON,
    Math,
  });
  Object.assign(context, {
    window: context,
    __BATON_STATE__: state,
  });
  // The script's own start-up promise has no catch; its failure is a failure of the page.
  const onRejection = (reason: unknown) => void errors.push(`page failed: ${String(reason)}`);
  process.on("unhandledRejection", onRejection);
  NodeVM.runInContext(
    `${script}\n;globalThis.__ready = get().catch(e => { console.error('page failed: ' + e); });`,
    context,
  );
  await (context as { __ready: Promise<void> }).__ready;
  await new Promise((r) => setImmediate(r));
  process.off("unhandledRejection", onRejection);
  const run = (code: string) => {
    try {
      NodeVM.runInContext(code, context);
    } catch (error) {
      errors.push(`threw: ${(error as { stack?: string }).stack ?? String(error)}`);
    }
  };
  return {
    errors,
    /** How many elements the script has made so far. */
    made: () => doc.created,
    textOf: (id: string) => doc.getElementById(id)?.textContent ?? "",
    show: (tab: string) => {
      run(`go(${JSON.stringify(tab)})`);
      return doc.getElementById("page")?.textContent ?? "";
    },
    openModal: (name: string) => {
      run(`modal = ${JSON.stringify(name)}; render();`);
      return doc.getElementById("mbody")?.textContent ?? "";
    },
    closeModal: () => run("closeModal()"),
    /** Runs a line in the page, for tests that need to set its state. */
    exec: run,
    /** Every element in the page, with the page's own classes. */
    elements: (): ReadonlyArray<FakeElement> => {
      const found: FakeElement[] = [];
      const walk = (e: FakeElement) => {
        found.push(e);
        for (const c of e.children) if (c instanceof FakeElement) walk(c);
      };
      walk(doc.documentElement);
      return found;
    },
    all: () => doc.documentElement.textContent,
  };
};
