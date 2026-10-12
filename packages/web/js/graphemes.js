// What a reader counts as one character: a whole emoji, flag or accented letter, never half of one.
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** [text] as an array of user-perceived characters (falls back to code points where Intl.Segmenter is missing). */
export const graphemesOf = (text) => segmenter ? Array.from(segmenter.segment(String(text ?? "")), (part) => part.segment) : [...String(text ?? "")];
