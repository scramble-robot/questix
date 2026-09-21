# Writing code for QUESTiX LAB

The reference implementation is the path-planning course: `js/planning/` with
`content/planning.json`. New and rewritten code follows it.

## Layers (one directory per course)

| File | Role | Rules |
| --- | --- | --- |
| `core.js` | Maths, simulation, parsing | No DOM, no `window`. Importable from Node, unit-testable. |
| `render.js` | Canvas / SVG drawing | Draws from plain data handed in by `ui.js`. Holds no state. |
| `view.js` | lit-html templates | Pure functions `model → TemplateResult`. No state, no `document.*`, no side effects. Events are bound in the template (`@click=${actions.x}`). |
| `ui.js` | State and behaviour | Owns the state, builds the `model`, implements `actions`, calls `render(view(model), container)` from one `update()` function, exports the `init… / activate… / review…` entry points. |
| `content/<course>.json` | Every learner-facing sentence | Loaded with `loadJson` (top-level await). Rich fragments (lists, links) go to `content/<course>/*.html`; downloadable scripts and procedures are real files. |

Short labels (button captions, table headers, units) may stay in `view.js`. Anything that reads as
a sentence, an explanation, or a status message belongs in the content file.

## Style

- Names say what the value is: `experiment`, `sample`, `clearance` — not `s`, `q`, `c`. Single
  letters are fine for loop indices and for the symbols of a formula written next to it
  (`x`, `y`, `theta`, `dt`, `v`, `w`), with the unit in a comment or the name.
- One declaration per statement (`const a = 1;` `const b = 2;`), never `const a = 1, b = 2;`.
- No nested ternaries. Use a small function with early returns (see `playButtonLabel`).
- Magic numbers become named constants with their unit: `const SAMPLE_PERIOD = 0.04; // seconds`.
- Functions do one thing and fit on a screen (about 40 lines). Templates are split into parts
  named after what the learner sees (`mapCard`, `controlPanel`, `resultsCard`).
- No `innerHTML` with interpolated values and no `getElementById(...).onclick = …` wiring.
  Status text, labels, disabled/hidden flags are part of the model, not poked into the DOM.
  Reading a canvas or an element's geometry by id is fine.
- Strings from other modules that are already HTML (`lessonBrief`, `schoolTips`, `lessonLabel`)
  are inserted with `unsafeHTML`; never pass learner input or robot data through it.
- Comments explain why (a constraint, a unit, a trap), not what the next line does.
- Shared helpers live in `js/core/` (`content.js`, `dom.js`); do not re-declare `download` or
  number formatting per module.
- Format with Prettier (`.prettierrc.json`); third-party code in `js/vendor/` is left as upstream.

## lit-html notes

- Import everything from `js/vendor/lit-html.js` (`html`, `svg`, `render`, `nothing`,
  `unsafeHTML`, `unsafeSVG`, `classMap`, `styleMap`, `ifDefined`, `live`, `ref`, `repeat`).
- Boolean attributes: `?disabled=${…}`, `?hidden=${…}`. Live form state: `.value=${…}`,
  `.checked=${…}`.
- Opening another topic rebuilds the page (`render(null, container)` then `update()`), so
  `<details>`, focus and scroll start fresh; within a topic, `update()` patches in place.
- `shell/supplement-ui.js` inserts a button before every `details[data-help-dialog]` and moves
  the details' children into a shared dialog while it is open. That is compatible with lit as
  long as such a `<details>` is not conditionally swapped while its dialog is open; pause
  animations on the `supplement-open` event as the courses already do.
- Module entry points and other exports keep their names, signatures and return types; other
  modules depend on them.

## Proving that learners see the same thing

`test/ui-regression.mjs` drives a baseline copy of the site and the working copy through the same
steps in headless Chrome (fake clock, seeded `Math.random`) and diffs a canonical serialisation
of the visible DOM, including a pixel hash of every canvas:

```bash
cp -r scripts/robot_manager/static/lab /tmp/lab-baseline        # before you start
node test/ui-regression.mjs --baseline /tmp/lab-baseline --route planning
node test/ui-regression.mjs --baseline /tmp/lab-baseline --route planning --steps test/steps/planning.json
```

Without `--steps` it opens every chapter/topic button and presses each primary button once. Add a
`test/steps/<course>.json` that exercises the controls the crawl does not reach (sliders,
checkboxes, examples, secondary buttons). A difference must be either fixed or a deliberate,
documented bug fix (list it under "Known intentional differences" below) — never silenced.

DOM-free modules get Node tests in `test/*.test.mjs` (`node --test test/*.test.mjs`).

## Known intentional differences from the single-file original

- Planning: the playback position slider never worked (the handler paused first, which wrote the
  current position back into the slider before its new value was read). It works now.
- Planning: the saved hardware procedure (`.txt`) has line breaks between paragraphs.
