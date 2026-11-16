// A faster drop-in for marked 18.1.3: parse(markdown) returns exactly the
// HTML marked renders with its default options (GFM on, breaks off), faster.
//
// How it works: marked's own Lexer does the block tokenizing and its Parser
// renders, but the inline tokenizing loop is replaced by FastLexer below, a
// character-dispatch loop that scans plain-text runs directly instead of
// trying every inline tokenizer's regex at each position. Every inline
// construct (escape, tag, link, reflink, emphasis, code span, hard break,
// strikethrough, autolink, extended autolink) is still tokenized by marked's
// own Tokenizer methods, and the emphasis mask is built the same way marked
// builds it, so the tokens — and therefore the HTML — are identical. Anything
// unexpected falls back to marked itself.

import { Lexer, Parser, getDefaults, marked } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small helpers, mirroring marked's helpers.ts exactly.
// ---------------------------------------------------------------------------

const MULTIPLE_SPACE_GLOBAL = /\s+/g;

/** Normalize a link label the way marked does (helpers.normalizeLabel). */
function normalizeLabel(label) {
  return label.trim().replace(MULTIPLE_SPACE_GLOBAL, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Numeric character references, from marked's rules.ts (other.*).
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/**
 * Decode numeric character references the way marked does
 * (helpers.decodeNumericCharacterReferences). A decoded character must not
 * join its neighbours into a new reference, so every `&` that is not already
 * one is escaped here.
 */
function decodeNumericCharacterReferences(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// The fast inline scanner: finds where marked's GFM inline-text regex would
// end a text token, without running that regex.
// ---------------------------------------------------------------------------

/** Email local-part characters, as in marked's GFM text regex. */
function isEmailLocal(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    ch === '.' || ch === '!' || ch === '#' || ch === '$' || ch === '%' ||
    ch === '&' || ch === "'" || ch === '*' || ch === '+' || ch === '/' ||
    ch === '=' || ch === '?' || ch === '`' || ch === '{' || ch === '|' ||
    ch === '}' || ch === '~' || ch === '-'
  );
}

function isAlphaNum(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isSpace(ch) {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Where a run of email-local characters starting at `i` ends (first index
 * that is not an email-local character).
 */
function scanEmailLocal(src, i) {
  while (i < src.length && isEmailLocal(src[i])) i++;
  return i;
}

/**
 * Finds the next position where marked's GFM text regex could stop: a special
 * character, a `www.` / protocol / `mailto:` / `xmpp:` start, a hard-break
 * run, or an `@`. The regex engine does the scanning; each candidate is then
 * checked against the exact stop conditions. Note `www.`, `mailto:` and
 * `xmpp:` are lowercase-only in marked's rules, while the protocols are
 * case-insensitive.
 */
const TEXT_STOP = /[\\<!\[`*~_]|www\.|[hH][tT][tT][pP][sS]?:|[fF][tT][pP]:|mailto:|xmpp:| {2,}\n|@/g;

/**
 * The length of the text token marked's GFM inline-text regex matches at the
 * start of `src`, computed by scanning for candidate stop positions instead of
 * running that regex. `src` is non-empty and no other inline tokenizer
 * matched at its start.
 */
function textRunLength(src) {
  const len = src.length;
  // Alternative A of the text regex: one non-alphanumeric char followed by
  // `mailto:` or `xmpp:` — the text token is just that one character, so the
  // email protocol can be autolinked next.
  if (len >= 2 && !isAlphaNum(src[0])) {
    if (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1)) return 1;
  }

  // The first unit: a run of backticks, a run of tildes, or one other char.
  let i = 0;
  const first = src[0];
  if (first === '`' || first === '~') {
    while (i < len && src[i] === first) i++;
  } else {
    i = 1;
  }

  // Immediate stops right after the first unit.
  if (i < len) {
    const c = src[i];
    // (a) a backtick or tilde follows: the text token is the first unit only.
    if (c === '`' || c === '~') return i;
    // (b) two or more spaces and a newline follow: stop for the hard break.
    if (c === ' ' && src[i + 1] === ' ') {
      let j = i;
      while (j < len && src[j] === ' ') j++;
      if (src[j] === '\n') return i;
    }
    // (c) an email local part and `@` follow: stop for the autolink.
    if (isEmailLocal(c)) {
      const end = scanEmailLocal(src, i);
      if (end > i && src[end] === '@') return i;
    }
  } else {
    return i;
  }

  // Lazy scan: jump from candidate to candidate.
  TEXT_STOP.lastIndex = i;
  let m;
  while ((m = TEXT_STOP.exec(src)) !== null) {
    const p = m.index;
    const cand = m[0];
    const c0 = cand[0];
    if (cand.length === 1) {
      if (c0 === '@') {
        // Consuming email stop: the text ends after the non-local character
        // before the local run that ends at this `@`.
        let runStart = p;
        while (runStart > 0 && isEmailLocal(src[runStart - 1])) runStart--;
        if (runStart > 0 && runStart < p) return runStart;
        continue;
      }
      // A special character stops the text — unless it sits inside an email
      // local run that ends at an `@`, in which case the regex's consuming
      // email stop at the run's start fires first (it is at an earlier
      // position than this character).
      if (c0 === '!' || c0 === '`' || c0 === '*' || c0 === '~' || c0 === '_') {
        let runStart = p;
        while (runStart > 0 && isEmailLocal(src[runStart - 1])) runStart--;
        if (runStart > 0) {
          const end = scanEmailLocal(src, p);
          if (src[end] === '@') return runStart;
        }
      }
      return p;
    }
    if (c0 === ' ') {
      // ` {2,}\n`: consuming stop after the preceding non-space character.
      if (src[p - 1] !== ' ') return p;
      continue;
    }
    if (c0 === 'w') {
      // A www autolink starts only at the start, after whitespace, or after
      // `*`, `_`, `~` or `(`.
      const prev = p === 0 ? '' : src[p - 1];
      if (p === 0 || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') return p;
      TEXT_STOP.lastIndex = p + 1;
      continue;
    }
    if (c0 === 'm' || c0 === 'x') {
      // `mailto:` / `xmpp:`: consuming stop after a non-alphanumeric char.
      if (!isAlphaNum(src[p - 1])) return p;
      TEXT_STOP.lastIndex = p + 1;
      continue;
    }
    // `http:` / `https:` / `ftp:`: stop only when `//` follows (the `:` is
    // already part of the candidate).
    if (src.startsWith('//', p + cand.length)) return p;
    TEXT_STOP.lastIndex = p + 1;
  }
  return len;
}

// ---------------------------------------------------------------------------
// FastLexer: marked's Lexer with the inline tokenizing loop replaced by a
// character-dispatch loop. Block tokenizing is untouched.
// ---------------------------------------------------------------------------

class FastLexer extends Lexer {
  inlineTokens(src, tokens = []) {
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      return this.tokenizeInlines(src, tokens);
    } finally {
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  /**
   * Does this link text hold a link already? An image does not count.
   * Mirrors Lexer.linkInText.
   */
  linkInText(text) {
    if (!text.includes('[')) return false;
    const linkRule = this.tokenizer.rules.inline.link;
    for (const match of text.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
    }
    for (const match of text.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
      return true;
    }
    return false;
  }

  /**
   * Mask links, code, html and escapes so emStrong and del do not see their
   * delimiters inside them. Mirrors Lexer.#maskSrc (every mask keeps the
   * length it replaces).
   */
  maskSrc(src) {
    let maskedSrc = src;
    if (this.tokens.links && src.includes('[')) {
      const reflinkSearch = this.tokenizer.rules.inline.reflinkSearch;
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }
    maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
    maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
    return maskedSrc;
  }

  tokenizeInlines(src, tokens) {
    // The masked source is only read by emStrong and del, which need a *,
    // _ or ~ to start. Skip building it for a run without one — and also
    // when the run holds nothing the mask could change: the mask only
    // touches reflinks (need `[`), code spans (need `` ` ``), links and
    // HTML (need `[` or `<`) and escapes (need `\`).
    const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~'))
      && (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'))
      ? this.maskSrc(src)
      : src;

    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        const errMsg = 'Infinite loop on byte: ' + src.charCodeAt(0);
        if (this.options.silent) console.error(errMsg);
        else throw new Error(errMsg);
        break;
      }

      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;

      let token;
      const ch = src[0];

      // Dispatch on the first character: each branch tries exactly the
      // tokenizers that can match there, in marked's order, then falls
      // through to the text scan.
      if (ch === '\\') {
        if ((token = this.tokenizer.escape(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if ((token = this.tokenizer.br(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === '<') {
        if ((token = this.tokenizer.tag(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if ((token = this.tokenizer.autolink(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === '[' || (ch === '!' && src[1] === '[')) {
        if ((token = this.tokenizer.link(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if ((token = this.tokenizer.reflink(src, this.tokens.links))) {
          src = src.substring(token.raw.length);
          const lastToken = tokens.at(-1);
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      } else if (ch === '*' || ch === '_') {
        if ((token = this.tokenizer.emStrong(src, maskedSrc, prevChar))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        // `_` can also start an email autolink (`_a@b.com`).
        if (ch === '_' && !this.state.inLink && (token = this.tokenizer.url(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === '`') {
        if ((token = this.tokenizer.codespan(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === '~') {
        if ((token = this.tokenizer.del(src, maskedSrc, prevChar))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (ch === ' ') {
        if (src[1] === ' ' && (token = this.tokenizer.br(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (!this.state.inLink && (isAlphaNum(ch) || ch === '.' || ch === '+' || ch === '-')) {
        // An extended autolink (www, http, email) can only start on a letter,
        // a digit, or one of . + - (the email local part's leading chars).
        if ((token = this.tokenizer.url(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }

      // Text: scan the run directly instead of running the text regex.
      const runLength = textRunLength(src);
      const raw = src.substring(0, runLength);
      src = src.substring(runLength);
      const escaped = this.state.inRawBlock;
      const text = escaped ? raw : decodeNumericCharacterReferences(raw);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += raw;
        lastToken.text += text;
      } else {
        tokens.push({ type: 'text', raw, text, escaped });
      }
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  try {
    const tokens = new FastLexer(getDefaults()).lex(markdown);
    return Parser.parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
