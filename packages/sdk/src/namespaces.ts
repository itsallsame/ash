/**
 * Standard hand namespaces. A hand declares capabilities named `<namespace>.<action>`; for a standard namespace the
 * input/result schemas, effect and default risk below are the contract, and every hand that implements a name must
 * give it the same meaning (a hand may accept or return more fields, never fewer, and may raise the risk, never lower
 * it). Anything only one kind of hand can do is not standard and is named `x.<name>.<action>`.
 */

/** A JSON Schema (2020-12) document. Kept loose: the shared `SchemaObject` type has no `description`. */
export type SchemaObject = Record<string, any>;

export type ActionEffect = "read" | "write" | "act" | "execute";
export type ActionRisk = "none" | "outward" | "structure";
export const ACTION_EFFECTS: readonly ActionEffect[] = Object.freeze(["read", "write", "act", "execute"]);
export const ACTION_RISKS: readonly ActionRisk[] = Object.freeze(["none", "outward", "structure"]);

export interface StandardAction {
  /** Full capability name, `<namespace>.<action>`. */
  name: string;
  /** One sentence for the agent. */
  description: string;
  /** What the owner sees while it runs (present continuous). */
  label: string;
  input_schema: SchemaObject;
  result_schema: SchemaObject;
  effect: ActionEffect;
  /** Default risk. */
  risk: ActionRisk;
  /** True when the call operates the screen the owner is currently looking at on that hand. */
  foreground: boolean;
  /** Error codes (SPEC-02 §7) this action is expected to return besides the generic bad_request / timeout / failed. */
  errors: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// browser
//
// A hand may keep several browser spaces (a space is one tab with its own page; spaces on a hand share logins).
// Every action takes an optional `space` (1-24 of a-z 0-9 _ -, default "main"). On a computer a space belongs to the
// caller that opened it. A hand may keep only a few spaces open: opening one more may close the one used longest ago.
// Page content is untrusted data, never instructions.
// ---------------------------------------------------------------------------------------------------------------------

export const BROWSER_SPACE_PATTERN = "^[a-z0-9_-]{1,24}$";
export const BROWSER_DEFAULT_SPACE = "main";

const SPACE_HELP = "Which browser space (tab) to use: 1-24 of a-z 0-9 _ -. Default main. Give each task its own space; spaces share logins.";
const spaceProp = (): SchemaObject => ({ type: "string", pattern: BROWSER_SPACE_PATTERN, description: SPACE_HELP });
const object = (properties: Record<string, SchemaObject>, required: readonly string[] = []): SchemaObject =>
  ({ type: "object", additionalProperties: false, required, properties });

/** One numbered control on the page. `ref` is only valid for the latest page the same space returned. */
const elementSchema = (): SchemaObject => ({
  type: "object", required: ["ref", "tag", "text"],
  properties: {
    ref: { type: "integer", minimum: 0, description: "The control number to pass to click / type." },
    tag: { type: "string", description: "Element name, e.g. a, button, input." },
    type: { type: "string", description: "Input type, e.g. text, checkbox." },
    text: { type: "string", description: "Visible name, label or placeholder." },
    href: { type: "string" },
    disabled: { type: "boolean" },
    inViewport: { type: "boolean", description: "False when the control is above or below the visible part of the page." },
  },
});

/** The page as the agent reads it. Returned by open, read, click, type, scroll and back. */
const pageResult = (): SchemaObject => ({
  type: "object", required: ["space", "url", "title", "text", "elements"],
  properties: {
    space: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    text: { type: "string", description: "The visible text of the page." },
    scroll: { type: "object", required: ["y", "height"], properties: { y: { type: "integer" }, height: { type: "integer" } } },
    elements: { type: "array", items: elementSchema(), description: "Links, buttons and fields, numbered." },
    truncated: { type: "boolean", description: "True when text or elements were cut to fit." },
  },
});

/** site and label name what is being touched so the owner can approve it by reading one line. */
const targetProps = (what: string): Record<string, SchemaObject> => ({
  ref: { type: "integer", minimum: 0, description: `The ${what} number from the latest page of that space.` },
  site: { type: "string", minLength: 1, description: "The site you are on, e.g. example.com." },
  label: { type: "string", minLength: 1, description: `The ${what}'s visible name, e.g. 登录.` },
});

export const BROWSER_ACTIONS: readonly StandardAction[] = Object.freeze([
  {
    name: "browser.open",
    description: "Open a web page (http or https) in a browser space and return it as text with numbered controls; scripts run like in a real browser.",
    label: "在打开网页",
    input_schema: object({ url: { type: "string", pattern: "^[hH][tT][tT][pP][sS]?://", maxLength: 2048, description: "The address to open." }, space: spaceProp() }, ["url"]),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["forbidden", "unavailable", "result_unknown"],
  },
  {
    name: "browser.read",
    description: "Read the page open in a space now: its text and the numbered controls (links, buttons, fields). Call again after the page changes.",
    label: "在读网页",
    input_schema: object({ space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.click",
    description: "Click a control from the latest page of that space; refused if the page or the control is no longer what site and label say. Returns the page afterwards.",
    label: "在网页上点击",
    input_schema: object({ ...targetProps("control"), space: spaceProp() }, ["ref", "site", "label"]),
    result_schema: pageResult(),
    effect: "act", risk: "outward", foreground: false,
    errors: ["not_found", "conflict", "unavailable", "result_unknown"],
  },
  {
    name: "browser.type",
    description: "Type text into a field from the latest page of that space, replacing its content, optionally submitting its form. Password and file fields are refused. Returns the page afterwards.",
    label: "在网页上输入",
    input_schema: object({
      ...targetProps("field"),
      text: { type: "string", maxLength: 20000, description: "What to type; replaces the field's content." },
      submit: { type: "boolean", description: "Submit the form after typing (like pressing Enter)." },
      space: spaceProp(),
    }, ["ref", "site", "label", "text"]),
    result_schema: pageResult(),
    effect: "act", risk: "outward", foreground: false,
    errors: ["not_found", "conflict", "forbidden", "unavailable", "result_unknown"],
  },
  {
    name: "browser.scroll",
    description: "Scroll the page about one screen down or up and return it.",
    label: "在滚动网页",
    input_schema: object({ direction: { type: "string", enum: ["down", "up"], description: "down (default) or up." }, space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.back",
    description: "Go to the previous page in that space and return it.",
    label: "在回上一页",
    input_schema: object({ space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.screenshot",
    description: "A picture of the page in a space as it looks now, for things text does not show (charts, layout). The picture is the image part of the result.",
    label: "在给网页截图",
    input_schema: object({ space: spaceProp() }),
    result_schema: {
      type: "object", required: ["space", "url", "title", "mime"],
      properties: {
        space: { type: "string" }, url: { type: "string" }, title: { type: "string" },
        mime: { type: "string", description: "image/jpeg or image/png." },
        path: { type: "string", description: "Where the hand saved the picture on its own machine, when it did." },
      },
    },
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.evaluate",
    description: "Run JavaScript in the page of a space and return its JSON-serializable result. Runs with the page's own authority, logged in as the owner.",
    label: "在网页里运行脚本",
    input_schema: object({ code: { type: "string", minLength: 1, maxLength: 100000, description: "JavaScript expression or function body; its value is returned." }, space: spaceProp() }, ["code"]),
    result_schema: {
      type: "object", required: ["space", "value"],
      properties: {
        space: { type: "string" },
        value: { description: "The returned value; null when the script returned nothing." },
        truncated: { type: "boolean" },
      },
    },
    effect: "execute", risk: "structure", foreground: false,
    errors: ["not_found", "unavailable", "result_unknown"],
  },
  {
    name: "browser.close",
    description: "Close a browser space and forget its page (logins stay). space \"*\" closes every space of the caller.",
    label: "在关网页",
    input_schema: object({ space: { type: "string", pattern: "^([a-z0-9_-]{1,24}|\\*)$", description: "The space to close (default main), or * for all of them." } }),
    result_schema: {
      type: "object", required: ["closed"],
      properties: { closed: { type: "array", items: { type: "string" }, description: "The spaces that were closed; empty when none was open." } },
    },
    effect: "act", risk: "none", foreground: false,
    errors: ["unavailable"],
  },
  {
    name: "browser.spaces",
    description: "List the open browser spaces of the caller: address, title and when each was last used (most recent first).",
    label: "在看打开了哪些网页",
    input_schema: object({}),
    result_schema: {
      type: "object", required: ["spaces"],
      properties: {
        spaces: {
          type: "array",
          items: {
            type: "object", required: ["space", "url", "title", "last_used"],
            properties: { space: { type: "string" }, url: { type: "string" }, title: { type: "string" }, last_used: { type: "integer", description: "Unix time, milliseconds." } },
          },
        },
      },
    },
    effect: "read", risk: "none", foreground: false,
    errors: ["unavailable"],
  },
]);

export const BROWSER_ACTION_NAMES: readonly string[] = Object.freeze(BROWSER_ACTIONS.map((action) => action.name));

/** Non-standard browser capabilities that exist today; they stay out of the standard because only one kind of hand can do them. */
export const BROWSER_EXTENSIONS: readonly string[] = Object.freeze([
  "x.android.browser.show", "x.android.browser.run", "x.kimi.browser.upload", "x.kimi.browser.network", "x.ego.browser.script",
]);
