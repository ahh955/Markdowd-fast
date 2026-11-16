# Markdowd-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ahh955/Markdowd-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ahh955/Markdowd-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked 18.1.3: `parse.js` exports `parse(markdown)`, which
returns exactly the HTML that marked renders with its default options (GFM on),
but faster. It keeps marked's own block lexer and renderer and replaces the
inline tokenizing loop with a character-dispatch loop that skips the regex
attempts plain text never matches; every inline construct (links, emphasis,
code spans, autolinks, strikethrough) is still tokenized by marked's own
tokenizers, and anything unexpected falls back to marked itself
(`vendor/marked/marked.esm.js`, byte-identical to the npm build, MIT).

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`),
renders each one alone with `parse()`, and writes `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=xsff4jzh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
