/*
 * GEO417E Planetary Orbit Simulator
 * areas.js - Stage 3.2: Kepler's 2nd law (equal areas, E7).
 *
 * Loaded after kepler.js and before ui.js. Declares the global
 * `OrbitAreas` object. Pure math/data module: no DOM access, no canvas,
 * no logging during computation (only the console-callable validation
 * routines report, mirroring OrbitPhysics/OrbitKepler).
 *
 * SCOPE (Stage 3.2 ONLY)
 * ----------------------
 * - E7  equal-area sectors: divide ONE orbital period into exactly 12
 *   equal TIME intervals, measure the area swept by the radius vector
 *   in each interval and compare with the theoretical pi*a*b/12.
 * - theoretical areal velocity dA/dt = h/2 with h = sqrt(mu*a*(1-e^2)).
 * - a toggleable sector overlay for the canvas (this module supplies
 *   the geometry; the drawing lives in canvas.js) and an expandable
 *   UI panel (wired in ui.js).
 *
 * NOT in scope (later stages): velocity vectors, trails, extra bodies.
 * The DISPLAYED planet keeps coming from the velocity-Verlet state in
 * OrbitPhysics; the analytic OrbitKepler positions used here are a
 * diagnostic/reference geometry only and never drive the rendered
 * planet. The Verlet engine itself is not touched by this module.
 *
 * CONVENTIONS (identical to physics.js / kepler.js, Stages 1-3.1)
 * ----------------------------------------------------------------
 * - Units: m, seconds; mu = GM = 4*pi^2 m^3/s^2 (default
 *   OrbitConfig.physics.mu). Areas are in m^2, areal velocities in
 *   m^2/s.
 * - Sun fixed at the origin (ellipse focus). Perihelion on the +x
 *   axis, prograde motion counter-clockwise, t = 0 at perihelion.
 * - Sector k (k = 0..11) covers the time interval
 *       t in [ k*T/12 , (k+1)*T/12 ]        (T = theoretical period, E4)
 *   so all 12 durations are equal BY CONSTRUCTION; the validation
 *   MEASURES the durations instead of assuming them.
 * - Sector numbering in the UI is 1-based (sector 1 starts at
 *   perihelion; sector 7 straddles aphelion at t = T/2).
 *
 * NUMERICAL METHOD (measured swept area)
 * --------------------------------------
 * The swept area of a sector is the area of the region bounded by the
 * orbit arc from p(t_k) to p(t_{k+1}) and the two radius vectors from
 * the Sun to those points. It is computed with the composite
 * TRIANGULAR-FAN (shoelace) quadrature:
 *
 *   sample n+1 analytic positions p_i = (x_i, y_i) at equal TIME steps
 *   t_i = t_k + i*(T/12)/n, i = 0..n  (via OrbitKepler: t -> M -> E -> x,y)
 *   A_k = 1/2 * sum_{i=0}^{n-1} ( x_i*y_{i+1} - y_i*x_{i+1} )
 *
 * Each term is the signed area of the triangle Sun-p_i-p_{i+1}; the
 * sum is the shoelace area of the polygon Sun-p_0-...-p_n (prograde
 * motion keeps every cross product positive, so no |.| is needed and
 * a negative term would flag an error rather than be silently fixed).
 *
 * Accuracy: for a smooth arc the chord-polygon area differs from the
 * exact sector area by O(dnu^3) per triangle (dnu = polar angle per
 * sample), i.e. the TOTAL error is O(n^-2) - second-order convergent,
 * the same order as the trapezoidal rule on dA/dt = 1/2*r^2*dnu/dt.
 * No velocities are needed (kepler.js deliberately provides none).
 * The Kepler-equation residual per sample is <= 1e-12 rad (Newton
 * solver tolerance), far below the quadrature error at every usable
 * resolution - the convergence study in runConvergenceStudy()
 * MEASURES the actual error decrease (factor ~4 per doubling of n).
 *
 * The sampling resolution n (samplesPerSector) is configurable via
 * OrbitConfig.areas.samplesPerSector (single source of truth, like the
 * integrator tuning) and per-call through the options object.
 */
"use strict";

const OrbitAreas = (() => {
  const TWO_PI = 2 * Math.PI;

  /* Default gravitational parameter [m^3/s^2]; config.js loads first. */
  const DEFmLT_MU = OrbitConfig.physics.mu;

  /* Stage 3.2 fixes the sector count at exactly 12 (one orbital period
   * divided into 12 equal time intervals). Kept in OrbitConfig so the
   * UI, canvas and validation share one source of truth. */
  const SECTOR_COUNT = OrbitConfig.areas.sectorCount;

  /* Default sampling resolution (analytic positions per sector). */
  const DEFmLT_SAMPLES = OrbitConfig.areas.samplesPerSector;

  /* Acceptance thresholds for runValidation()/runConvergenceStudy().
   * Values chosen from MEASURED worst-case errors over the full
   * parameter range (a in [0.5, 2] m, e in [0, 0.95]) at the default
   * sampling resolution - see README.md for the measured numbers. */
  const VALIDATION = Object.freeze({
    durationTolerance: 1e-12,       /* rel., |dur - T/12| / (T/12)      */
    areaTolerance: 5e-4,            /* rel., vs pi*a*b/12, default n    */
    totalAreaTolerance: 5e-4,       /* rel., sum of sectors vs pi*a*b   */
    arealVelocityTolerance: 5e-4,   /* rel., mean A/T vs h/2            */
    circularSpreadTolerance: 1e-12, /* rel. spread of the 12 areas, e=0 */
    boundaryTolerance: 1e-3,        /* m, sector 1 starts at perihelion*/
    highEThreshold: 0.9,            /* e >= this: strong nu-span check  */
    nuSpanRatioMin: 10,             /* sector1/sector7 nu span, high e  */
    convergenceLadder: [8, 16, 32, 64, 128, 256, 512],
    convergenceOrderMin: 1.5,       /* observed order p = log2(err ratio)*/
    convergenceOrderMax: 2.5,
    convergenceImprovementMin: 100  /* err(n_min)/err(n_max)            */
  });

  /* ================================================================
   * Small helpers
   * ================================================================ */

  function isFiniteNumber(x) {
    return typeof x === "number" && Number.isFinite(x);
  }

  /* 0 <= e < 1 (same domain as OrbitKepler; e >= 1 is not an ellipse). */
  function validEccentricity(e) {
    return isFiniteNumber(e) && e >= 0 && e < 1;
  }

  function validParameters(a, e, mu) {
    return isFiniteNumber(a) && a > 0 && validEccentricity(e) &&
      isFiniteNumber(mu) && mu > 0;
  }

  /* ================================================================
   * Theoretical quantities (E1/E2/E4/E7, pure functions)
   * ================================================================ */

  /**
   * Semi-minor axis b = a*sqrt(1-e^2) [m] (E1).
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   * @returns {number} b [m], or NaN for invalid input
   */
  function semiMinorAxis(a, e) {
    if (!isFiniteNumber(a) || a <= 0 || !validEccentricity(e)) {
      return NaN;
    }
    return a * Math.sqrt(1 - e * e);
  }

  /**
   * Total ellipse area pi*a*b [m^2] (b = a*sqrt(1-e^2), E1).
   * @returns {number} area [m^2], or NaN for invalid input
   */
  function ellipseArea(a, e) {
    const b = semiMinorAxis(a, e);
    return Number.isFinite(b) ? Math.PI * a * b : NaN;
  }

  /**
   * Theoretical area of ONE of the 12 equal-time sectors [m^2]:
   *   A_th = pi*a*b / 12
   * (Kepler's 2nd law: equal areas in equal times, so each twelfth of
   * the period sweeps exactly one twelfth of the ellipse area).
   * @returns {number} area [m^2], or NaN for invalid input
   */
  function theoreticalSectorArea(a, e) {
    const total = ellipseArea(a, e);
    return Number.isFinite(total) ? total / SECTOR_COUNT : NaN;
  }

  /**
   * Specific angular momentum of the analytic orbit [m^2/s]:
   *   h = sqrt(mu*a*(1-e^2))                        (E2, analytic)
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   * @returns {number} h [m^2/s], or NaN for invalid input
   */
  function specificAngularMomentum(a, e, mu) {
    const m = (mu === undefined) ? DEFmLT_MU : mu;
    if (!validParameters(a, e, m)) {
      return NaN;
    }
    return Math.sqrt(m * a * (1 - e * e));
  }

  /**
   * Theoretical areal velocity [m^2/s]:
   *   dA/dt = h/2 = 1/2*sqrt(mu*a*(1-e^2)) = pi*a*b / T   (E2/E4/E7)
   * The two right-hand sides agree analytically; runValidation()
   * MEASURES the measured mean areal velocity against h/2 instead of
   * assuming the equality.
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   * @returns {number} dA/dt [m^2/s], or NaN for invalid input
   */
  function theoreticalArealVelocity(a, e, mu) {
    const h = specificAngularMomentum(a, e, mu);
    return Number.isFinite(h) ? h / 2 : NaN;
  }

  /**
   * Theoretical period T = 2*pi*sqrt(a^3/mu) [s] (E4). Computed from
   * the mu actually passed in (OrbitPhysics.orbitalPeriod hardcodes
   * the config mu; with the default mu both are identical).
   * @param {number} [mu] gravitational parameter [m^3/s^2]
   * @returns {number} T [s], or NaN for invalid input
   */
  function orbitalPeriod(a, mu) {
    const m = (mu === undefined) ? DEFmLT_MU : mu;
    if (!isFiniteNumber(a) || a <= 0 || !isFiniteNumber(m) || m <= 0) {
      return NaN;
    }
    return TWO_PI * Math.sqrt(a * a * a / m);
  }

  /* ================================================================
   * Sector computation (E7)
   * ================================================================ */

  /**
   * Divide one orbital period into exactly 12 equal time intervals and
   * measure the area swept in each (see the module header for the
   * triangular-fan/shoelace quadrature and its O(n^-2) accuracy).
   *
   * Sample times are computed as t = (k*n + i)*step with
   * step = T/(12*n): adjacent sectors then share their boundary
   * sample exactly (up to one rounding of the shared expression), and
   * the sector boundaries themselves are the exact k*T/12 grid.
   *
   * @param {object} [options]
   *   a                 semi-major axis [m] (default: config default)
   *   e                 eccentricity [-]     (default: config default)
   *   samplesPerSector  analytic positions per sector (default:
   *                     OrbitConfig.areas.samplesPerSector)
   *   mu                gravitational parameter [m^3/s^2] (default:
   *                     OrbitConfig.physics.mu)
   * @returns {object|null} null for invalid parameters, otherwise:
   *   { a, e, mu, period, semiMinorAxis, sectorCount, samplesPerSector,
   *     theoreticalSectorArea, theoreticalTotalArea,
   *     theoreticalArealVelocity, specificAngularMomentum,
   *     allFinite, allSolversConverged, allCrossProductsPositive,
   *     sectors, summary } where sectors[i] is
   *   { index (1-based), tStart, tEnd, duration, startPosition,
   *     endPosition, nuStart, nuEnd, nuSpan, samplePositions,
   *     measuredArea, theoreticalArea, absoluteError, relativeError,
   *     measuredArealVelocity } and summary carries the aggregates
   *   { totalMeasuredArea, totalAbsoluteError, totalRelativeError,
   *     maxAbsoluteError, maxRelativeError, meanArealVelocity,
   *     arealVelocityRelativeError, maxDurationDeviation,
   *     durationDeviationRelative } (areas in m^2, times in s,
   *     angles in rad).
   */
  function computeSectors(options) {
    const opts = options || {};
    const a = (opts.a !== undefined) ? Number(opts.a) :
      OrbitConfig.defaults.semiMajorAxis;
    const e = (opts.e !== undefined) ? Number(opts.e) :
      OrbitConfig.defaults.eccentricity;
    const mu = (opts.mu !== undefined) ? Number(opts.mu) : DEFmLT_MU;
    const nSamples = (opts.samplesPerSector !== undefined) ?
      Number(opts.samplesPerSector) : DEFmLT_SAMPLES;

    if (!validParameters(a, e, mu) || !Number.isInteger(nSamples) ||
        nSamples < 1) {
      return null;
    }

    const T = orbitalPeriod(a, mu);                          /* E4 */
    const b = semiMinorAxis(a, e);                           /* E1 */
    const sectorTheoretical = theoreticalSectorArea(a, e);   /* E7 */
    const h = specificAngularMomentum(a, e, mu);             /* E2 */
    const arealVelocity = h / 2;                             /* E7 */

    const step = T / (SECTOR_COUNT * nSamples);
    const nominalDuration = T / SECTOR_COUNT;

    const sectors = [];
    let allFinite = true;
    let allSolversConverged = true;
    let allCrossProductsPositive = true;
    let maxDurationDeviation = 0;

    for (let k = 0; k < SECTOR_COUNT; k += 1) {
      const tStart = k * T / SECTOR_COUNT;
      const tEnd = (k + 1) * T / SECTOR_COUNT;
      const duration = tEnd - tStart;
      const durationDeviation = Math.abs(duration - nominalDuration);
      if (durationDeviation > maxDurationDeviation) {
        maxDurationDeviation = durationDeviation;
      }

      /* --- n+1 analytic positions at equal time steps (E3/E5) --- */
      const samplePositions = [];
      let nuStart = NaN;
      let nuEnd = NaN;
      for (let i = 0; i <= nSamples; i += 1) {
        const t = (k * nSamples + i) * step;
        const s = OrbitKepler.analyticStateAtTime(t, a, e, mu);
        if (!s) {
          allFinite = false;
          allSolversConverged = false;
          samplePositions.push({ x: NaN, y: NaN });
          continue;
        }
        if (!s.solver.converged) {
          allSolversConverged = false;
        }
        if (!(Number.isFinite(s.position.x) &&
              Number.isFinite(s.position.y))) {
          allFinite = false;
        }
        samplePositions.push({ x: s.position.x, y: s.position.y });
        if (i === 0) {
          nuStart = s.trueAnomaly;
        }
        if (i === nSamples) {
          nuEnd = s.trueAnomaly;
        }
      }

      /* --- triangular-fan / shoelace quadrature (module header) --- */
      let measured = 0;
      for (let i = 0; i < nSamples; i += 1) {
        const p0 = samplePositions[i];
        const p1 = samplePositions[i + 1];
        const cross = p0.x * p1.y - p0.y * p1.x;
        if (!(cross > 0)) {
          /* NaN or non-positive: prograde convention violated. */
          allCrossProductsPositive = false;
        }
        measured += cross;
      }
      measured *= 0.5;
      if (!Number.isFinite(measured)) {
        allFinite = false;
      }

      const absoluteError = measured - sectorTheoretical; /* signed */
      sectors.push({
        index: k + 1,                   /* 1-based sector number     */
        tStart: tStart,                 /* s since perihelion       */
        tEnd: tEnd,                     /* s since perihelion       */
        duration: duration,             /* s                        */
        startPosition: samplePositions[0],
        endPosition: samplePositions[nSamples],
        nuStart: nuStart,               /* rad, [0, 2*pi)           */
        nuEnd: nuEnd,                   /* rad, [0, 2*pi)           */
        nuSpan: OrbitKepler.normalizeAngle(nuEnd - nuStart),
        samplePositions: samplePositions, /* n+1 points [m]        */
        measuredArea: measured,         /* m^2                      */
        theoreticalArea: sectorTheoretical,
        absoluteError: absoluteError,   /* m^2, signed              */
        relativeError: Math.abs(absoluteError) / sectorTheoretical,
        measuredArealVelocity: measured / duration /* m^2/s       */
      });
    }

    /* --- aggregates (measured, never assumed) ------------------- */
    let totalMeasured = 0;
    let maxAbs = 0;
    let maxRel = 0;
    for (let k = 0; k < SECTOR_COUNT; k += 1) {
      const s = sectors[k];
      totalMeasured += s.measuredArea;
      const absE = Math.abs(s.absoluteError);
      if (absE > maxAbs) {
        maxAbs = absE;
      }
      if (s.relativeError > maxRel) {
        maxRel = s.relativeError;
      }
    }
    const totalTheoretical = ellipseArea(a, e);
    const meanArealVelocity = totalMeasured / T;
    const arealVelocityError = Math.abs(meanArealVelocity - arealVelocity) /
      arealVelocity;

    return {
      a: a,
      e: e,
      mu: mu,
      period: T,
      semiMinorAxis: b,
      sectorCount: SECTOR_COUNT,
      samplesPerSector: nSamples,
      theoreticalSectorArea: sectorTheoretical,
      theoreticalTotalArea: totalTheoretical,
      theoreticalArealVelocity: arealVelocity,
      specificAngularMomentum: h,
      allFinite: allFinite,
      allSolversConverged: allSolversConverged,
      allCrossProductsPositive: allCrossProductsPositive,
      sectors: sectors,
      summary: {
        totalMeasuredArea: totalMeasured,
        totalAbsoluteError: totalMeasured - totalTheoretical,
        totalRelativeError: Math.abs(totalMeasured - totalTheoretical) /
          totalTheoretical,
        maxAbsoluteError: maxAbs,
        maxRelativeError: maxRel,
        meanArealVelocity: meanArealVelocity,
        arealVelocityRelativeError: arealVelocityError,
        maxDurationDeviation: maxDurationDeviation,
        durationDeviationRelative: maxDurationDeviation / nominalDuration
      }
    };
  }

  /* ================================================================
   * Memoised access for the canvas overlay and the UI panel
   * ================================================================ */

  /* Single-entry cache: the canvas asks for the current (a, e) every
   * rendered frame and the UI panel asks on every slider input; both
   * only ever need the latest configuration. Keyed on a|e|n. */
  let cache = { key: null, result: null };

  /**
   * Memoised computeSectors() for rendering/UI use. Returns the cached
   * result when (a, e, samplesPerSector) are unchanged.
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   * @param {number} [samplesPerSector] sampling resolution (default:
   *   OrbitConfig.areas.samplesPerSector)
   * @returns {object|null} the computeSectors() result (cached)
   */
  function getSectors(a, e, samplesPerSector) {
    const n = (samplesPerSector === undefined) ? DEFmLT_SAMPLES :
      Number(samplesPerSector);
    const key = a + "|" + e + "|" + n;
    if (cache.key === key && cache.result) {
      return cache.result;
    }
    const result = computeSectors({
      a: a, e: e,
      samplesPerSector: Number.isInteger(n) ? n : DEFmLT_SAMPLES
    });
    cache = { key: key, result: result };
    return result;
  }

  /* ================================================================
   * Validation / self-test (Stage 3.2)
   * ================================================================ */
  /* Every quantity is MEASURED; thresholds only decide pass/fail
   * afterwards (same philosophy as OrbitPhysics/OrbitKepler).
   *
   * runValidation()  - one (a, e) case: structure, equal durations,
   *                    per-sector areas vs pi*a*b/12, areal velocity
   *                    vs h/2, circular equality (e = 0) and the
   *                    high-eccentricity anomaly-span behaviour.
   * runConvergenceStudy() - max relative error vs sampling resolution
   *                    over the ladder [8 .. 512] and the observed
   *                    convergence order (expected ~2).
   * runValidationSuite()  - e = 0/0.2/0.5/0.95 at a = 0.5/1/2 m
   *                    (12 cases) plus convergence studies. */

  /**
   * Run the Stage 3.2 validation for one (a, e) case.
   * @param {object} [options] { a, e, samplesPerSector } (defaults:
   *   configured defaults)
   * @param {object} [reporting] { quiet: boolean } suppress console output
   * @returns {{passed: boolean, parameters: object, checks: Array,
   *            worst: object, data: object}}
   */
  function runValidation(options, reporting) {
    const quiet = Boolean(reporting && reporting.quiet);
    const opts = options || {};
    const a = (opts.a !== undefined) ? Number(opts.a) :
      OrbitConfig.defaults.semiMajorAxis;
    const e = (opts.e !== undefined) ? Number(opts.e) :
      OrbitConfig.defaults.eccentricity;
    const nSamples = (opts.samplesPerSector !== undefined) ?
      Number(opts.samplesPerSector) : DEFmLT_SAMPLES;

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

    /* --- 0. parameters and structure ---------------------------- */
    const data = computeSectors({ a: a, e: e, samplesPerSector: nSamples });
    const paramsOk = data !== null;
    addCheck("parameters valid (a > 0, 0 <= e < 1, n >= 1)", paramsOk, true,
      "boolean", paramsOk, "a = " + a + " m, e = " + e + ", n = " + nSamples);
    if (!paramsOk) {
      return finish(NaN, NaN, NaN, null);
    }

    addCheck("exactly 12 sectors per period", data.sectors.length, 12,
      "sectors", data.sectors.length === SECTOR_COUNT, "12");
    addCheck("all sample positions and areas finite", data.allFinite, true,
      "boolean", data.allFinite, "finite");
    addCheck("Kepler solver converged for every sample",
      data.allSolversConverged, true, "boolean", data.allSolversConverged,
      "converged (residual <= 1e-12 rad)");
    addCheck("prograde: all shoelace cross products > 0",
      data.allCrossProductsPositive, true, "boolean",
      data.allCrossProductsPositive, "x_i*y_j - y_i*x_j > 0");

    /* --- 1. equal durations (measured, not assumed) -------------- */
    const durRel = data.summary.durationDeviationRelative;
    addCheck("equal durations: max |dur - T/12| / (T/12)", durRel,
      VALIDATION.durationTolerance, "relative",
      durRel <= VALIDATION.durationTolerance, "T/12 = " +
      (data.period / SECTOR_COUNT).toFixed(6) + " s");

    /* --- 2. sector 1 starts at perihelion (E1/E5 wiring) --------- */
    const rp = a * (1 - e);                                       /* E1 */
    const s1 = data.sectors[0];
    const boundaryErr = Math.max(
      Math.abs(s1.startPosition.x - rp), Math.abs(s1.startPosition.y));
    addCheck("sector 1 starts at perihelion (a*(1-e), 0)", boundaryErr,
      VALIDATION.boundaryTolerance, "m",
      boundaryErr <= VALIDATION.boundaryTolerance,
      "(" + rp.toFixed(6) + ", 0) m");

    /* --- 3. equal areas vs pi*a*b/12 (absolute AND relative) ----- */
    const maxAbsErr = data.summary.maxAbsoluteError;
    const maxRelErr = data.summary.maxRelativeError;
    addCheck("max |A_measured - pi*a*b/12| (absolute)", maxAbsErr,
      VALIDATION.areaTolerance * data.theoreticalSectorArea, "m^2",
      maxRelErr <= VALIDATION.areaTolerance,
      "pi*a*b/12 = " + data.theoreticalSectorArea.toFixed(6) + " m^2");
    addCheck("max |A_measured - pi*a*b/12| / (pi*a*b/12)", maxRelErr,
      VALIDATION.areaTolerance, "relative",
      maxRelErr <= VALIDATION.areaTolerance, "O(n^-2) quadrature, n = " +
      data.samplesPerSector);

    const totalRel = data.summary.totalRelativeError;
    addCheck("total swept area vs pi*a*b (12 sectors)", totalRel,
      VALIDATION.totalAreaTolerance, "relative",
      totalRel <= VALIDATION.totalAreaTolerance,
      "pi*a*b = " + data.theoreticalTotalArea.toFixed(6) + " m^2");

    /* --- 4. areal velocity: measured mean vs h/2 ----------------- */
    const avRel = data.summary.arealVelocityRelativeError;
    addCheck("mean areal velocity A_total/T vs h/2", avRel,
      VALIDATION.arealVelocityTolerance, "relative",
      avRel <= VALIDATION.arealVelocityTolerance,
      "h/2 = " + data.theoreticalArealVelocity.toFixed(6) + " m^2/s");

    /* --- 5. shape-dependent behaviour ---------------------------- */
    if (e === 0) {
      /* Circular orbit: every sector is geometrically identical, so
       * the 12 measured areas must agree to machine precision. */
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < SECTOR_COUNT; k += 1) {
        const areaK = data.sectors[k].measuredArea;
        if (areaK < lo) { lo = areaK; }
        if (areaK > hi) { hi = areaK; }
      }
      const spread = (hi - lo) / data.summary.totalMeasuredArea *
        SECTOR_COUNT; /* (hi-lo)/mean */
      addCheck("circular: all 12 areas equal, (max-min)/mean", spread,
        VALIDATION.circularSpreadTolerance, "relative",
        spread <= VALIDATION.circularSpreadTolerance, "machine precision");
    } else {
      /* Eccentric orbit: the perihelion sector sweeps a WIDER true
       * anomaly than the aphelion sector (fast motion near the star)
       * while sweeping the same area - the essence of Kepler's 2nd
       * law. Sector 1 starts at perihelion, sector 7 at aphelion. */
      const spanPeri = data.sectors[0].nuSpan;
      const spanAph = data.sectors[6].nuSpan;
      const ratio = spanPeri / spanAph;
      addCheck("perihelion sector sweeps wider nu than aphelion sector",
        "sector1/sector7 = " + ratio.toFixed(2), "ratio > 1", "rad",
        spanPeri > spanAph,
        "nu1 = " + spanPeri.toFixed(4) + ", nu7 = " + spanAph.toFixed(4));
      if (e >= VALIDATION.highEThreshold) {
        addCheck("high-e: nu-span ratio sector1/sector7 >= " +
          VALIDATION.nuSpanRatioMin, ratio, VALIDATION.nuSpanRatioMin,
          "ratio", ratio >= VALIDATION.nuSpanRatioMin,
          "fast perihelion passage");
      }
    }

    return finish(maxRelErr, totalRel, avRel, data);

    function finish(worstRel, worstTotalRel, worstAvRel, result) {
      const summary = {
        passed: checks.every(function (c) { return c.passed; }),
        parameters: {
          a: a, e: e, mu: DEFmLT_MU,
          samplesPerSector: nSamples,
          period: result ? result.period : NaN
        },
        checks: checks,
        worst: {
          maxSectorRelativeError: worstRel,
          totalRelativeError: worstTotalRel,
          arealVelocityRelativeError: worstAvRel
        },
        data: result
      };
      if (!quiet) {
        console.info("[GEO417E] Stage 3.2 equal-areas validation - a = " +
          a + " m, e = " + e + ", n = " + nSamples +
          " samples/sector, T = " +
          (result ? result.period.toFixed(6) : "n/a") + " s");
        console.table(checks);
        if (result) {
          console.info("[GEO417E] per-sector detail (measured vs " +
            "pi*a*b/12 = " + result.theoreticalSectorArea.toFixed(6) +
            " m^2):");
          console.table(result.sectors.map(function (s) {
            return {
              sector: s.index,
              tStartYr: s.tStart,
              tEndYr: s.tEnd,
              measuredm2: s.measuredArea,
              absErrorm2: s.absoluteError,
              relError: s.relativeError,
              nuSpanRad: s.nuSpan
            };
          }));
        }
        console.info((summary.passed ? "[PASS] " : "[FAIL] ") +
          "Stage 3.2 checks for a = " + a + ", e = " + e + "." +
          " Worst sector rel. error = " + (Number.isFinite(worstRel) ?
          worstRel.toExponential(2) : "n/a") + ".");
      }
      return summary;
    }
  }

  /**
   * Measure the max relative sector-area error as a function of the
   * sampling resolution (configurable via the ladder in VALIDATION).
   * Verifies that the quadrature converges as n increases with an
   * observed order near 2 (each doubling of n should shrink the error
   * by roughly 4x, the O(n^-2) behaviour documented in the header).
   * @param {object} [options] { a, e } (defaults: a = 1 m, e = 0.5)
   * @param {object} [reporting] { quiet: boolean }
   * @returns {{passed: boolean, parameters: object, checks: Array,
   *            resolutions: Array}}
   */
  function runConvergenceStudy(options, reporting) {
    const quiet = Boolean(reporting && reporting.quiet);
    const opts = options || {};
    const a = (opts.a !== undefined) ? Number(opts.a) : 1;
    const e = (opts.e !== undefined) ? Number(opts.e) : 0.5;

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

    if (!validParameters(a, e, DEFmLT_MU)) {
      addCheck("parameters valid", false, true, "boolean", false,
        "a = " + a + " m, e = " + e);
      return report();
    }

    const ladder = VALIDATION.convergenceLadder;
    const resolutions = [];
    for (let i = 0; i < ladder.length; i += 1) {
      const data = computeSectors({ a: a, e: e, samplesPerSector: ladder[i] });
      resolutions.push({
        samplesPerSector: ladder[i],
        maxRelativeError: data ? data.summary.maxRelativeError : NaN
      });
    }

    /* Errors strictly decrease as the resolution increases. */
    let decreasing = true;
    for (let i = 1; i < resolutions.length; i += 1) {
      if (!(resolutions[i].maxRelativeError < resolutions[i - 1].maxRelativeError)) {
        decreasing = false;
      }
    }
    addCheck("max rel. error strictly decreases over the ladder " +
      "(" + ladder[0] + " -> " + ladder[ladder.length - 1] + " samples)",
      decreasing, true, "boolean", decreasing, "monotone convergence");

    /* Observed order p = log2(err_i / err_{i+1}) per doubling. */
    const orders = [];
    for (let i = 1; i < resolutions.length; i += 1) {
      const ratio = resolutions[i - 1].maxRelativeError /
        resolutions[i].maxRelativeError;
      if (ratio > 0) {
        orders.push(Math.log(ratio) / Math.LN2);
      }
    }
    const meanOrder = orders.reduce(function (s, p) { return s + p; }, 0) /
      orders.length;
    addCheck("observed convergence order (mean over doublings)", meanOrder,
      "[" + VALIDATION.convergenceOrderMin + ", " +
      VALIDATION.convergenceOrderMax + "]", "order",
      meanOrder >= VALIDATION.convergenceOrderMin &&
      meanOrder <= VALIDATION.convergenceOrderMax,
      "~2 (O(n^-2) triangular fan)");

    /* Total improvement across the ladder. */
    const improvement = resolutions[0].maxRelativeError /
      resolutions[resolutions.length - 1].maxRelativeError;
    addCheck("improvement err(" + ladder[0] + ")/err(" +
      ladder[ladder.length - 1] + ")", improvement,
      ">= " + VALIDATION.convergenceImprovementMin, "factor",
      improvement >= VALIDATION.convergenceImprovementMin,
      "second-order convergence");

    return report();

    function report() {
      const result = {
        passed: checks.every(function (c) { return c.passed; }),
        parameters: { a: a, e: e, ladder: ladder.slice() },
        checks: checks,
        resolutions: resolutions
      };
      if (!quiet) {
        console.info("[GEO417E] Stage 3.2 convergence study - a = " + a +
          " m, e = " + e + " (max rel. sector-area error vs sampling):");
        console.table(resolutions.map(function (r, i) {
          return {
            samplesPerSector: r.samplesPerSector,
            maxRelativeError: r.maxRelativeError,
            improvementFactor: (i === 0) ? "-" :
              resolutions[i - 1].maxRelativeError / r.maxRelativeError
          };
        }));
        console.table(checks);
        console.info((result.passed ? "[PASS] " : "[FAIL] ") +
          "Convergence study for a = " + a + ", e = " + e +
          " (mean observed order " + meanOrder.toFixed(2) + ").");
      }
      return result;
    }
  }

  /**
   * Console-callable Stage 3.2 suite: 12 cases covering e = 0, 0.2,
   * 0.5 and 0.95 at a = 0.5, 1 and 2 m (equal durations, equal areas,
   * circular equality, high-eccentricity behaviour) plus convergence
   * studies at e = 0, 0.5 and 0.95. Prints summary tables.
   * @returns {{passed: boolean, cases: Array, convergence: Array}}
   */
  function runValidationSuite() {
    const es = [0, 0.2, 0.5, 0.95];
    const as = [0.5, 1, 2];
    const cases = [];
    for (let i = 0; i < es.length; i += 1) {
      for (let j = 0; j < as.length; j += 1) {
        cases.push({ label: "a=" + as[j] + ", e=" + es[i], a: as[j], e: es[i] });
      }
    }

    const rows = cases.map(function (c) {
      const result = runValidation({ a: c.a, e: c.e }, { quiet: true });
      const data = result.data;
      const peri = data ? data.sectors[0].nuSpan : NaN;
      const aph = data ? data.sectors[6].nuSpan : NaN;
      return {
        case: c.label,
        maxRelAreaError: result.worst.maxSectorRelativeError,
        totalRelError: result.worst.totalRelativeError,
        arealVelRelError: result.worst.arealVelocityRelativeError,
        nuSpanRatio17: (c.e > 0 && data) ? peri / aph : "-",
        checksPassed: result.checks.filter(function (x) { return x.passed; })
          .length + "/" + result.checks.length,
        passed: result.passed
      };
    });

    const convergenceCases = [
      { label: "circular (a=1, e=0)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0 },
      { label: "moderate (a=1, e=0.5)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.5 },
      { label: "high-e (a=1, e=0.95)", a: 1 * OrbitConfig.physics.astronomicalUnit, e: 0.95 }
    ];
    const convergence = convergenceCases.map(function (c) {
      const study = runConvergenceStudy({ a: c.a, e: c.e }, { quiet: true });
      const last = study.resolutions[study.resolutions.length - 1];
      return {
        case: c.label,
        errAt8: study.resolutions[0].maxRelativeError,
        errAt512: last.maxRelativeError,
        observedOrder: study.checks[1] ? study.checks[1].measured : NaN,
        passed: study.passed
      };
    });

    console.info("[GEO417E] Stage 3.2 equal-areas validation suite " +
      "(analytic Kepler geometry only - the rendered planet stays " +
      "Verlet-integrated):");
    console.table(rows);
    console.info("[GEO417E] convergence studies (max rel. sector-area " +
      "error vs samples per sector):");
    console.table(convergence);
    const passed = rows.every(function (r) { return r.passed; }) &&
      convergence.every(function (c) { return c.passed; });
    console.info((passed ? "[PASS] " : "[FAIL] ") +
      "All Stage 3.2 cases within tolerances (sector area <= " +
      VALIDATION.areaTolerance + " rel at n = " + DEFmLT_SAMPLES +
      ", durations <= " + VALIDATION.durationTolerance +
      " rel, areal velocity <= " + VALIDATION.arealVelocityTolerance +
      " rel, convergence order ~2).");
    return { passed: passed, cases: rows, convergence: convergence };
  }

  /* ================================================================
   * Public API
   * ================================================================ */
  return {
    SECTOR_COUNT: SECTOR_COUNT,
    VALIDATION: VALIDATION,
    semiMinorAxis: semiMinorAxis,
    ellipseArea: ellipseArea,
    theoreticalSectorArea: theoreticalSectorArea,
    specificAngularMomentum: specificAngularMomentum,
    theoreticalArealVelocity: theoreticalArealVelocity,
    orbitalPeriod: orbitalPeriod,
    computeSectors: computeSectors,
    getSectors: getSectors,
    runValidation: runValidation,
    runConvergenceStudy: runConvergenceStudy,
    runValidationSuite: runValidationSuite
  };
})();
