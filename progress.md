Original prompt: track can be split into N segments, and each segment can have its own angle

- 2026-03-14: Added segmented-track controls to `1.html`: `N`, common segment length `d`, and angle inputs `theta1..thetaN`.
- 2026-03-14: Updated single-rod physics to use local segment angle `theta(x)` for gravity and track rendering.
- 2026-03-14: Added the same segmented-track controls to `2.html` and applied local angles `theta(x1)` / `theta(x2)` in dual-rod dynamics.
- 2026-03-14: Fixed `2.html` startup so dynamic segment inputs are created on load, and new segment-angle inputs now trigger `app.applyParams()`.
- 2026-03-14: Validation completed:
  - inline script syntax check passed for `1.html` and `2.html`
  - Playwright client opened both pages successfully
  - screenshot smoke test passed at default settings
  - mock DOM test confirmed `N=3` input generation, segmented angle reading, and local segment indexing/elevation helpers
- 2026-03-14: Added a lightweight MCP server inspired by `emf_solver_mcp_lightweight` with three tools:
  - `moving_rod_simulate_scene`
  - `moving_rod_measure_scene`
  - `moving_rod_describe_scene_schema`
- 2026-03-14: Added Node package setup, Windows UTF-8 start script, README, and MCP tests under `mcp/tests/run-tests.js`.
- 2026-03-14: MCP validation completed:
  - `npm install` completed successfully
  - `npm run test:mcp` passed
  - `node mcp/src/index.js` started and printed `moving_rod_mcp started`

TODO
- Do a manual browser pass for multi-segment visuals near the joint/split area in `2.html`.
- Consider whether future iterations need per-segment length instead of one shared length `d`.
- Consider whether to expose a higher-level "solve this named textbook setup" tool on top of the current sandbox tools.
