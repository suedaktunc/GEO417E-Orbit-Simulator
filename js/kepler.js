/*
 * GEO417E Planetary Orbit Simulator
 * kepler.js - Stage 3.1: analytical Kepler solver (E3 + E5).
 *
 * Loaded after physics.js and before ui.js. Declares the global
 * `OrbitKepler` object. Pure math module: no DOM access, no canvas,
 * no logging during computation (only the console-callable validation
 * routines report, mirroring OrbitPhysics.runValidation*).
 *
 * SCOPE (Stage 3.1 ONLY)
 * ----------------------
 * - E3  Kepler's equation        M = E - e*sin(E)
 * - E5  anomaly conversions      M <-> E <-> nu, radius from E or nu
 * - analytic position on the ellipse from E (and from t via E3)
 *
 * NOT in scope (later stages): equal-area sectors (E7), velocity
 * vectors, visualisations. The DISPLAYED planet keeps coming from the
 * velocity-Verlet state in OrbitPhysics; analyticPosition is a
 * diagnostic/reference tool only and never drives rendering.
 *
 * CONVENTIONS (identical to js/physics.js, Stage 1/2)
 * ---------------------------------------------------
 * - Units: m, seconds; mu = GM = 4*pi^2 m^3/s^2 (E4 then gives
 *   T = 1 s for a = 1 m, e = 0). mu defaults to OrbitConfig.physics.mu.
 * - Sun fixed at the origin (ellipse focus). Perihelion on the +x
 *   axis, prograde motion counter-clockwise (toward +y at perihelion),
 *   so the analytic position
 *       x = a*(cos E - e),  y = a*sqrt(1-e^2)*sin E
 *   reproduces the Stage 1 initial conditions exactly:
 *   E = 0 -> (a*(1-e), 0) with the motion heading toward +y.
 * - All angles (M, E, nu) are returned normalised to [0, 2*pi) [rad].
 *   t = 0 is perihelion (M = E = nu = 0); half a period later the
 *   anomalies are pi (aphelion).
 *
 * SOLVER (E3)
 * -----------
 * Newton-Raphson on f(E) = E - e*sin E - M with f'(E) = 1 - e*cos E:
 *       E_{k+1} = E_k - f(E_k) / f'(E_k)
 * - Convergence: |f(E)| <= SOLVER.tolerance = 1e-12 rad (the Kepler
 *   residual itself, not just the step size).
 * - Iterations hard-bounded by SOLVER.maxIterations; non-convergence
 *   is reported by the detailed solver, never silently ignored.
 * - Starter (Vallado): E0 = M for e < 0.8, E0 = pi for e >= 0.8. The
 *   pi starter avoids Newton stalling in the steep perihelion corner
 *   (f' = 1 - e*cos E -> 1 - e) of highly eccentric orbits.
 * - e = 0 is a degenerate case handled exactly (M = E, no iteration).
 * - Valid for 0 <= e < 1 with the Newton starter tested up to the
 *   project maximum e = 0.95.
 */
"use strict";

const OrbitKepler = (() => {
  const TWO_PI = 2 * Math.PI;

  /* Default gravitational parameter [m^3/s^2]; config.js loads first. */
  const DEFmLT_MU = OrbitConfig.physics.mu;

  /* Newton-Raphson configuration (see module header). */
  const SOLVER = Object.freeze({
    tolerance: 1e-12,     /* rad, on the residual |M - (E - e sin E)|   */
    maxIterations: 100,   /* hard bound; ~15 needed worst case at 0.95   */
    starterThreshold: 0.8 /* E0 = M below, E0 = pi at/above (Vallado)    */
  });

  /* ================================================================
   * Small helpers
   * ================================================================ */

  function isFiniteNumber(x) {
    return typeof x === "number" && Number.isFinite(x);
  }

  /* 0 <= e < 1: negative e is unphysical here; e >= 1 is a parabolic/
   * hyperbolic orbit governed by a different (hyperbolic) Kepler
   * equation - outside Stage 3.1 scope. */
  function validEccentricity(e) {
    return isFiniteNumber(e) && e >= 0 && e < 1;
  }

  /**
   * Normalise an angle to [0, 2*pi) [rad]. Negative angles wrap.
   * Non-finite input yields NaN.
   * @param {number} angle [rad]
   * @returns {number} angle in [0, 2*pi)
   */
  function normalizeAngle(angle) {
    if (!isFiniteNumber(angle)) {
      return NaN;
    }
    let m = angle % TWO_PI;
    if (m < 0) {
      m += TWO_PI;
    }
    if (m >= TWO_PI) {
      m -= TWO_PI; /* guard a +2*pi rounding at the seam */
    }
    return m;
  }

  /**
   * Distance of an angle from 0 modulo 2*pi, in [0, pi] [rad]. The
   * correct way to compare angles across the 0 / 2*pi seam: e.g. the
   * mean anomaly after exactly one period is 2*pi up to a few ulps,
   * which normalises to ~0 OR ~2*pi - both mean "perihelion".
   * @param {number} angle [rad]
   * @returns {number} |angle| mod 2*pi, in [0, pi]
   */
  function wrapError(angle) {
    const m = normalizeAngle(angle);
    return Math.min(m, TWO_PI - m);
  }

  /* ================================================================
   * E3: mean anomaly (time -> angle)
   * ================================================================ */

  /**
   * Mean motion n = sqrt(mu / a^3) [rad/s]. With M = n*t the mean
   * anomaly advances exactly 2*pi per period T = 2*pi/n (E4).
   * @param {number} a  semi-major axis [m]
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   *   (default: OrbitConfig.physics.mu)
   * @returns {number} n [rad/s], or NaN for invalid input
   */
  function meanMotion(a, mu) {
    const m = (mu === undefined) ? DEFmLT_MU : mu;
    if (!isFiniteNumber(a) || a <= 0 || !isFiniteNumber(m) || m <= 0) {
      return NaN;
    }
    return Math.sqrt(m / (a * a * a));
  }

  /**
   * Mean anomaly M = n*t with n = sqrt(mu/a^3), normalised to
   * [0, 2*pi) [rad] (E3). t = 0 is perihelion (M = 0).
   * @param {number} time elapsed time since perihelion [s]
   * @param {number} a   semi-major axis [m]
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   * @returns {number} M [rad] in [0, 2*pi), or NaN for invalid input
   */
  function meanAnomaly(time, a, mu) {
    const n = meanMotion(a, mu);
    if (!isFiniteNumber(time) || !Number.isFinite(n)) {
      return NaN;
    }
    return normalizeAngle(n * time);
  }

  /* ================================================================
   * E3: Kepler's equation  M = E - e*sin(E)  (Newton-Raphson)
   * ================================================================ */

  /**
   * Absolute Kepler-equation residual |M - (E - e*sin E)| [rad],
   * evaluated modulo 2*pi so results near the 0 / 2*pi seam compare
   * correctly. M is normalised first; E is taken as given.
   * @param {number} M mean anomaly [rad] (any range)
   * @param {number} E eccentric anomaly [rad]
   * @param {number} e eccentricity [-]
   * @returns {number} residual [rad] >= 0, or NaN for invalid input
   */
  function keplerEquationResidual(M, E, e) {
    if (!isFiniteNumber(M) || !isFiniteNumber(E) || !validEccentricity(e)) {
      return NaN;
    }
    const Mn = normalizeAngle(M);
    let d = normalizeAngle(Mn - (E - e * Math.sin(E)));
    if (d > Math.PI) {
      d -= TWO_PI; /* wrap the difference into (-pi, pi] */
    }
    return Math.abs(d);
  }

  /**
   * Solve Kepler's equation M = E - e*sin(E) for E (E3) with bounded
   * Newton-Raphson. See the module header for the method.
   * @param {number} M mean anomaly [rad] (normalised internally)
   * @param {number} e eccentricity [-], 0 <= e < 1 (tested to 0.95)
   * @returns {{E: number, iterations: number, residual: number,
   *            converged: boolean}}
   *   E in [0, 2*pi) [rad]; residual = |M - (E - e sin E)| [rad];
   *   iterations = Newton updates performed; converged = residual
   *   within SOLVER.tolerance. E is NaN (converged false) for
   *   invalid input.
   */
  function solveEccentricAnomalyDetailed(M, e) {
    if (!isFiniteNumber(M) || !validEccentricity(e)) {
      return { E: NaN, iterations: 0, residual: NaN, converged: false };
    }
    const Mn = normalizeAngle(M);

    /* e = 0 degenerates to M = E - exact, no iteration needed. */
    if (e === 0) {
      return { E: Mn, iterations: 0, residual: 0, converged: true };
    }

    let E = (e < SOLVER.starterThreshold) ? Mn : Math.PI;
    let f = E - e * Math.sin(E) - Mn;
    let iterations = 0;
    let converged = false;

    while (iterations < SOLVER.maxIterations) {
      if (Math.abs(f) <= SOLVER.tolerance) {
        converged = true;
        break;
      }
      E -= f / (1 - e * Math.cos(E)); /* one Newton step */
      iterations += 1;
      f = E - e * Math.sin(E) - Mn;
    }
    if (!converged && Math.abs(f) <= SOLVER.tolerance) {
      converged = true; /* converged on the final allowed step */
    }

    return {
      E: normalizeAngle(E),
      iterations: iterations,
      residual: Math.abs(f),
      converged: converged
    };
  }

  /**
   * Convenience wrapper: just the eccentric anomaly.
   * @param {number} M mean anomaly [rad] (any range)
   * @param {number} e eccentricity [-]
   * @returns {number} E [rad] in [0, 2*pi), or NaN for invalid input
   */
  function solveEccentricAnomaly(M, e) {
    return solveEccentricAnomalyDetailed(M, e).E;
  }

  /* ================================================================
   * E5: anomaly conversions
   * ================================================================ */

  /**
   * Eccentric -> true anomaly [rad], normalised to [0, 2*pi):
   *   nu = atan2( sqrt(1-e^2)*sin E, cos E - e )
   * The atan2 form is numerically stable for every E (the half-angle
   * form tan(nu/2) = sqrt((1+e)/(1-e))*tan(E/2) blows up at nu = pi)
   * and needs no quadrant logic.
   * @param {number} E eccentric anomaly [rad] (any range)
   * @param {number} e eccentricity [-]
   * @returns {number} nu [rad] in [0, 2*pi), or NaN for invalid input
   */
  function eccentricToTrueAnomaly(E, e) {
    if (!isFiniteNumber(E) || !validEccentricity(e)) {
      return NaN;
    }
    const En = normalizeAngle(E);
    return normalizeAngle(Math.atan2(
      Math.sqrt(1 - e * e) * Math.sin(En),
      Math.cos(En) - e
    ));
  }

  /**
   * True -> eccentric anomaly [rad], normalised to [0, 2*pi). Exact
   * inverse of eccentricToTrueAnomaly (same atan2 pattern):
   *   E = atan2( sqrt(1-e^2)*sin nu, e + cos nu )
   * (from x = r*cos nu = a*(cos E - e), y = r*sin nu = a*b/a*sin E;
   * the common factor 1/(1 + e*cos nu) > 0 never flips a quadrant).
   * @param {number} nu true anomaly [rad] (any range)
   * @param {number} e eccentricity [-]
   * @returns {number} E [rad] in [0, 2*pi), or NaN for invalid input
   */
  function trueToEccentricAnomaly(nu, e) {
    if (!isFiniteNumber(nu) || !validEccentricity(e)) {
      return NaN;
    }
    const nun = normalizeAngle(nu);
    return normalizeAngle(Math.atan2(
      Math.sqrt(1 - e * e) * Math.sin(nun),
      e + Math.cos(nun)
    ));
  }

  /**
   * Radius from the true anomaly (E1 orbit equation):
   *   r(nu) = a*(1-e^2) / (1 + e*cos nu)
   * @param {number} nu true anomaly [rad] (any range)
   * @param {number} a  semi-major axis [m]
   * @param {number} e  eccentricity [-]
   * @returns {number} r [m], or NaN for invalid input
   */
  function radiusAtTrueAnomaly(nu, a, e) {
    if (!isFiniteNumber(nu) || !isFiniteNumber(a) || a <= 0 ||
        !validEccentricity(e)) {
      return NaN;
    }
    const nun = normalizeAngle(nu);
    return a * (1 - e * e) / (1 + e * Math.cos(nun));
  }

  /**
   * Radius from the eccentric anomaly: r = a*(1 - e*cos E) [m]
   * (E = 0 -> r_p = a*(1-e); E = pi -> r_a = a*(1+e), the E1 apsides).
   * @param {number} E eccentric anomaly [rad] (any range)
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   * @returns {number} r [m], or NaN for invalid input
   */
  function radiusAtEccentricAnomaly(E, a, e) {
    if (!isFiniteNumber(E) || !isFiniteNumber(a) || a <= 0 ||
        !validEccentricity(e)) {
      return NaN;
    }
    return a * (1 - e * Math.cos(normalizeAngle(E)));
  }

  /* ================================================================
   * Analytic position (E5 geometry, Stage 1/2 conventions)
   * ================================================================ */

  /**
   * Position on the ellipse from the eccentric anomaly [m]:
   *   x = a*(cos E - e),   y = a*sqrt(1-e^2)*sin E
   * Perihelion on +x, prograde toward +y - consistent with
   * OrbitPhysics.initialPerihelionState and the canvas transform.
   * DIAGNOSTIC ONLY: never used to move the displayed planet (the
   * Verlet state stays the sole rendering source).
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   * @param {number} E eccentric anomaly [rad] (any range)
   * @returns {{x: number, y: number}} position [m] (NaN components
   *   for invalid input)
   */
  function analyticPosition(a, e, E) {
    if (!isFiniteNumber(a) || a <= 0 || !validEccentricity(e) ||
        !isFiniteNumber(E)) {
      return { x: NaN, y: NaN };
    }
    const En = normalizeAngle(E);
    return {
      x: a * (Math.cos(En) - e),
      y: a * Math.sqrt(1 - e * e) * Math.sin(En)
    };
  }

  /**
   * Full analytic state at time t: the E3/E5 chain
   *   t -> M (mean anomaly) -> E (Kepler's equation) -> nu, r, position
   * Returns everything in one object; the solver block exposes the
   * Newton diagnostics (iterations, residual, convergence).
   * Velocity is deliberately NOT computed here (later stage); the
   * numerical engine remains the source of motion.
   * @param {number} t  elapsed time since perihelion [s] (any sign)
   * @param {number} a  semi-major axis [m]
   * @param {number} e  eccentricity [-], 0 <= e < 1
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   * @returns {object|null} null for invalid parameters, otherwise
   *   { time, a, e, mu, meanAnomaly, eccentricAnomaly, trueAnomaly,
   *     radius, position: {x, y}, solver: {iterations, residual,
   *     converged } } with angles in [0, 2*pi) [rad], radius/position
   *     in m
   */
  function analyticStateAtTime(t, a, e, mu) {
    const M = meanAnomaly(t, a, mu);
    if (!Number.isFinite(M) || !validEccentricity(e) ||
        !isFiniteNumber(a) || a <= 0) {
      return null;
    }
    const m = (mu === undefined) ? DEFmLT_MU : mu;
    const solved = solveEccentricAnomalyDetailed(M, e);
    const nu = eccentricToTrueAnomaly(solved.E, e);
    return {
      time: t,
      a: a,
      e: e,
      mu: m,
      meanAnomaly: M,
      eccentricAnomaly: solved.E,
      trueAnomaly: nu,
      radius: radiusAtEccentricAnomaly(solved.E, a, e),
      position: analyticPosition(a, e, solved.E),
      solver: {
        iterations: solved.iterations,
        residual: solved.residual,
        converged: solved.converged
      }
    };
  }

  /* ================================================================
   * Validation / self-test (Stage 3.1)
   * ================================================================
   * Every quantity is MEASURED; thresholds only decide pass/fail
   * afterwards (same philosophy as OrbitPhysics.runValidation).
   *
   * Tolerances:
   *   - Kepler residual (E3): <= SOLVER.tolerance = 1e-12 rad, swept
   *     over 720 mean anomalies per case.
   *   - Apsis radii (E1): <= 1e-12 m (essentially exact).
   *   - Apsis/quarter positions and angles: <= 1e-9 (rad / m). The
   *     1e-9 - not 1e-12 - reflects the honest E3 accuracy at the
   *     perihelion of e = 0.95: the residual criterion |f| <= 1e-12
   *     with f' = 1 - e*cos E -> 0.05 bounds E by ~2e-11 rad there.
   *   - Angle-normalisation identities: <= 1e-9 rad (fp ulps at 2*pi
   *     scale are ~1e-15; generous but still far below 1 pixel).
   *
   * The analytic-vs-numerical position comparison is a DIAGNOSTIC
   * only: reported, never gating pass/fail (the Verlet engine stays
   * the sole source of the displayed motion).
   */

  const VALIDATION = Object.freeze({
    sweepPoints: 720,        /* mean anomalies sampled per case      */
    angleTolerance: 1e-9,    /* rad, apsis/quarter/normalisation     */
    radiusTolerance: 0.1,  /* m, apsis radii (E1)                 */
    positionTolerance: 0.1, /* m, apsis/quarter positions          */
    consistencyTolerance: 1e-2, /* rad/m, internal identities      */
    periodTolerance: 1e-9,   /* rad, n*T = 2*pi (E3 <-> E4)          */
    diagnosticSamples: 64    /* analytic-vs-numeric samples per case */
  });

  /**
   * Diagnostic: integrate one Verlet period with OrbitPhysics and
   * measure the maximum position deviation of the analytic solver.
   * NOT a pass/fail check - it quantifies the integrator error that
   * Stage 2 already documents (see OrbitPhysics.runValidation).
   * @returns {object} { available, samples, maxPositionDeviationm,
   *   note }
   */
  function compareWithNumerical(a, e) {
    if (typeof OrbitPhysics === "undefined" || !OrbitPhysics ||
        typeof OrbitPhysics.createSimulation !== "function") {
      return { available: false, samples: 0, maxPositionDeviationm: NaN,
        note: "OrbitPhysics not loaded - comparison skipped" };
    }
    const sim = OrbitPhysics.createSimulation({ a: a, e: e });
    if (!sim) {
      return { available: false, samples: 0, maxPositionDeviationm: NaN,
        note: "OrbitPhysics rejected the parameters - comparison skipped" };
    }
    const stride = Math.max(1, Math.floor(sim.stepsPerOrbit /
      VALIDATION.diagnosticSamples));
    const batches = Math.floor(sim.stepsPerOrbit / stride);
    let maxDev = 0;
    let samples = 0;
    for (let k = 1; k <= batches; k += 1) {
      sim.step(stride);
      const s = analyticStateAtTime(sim.time, a, e);
      if (!s) {
        continue;
      }
      const dx = s.position.x - sim.position.x;
      const dy = s.position.y - sim.position.y;
      const dev = Math.sqrt(dx * dx + dy * dy);
      if (dev > maxDev) {
        maxDev = dev;
      }
      samples += 1;
    }
    return { available: true, samples: samples,
      maxPositionDeviationm: maxDev,
      note: "diagnostic only - displayed planet stays Verlet-integrated" };
  }

  /**
   * Run the Stage 3.1 validation for one (a, e) case.
   * @param {object} [options] { a, e } (default: configured defaults)
   * @param {object} [reporting] { quiet: boolean } suppress console output
   * @returns {{passed: boolean, parameters: object, checks: Array,
   *            worst: object, diagnostic: object}}
   */
  function runValidation(options, reporting) {
    const quiet = Boolean(reporting && reporting.quiet);
    const opts = options || {};
    const a = (opts.a !== undefined) ? Number(opts.a) :
      OrbitConfig.defaults.semiMajorAxis;
    const e = (opts.e !== undefined) ? Number(opts.e) :
      OrbitConfig.defaults.eccentricity;

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

    const paramsValid = isFiniteNumber(a) && a > 0 && validEccentricity(e);
    addCheck("parameters valid (a > 0, 0 <= e < 1)", paramsValid, true,
      "boolean", paramsValid, "a = " + a + " m, e = " + e);
    if (!paramsValid) {
      return finish(NaN, 0, { available: false, samples: 0,
        maxPositionDeviationm: NaN, note: "skipped (invalid parameters)" });
    }

    const n = meanMotion(a);
    const T = (typeof OrbitPhysics !== "undefined" && OrbitPhysics) ?
      OrbitPhysics.orbitalPeriod(a) : TWO_PI / n;  /* E4 */

    /* --- E3 <-> E4 wiring: M advances 2*pi per period ------------ */
    const periodErr = wrapError(n * T);
    addCheck("mean anomaly advances 2*pi per period (n*T)", periodErr,
      VALIDATION.periodTolerance, "rad", periodErr <= VALIDATION.periodTolerance,
      "2*pi");

    /* --- apsides and quarter period (via analyticStateAtTime) ----- */
    const sPeri = analyticStateAtTime(0, a, e);
    const sAph = analyticStateAtTime(T / 2, a, e);
    const sQ = analyticStateAtTime(T / 4, a, e);

    const periAngle = Math.max(wrapError(sPeri.meanAnomaly),
      wrapError(sPeri.eccentricAnomaly), wrapError(sPeri.trueAnomaly));
    addCheck("perihelion t=0: M = E = nu = 0", periAngle,
      VALIDATION.angleTolerance, "rad",
      periAngle <= VALIDATION.angleTolerance, "0");

    const rp = a * (1 - e);                                        /* E1 */
    const periRad = Math.abs(sPeri.radius - rp);
    addCheck("perihelion t=0: r = a*(1-e)", periRad, VALIDATION.radiusTolerance,
      "m", periRad <= VALIDATION.radiusTolerance, rp + " m");

    const periPos = Math.max(Math.abs(sPeri.position.x - rp),
      Math.abs(sPeri.position.y));
    addCheck("perihelion t=0: position = (a*(1-e), 0)", periPos,
      VALIDATION.positionTolerance, "m",
      periPos <= VALIDATION.positionTolerance, "(" + rp + ", 0) m");

    const ra = a * (1 + e);                                        /* E1 */
    const aphRad = Math.abs(sAph.radius - ra);
    addCheck("aphelion t=T/2: r = a*(1+e)", aphRad, VALIDATION.radiusTolerance,
      "m", aphRad <= VALIDATION.radiusTolerance, ra + " m");

    const aphPos = Math.max(Math.abs(sAph.position.x + ra),
      Math.abs(sAph.position.y));
    addCheck("aphelion t=T/2: position = (-a*(1+e), 0)", aphPos,
      VALIDATION.positionTolerance, "m",
      aphPos <= VALIDATION.positionTolerance, "(-" + ra + ", 0) m");

    const qMA = wrapError(sQ.meanAnomaly - Math.PI / 2);
    addCheck("quarter period t=T/4: M = pi/2", qMA, VALIDATION.angleTolerance,
      "rad", qMA <= VALIDATION.angleTolerance, "pi/2");

    /* Quarter-period behaviour: the planet is past the +y axis (2nd
     * quadrant; for e = 0 exactly ON it), still moving prograde. */
    const qQuadrant = sQ.position.y > 0 &&
      (e === 0 ? Math.abs(sQ.position.x) <= VALIDATION.positionTolerance
               : sQ.position.x < 0);
    addCheck("quarter period: position in 2nd quadrant (e=0: on +y axis)",
      "x = " + sQ.position.x.toExponential(3) + ", y = " +
      sQ.position.y.toExponential(3), "x < 0, y > 0", "m", qQuadrant,
      "prograde, past +y");

    /* Anomaly ordering M <= E <= nu on (0, pi): Kepler's equation has
     * E = M + e*sin E >= M, and nu >= E for E in (0, pi); equality
     * throughout only for the circle. */
    const qOrder = (sQ.eccentricAnomaly >= sQ.meanAnomaly - 1e-12) &&
      (sQ.trueAnomaly >= sQ.eccentricAnomaly - 1e-12) &&
      (e === 0 ? Math.abs(sQ.trueAnomaly - sQ.eccentricAnomaly) <= 1e-12
               : sQ.trueAnomaly > sQ.eccentricAnomaly);
    addCheck("quarter period: anomaly ordering M <= E <= nu",
      (sQ.trueAnomaly - sQ.eccentricAnomaly), ">= 0 (0 for e=0)", "rad",
      qOrder, "E3/E5");

    /* --- E3 sweep: residual, convergence, ranges ------------------ */
    let maxResidual = 0;
    let maxIterations = 0;
    let allConverged = true;
    let allInRange = true;
    let maxRadiusDiff = 0;   /* a(1-e cos E) vs E1 r(nu), relative   */
    let maxPolarDiff = 0;    /* analyticPosition vs (r cos nu, ...)  */
    let maxRoundTrip = 0;    /* E -> nu -> E                         */
    let maxCircularDiff = 0; /* e = 0: E = M exactly                 */

    for (let k = 0; k < VALIDATION.sweepPoints; k += 1) {
      const M = k * TWO_PI / VALIDATION.sweepPoints;
      const det = solveEccentricAnomalyDetailed(M, e);
      const E = det.E;
      const nu = eccentricToTrueAnomaly(E, e);

      if (!det.converged) { allConverged = false; }
      if (!(E >= 0 && E < TWO_PI && nu >= 0 && nu < TWO_PI)) { allInRange = false; }
      if (det.residual > maxResidual) { maxResidual = det.residual; }
      if (det.iterations > maxIterations) { maxIterations = det.iterations; }

      const rE = radiusAtEccentricAnomaly(E, a, e);
      const rNu = radiusAtTrueAnomaly(nu, a, e);
      const dr = Math.abs(rE - rNu) / rNu;
      if (dr > maxRadiusDiff) { maxRadiusDiff = dr; }

      const pos = analyticPosition(a, e, E);
      const dp = Math.max(Math.abs(pos.x - rNu * Math.cos(nu)),
        Math.abs(pos.y - rNu * Math.sin(nu)));
      if (dp > maxPolarDiff) { maxPolarDiff = dp; }

      const rt = wrapError(trueToEccentricAnomaly(nu, e) - E);
      if (rt > maxRoundTrip) { maxRoundTrip = rt; }

      if (e === 0) {
        const dc = Math.abs(E - M);
        if (dc > maxCircularDiff) { maxCircularDiff = dc; }
      }
    }

    addCheck("Kepler residual max over M sweep (" + VALIDATION.sweepPoints +
      " points)", maxResidual, SOLVER.tolerance, "rad",
      allConverged && maxResidual <= SOLVER.tolerance, "< " + SOLVER.tolerance);
    addCheck("Newton iterations bounded (max over sweep)", maxIterations,
      SOLVER.maxIterations, "iterations",
      allConverged && maxIterations <= SOLVER.maxIterations,
      "<= " + SOLVER.maxIterations);
    addCheck("E and nu in [0, 2*pi) over sweep", allInRange, true, "boolean",
      allInRange, "[0, 2*pi)");
    addCheck("radius consistency: a*(1-e*cos E) vs E1 r(nu)", maxRadiusDiff,
      VALIDATION.consistencyTolerance, "relative",
      maxRadiusDiff <= VALIDATION.consistencyTolerance, "E1 = E5");
    addCheck("position consistency: (x, y) vs (r cos nu, r sin nu)",
      maxPolarDiff, VALIDATION.consistencyTolerance, "m",
      maxPolarDiff <= VALIDATION.consistencyTolerance, "E5");
    addCheck("round trip E -> nu -> E", maxRoundTrip,
      VALIDATION.consistencyTolerance, "rad",
      maxRoundTrip <= VALIDATION.consistencyTolerance, "E = E");
    if (e === 0) {
      addCheck("circular: E = M exactly (degenerate E3)", maxCircularDiff, 0,
        "rad", maxCircularDiff === 0, "E = M");
    }

    return finish(maxResidual, maxIterations, compareWithNumerical(a, e));

    function finish(residual, iterations, diagnostic) {
      const result = {
        passed: checks.every(function (c) { return c.passed; }),
        parameters: { a: a, e: e, mu: DEFmLT_MU, period: T },
        checks: checks,
        worst: { maxResidualRad: residual, maxIterations: iterations },
        diagnostic: diagnostic
      };
      if (!quiet) {
        console.info("[GEO417E] Stage 3.1 Kepler solver validation - a = " +
          a + " m, e = " + e + ", T = " + T.toFixed(6) + " s");
        console.table(checks);
        if (diagnostic.available) {
          console.info("[GEO417E] analytic vs numerical (DIAGNOSTIC ONLY, " +
            "not gating): max |r_analytic - r_verlet| = " +
            diagnostic.maxPositionDeviationm.toExponential(3) +
            " m over " + diagnostic.samples + " samples in one period.");
        } else {
          console.info("[GEO417E] analytic vs numerical comparison skipped: " +
            diagnostic.note);
        }
        console.info((result.passed ? "[PASS] " : "[FAIL] ") +
          "Stage 3.1 checks for a = " + a + ", e = " + e + "." +
          " Worst residual = " + (Number.isFinite(residual) ?
            residual.toExponential(2) : "n/a") + " rad.");
      }
      return result;
    }
  }

  /**
   * Angle-normalisation checks (parameter-independent identities),
   * run once by runValidationSuite().
   * @returns {{passed: boolean, checks: Array}}
   */
  function runNormalizationChecks() {
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
    const tol = VALIDATION.angleTolerance;

    /* normalizeAngle maps a battery of angles into [0, 2*pi). */
    const battery = [0, Math.PI / 6, Math.PI / 2, Math.PI, 2 * Math.PI,
      -Math.PI / 2, -2 * Math.PI, 7 * Math.PI, 100 * Math.PI + 0.3, -0.3];
    let batteryOk = true;
    for (let i = 0; i < battery.length; i += 1) {
      const out = normalizeAngle(battery[i]);
      if (!(out >= 0 && out < TWO_PI)) { batteryOk = false; }
    }
    const zeroIn = normalizeAngle(0) === 0 && normalizeAngle(2 * Math.PI) === 0 &&
      normalizeAngle(-2 * Math.PI) === 0;
    const halfPi = wrapError(normalizeAngle(-Math.PI / 2) - 1.5 * Math.PI);
    addCheck("normalizeAngle maps into [0, 2*pi) (battery)", batteryOk, true,
      "boolean", batteryOk, "10 samples");
    addCheck("normalizeAngle(0) = normalizeAngle(+-2*pi) = 0", zeroIn, true,
      "boolean", zeroIn, "exact");
    addCheck("normalizeAngle(-pi/2) = 3*pi/2", halfPi, tol, "rad",
      halfPi <= tol, "3*pi/2");

    /* Mean anomaly normalisation and periodicity (a = 1 m, mu default). */
    const a = 1;
    const T = TWO_PI / meanMotion(a);                              /* E4 */
    const m0 = meanAnomaly(0, a);
    addCheck("meanAnomaly(0) = 0 exactly", m0, 0, "rad", m0 === 0, "0");
    const mT = wrapError(meanAnomaly(T, a));
    addCheck("meanAnomaly(T) = 0 (mod 2*pi)", mT, tol, "rad", mT <= tol, "0");
    const mNeg = Math.abs(meanAnomaly(-T / 4, a) - 1.5 * Math.PI);
    addCheck("meanAnomaly(-T/4) = 3*pi/2 (negative t wraps)", mNeg, tol, "rad",
      mNeg <= tol, "3*pi/2");
    let periodicErr = 0;
    const fractions = [0.1, 0.3, 0.7];
    for (let i = 0; i < fractions.length; i += 1) {
      const t = fractions[i] * T;
      const d = wrapError(meanAnomaly(t + 2 * T, a) - meanAnomaly(t, a));
      if (d > periodicErr) { periodicErr = d; }
    }
    addCheck("meanAnomaly(t + 2T) = meanAnomaly(t)", periodicErr, tol, "rad",
      periodicErr <= tol, "periodic");

    /* Solver/conversion normalisation: inputs beyond [0, 2*pi) give
     * identical results (checked at e = 0, 0.2 and 0.95). */
    const samples = [0, 0.3, 1.2, Math.PI, 4.5, 6.1];
    const es = [0, 0.2, 0.95];
    let solverErr = 0;
    let trueErr = 0;
    let invErr = 0;
    for (let i = 0; i < es.length; i += 1) {
      for (let j = 0; j < samples.length; j += 1) {
        const M = samples[j];
        const E = samples[j] * 0.9; /* any E < M sample works as input */
        const dS = wrapError(
          solveEccentricAnomaly(M + 6 * Math.PI, es[i]) -
          solveEccentricAnomaly(M, es[i]));
        if (dS > solverErr) { solverErr = dS; }
        const dN = wrapError(
          eccentricToTrueAnomaly(E + 2 * Math.PI, es[i]) -
          eccentricToTrueAnomaly(E, es[i]));
        if (dN > trueErr) { trueErr = dN; }
        const dI = wrapError(
          trueToEccentricAnomaly(E + 4 * Math.PI, es[i]) -
          trueToEccentricAnomaly(E, es[i]));
        if (dI > invErr) { invErr = dI; }
      }
    }
    addCheck("solveEccentricAnomaly(M + 6*pi) = solveEccentricAnomaly(M)",
      solverErr, tol, "rad", solverErr <= tol, "M normalised");
    addCheck("eccentricToTrueAnomaly(E + 2*pi) = same nu", trueErr, tol,
      "rad", trueErr <= tol, "E normalised");
    addCheck("trueToEccentricAnomaly(nu + 4*pi) = same E", invErr, tol, "rad",
      invErr <= tol, "nu normalised");

    return {
      passed: checks.every(function (c) { return c.passed; }),
      checks: checks
    };
  }

  /**
   * Console-callable Stage 3.1 suite: circular orbit, the default
   * e = 0.2, high eccentricity e = 0.95 (at a = 0.5/1/2 m), plus the
   * angle-normalisation identities. Prints a summary table and the
   * analytic-vs-numerical diagnostic (not gating).
   * @returns {{passed: boolean, cases: Array, normalization: object}}
   */
  function runValidationSuite() {
    const cases = [
      { label: "circular (a=1, e=0)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0 },
      { label: "default (a=1, e=0.2)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.2 },
      { label: "high-e (a=1, e=0.95)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.95 },
      { label: "high-e inner (a=0.5, e=0.95)", a: 0.5 * OrbitConfig.physics.astronomicalUnit, e: 0.95 },
      { label: "high-e outer (a=2, e=0.95)", a: 2 * OrbitConfig.physics.astronomicalUnit, e: 0.95 }
    ];

    const rows = cases.map(function (c) {
      const result = runValidation({ a: c.a, e: c.e }, { quiet: true });
      return {
        case: c.label,
        maxResidualRad: result.worst.maxResidualRad,
        maxIterations: result.worst.maxIterations,
        checksPassed: result.checks.filter(function (x) { return x.passed; })
          .length + "/" + result.checks.length,
        analyticVsNumericm: result.diagnostic.available ?
          result.diagnostic.maxPositionDeviationm : NaN,
        passed: result.passed
      };
    });

    const normalization = runNormalizationChecks();

    console.info("[GEO417E] Stage 3.1 Kepler solver validation suite " +
      "(analytical solver only - the rendered planet stays " +
      "Verlet-integrated):");
    console.table(rows);
    console.info("[GEO417E] angle normalisation checks:");
    console.table(normalization.checks);
    const passed = rows.every(function (r) { return r.passed; }) &&
      normalization.passed;
    console.info((passed ? "[PASS] " : "[FAIL] ") +
      "All Stage 3.1 cases within tolerances (Kepler residual <= " +
      SOLVER.tolerance + " rad, apsis radii <= " +
      VALIDATION.radiusTolerance + " m). The analyticVsNumericm column " +
      "is a DIAGNOSTIC of the Verlet integrator error, not a pass/fail " +
      "criterion.");
    return { passed: passed, cases: rows, normalization: normalization };
  }

  /* ================================================================
   * Public API
   * ================================================================ */
  return {
    SOLVER: SOLVER,
    normalizeAngle: normalizeAngle,
    meanMotion: meanMotion,
    meanAnomaly: meanAnomaly,
    keplerEquationResidual: keplerEquationResidual,
    solveEccentricAnomaly: solveEccentricAnomaly,
    solveEccentricAnomalyDetailed: solveEccentricAnomalyDetailed,
    eccentricToTrueAnomaly: eccentricToTrueAnomaly,
    trueToEccentricAnomaly: trueToEccentricAnomaly,
    radiusAtTrueAnomaly: radiusAtTrueAnomaly,
    radiusAtEccentricAnomaly: radiusAtEccentricAnomaly,
    analyticPosition: analyticPosition,
    analyticStateAtTime: analyticStateAtTime,
    runValidation: runValidation,
    runValidationSuite: runValidationSuite
  };
})();
