# moving_rod_mcp

This project now includes a lightweight MCP server for the segmented inclined-track rod problems implemented in `1.html` and `2.html`.

## Design

The MCP follows the same general split used by the reference project `emf_solver_mcp_lightweight`:

- simulation tool: execute the physical model and return structured evidence
- measurement tool: ask follow-up questions against a prior run
- schema tool: describe the accepted scene DSL and query shapes

The local MCP does not try to write the final human derivation. It acts as a reliable executable sandbox for:

- single-rod motion on a segmented inclined track
- double-rod motion with the current two-stage `splitX` logic
- magnetic-field normal component `Bn = B cos(phi)`
- gravity along track using local segment angle `theta(x)`
- optional elastic collision for the double-rod model

## Install

```bash
npm install
```

## Start the MCP server

```bash
npm run start:mcp
```

Windows UTF-8 helper:

```bash
npm run start:mcp:utf8
```

## Tools

- `moving_rod_simulate_scene`
- `moving_rod_measure_scene`
- `moving_rod_describe_scene_schema`

## Tests

```bash
npm run test:mcp
```

## Example MCP config

```json
{
  "mcpServers": {
    "moving_rod_mcp": {
      "command": "npm",
      "args": ["run", "start:mcp"],
      "cwd": "C:/Users/zmg/Desktop/moving_rod_problem"
    }
  }
}
```
