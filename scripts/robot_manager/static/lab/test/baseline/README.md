# Pinned pre-refactor modules

The DOM-free modules below are copies of the site as it was before the course code was split into
core / render / view / ui layers (the single-file QUESTiX-LAB.html, mechanically split). Several
tests (`systems-core`, `vision-core`, `slam-concepts-core`, `rl-foundations-core`, `rl-experiment`,
`core-depth`, `core-engine`) run the same inputs through these copies and through the current
modules and require identical results, so a refactor cannot change what a simulation computes.

Keep these files exactly as they are (they are excluded from Prettier). Change them only together
with a deliberate, documented behaviour change, listed in `CONTRIBUTING.md` under "Known intentional
differences". `content/systems.json` is here because `js/systems/data.js` loads it.
