/**
 * Behaviours a persona can unlock in code. The persona's instructions steer which action the model
 * picks; traits decide which actions exist to pick from.
 */
export const TRAITS = {
  "adversarial-input": "Fills fields with emoji, non-Latin text, very long, empty and injection-shaped values",
  "boundary-input": "Fills fields with edge values for their type: 0, -1, huge and fractional numbers, extreme dates",
  "double-submit": "Double-clicks submit buttons and navigates away straight after submitting",
  hasty: "Acts before the page has fully settled",
  history: "Goes forward in history and re-enters recently visited URLs directly",
  "url-tamper": "Enters edited URLs: ids changed to neighbours, zero or huge values, query values emptied, a parent path",
  keyboard: "Presses Enter on fields, buttons and links instead of clicking, and Escape to dismiss",
} as const;
export type Trait = keyof typeof TRAITS;
export const TRAIT_NAMES = Object.keys(TRAITS) as Trait[];

export interface Persona {
  name: string;
  /** Written into the state and the action question; shapes what the model picks. */
  strategy: string;
  traits: Trait[];
}

export const BUILT_IN_PERSONAS: Persona[] = [
  {
    name: "impatient",
    strategy:
      "You are impatient. You double-click submit buttons, navigate away while requests are in flight, " +
      "and click things before they finish loading. You hunt for duplicate submissions and race conditions.",
    traits: ["double-submit", "hasty"],
  },
  {
    name: "sloppy",
    strategy:
      "You are a sloppy typist. You fill fields with emoji, non-Latin characters, very long strings, " +
      "empty values in required fields and injection-shaped input, then submit. " +
      "You hunt for validation gaps and encoding bugs.",
    traits: ["adversarial-input"],
  },
  {
    name: "out-of-order",
    strategy:
      "You navigate out of order. You press back in the middle of multi-step flows, enter URLs directly, " +
      "and revisit steps you already completed. You hunt for broken state machines.",
    traits: ["history"],
  },
  {
    name: "completionist",
    strategy:
      "You are a completionist. You seek rarely visited surfaces: empty states, filters with no results, " +
      "secondary tabs, settings sub-pages. You prefer pages you have not visited yet.",
    traits: [],
  },
  {
    name: "boundary",
    strategy:
      "You test the edges of every input. You enter zero, negative, fractional and enormous quantities, " +
      "dates far in the past and future, and minimal or maximal lengths, then submit and read what the app " +
      "shows back. You hunt for off-by-one errors, overflowing totals, wrong rounding and values the app " +
      "accepts but should reject.",
    traits: ["boundary-input"],
  },
  {
    name: "url-tamperer",
    strategy:
      "You edit the address bar. You change ids in URLs to neighbouring, zero and huge values, empty out " +
      "query parameters and strip path segments. A clear not-found or access-denied page is the correct answer; " +
      "you hunt for crashes, raw error pages, stack traces, and pages that show a record you should not reach.",
    traits: ["url-tamper"],
  },
  {
    name: "keyboard",
    strategy:
      "You use the keyboard only. You press Enter in fields to submit forms, Enter on buttons and links " +
      "to activate them, and Escape to close dialogs and menus. You hunt for controls that only respond " +
      "to a mouse, forms that ignore Enter, and dialogs you cannot dismiss.",
    traits: ["keyboard"],
  },
];

export const BUILT_IN_NAMES = BUILT_IN_PERSONAS.map((p) => p.name);

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_STRATEGY_CHARS = 2000;

/** Check a persona definition from a config file, the API or the UI. Returns it normalized. */
export function validatePersona(value: unknown): Persona {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A persona must be an object { name, strategy, traits }");
  const { name, strategy, traits = [], ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`Unknown persona field(s): ${extra.join(", ")}`);
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`Persona name "${String(name)}" must be 1-32 lowercase letters, digits or dashes`);
  }
  if (typeof strategy !== "string" || !strategy.trim()) throw new Error(`Persona "${name}" needs instructions`);
  if (strategy.length > MAX_STRATEGY_CHARS) throw new Error(`Persona "${name}" instructions exceed ${MAX_STRATEGY_CHARS} characters`);
  if (!Array.isArray(traits) || !traits.every((t) => TRAIT_NAMES.includes(t as Trait))) {
    throw new Error(`Persona "${name}" traits must be some of: ${TRAIT_NAMES.join(", ")}`);
  }
  return { name, strategy: strategy.trim(), traits: [...new Set(traits as Trait[])] };
}

/**
 * Personas by name from a library, or definitions given inline. An unknown name is an error, so a
 * typo does not silently shrink a run to fewer personas.
 */
export function resolvePersonas(entries: readonly (string | Persona)[], library: readonly Persona[] = BUILT_IN_PERSONAS): Persona[] {
  const personas = entries.map((entry) => {
    if (typeof entry !== "string") return validatePersona(entry);
    const found = library.find((p) => p.name === entry);
    if (!found) throw new Error(`Unknown persona "${entry}" (known: ${library.map((p) => p.name).join(", ")})`);
    return found;
  });
  const names = personas.map((p) => p.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new Error(`Persona "${dupe}" is listed twice`);
  return personas;
}
