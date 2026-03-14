"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_G = 9.8;
const DEFAULT_DT = 0.01;
const DEFAULT_T_END = 6;
const DEFAULT_SAMPLE_EVERY = 2;

function degToRad(deg) {
  return (Number(deg) || 0) * Math.PI / 180;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asNonNegativeNumber(value, fallback) {
  return Math.max(0, asFiniteNumber(value, fallback));
}

function signWithDeadZone(value, epsilon = 1e-9) {
  if (value > epsilon) {
    return 1;
  }
  if (value < -epsilon) {
    return -1;
  }
  return 0;
}

function kineticFrictionForce({ mu, normalForce, velocity, driveForce }) {
  const coefficient = asNonNegativeNumber(mu, 0);
  const normal = Math.max(0, normalForce);
  if (coefficient <= 0 || normal <= 1e-12) {
    return 0;
  }

  const direction = signWithDeadZone(velocity) || signWithDeadZone(driveForce);
  if (!direction) {
    return 0;
  }

  return -direction * coefficient * normal;
}

function createRunId(prefix = "moving_rod") {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomBytes(4).toString("hex")}`;
}

function experimentRoot() {
  return path.resolve(process.cwd(), "experiment_runs");
}

function runDir(runId) {
  return path.join(experimentRoot(), runId);
}

function artifactPath(runId, fileName) {
  return path.join(runDir(runId), "artifacts", fileName);
}

async function ensureRunDirs(runId) {
  await fs.mkdir(artifactPath(runId, "."), { recursive: true });
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function normalizeTrack(trackInput) {
  const track = asObject(trackInput) || {};
  const defaultLength = asPositiveNumber(track.segment_length ?? track.default_segment_length, 2);
  const profileStart = asFiniteNumber(track.profile_start, 0);
  const rawSegments = Array.isArray(track.segments) && track.segments.length > 0
    ? track.segments
    : [{ angle_deg: asFiniteNumber(track.theta_deg, 0), length: defaultLength }];

  const segments = rawSegments.map((segment, index) => {
    const item = asObject(segment) || {};
    return {
      index,
      angle_deg: asFiniteNumber(item.angle_deg ?? item.theta_deg, 0),
      angle_rad: degToRad(item.angle_deg ?? item.theta_deg),
      length: asPositiveNumber(item.length, defaultLength)
    };
  });

  return {
    profile_start: profileStart,
    default_segment_length: defaultLength,
    segments
  };
}

function normalizeMagneticProfile(environmentInput) {
  const environment = asObject(environmentInput) || {};
  const defaultLength = asPositiveNumber(environment.field_segment_length ?? environment.segment_length, 2);
  const profileStart = asFiniteNumber(environment.field_profile_start ?? environment.profile_start, 0);
  const fallbackB = asFiniteNumber(environment.B, 1);
  const fallbackPhiDeg = asFiniteNumber(environment.phi_deg, 0);
  const rawSegments = Array.isArray(environment.field_segments) && environment.field_segments.length > 0
    ? environment.field_segments
    : [{ B: fallbackB, phi_deg: fallbackPhiDeg, length: defaultLength }];

  const segments = rawSegments.map((segment, index) => {
    const item = asObject(segment) || {};
    const phiDeg = asFiniteNumber(item.phi_deg ?? item.phi ?? fallbackPhiDeg, fallbackPhiDeg);
    const B = asFiniteNumber(item.B ?? item.magnitude ?? fallbackB, fallbackB);
    return {
      index,
      B,
      phi_deg: phiDeg,
      phi_rad: degToRad(phiDeg),
      Bn: B * Math.cos(degToRad(phiDeg)),
      length: asPositiveNumber(item.length, defaultLength)
    };
  });

  return {
    profile_start: profileStart,
    default_segment_length: defaultLength,
    segments
  };
}

function getTrackSegmentIndex(x, track) {
  if (!track.segments.length) {
    return 0;
  }
  if (x <= track.profile_start) {
    return 0;
  }
  let cursor = track.profile_start;
  for (let index = 0; index < track.segments.length - 1; index += 1) {
    cursor += track.segments[index].length;
    if (x < cursor) {
      return index;
    }
  }
  return track.segments.length - 1;
}

function getProfileSegmentIndex(x, profile) {
  if (!profile?.segments?.length) {
    return 0;
  }
  if (x <= profile.profile_start) {
    return 0;
  }
  let cursor = profile.profile_start;
  for (let index = 0; index < profile.segments.length - 1; index += 1) {
    cursor += profile.segments[index].length;
    if (x < cursor) {
      return index;
    }
  }
  return profile.segments.length - 1;
}

function getTrackAngleAt(x, track) {
  const index = getTrackSegmentIndex(x, track);
  return track.segments[index]?.angle_rad ?? 0;
}

function getMagneticSegmentIndex(x, fieldProfile) {
  return getProfileSegmentIndex(x, fieldProfile);
}

function getMagneticFieldAt(x, fieldProfile) {
  const index = getMagneticSegmentIndex(x, fieldProfile);
  return fieldProfile?.segments?.[index] ?? { index: 0, B: 0, phi_deg: 0, phi_rad: 0, Bn: 0 };
}

function getTrackElevationAt(x, track) {
  if (!track.segments.length) {
    return 0;
  }
  if (x <= track.profile_start) {
    return (x - track.profile_start) * Math.tan(track.segments[0].angle_rad);
  }
  let elevation = 0;
  let cursor = track.profile_start;
  for (let index = 0; index < track.segments.length; index += 1) {
    const segment = track.segments[index];
    const next = cursor + segment.length;
    if (x <= next || index === track.segments.length - 1) {
      return elevation + (x - cursor) * Math.tan(segment.angle_rad);
    }
    elevation += segment.length * Math.tan(segment.angle_rad);
    cursor = next;
  }
  return elevation;
}

function normalizeSolveOptions(input) {
  const solveOptions = asObject(input) || {};
  const dt = asPositiveNumber(solveOptions.dt, DEFAULT_DT);
  const tEnd = asPositiveNumber(solveOptions.t_end, DEFAULT_T_END);
  const maxStepsFallback = Math.ceil(tEnd / dt);
  return {
    dt,
    t_end: tEnd,
    sample_every: Math.max(1, Math.floor(asPositiveNumber(solveOptions.sample_every, DEFAULT_SAMPLE_EVERY))),
    max_steps: Math.max(100, Math.floor(asPositiveNumber(solveOptions.max_steps, maxStepsFallback)))
  };
}

function baseSummary(scene, track, solveOptions) {
  return {
    model: scene.model,
    segment_count: track.segments.length,
    profile_start: track.profile_start,
    solve_options: solveOptions
  };
}

function makeSeriesStore(names) {
  const store = {};
  for (const name of names) {
    store[name] = [];
  }
  return store;
}

function recordSeries(store, sample) {
  for (const [key, value] of Object.entries(sample)) {
    if (store[key]) {
      store[key].push(value);
    }
  }
}

function pushEvent(events, type, payload) {
  events.push({
    type,
    ...payload
  });
}

function normalizeSingleScene(scene, issues) {
  const environment = asObject(scene.environment) || {};
  const track = normalizeTrack(scene.track);
  const rod = asObject(scene.single_rod || scene.single || {}) || {};
  const circuit = asObject(rod.circuit) || {};
  const dynamics = asObject(rod.dynamics) || {};
  const body = asObject(rod.rod) || {};

  const model = {
    environment: {
      B: asFiniteNumber(environment.B, 1),
      phi_deg: asFiniteNumber(environment.phi_deg, 0),
      phi_rad: degToRad(environment.phi_deg),
      g: asPositiveNumber(environment.g, DEFAULT_G),
      magnetic_profile: normalizeMagneticProfile(environment)
    },
    track,
    rod: {
      length: asPositiveNumber(body.length, 1),
      mass: asPositiveNumber(body.mass, 1),
      internal_resistance: Math.max(0, asFiniteNumber(body.internal_resistance ?? body.r, 0.5)),
      kinetic_friction: asNonNegativeNumber(body.kinetic_friction ?? body.mu_k ?? body.mu, 0)
    },
    circuit: {
      external_resistance: Math.max(0, asFiniteNumber(circuit.external_resistance ?? circuit.R, 2)),
      source_voltage: asFiniteNumber(circuit.source_voltage ?? circuit.U, 0)
    },
    dynamics: {
      external_force: asFiniteNumber(dynamics.external_force ?? dynamics.F, 0),
      x0: asFiniteNumber(dynamics.x0, 0),
      v0: asFiniteNumber(dynamics.v0, 0)
    }
  };

  if (!track.segments.length) {
    issues.push({ path: "scene.track.segments", reason: "At least one track segment is required." });
  }

  return model;
}

function normalizeDoubleScene(scene, issues) {
  const environment = asObject(scene.environment) || {};
  const track = normalizeTrack(scene.track);
  const doubleRod = asObject(scene.double_rod || scene.double || {}) || {};
  const rod1 = asObject(doubleRod.rod1) || {};
  const rod2 = asObject(doubleRod.rod2) || {};

  const model = {
    environment: {
      B: asFiniteNumber(environment.B, 1),
      phi_deg: asFiniteNumber(environment.phi_deg, 0),
      phi_rad: degToRad(environment.phi_deg),
      g: asPositiveNumber(environment.g, DEFAULT_G),
      magnetic_profile: normalizeMagneticProfile(environment)
    },
    track,
    system: {
      dist0: asPositiveNumber(doubleRod.dist0, 2),
      split_ratio: clamp(asFiniteNumber(doubleRod.split_ratio, 0.5), 0, 1),
      collide: Boolean(doubleRod.collide)
    },
    rod1: {
      length: asPositiveNumber(rod1.length ?? rod1.L, 1),
      mass: asPositiveNumber(rod1.mass ?? rod1.m, 1),
      resistance: Math.max(0, asFiniteNumber(rod1.resistance ?? rod1.R, 1)),
      kinetic_friction: asNonNegativeNumber(rod1.kinetic_friction ?? rod1.mu_k ?? rod1.mu, 0),
      v0: asFiniteNumber(rod1.v0 ?? rod1.v, 0),
      external_force: asFiniteNumber(rod1.external_force ?? rod1.F, 0)
    },
    rod2: {
      length: asPositiveNumber(rod2.length ?? rod2.L, 1),
      mass: asPositiveNumber(rod2.mass ?? rod2.m, 1),
      resistance: Math.max(0, asFiniteNumber(rod2.resistance ?? rod2.R, 1)),
      kinetic_friction: asNonNegativeNumber(rod2.kinetic_friction ?? rod2.mu_k ?? rod2.mu, 0),
      v0: asFiniteNumber(rod2.v0 ?? rod2.v, 0),
      external_force: asFiniteNumber(rod2.external_force ?? rod2.F, 0)
    }
  };

  return model;
}

function simulateSingle(scene, solveOptions) {
  const totalR = scene.circuit.external_resistance + scene.rod.internal_resistance;
  const history = makeSeriesStore(["t", "x", "v", "a", "I", "E_induced", "F_amp", "F_friction", "segment_index", "theta_deg", "field_segment_index", "B", "phi_deg", "Bn"]);
  const events = [];
  let t = 0;
  let x = scene.dynamics.x0;
  let v = scene.dynamics.v0;
  let a = 0;
  let current = 0;
  let inducedEmf = 0;
  let ampForce = 0;
  let frictionForce = 0;
  let segmentIndex = getTrackSegmentIndex(x, scene.track);
  let fieldSegmentIndex = getMagneticSegmentIndex(x, scene.environment.magnetic_profile);

  pushEvent(events, "simulation_start", { t, x, v, segment_index: segmentIndex, field_segment_index: fieldSegmentIndex });

  for (let step = 0; step <= solveOptions.max_steps && t <= solveOptions.t_end + 1e-12; step += 1) {
    const theta = getTrackAngleAt(x, scene.track);
    const field = getMagneticFieldAt(x, scene.environment.magnetic_profile);
    const Bn = field.Bn;
    const nextSegmentIndex = getTrackSegmentIndex(x, scene.track);
    if (nextSegmentIndex !== segmentIndex) {
      segmentIndex = nextSegmentIndex;
      pushEvent(events, "segment_enter", {
        t,
        x,
        segment_index: segmentIndex,
        theta_deg: scene.track.segments[segmentIndex]?.angle_deg ?? 0
      });
    }
    const nextFieldSegmentIndex = getMagneticSegmentIndex(x, scene.environment.magnetic_profile);
    if (nextFieldSegmentIndex !== fieldSegmentIndex) {
      fieldSegmentIndex = nextFieldSegmentIndex;
      pushEvent(events, "field_enter", {
        t,
        x,
        field_segment_index: fieldSegmentIndex,
        B: field.B,
        phi_deg: field.phi_deg,
        Bn
      });
    }

    inducedEmf = Bn * scene.rod.length * v;
    current = totalR > 1e-9 ? (inducedEmf - scene.circuit.source_voltage) / totalR : 0;
    ampForce = Bn * current * scene.rod.length;
    const gravityAlongTrack = scene.rod.mass * scene.environment.g * Math.sin(theta);
    const normalForce = scene.rod.mass * scene.environment.g * Math.cos(theta);
    const driveForce = scene.dynamics.external_force - ampForce - gravityAlongTrack;
    frictionForce = kineticFrictionForce({
      mu: scene.rod.kinetic_friction,
      normalForce,
      velocity: v,
      driveForce
    });
    a = (driveForce + frictionForce) / scene.rod.mass;
    v += a * solveOptions.dt;
    x += v * solveOptions.dt;
    t += solveOptions.dt;

    if (step % solveOptions.sample_every === 0 || step === solveOptions.max_steps || t >= solveOptions.t_end) {
      recordSeries(history, {
        t,
        x,
        v,
        a,
        I: current,
        E_induced: inducedEmf,
        F_amp: ampForce,
        F_friction: frictionForce,
        segment_index: segmentIndex,
        theta_deg: scene.track.segments[segmentIndex]?.angle_deg ?? 0,
        field_segment_index: fieldSegmentIndex,
        B: field.B,
        phi_deg: field.phi_deg,
        Bn
      });
    }
  }

  pushEvent(events, "simulation_end", { t, x, v, segment_index: getTrackSegmentIndex(x, scene.track) });

  return {
    model: "single_rod",
    summary: {
      ...baseSummary({ model: "single_rod" }, scene.track, solveOptions),
      Bn_initial: getMagneticFieldAt(scene.dynamics.x0, scene.environment.magnetic_profile).Bn,
      total_resistance: totalR,
      final_state: { t, x, v, a, I: current, E_induced: inducedEmf, F_amp: ampForce, F_friction: frictionForce },
      extrema: {
        max_abs_current: Math.max(...history.I.map(value => Math.abs(value)), 0),
        max_speed: Math.max(...history.v.map(value => Math.abs(value)), 0),
        max_abs_friction: Math.max(...history.F_friction.map(value => Math.abs(value)), 0),
        max_abs_Bn: Math.max(...history.Bn.map(value => Math.abs(value)), 0),
        min_x: Math.min(...history.x, x),
        max_x: Math.max(...history.x, x)
      }
    },
    history,
    events
  };
}

function simulateDouble(scene, solveOptions) {
  const totalR = scene.rod1.resistance + scene.rod2.resistance;
  const x1Start = -scene.system.dist0 / 2;
  const x2Start = scene.system.dist0 / 2;
  const splitX = x1Start + scene.system.split_ratio * scene.system.dist0;

  scene.track.profile_start = x1Start;

  const history = makeSeriesStore(["t", "x1", "x2", "v1", "v2", "a1", "a2", "I", "E", "Q_total", "stage", "distance", "theta1_deg", "theta2_deg", "F_friction1", "F_friction2", "field_segment_index1", "field_segment_index2", "B1", "B2", "phi1_deg", "phi2_deg", "Bn1", "Bn2"]);
  const events = [];

  let t = 0;
  let x1 = x1Start;
  let x2 = x2Start;
  let v1 = scene.rod1.v0;
  let v2 = scene.rod2.v0;
  let a1 = 0;
  let a2 = 0;
  let I = 0;
  let E = 0;
  let Q_total = 0;
  let friction1 = 0;
  let friction2 = 0;
  let stage = x1 >= splitX ? 2 : 1;
  let segment1 = getTrackSegmentIndex(x1, scene.track);
  let segment2 = getTrackSegmentIndex(x2, scene.track);
  let fieldSegment1 = getMagneticSegmentIndex(x1, scene.environment.magnetic_profile);
  let fieldSegment2 = getMagneticSegmentIndex(x2, scene.environment.magnetic_profile);

  pushEvent(events, "simulation_start", { t, x1, x2, v1, v2, stage, field_segment_index1: fieldSegment1, field_segment_index2: fieldSegment2 });
  if (stage === 2) {
    pushEvent(events, "stage_change", { t, stage, reason: "rod1 started beyond splitX" });
  }

  for (let step = 0; step <= solveOptions.max_steps && t <= solveOptions.t_end + 1e-12; step += 1) {
    if (stage === 1 && x1 >= splitX) {
      stage = 2;
      pushEvent(events, "stage_change", {
        t,
        stage,
        split_x: splitX,
        x1,
        x2,
        v1,
        v2,
        I
      });
    }

    const activeL1 = stage === 2 ? scene.rod2.length : scene.rod1.length;
    const field1 = getMagneticFieldAt(x1, scene.environment.magnetic_profile);
    const field2 = getMagneticFieldAt(x2, scene.environment.magnetic_profile);
    const Bn1 = field1.Bn;
    const Bn2 = field2.Bn;
    E = Bn1 * activeL1 * v1 - Bn2 * scene.rod2.length * v2;
    I = totalR > 1e-9 ? E / totalR : 0;

    const theta1 = getTrackAngleAt(x1, scene.track);
    const theta2 = getTrackAngleAt(x2, scene.track);
    const Fa1 = -Bn1 * I * activeL1;
    const Fa2 = Bn2 * I * scene.rod2.length;
    const gravity1 = scene.rod1.mass * scene.environment.g * Math.sin(theta1);
    const gravity2 = scene.rod2.mass * scene.environment.g * Math.sin(theta2);
    const normal1 = scene.rod1.mass * scene.environment.g * Math.cos(theta1);
    const normal2 = scene.rod2.mass * scene.environment.g * Math.cos(theta2);
    const drive1 = scene.rod1.external_force + Fa1 - gravity1;
    const drive2 = scene.rod2.external_force + Fa2 - gravity2;

    friction1 = kineticFrictionForce({
      mu: scene.rod1.kinetic_friction,
      normalForce: normal1,
      velocity: v1,
      driveForce: drive1
    });
    friction2 = kineticFrictionForce({
      mu: scene.rod2.kinetic_friction,
      normalForce: normal2,
      velocity: v2,
      driveForce: drive2
    });

    a1 = (drive1 + friction1) / scene.rod1.mass;
    a2 = (drive2 + friction2) / scene.rod2.mass;

    v1 += a1 * solveOptions.dt;
    v2 += a2 * solveOptions.dt;
    x1 += v1 * solveOptions.dt;
    x2 += v2 * solveOptions.dt;
    t += solveOptions.dt;
    Q_total += I * I * totalR * solveOptions.dt;

    const nextSegment1 = getTrackSegmentIndex(x1, scene.track);
    if (nextSegment1 !== segment1) {
      segment1 = nextSegment1;
      pushEvent(events, "segment_enter", {
        rod: "rod1",
        t,
        x: x1,
        segment_index: segment1,
        theta_deg: scene.track.segments[segment1]?.angle_deg ?? 0
      });
    }
    const nextFieldSegment1 = getMagneticSegmentIndex(x1, scene.environment.magnetic_profile);
    if (nextFieldSegment1 !== fieldSegment1) {
      fieldSegment1 = nextFieldSegment1;
      pushEvent(events, "field_enter", {
        rod: "rod1",
        t,
        x: x1,
        field_segment_index: fieldSegment1,
        B: field1.B,
        phi_deg: field1.phi_deg,
        Bn: field1.Bn
      });
    }

    const nextSegment2 = getTrackSegmentIndex(x2, scene.track);
    if (nextSegment2 !== segment2) {
      segment2 = nextSegment2;
      pushEvent(events, "segment_enter", {
        rod: "rod2",
        t,
        x: x2,
        segment_index: segment2,
        theta_deg: scene.track.segments[segment2]?.angle_deg ?? 0
      });
    }
    const nextFieldSegment2 = getMagneticSegmentIndex(x2, scene.environment.magnetic_profile);
    if (nextFieldSegment2 !== fieldSegment2) {
      fieldSegment2 = nextFieldSegment2;
      pushEvent(events, "field_enter", {
        rod: "rod2",
        t,
        x: x2,
        field_segment_index: fieldSegment2,
        B: field2.B,
        phi_deg: field2.phi_deg,
        Bn: field2.Bn
      });
    }

    if (scene.system.collide && x1 >= x2) {
      const preV1 = v1;
      const preV2 = v2;
      v1 = ((scene.rod1.mass - scene.rod2.mass) * preV1 + 2 * scene.rod2.mass * preV2) / (scene.rod1.mass + scene.rod2.mass);
      v2 = ((scene.rod2.mass - scene.rod1.mass) * preV2 + 2 * scene.rod1.mass * preV1) / (scene.rod1.mass + scene.rod2.mass);
      const midpoint = (x1 + x2) / 2;
      x1 = midpoint - 0.01;
      x2 = midpoint + 0.01;
      pushEvent(events, "collision", { t, x: midpoint, pre_v1: preV1, pre_v2: preV2, post_v1: v1, post_v2: v2 });
    }

    if (step % solveOptions.sample_every === 0 || step === solveOptions.max_steps || t >= solveOptions.t_end) {
      recordSeries(history, {
        t,
        x1,
        x2,
        v1,
        v2,
        a1,
        a2,
        I,
        E,
        Q_total,
        stage,
        distance: x2 - x1,
        theta1_deg: scene.track.segments[segment1]?.angle_deg ?? 0,
        theta2_deg: scene.track.segments[segment2]?.angle_deg ?? 0,
        F_friction1: friction1,
        F_friction2: friction2,
        field_segment_index1: fieldSegment1,
        field_segment_index2: fieldSegment2,
        B1: field1.B,
        B2: field2.B,
        phi1_deg: field1.phi_deg,
        phi2_deg: field2.phi_deg,
        Bn1,
        Bn2
      });
    }
  }

  pushEvent(events, "simulation_end", { t, x1, x2, v1, v2, stage });

  return {
    model: "double_rod",
    summary: {
      ...baseSummary({ model: "double_rod" }, scene.track, solveOptions),
      Bn1_initial: getMagneticFieldAt(x1Start, scene.environment.magnetic_profile).Bn,
      Bn2_initial: getMagneticFieldAt(x2Start, scene.environment.magnetic_profile).Bn,
      total_resistance: totalR,
      split_x: splitX,
      final_state: { t, x1, x2, v1, v2, a1, a2, I, E, Q_total, stage, F_friction1: friction1, F_friction2: friction2 },
      extrema: {
        max_abs_current: Math.max(...history.I.map(value => Math.abs(value)), 0),
        max_speed_rod1: Math.max(...history.v1.map(value => Math.abs(value)), 0),
        max_speed_rod2: Math.max(...history.v2.map(value => Math.abs(value)), 0),
        max_abs_friction_rod1: Math.max(...history.F_friction1.map(value => Math.abs(value)), 0),
        max_abs_friction_rod2: Math.max(...history.F_friction2.map(value => Math.abs(value)), 0),
        max_abs_Bn1: Math.max(...history.Bn1.map(value => Math.abs(value)), 0),
        max_abs_Bn2: Math.max(...history.Bn2.map(value => Math.abs(value)), 0),
        min_distance: Math.min(...history.distance, x2 - x1)
      }
    },
    history,
    events
  };
}

function validateScene(input) {
  const issues = [];
  const scene = asObject(input) || {};
  const model = scene.model;

  if (model !== "single_rod" && model !== "double_rod") {
    issues.push({ path: "scene.model", reason: 'Expected "single_rod" or "double_rod".' });
  }

  return { scene, model, issues };
}

function nearestIndex(times, targetTime) {
  if (!Array.isArray(times) || times.length === 0) {
    return -1;
  }
  let bestIndex = 0;
  let bestDelta = Math.abs(times[0] - targetTime);
  for (let index = 1; index < times.length; index += 1) {
    const delta = Math.abs(times[index] - targetTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function stateFromHistory(history, index) {
  const state = {};
  for (const [key, values] of Object.entries(history)) {
    state[key] = Array.isArray(values) ? values[index] : undefined;
  }
  return state;
}

function measureSimulation(simulation, queryInput) {
  const query = asObject(queryInput) || {};
  const history = simulation.history || {};
  const events = Array.isArray(simulation.events) ? simulation.events : [];
  const type = query.type;

  if (type === "state_at_time") {
    const time = asFiniteNumber(query.time, 0);
    const index = nearestIndex(history.t, time);
    if (index < 0) {
      return { status: "INVALID_QUERY", error: "No time samples available.", matches: [], derived_values: {} };
    }
    return {
      status: "PASS",
      matches: [{ index, state: stateFromHistory(history, index) }],
      derived_values: { requested_time: time, sampled_time: history.t[index] }
    };
  }

  if (type === "final_state") {
    const index = Array.isArray(history.t) && history.t.length > 0 ? history.t.length - 1 : -1;
    if (index < 0) {
      return { status: "INVALID_QUERY", error: "No samples available.", matches: [], derived_values: {} };
    }
    return {
      status: "PASS",
      matches: [{ index, state: stateFromHistory(history, index) }],
      derived_values: { summary: simulation.summary?.final_state ?? null }
    };
  }

  if (type === "event_search") {
    const filtered = events.filter(event => {
      if (query.event_type && event.type !== query.event_type) {
        return false;
      }
      if (query.rod && event.rod !== query.rod) {
        return false;
      }
      return true;
    });
    const limit = Math.max(1, Math.floor(asPositiveNumber(query.limit, filtered.length || 1)));
    return {
      status: "PASS",
      matches: filtered.slice(0, limit),
      derived_values: { count: filtered.length }
    };
  }

  if (type === "series_extremum") {
    const seriesName = String(query.series || "");
    const values = history[seriesName];
    if (!Array.isArray(values) || !values.length) {
      return { status: "INVALID_QUERY", error: `Unknown or empty series: ${seriesName}`, matches: [], derived_values: {} };
    }
    const mode = query.mode === "min" ? "min" : "max";
    let bestIndex = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (mode === "max" ? values[index] > values[bestIndex] : values[index] < values[bestIndex]) {
        bestIndex = index;
      }
    }
    return {
      status: "PASS",
      matches: [{ index: bestIndex, state: stateFromHistory(history, bestIndex) }],
      derived_values: { series: seriesName, mode, value: values[bestIndex] }
    };
  }

  if (type === "segment_at_position") {
    const position = asFiniteNumber(query.position, 0);
    const track = simulation.scene_echo?.track;
    if (!track) {
      return { status: "INVALID_QUERY", error: "Track data not available in simulation echo.", matches: [], derived_values: {} };
    }
    const segmentIndex = getTrackSegmentIndex(position, track);
    return {
      status: "PASS",
      matches: [{
        position,
        segment_index: segmentIndex,
        angle_deg: track.segments[segmentIndex]?.angle_deg ?? 0,
        elevation: getTrackElevationAt(position, track)
      }],
      derived_values: {}
    };
  }

  return {
    status: "INVALID_QUERY",
    error: `Unsupported query type: ${type || "(missing)"}`,
    matches: [],
    derived_values: {}
  };
}

async function simulateMovingRodTool(args) {
  const input = asObject(args) || {};
  const { scene, model, issues } = validateScene(input.scene);
  if (issues.length > 0) {
    return {
      status: "INVALID_SCENE",
      run_id: "",
      errors: issues,
      summary: null,
      history: {},
      events: [],
      log_ref: null
    };
  }

  const sceneIssues = [];
  const solveOptions = normalizeSolveOptions(input.solve_options);
  let normalizedScene;
  let simulation;

  if (model === "single_rod") {
    normalizedScene = normalizeSingleScene(scene, sceneIssues);
    simulation = simulateSingle(normalizedScene, solveOptions);
  } else {
    normalizedScene = normalizeDoubleScene(scene, sceneIssues);
    simulation = simulateDouble(normalizedScene, solveOptions);
  }

  if (sceneIssues.length > 0) {
    return {
      status: "INVALID_SCENE",
      run_id: "",
      errors: sceneIssues,
      summary: null,
      history: {},
      events: [],
      log_ref: null
    };
  }

  const runId = createRunId("moving_rod");
  await ensureRunDirs(runId);
  const output = {
    status: "PASS",
    run_id: runId,
    errors: [],
    summary: simulation.summary,
    history: simulation.history,
    events: simulation.events,
    scene_echo: normalizedScene,
    log_ref: {
      path: artifactPath(runId, "simulation.json")
    }
  };
  await writeJson(output.log_ref.path, output);
  return output;
}

async function measureMovingRodTool(args) {
  const input = asObject(args) || {};
  const query = asObject(input.query) || {};
  let simulation = asObject(input.simulation) || null;
  let runId = typeof input.run_id === "string" ? input.run_id : "";

  if (!simulation && runId) {
    const filePath = artifactPath(runId, "simulation.json");
    try {
      simulation = await readJson(filePath);
    } catch (error) {
      return {
        status: "RUN_NOT_FOUND",
        query_echo: query,
        matches: [],
        derived_values: {},
        error: error instanceof Error ? error.message : String(error),
        log_ref: null
      };
    }
  }

  if (!simulation) {
    return {
      status: "INVALID_QUERY",
      query_echo: query,
      matches: [],
      derived_values: {},
      error: "Provide either run_id or simulation.",
      log_ref: null
    };
  }

  if (!runId && typeof simulation.run_id === "string") {
    runId = simulation.run_id;
  }

  const result = measureSimulation(simulation, query);
  const logRef = runId ? { path: artifactPath(runId, "measurement_latest.json") } : null;
  const output = {
    status: result.status,
    query_echo: query,
    matches: result.matches,
    derived_values: result.derived_values,
    error: result.error,
    log_ref: logRef
  };
  if (logRef) {
    await writeJson(logRef.path, output);
  }
  return output;
}

function describeMovingRodSchemaTool() {
  return {
    scene_schema: {
      model: '"single_rod" | "double_rod"',
      environment: {
        B: "number, fallback magnetic field magnitude in tesla",
        phi_deg: "number, fallback angle relative to track-plane normal",
        g: "number optional, defaults to 9.8"
      },
      magnetic_field_profile: {
        field_profile_start: "number optional, magnetic profile x-start",
        field_segment_length: "number optional fallback magnetic segment length",
        field_segments: [
          {
            B: "number, magnetic field magnitude in tesla for this segment",
            phi_deg: "number optional, angle relative to track-plane normal for this segment",
            length: "number optional, overrides fallback field_segment_length"
          }
        ]
      },
      track: {
        profile_start: "number optional, usually omit and let solver choose for double-rod runs",
        segment_length: "number optional fallback length",
        segments: [
          {
            angle_deg: "number, segment incline angle relative to horizontal",
            length: "number optional, overrides fallback segment_length"
          }
        ]
      },
      single_rod: {
        rod: {
          length: "L, rod length / rail spacing",
          mass: "m",
          internal_resistance: "r",
          kinetic_friction: "mu_k, kinetic friction coefficient"
        },
        circuit: {
          external_resistance: "R",
          source_voltage: "U"
        },
        dynamics: {
          external_force: "F",
          x0: "initial position along track",
          v0: "initial velocity along track"
        }
      },
      double_rod: {
        dist0: "initial separation between rods",
        split_ratio: "connection-point ratio, 0 to 1",
        collide: "boolean, whether to apply 1D elastic collision",
        rod1: { length: "L1", mass: "m1", resistance: "R1", kinetic_friction: "mu_k1", v0: "initial velocity", external_force: "F1" },
        rod2: { length: "L2", mass: "m2", resistance: "R2", kinetic_friction: "mu_k2", v0: "initial velocity", external_force: "F2" }
      }
    },
    query_schema: {
      state_at_time: { type: "state_at_time", time: "number" },
      final_state: { type: "final_state" },
      event_search: { type: "event_search", event_type: "string optional", rod: '"rod1" | "rod2" optional', limit: "positive integer optional" },
      series_extremum: { type: "series_extremum", series: "history key", mode: '"max" | "min"' },
      segment_at_position: { type: "segment_at_position", position: "number" }
    },
    examples: {
      single_rod: {
        scene: {
          model: "single_rod",
          environment: {
            B: 1.0,
            phi_deg: 0,
            field_segments: [
              { B: 1.0, phi_deg: 0, length: 1.5 },
              { B: 0.6, phi_deg: 0, length: 1.5 },
              { B: 1.4, phi_deg: 15, length: 1.5 }
            ]
          },
          track: {
            segments: [
              { angle_deg: 0, length: 1.5 },
              { angle_deg: 18, length: 1.5 },
              { angle_deg: -12, length: 1.5 }
            ]
          },
          single_rod: {
            rod: { length: 1.0, mass: 1.0, internal_resistance: 0.5, kinetic_friction: 0.15 },
            circuit: { external_resistance: 2.0, source_voltage: 1.0 },
            dynamics: { external_force: 2.0, x0: 0, v0: 0 }
          }
        }
      },
      double_rod: {
        scene: {
          model: "double_rod",
          environment: {
            B: 1.2,
            phi_deg: 10,
            field_segments: [
              { B: 1.2, phi_deg: 10, length: 1.2 },
              { B: 2.0, phi_deg: 0, length: 1.2 },
              { B: 0.8, phi_deg: 20, length: 1.2 }
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
            dist0: 2.0,
            split_ratio: 0.5,
            collide: true,
            rod1: { length: 1.4, mass: 1.0, resistance: 0.6, kinetic_friction: 0.08, v0: 6.0, external_force: 0.0 },
            rod2: { length: 1.0, mass: 1.0, resistance: 0.6, kinetic_friction: 0.08, v0: 0.0, external_force: 0.0 }
          }
        }
      }
    },
    notes: [
      "This MCP focuses on the segmented inclined-track rod problems currently implemented in 1.html and 2.html.",
      "Magnetic field can be configured globally or by field_segments; each rod samples its local segment field Bn(x) = B(x) cos(phi(x)).",
      "Single-rod dynamics use I = (Bn(x) L v - U) / (R + r), and add kinetic friction f_k = mu_k N opposite the current motion or driving tendency.",
      "Double-rod dynamics keep the current two-stage logic: activeL1 switches from L1 to L2 after rod1 crosses split_x, while each rod uses its own local magnetic segment.",
      "Past the last segment, the solver continues with the final segment angle."
    ]
  };
}

module.exports = {
  artifactPath,
  describeMovingRodSchemaTool,
  getMagneticFieldAt,
  getMagneticSegmentIndex,
  getTrackAngleAt,
  getTrackElevationAt,
  getTrackSegmentIndex,
  normalizeMagneticProfile,
  measureMovingRodTool,
  normalizeTrack,
  simulateMovingRodTool
};
