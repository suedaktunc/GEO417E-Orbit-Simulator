/*
 * GEO417E Planetary Orbit Simulator
 * config.js - static configuration, default values and control ranges.
 *
 * Loaded first. Declares the global `OrbitConfig` object that every other
 * script reads. Nothing in this file performs calculations.
 */
"use strict";

const OrbitConfig = Object.freeze({
  /* Default simulation parameters (consumed by OrbitState and OrbitPhysics). */
  defaults: Object.freeze({
    eccentricity: 0.2,   // e - unitless (0 = circle)
    semiMajorAxis: 149597870700.0,  // a - metres (m)
    timeScale: 1.0       // simulation speed multiplier (1 = baseline)
  }),

  /*
   * Ranges for the UI sliders AND for OrbitPhysics.validateParameters().
   * Single source of truth: ui.js applies these attributes to the HTML
   * inputs on startup; physics.js clamps requested parameters to them.
   *
   * Stage 1 limits (Newtonian two-body core):
   *   a in [0.5, 2] AU - spans a factor 4 in period (Kepler III, E4)
   *                      while keeping the whole ellipse inside the
   *                      Stage 2 viewport at a readable scale;
   *   e in [0, 0.95]   - 0.95 keeps perihelion (a*(1-e) >= 0.025 AU)
   *                      clear of the star while still showing a very
   *                      elongated ellipse.
   */
  ranges: Object.freeze({
    eccentricity:  { min: 0,   max: 0.95, step: 0.01 },
    semiMajorAxis: { min: 74798935350, max: 299195741400, step: 14959787070 },
    timeScale:     { min: 0.1, max: 5,    step: 0.1  }
  }),

  /* SI physical constants and unit system used by every physics module. */
  physics: Object.freeze({
    G: 6.67430e-11,
    solarMass: 1.98847e30,
    mu: 6.67430e-11 * 1.98847e30,   // m^3 / s^2
    astronomicalUnit: 149597870700,
    julianYear: 31557600,
    day: 86400,
    lengthUnit: "m",
    timeUnit: "s"
  }),

  /*
   * Velocity-Verlet integrator configuration (Stage 1 physics core).
   *
   *   stepsPerOrbit(e) = clamp(
   *       ceil(baseStepsPerOrbit * sqrt(1+e) / (1-e)^eccentricityExponent),
   *       baseStepsPerOrbit, maxStepsPerOrbit)
   *
   * Rationale: the fastest dynamical timescale of an eccentric orbit is
   * the perihelion passage time tau_p = r_p / v_p, which shrinks as
   * (1-e)^1.5 / sqrt(1+e) relative to the period T. Scaling the number
   * of steps per orbit as sqrt(1+e)/(1-e)^1.5 therefore keeps dt a
   * fixed fraction of tau_p for every eccentricity, keeping the
   * integrator error roughly uniform across the allowed e range.
   *
   * Default 2048 steps per orbit at e = 0 (~0.18 deg of anomaly per
   * step) chosen after measurement: over one theoretical period it
   * holds the relative specific-energy drift below ~1e-6 at the default
   * e = 0.2 and below ~3e-5 at the extreme e = 0.95, while the specific
   * angular momentum stays at machine precision (~1e-14). Measured
   * numbers: OrbitPhysics.runValidationSuite() in the browser console.
   */
  integrator: Object.freeze({
    baseStepsPerOrbit: 2048,
    maxStepsPerOrbit: 262144,      // safety cap (2^18)
    eccentricityExponent: 1.5
  }),

  /*
   * Animation loop configuration (Stage 2).
   *
   *   secondsPerRealSecond - base simulation rate: 3.15576e6 simulation seconds per real second (10 real seconds per
   *                        Julian year at 1x speed). The speed
   *                        slider multiplies this by 0.1x .. 5x.
   *   maxFrameDeltaSec   - clamp on the real-time frame delta. After a
   *                        slow frame or a background-tab pause the
   *                        simulation falls behind by at most this much
   *                        real time instead of entering a catch-up
   *                        spiral (unbounded step batching).
   *   telemetryIntervalMs - live readout refresh period (~6.7 Hz,
   *                        inside the 5-10 Hz target).
   */
  animation: Object.freeze({
    secondsPerRealSecond: 3155760,
    maxFrameDeltaSec: 0.1,
    telemetryIntervalMs: 150
  }),

  /*
   * Canvas viewport configuration (Stage 2). fitPaddingPx is the
   * minimum margin kept between the fitted orbit and the canvas edge;
   * gridStepPx is the decorative background grid spacing (CSS px).
   */
  canvas: Object.freeze({
    fitPaddingPx: 28,
    gridStepPx: 48
  }),

  /*
   * Stage 3.2 - Kepler's 2nd law equal-area sectors (E7).
   *
   *   sectorCount       - one orbital period is divided into exactly
   *                       12 equal TIME intervals (Stage 3.2 scope;
   *                       boundaries at t = k*T/12 from perihelion).
   *   samplesPerSector  - sampling resolution of the swept-area
   *                       quadrature: number of analytic positions
   *                       (from the Stage 3.1 Kepler solver) sampled
   *                       per sector at equal time steps. The
   *                       triangular-fan/shoelace rule is O(n^-2):
   *                       doubling n shrinks the worst relative
   *                       sector-area error by ~4x. Default 256 was
   *                       chosen after measurement: it holds the max
   *                       relative error below ~7e-7 at e = 0.2 and
   *                       ~1.4e-4 at the extreme e = 0.95 (the error
   *                       is independent of a). Measured numbers:
   *                       OrbitAreas.runValidationSuite() / the
   *                       convergence study in the browser console.
   */
  areas: Object.freeze({
    sectorCount: 12,
    samplesPerSector: 256
  }),

  /*
   * Appearance of the canvas scene. Purely cosmetic - no physics.
   * Stage 2: starColor/starGlowColor paint the Sun (at the focus),
   * orbitPathColor strokes the analytic reference ellipse (E1) and
   * planetColor/planetGlowColor paint the Verlet-integrated planet.
   * Stage 3.2: sectorFillColorA/B alternate between adjacent equal-
   * area sectors and sectorLineColor strokes the sector boundary
   * radii - deliberately faint so the overlay stays restrained.
   */
  appearance: Object.freeze({
    backgroundTop: "#0d1330",
    backgroundBottom: "#070b1c",
    gridColor: "rgba(148, 163, 216, 0.16)",
    orbitPathColor: "rgba(148, 163, 216, 0.55)",
    starColor: "#ffd66b",
    starGlowColor: "rgba(255, 190, 80, 0.35)",
    planetColor: "#6ee7ff",
    planetGlowColor: "rgba(110, 231, 255, 0.45)",
    sectorFillColorA: "rgba(110, 231, 255, 0.05)",
    sectorFillColorB: "rgba(110, 231, 255, 0.11)",
    sectorLineColor: "rgba(110, 231, 255, 0.32)"
  })
});

/* Physical constants live in OrbitConfig.physics; integrator tuning in
 * OrbitConfig.integrator. Both are consumed by js/physics.js. */
