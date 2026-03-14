"use strict";

const assert = require("node:assert/strict");
const {
  describeMovingRodSchemaTool,
  measureMovingRodTool,
  simulateMovingRodTool
} = require("../src/simulator");

async function testSingleRod() {
  const mu = 0.2;
  const simulation = await simulateMovingRodTool({
    scene: {
      model: "single_rod",
      environment: {
        B: 0,
        phi_deg: 0,
        g: 9.8,
        field_segments: [
          { B: 0, phi_deg: 0, length: 1.5 },
          { B: 0.5, phi_deg: 0, length: 1.5 },
          { B: 1.0, phi_deg: 60, length: 1.5 }
        ]
      },
      track: {
        segments: [
          { angle_deg: 0, length: 1.5 },
          { angle_deg: 30, length: 1.5 },
          { angle_deg: -10, length: 1.5 }
        ]
      },
      single_rod: {
        rod: { length: 1, mass: 1, internal_resistance: 0.5, kinetic_friction: mu },
        circuit: { external_resistance: 2, source_voltage: 0 },
        dynamics: { external_force: 0, x0: 1.6, v0: 0 }
      }
    },
    solve_options: { dt: 0.01, t_end: 0.05, sample_every: 1 }
  });

  assert.equal(simulation.status, "PASS");
  assert.equal(simulation.summary.model, "single_rod");
  const expectedA0 = -9.8 * Math.sin(Math.PI / 6) + 9.8 * mu * Math.cos(Math.PI / 6);
  assert.ok(Math.abs(simulation.history.a[0] - expectedA0) < 0.2, "single-rod acceleration should include kinetic friction");
  assert.ok(simulation.history.F_friction[0] > 0, "friction should oppose the downhill driving tendency");
  assert.equal(simulation.history.Bn[0], 0.5, "single-rod should sample the local magnetic segment");
  const measure = await measureMovingRodTool({
    simulation,
    query: { type: "segment_at_position", position: 1.6 }
  });
  assert.equal(measure.status, "PASS");
  assert.equal(measure.matches[0].segment_index, 1);
}

async function testDoubleRod() {
  const simulation = await simulateMovingRodTool({
    scene: {
      model: "double_rod",
      environment: {
        B: 1.2,
        phi_deg: 90,
        g: 9.8,
        field_profile_start: -1,
        field_segments: [
          { B: 1.2, phi_deg: 90, length: 1.2 },
          { B: 2.0, phi_deg: 0, length: 1.2 },
          { B: 0.8, phi_deg: 60, length: 1.2 }
        ]
      },
      track: {
        segments: [
          { angle_deg: 5, length: 1.2 },
          { angle_deg: 20, length: 1.2 },
          { angle_deg: -8, length: 1.2 }
        ]
      },
      double_rod: {
        dist0: 2,
        split_ratio: 0.5,
        collide: true,
        rod1: { length: 1.4, mass: 1, resistance: 0.6, kinetic_friction: 0.1, v0: 6, external_force: 0 },
        rod2: { length: 1.0, mass: 1, resistance: 0.6, kinetic_friction: 0.1, v0: 0, external_force: 0 }
      }
    },
    solve_options: { dt: 0.01, t_end: 0.5, sample_every: 1 }
  });

  assert.equal(simulation.status, "PASS");
  assert.equal(simulation.summary.model, "double_rod");
  assert.ok(Math.abs(simulation.summary.Bn1_initial) < 1e-9, "rod1 initial field segment should zero out Bn");
  assert.ok(Math.abs(simulation.summary.Bn2_initial - 2) < 1e-9, "rod2 should read a different initial magnetic segment");
  assert.ok(simulation.history.Bn1[0] !== simulation.history.Bn2[0], "double-rod should use local field for each rod");
  assert.ok(simulation.summary.extrema.max_abs_friction_rod1 > 0, "double-rod run should record friction on rod1");
  const stageEvent = await measureMovingRodTool({
    simulation,
    query: { type: "event_search", event_type: "stage_change", limit: 1 }
  });
  assert.equal(stageEvent.status, "PASS");
  assert.ok(stageEvent.derived_values.count >= 1, "double-rod run should enter stage 2");
}

async function testSchema() {
  const schema = describeMovingRodSchemaTool();
  assert.ok(schema.scene_schema);
  assert.ok(schema.query_schema);
  assert.ok(schema.examples.single_rod);
  assert.ok(schema.scene_schema.magnetic_field_profile);
}

async function main() {
  await testSingleRod();
  await testDoubleRod();
  await testSchema();
  console.log("mcp tests passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
