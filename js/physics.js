/*
 * GEO417E Planetary Orbit Simulator
 * physics.js - Newtonian two-body orbital mechanics core (Stage 1).
 *
 * MODEL (Stage 1 scope)
 * ---------------------
 * - Planar (2D) Newtonian two-body problem: one planet around the Sun.
 *   The Sun's mass dominates (m_sun >> m_planet), so it is held fixed
 *   at the origin; the barycentre coincides with it.
 * - The orbit is an ellipse with semi-major axis a and eccentricity e,
 *   initialised at perihelion on the +x axis with velocity along +y.
 * - No third bodies, no perturbations, no relativity.
 *
 * UNITS
 * -----
 * - Length : metre (m)
 * - Time   : second (s)
 * - Mass   : kilogram (kg)
 * With these units the gravitational parameter is
 *   mu = GM_sun = 4*pi^2 m^3/s^2,
 * so a = 1 m, e = 0 gives T = 1 s exactly (E4).
 *
 * EQUATION REFERENCE LEGEND (tags used in comments below and in README)
 * ---------------------------------------------------------------------
 *   E1  Kepler's 1st law - orbit shape and apsides:
 *         r(nu) = a(1-e^2) / (1 + e*cos nu);  r_p = a(1-e);  r_a = a(1+e)
 *   E2  Kepler's 2nd law - equal areas / specific angular momentum:
 *         dA/dt = 1/2 r^2 (dnu/dt) = h/2 = const;  h = |r x v|
 *   E4  Kepler's 3rd law - theoretical period:
 *         T = 2*pi * sqrt(a^3 / mu)
 *   E6  Specific orbital energy:
 *         epsilon = v^2/2 - mu/r = -mu/(2a)   (bound orbit: epsilon < 0)
 *   E8  Vis-viva equation:
 *         v^2 = mu * (2/r - 1/a)
 *   E9  Two-body equation of motion (Newtonian gravity):
 *         a(r) = -mu * r / |r|^3
 *   E3 (Kepler's equation), E5 (eccentric/mean anomaly conversions) and
 *   E7 (equal-area sectors) are NOT implemented: Stage 2 propagates the
 *   orbit numerically and reads the true anomaly straight off the
 *   integrated position (see trueAnomalyDegrees below). The dashed
 *   reference ellipse drawn on the canvas uses E1 directly.
 *
 * INTEGRATOR
 * ----------
 * Velocity Verlet (symplectic, second order), fixed step dt = T/N:
 *   1. a0 = a(r_n)                     (kept in the simulation state)
 *   2. r_{n+1} = r_n + v_n*dt + 1/2*a0*dt^2
 *   3. a1 = a(r_{n+1})                 (E9)
 *   4. v_{n+1} = v_n + 1/2*(a0 + a1)*dt
 * For any central force a(r) = f(|r|)*r this map conserves the specific
 * angular momentum h = r x v exactly in exact arithmetic:
 *   r_{n+1} x v_{n+1} = r_n x v_n + 1/2*dt*(r_{n+1} x a(r_{n+1})),
 * and the last term vanishes because a is parallel to r at the same
 * point. Kepler's 2nd law (E2) is therefore preserved to machine
 * precision; the specific energy (E6) oscillates with an O(dt^2)
 * amplitude and shows no secular drift, as expected for a symplectic
 * integrator. Both properties are MEASURED by runValidation().
 *
 * DOM INDEPENDENCE
 * ----------------
 * No DOM access, no canvas references, no logging during simulation.
 * Everything here is callable from the browser console; see
 * runValidation() / runValidationSuite().
 */
"use strict";

const OrbitPhysics = (() => {
  /* Gravitational parameter GM of the central star [m^3/s^2]. */
  const MU = OrbitConfig.physics.mu;

  /* Acceptance thresholds used by runValidation(). Values were chosen
   * from measured worst-case errors over the full parameter range
   * (a in [0.5, 2] m, e in [0, 0.95]) with the default integrator
   * settings; see README.md for the measured numbers. */
  const TOLERANCES = Object.freeze({
    parameterValidation: true,  /* reject out-of-range / non-numeric input */
    initialRadius: 1e-6,        /* m,    |r0 - a(1-e)|                */
    initialSpeed: 1e-12,        /* m/s, |v0 - sqrt(mu(1+e)/rp)|     */
    initialEnergy: 1e-12,       /* rel.,  |eps0 + mu/(2a)| / (mu/2a)  */
    initialAngularMomentum: 1e-12, /* rel., vs sqrt(mu*a*(1-e^2))     */
    angularMomentum: 1e-12,     /* rel. max drift over one period (E2) */
    energy: 1e-4,               /* rel. max drift over one period (E6) */
    positionReturn: 1.5e9,         /* m,   |r(T) - r0| after one period */
    velocityReturn: 0.05        /* rel. to v_p, |v(T) - v0| / v_p     */
  });

  /* ================================================================
   * Parameter validation
   * ================================================================ */

  /**
   * Validate orbital parameters against the configured ranges
   * (OrbitConfig.ranges is the single source of truth: the UI sliders
   * and this function share it).
   *
   * Accepted: a in [0.5, 2] m, e in [0, 0.95]; both must be finite
   * numbers. Additionally e must stay < 1 (bound ellipse) regardless
   * of what the configuration allows.
   *
   * @param {number} a raw semi-major axis [m]
   * @param {number} e raw eccentricity [-]
   * @returns {{valid: boolean, errors: string[], value: {a: number, e: number}}}
   *   `value` always contains usable, clamped numbers (non-numeric
   *   input falls back to the range minimum) so callers can recover.
   */
  function validateParameters(a, e) {
    const errors = [];
    const rangeA = OrbitConfig.ranges.semiMajorAxis;
    const rangeE = OrbitConfig.ranges.eccentricity;

    /* --- semi-major axis a --- */
    let outA;
    const numA = Number(a);
    if (!Number.isFinite(numA)) {
      errors.push("semi-major axis a must be a finite number (got " + a + ")");
      outA = rangeA.min;
    } else if (numA < rangeA.min || numA > rangeA.max) {
      errors.push("semi-major axis a = " + numA + " m is outside the allowed range [" +
        rangeA.min + ", " + rangeA.max + "] m");
      outA = Math.min(rangeA.max, Math.max(rangeA.min, numA));
    } else {
      outA = numA;
    }

    /* --- eccentricity e --- */
    let outE;
    const numE = Number(e);
    if (!Number.isFinite(numE)) {
      errors.push("eccentricity e must be a finite number (got " + e + ")");
      outE = rangeE.min;
    } else if (numE < rangeE.min || numE > rangeE.max) {
      errors.push("eccentricity e = " + numE + " is outside the allowed range [" +
        rangeE.min + ", " + rangeE.max + "]");
      outE = Math.min(rangeE.max, Math.max(rangeE.min, numE));
    } else {
      outE = numE;
    }
    if (Number.isFinite(outE) && outE >= 1) {
      /* Physical guard independent of the configuration: e >= 1 is a
       * parabolic/hyperbolic (unbound) orbit, not an ellipse. */
      errors.push("eccentricity e = " + outE + " must be < 1 for a bound elliptical orbit");
      outE = rangeE.max;
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      value: { a: outA, e: outE }
    };
  }

  /* ================================================================
   * Derived quantities (pure functions, no state)
   * ================================================================ */

  /** Distance from the Sun |r| [m]. */
  function radius(position) {
    return Math.sqrt(position.x * position.x + position.y * position.y);
  }

  /** Speed |v| [m/s]. */
  function speed(velocity) {
    return Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  }

  /**
   * Gravitational acceleration (E9): a(r) = -mu * r / |r|^3.
   * The Sun sits fixed at the origin; the origin itself is a
   * singularity (callers must keep r > 0, guaranteed for validated
   * parameters since r_p = a*(1-e) >= 0.025 m).
   * @param {{x: number, y: number}} position [m]
   * @returns {{x: number, y: number}} acceleration [m/s^2]
   */
  function gravitationalAcceleration(position) {
    const x = position.x;
    const y = position.y;
    const r2 = x * x + y * y;
    const r = Math.sqrt(r2);
    const s = -MU / (r2 * r);           /* -mu / |r|^3 */
    return { x: s * x, y: s * y };
  }

  /** Perihelion distance (E1): r_p = a*(1-e) [m]. */
  function perihelionDistance(a, e) {
    return a * (1 - e);
  }

  /** Aphelion distance (E1): r_a = a*(1+e) [m]. */
  function aphelionDistance(a, e) {
    return a * (1 + e);
  }

  /** Theoretical orbital period (E4): T = 2*pi*sqrt(a^3/mu) [s]. */
  function orbitalPeriod(a) {
    return 2 * Math.PI * Math.sqrt(a * a * a / MU);
  }

  /** Speed from the vis-viva equation (E8): v = sqrt(mu*(2/r - 1/a)) [m/s]. */
  function visVivaSpeed(a, r) {
    return Math.sqrt(MU * (2 / r - 1 / a));
  }

  /** Specific orbital energy (E6): eps = v^2/2 - mu/r [m^2/s^2]. */
  function specificEnergy(position, velocity) {
    return 0.5 * (velocity.x * velocity.x + velocity.y * velocity.y) - MU / radius(position);
  }

  /** Specific angular momentum (E2, planar z-component): h = x*vy - y*vx [m^2/s]. */
  function specificAngularMomentum(position, velocity) {
    return position.x * velocity.y - position.y * velocity.x;
  }

  /**
   * True anomaly nu of a position on the orbit [degrees, [0, 360)].
   * Stage 2 telemetry helper. Because the Stage 1/2 convention places
   * perihelion on the +x axis with prograde (counter-clockwise)
   * motion, nu equals the polar angle of the position vector:
   *   nu = atan2(y, x), normalised to [0, 360).
   * This is NOT a Kepler-equation (E3) solver - it reads the angle off
   * the integrated state directly, so it stays exact with respect to
   * the numerically propagated position.
   * @param {{x: number, y: number}} position [m]
   * @returns {number} true anomaly in degrees, [0, 360)
   */
  function trueAnomalyDegrees(position) {
    const deg = Math.atan2(position.y, position.x) * 180 / Math.PI;
    const normalised = deg % 360;
    return normalised < 0 ? normalised + 360 : normalised;
  }

  /**
   * Initial conditions at perihelion (Stage 1 convention: perihelion on
   * the +x axis, velocity along +y):
   *   r0 = ( a*(1-e), 0 )                      (E1: r_p = a(1-e))
   *   v0 = ( 0, sqrt(mu*(1+e)/(a*(1-e))) )     (E8 evaluated at r = r_p)
   * @returns {{position: {x, y}, velocity: {x, y}}}
   */
  function initialPerihelionState(a, e) {
    const rp = perihelionDistance(a, e);                 /* E1 */
    const vp = Math.sqrt(MU * (1 + e) / rp);             /* E8 at r_p */
    return {
      position: { x: rp, y: 0 },
      velocity: { x: 0, y: vp }
    };
  }

  /* ================================================================
   * Integrator
   * ================================================================ */

  /**
   * Number of Verlet steps per orbit for eccentricity e:
   *   N(e) = clamp(ceil(base * sqrt(1+e) / (1-e)^exponent), base, max)
   * Keeps dt = T/N a fixed fraction of the perihelion timescale
   * tau_p = r_p/v_p ~ (T/2pi)*(1-e)^1.5/sqrt(1+e); see
   * OrbitConfig.integrator for the full rationale.
   * @returns {number} steps per orbit, >= baseStepsPerOrbit
   */
  function stepsPerOrbit(e) {
    const cfg = OrbitConfig.integrator;
    const raw = cfg.baseStepsPerOrbit * Math.sqrt(1 + e) /
      Math.pow(1 - e, cfg.eccentricityExponent);
    const n = Math.ceil(raw);
    return Math.min(cfg.maxStepsPerOrbit, Math.max(cfg.baseStepsPerOrbit, n));
  }

  /**
   * Create an independent simulation object. Pure data plus methods;
   * no DOM, no canvas, no globals shared between instances.
   *
   * @param {object} [options]
   *   a             semi-major axis [m]      (default: config default)
   *   e             eccentricity [-]          (default: config default)
   *   stepsPerOrbit integration steps per
   *                 theoretical period        (default: stepsPerOrbit(e))
   * @returns {object|null} the simulation, or null (with a console
   *   error) if the parameters fail validation.
   *
   * The returned object exposes:
   *   mu, a, e, period, dt, stepsPerOrbit   - fixed parameters
   *   position, velocity, acceleration      - current state [AU, m/s, m/s^2]
   *   time, stepCount                       - elapsed time [s], steps done
   *   step(n)    - advance n velocity-Verlet steps (default 1)
   *   reset()    - back to the perihelion initial state, t = 0
   *   derived()  - radius, speed, energy (E6), h (E2), vis-viva speed
   *                (E8), apsides (E1), period (E4) at the current state
   *   snapshot() - deep copy of parameters + state
   */
  function createSimulation(options) {
    const opts = options || {};
    const aIn = (opts.a !== undefined) ? opts.a : OrbitConfig.defaults.semiMajorAxis;
    const eIn = (opts.e !== undefined) ? opts.e : OrbitConfig.defaults.eccentricity;

    const check = validateParameters(aIn, eIn);
    if (!check.valid) {
      console.error("[GEO417E] createSimulation rejected parameters: " +
        check.errors.join("; "));
      return null;
    }

    const a = check.value.a;
    const e = check.value.e;
    const period = orbitalPeriod(a);                 /* E4 [s] */

    let nSteps = stepsPerOrbit(e);
    if (opts.stepsPerOrbit !== undefined) {
      const n = Number(opts.stepsPerOrbit);
      if (Number.isFinite(n) && n >= 1) {
        nSteps = Math.max(1, Math.floor(n));
      }
    }
    const dt = period / nSteps;                      /* fixed step [s] */

    const sim = {
      /* Fixed parameters */
      mu: MU,
      a: a,
      e: e,
      period: period,
      stepsPerOrbit: nSteps,
      dt: dt,

      /* Live state (mutated by step()) */
      position: null,      /* {x, y} [m]          */
      velocity: null,      /* {x, y} [m/s]       */
      acceleration: null,  /* {x, y} [m/s^2]     */
      time: 0,             /* elapsed time [s]    */
      stepCount: 0,        /* completed Verlet steps */

      /* Methods */
      step: step,
      reset: reset,
      derived: derived,
      snapshot: snapshot
    };

    reset();
    return sim;

    /* --- methods (closures over `sim`, `a`, `e`, `dt`) --- */

    /** Back to the perihelion initial state (E1 + E8) at t = 0. */
    function reset() {
      const init = initialPerihelionState(a, e);
      sim.position = { x: init.position.x, y: init.position.y };
      sim.velocity = { x: init.velocity.x, y: init.velocity.y };
      sim.acceleration = gravitationalAcceleration(sim.position); /* E9 at r0 */
      sim.time = 0;
      sim.stepCount = 0;
    }

    /**
     * One velocity-Verlet step (see the module header):
     *   a0 = stored acceleration (at the current position)
     *   r' = r + v*dt + 1/2*a0*dt^2
     *   a1 = a(r')                                  (E9)
     *   v' = v + 1/2*(a0 + a1)*dt
     * @param {number} [n] number of steps (default 1)
     */
    function step(n) {
      const count = (n === undefined) ? 1 : Math.max(0, Math.floor(n));
      const halfDt2 = 0.5 * dt * dt;
      const halfDt = 0.5 * dt;
      for (let i = 0; i < count; i += 1) {
        const p = sim.position;
        const v = sim.velocity;
        const a0 = sim.acceleration;

        /* Position update (uses acceleration at the current position). */
        p.x = p.x + v.x * dt + a0.x * halfDt2;
        p.y = p.y + v.y * dt + a0.y * halfDt2;

        /* Acceleration at the new position (E9). */
        const a1 = gravitationalAcceleration(p);

        /* Velocity update with the average of the two accelerations. */
        v.x = v.x + (a0.x + a1.x) * halfDt;
        v.y = v.y + (a0.y + a1.y) * halfDt;

        sim.acceleration = a1;
        sim.time += dt;
        sim.stepCount += 1;
      }
      return sim;
    }

    /** Physically meaningful quantities at the current state. */
    function derived() {
      const r = radius(sim.position);
      return {
        radius: r,                                            /* [m]    */
        speed: speed(sim.velocity),                           /* [m/s] */
        specificEnergy: specificEnergy(sim.position, sim.velocity),        /* E6 */
        specificAngularMomentum: specificAngularMomentum(sim.position, sim.velocity), /* E2 */
        visVivaSpeed: visVivaSpeed(a, r),                     /* E8      */
        perihelionDistance: perihelionDistance(a, e),         /* E1      */
        aphelionDistance: aphelionDistance(a, e),             /* E1      */
        period: period                                        /* E4      */
      };
    }

    /** Deep copy of the full simulation state (safe to keep around). */
    function snapshot() {
      return {
        mu: MU, a: a, e: e,
        period: period, stepsPerOrbit: nSteps, dt: dt,
        time: sim.time, stepCount: sim.stepCount,
        position: { x: sim.position.x, y: sim.position.y },
        velocity: { x: sim.velocity.x, y: sim.velocity.y },
        acceleration: { x: sim.acceleration.x, y: sim.acceleration.y }
      };
    }
  }

  /* ================================================================
   * Validation / self-test
   * ================================================================ */

  /**
   * Run the Stage 1 physics validation for one orbit. Self-contained:
   * creates a fresh simulation, integrates exactly one theoretical
   * period T (E4) and MEASURES every quantity below (nothing is
   * assumed to pass - thresholds only decide pass/fail afterwards):
   *
   *   parameter validation rejects out-of-range and non-numeric a, e
   *   initial radius      r(0) = a*(1-e)                      (E1)
   *   initial speed       v(0) = sqrt(mu*(1+e)/r_p)           (E8)
   *   initial energy      eps(0) = -mu/(2a) < 0, bound orbit  (E6)
   *   initial ang. mom.   h(0) = sqrt(mu*a*(1-e^2))           (E2)
   *   finiteness          position/velocity/acceleration at every step
   *   h conservation      max |h - h0| / h0 over the period    (E2)
   *   energy conservation max |eps - eps0| / |eps0|            (E6)
   *   perihelion return   |r(T) - r0| [m] and |v(T) - v0| / v_p
   *
   * @param {object} [options] passed to createSimulation:
   *   a, e, stepsPerOrbit (all optional)
   * @param {object} [reporting] { quiet: boolean } - suppress console output
   * @returns {{passed: boolean, parameters: object, checks: Array, worst: object}}
   */
  function runValidation(options, reporting) {
    const quiet = Boolean(reporting && reporting.quiet);
    const opts = options || {};

    const checks = [];
    function addCheck(name, measured, tolerance, unit, passed, expected) {
      checks.push({
        check: name,
        measured: measured,
        expected: (expected === undefined) ? "" : expected,
        tolerance: tolerance,
        unit: unit,
        passed: passed
      });
    }

    /* Worst measured errors (filled in below; declared up here so the
     * early-return path can still build a result object). */
    let maxDh = 0;
    let maxDe = 0;
    let dr = 0;
    let dvRel = 0;

    /* --- 0. parameter validation rejects bad input ---------------- */
    const badA = validateParameters(99, 0.2);           /* a out of range */
    const badE = validateParameters(1, 2);              /* e out of range */
    const badN = validateParameters("garbage", "nope"); /* non-numeric    */
    const okIn = validateParameters(
      (opts.a !== undefined) ? opts.a : OrbitConfig.defaults.semiMajorAxis,
      (opts.e !== undefined) ? opts.e : OrbitConfig.defaults.eccentricity);
    addCheck("parameter validation (rejects bad a)",
      badA.valid === false, TOLERANCES.parameterValidation, "boolean",
      badA.valid === false, "valid = false");
    addCheck("parameter validation (rejects bad e)",
      badE.valid === false, TOLERANCES.parameterValidation, "boolean",
      badE.valid === false, "valid = false");
    addCheck("parameter validation (rejects non-numeric)",
      badN.valid === false, TOLERANCES.parameterValidation, "boolean",
      badN.valid === false, "valid = false");
    addCheck("parameter validation (accepts test case)",
      okIn.valid, TOLERANCES.parameterValidation, "boolean",
      okIn.valid, "valid = true");

    /* --- fresh simulation at perihelion ---------------------------- */
    const sim = createSimulation(opts);
    if (!sim) {
      addCheck("simulation creation", 0, 1, "boolean", false, "sim != null");
      /* Keep the result object safe to print even without a simulation. */
      return finish({
        a: okIn.value.a,
        e: okIn.value.e,
        stepsPerOrbit: Number(opts.stepsPerOrbit) || 0,
        dt: NaN,
        period: NaN
      }, checks);
    }

    const a = sim.a;
    const e = sim.e;
    const rp = perihelionDistance(a, e);                       /* E1 */
    const vp = Math.sqrt(MU * (1 + e) / rp);                   /* E8 */
    const epsAnalytic = -MU / (2 * a);                         /* E6 */
    const hAnalytic = Math.sqrt(MU * a * (1 - e * e));         /* E2  */

    /* --- 1-4. initial state ---------------------------------------- */
    const errR0 = Math.abs(radius(sim.position) - rp);
    addCheck("initial radius = a*(1-e)", errR0, TOLERANCES.initialRadius, "m",
      errR0 <= TOLERANCES.initialRadius, rp.toFixed(6) + " m");

    const errV0 = Math.abs(speed(sim.velocity) - vp);
    addCheck("initial speed (vis-viva at r_p)", errV0, TOLERANCES.initialSpeed, "m/s",
      errV0 <= TOLERANCES.initialSpeed, vp.toFixed(6) + " m/s");

    const d0 = sim.derived();
    const errE0 = Math.abs(d0.specificEnergy - epsAnalytic) / Math.abs(epsAnalytic);
    addCheck("initial energy = -mu/(2a)", errE0, TOLERANCES.initialEnergy, "relative",
      errE0 <= TOLERANCES.initialEnergy && d0.specificEnergy < 0,
      epsAnalytic.toFixed(6) + " m^2/s^2 (bound: eps < 0)");

    const errH0 = Math.abs(d0.specificAngularMomentum - hAnalytic) / hAnalytic;
    addCheck("initial ang. momentum = sqrt(mu*a*(1-e^2))", errH0,
      TOLERANCES.initialAngularMomentum, "relative",
      errH0 <= TOLERANCES.initialAngularMomentum, hAnalytic.toFixed(6) + " m^2/s");

    /* --- 5-7. integrate exactly one theoretical period ------------- */
    const h0 = d0.specificAngularMomentum;
    const eps0 = d0.specificEnergy;
    let allFinite = true;

    for (let i = 0; i < sim.stepsPerOrbit; i += 1) {
      sim.step(1);
      const p = sim.position;
      const v = sim.velocity;
      const acc = sim.acceleration;
      if (!(Number.isFinite(p.x) && Number.isFinite(p.y) &&
            Number.isFinite(v.x) && Number.isFinite(v.y) &&
            Number.isFinite(acc.x) && Number.isFinite(acc.y))) {
        allFinite = false;
        break;
      }
      const h = p.x * v.y - p.y * v.x;                          /* E2 */
      const eps = 0.5 * (v.x * v.x + v.y * v.y) - MU / radius(p); /* E6 */
      const dh = Math.abs(h - h0) / Math.abs(h0);
      const de = Math.abs(eps - eps0) / Math.abs(eps0);
      if (dh > maxDh) { maxDh = dh; }
      if (de > maxDe) { maxDe = de; }
    }
    addCheck("all state values finite (every step)", allFinite, true, "boolean",
      allFinite, "finite");

    addCheck("angular momentum conservation", maxDh,
      TOLERANCES.angularMomentum, "relative",
      maxDh <= TOLERANCES.angularMomentum, "h const (E2)");

    addCheck("specific energy conservation", maxDe,
      TOLERANCES.energy, "relative",
      maxDe <= TOLERANCES.energy, "eps const (E6), no secular drift");

    /* --- 8. return to perihelion after one period ------------------ */
    dr = Math.sqrt(
      (sim.position.x - rp) * (sim.position.x - rp) +
      (sim.position.y - 0) * (sim.position.y - 0));
    const dv = Math.sqrt(
      (sim.velocity.x - 0) * (sim.velocity.x - 0) +
      (sim.velocity.y - vp) * (sim.velocity.y - vp));
    dvRel = dv / vp;
    addCheck("perihelion return: |r(T) - r0|", dr, TOLERANCES.positionReturn, "m",
      dr <= TOLERANCES.positionReturn, rp.toFixed(6) + " m");
    addCheck("perihelion return: |v(T) - v0| / v_p", dvRel, TOLERANCES.velocityReturn,
      "relative", dvRel <= TOLERANCES.velocityReturn, vp.toFixed(6) + " m/s");

    return finish({
      a: sim.a,
      e: sim.e,
      stepsPerOrbit: sim.stepsPerOrbit,
      dt: sim.dt,
      period: sim.period
    }, checks);

    function finish(parameters, allChecks) {
      const result = {
        passed: allChecks.every(function (c) { return c.passed; }),
        parameters: parameters,
        checks: allChecks,
        worst: {
          maxRelativeAngularMomentumDrift: maxDh,
          maxRelativeEnergyDrift: maxDe,
          perihelionReturnDistanceM: dr,
          perihelionReturnSpeedError: dvRel
        }
      };
      if (!quiet) {
        console.info("[GEO417E] Stage 1 physics validation - a = " +
          result.parameters.a + " m, e = " + result.parameters.e +
          ", N = " + result.parameters.stepsPerOrbit + " steps/orbit, dt = " +
          result.parameters.dt.toExponential(3) + " s");
        console.table(allChecks);
        console.info((result.passed ? "[PASS] " : "[FAIL] ") +
          "All measured checks within tolerance." +
          " Worst: |dh|/h = " + maxDh.toExponential(2) +
          ", |deps|/|eps| = " + maxDe.toExponential(2) +
          ", |dr| = " + dr.toExponential(2) + " m" +
          ", |dv|/v_p = " + dvRel.toExponential(2));
      }
      return result;
    }
  }

  /**
   * Run runValidation() across representative parameter corners
   * (defaults, circular extremes, and the harshest eccentricity) and
   * report the worst measured errors. Console-callable.
   * @returns {{passed: boolean, cases: Array}}
   */
  function runValidationSuite() {
    const cases = [
      { label: "default (a=1, e=0.2)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.2 },
      { label: "inner circular (a=0.5, e=0)", a: 0.5 * OrbitConfig.physics.astronomicalUnit, e: 0 },
      { label: "outer circular (a=2, e=0)", a: 2 * OrbitConfig.physics.astronomicalUnit, e: 0 },
      { label: "high-e (a=1, e=0.95)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.95 },
      { label: "high-e outer (a=2, e=0.95)", a: 2 * OrbitConfig.physics.astronomicalUnit, e: 0.95 },
      { label: "high-e inner (a=0.5, e=0.95)", a: 0.5 * OrbitConfig.physics.astronomicalUnit, e: 0.95 }
    ];

    const rows = cases.map(function (c) {
      const result = runValidation({ a: c.a, e: c.e }, { quiet: true });
      return {
        case: c.label,
        stepsPerOrbit: result.parameters.stepsPerOrbit,
        maxRelDriftH: result.worst.maxRelativeAngularMomentumDrift,
        maxRelDriftEnergy: result.worst.maxRelativeEnergyDrift,
        returnDistM: result.worst.perihelionReturnDistanceM,
        returnSpeedRel: result.worst.perihelionReturnSpeedError,
        passed: result.passed
      };
    });

    const summary = {
      passed: rows.every(function (r) { return r.passed; }),
      cases: rows
    };

    console.info("[GEO417E] Stage 1 physics validation suite (one theoretical period per case):");
    console.table(rows);
    console.info((summary.passed ? "[PASS] " : "[FAIL] ") +
      "All cases within tolerances (h <= " + TOLERANCES.angularMomentum +
      " rel, energy <= " + TOLERANCES.energy + " rel, return <= " +
      TOLERANCES.positionReturn + " m / " + TOLERANCES.velocityReturn +
      " v_p rel).");
    return summary;
  }

  /* ================================================================
   * Public API
   * ================================================================ */
  return {
    mu: MU,
    TOLERANCES: TOLERANCES,
    validateParameters: validateParameters,
    radius: radius,
    speed: speed,
    gravitationalAcceleration: gravitationalAcceleration,
    perihelionDistance: perihelionDistance,
    aphelionDistance: aphelionDistance,
    orbitalPeriod: orbitalPeriod,
    visVivaSpeed: visVivaSpeed,
    specificEnergy: specificEnergy,
    specificAngularMomentum: specificAngularMomentum,
    trueAnomalyDegrees: trueAnomalyDegrees,
    initialPerihelionState: initialPerihelionState,
    stepsPerOrbit: stepsPerOrbit,
    createSimulation: createSimulation,
    runValidation: runValidation,
    runValidationSuite: runValidationSuite
  };
})();
