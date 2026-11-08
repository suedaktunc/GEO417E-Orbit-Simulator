/*
 * GEO417E Planetary Orbit Simulator
 * state.js - central mutable state store shared by the UI, canvas,
 * animation and physics modules.
 *
 * Loaded after config.js. Declares the global `OrbitState` object.
 * Also owns the OrbitPhysics simulation instance (built via
 * rebuildSimulation() once physics.js has loaded).
 *
 * Stage 2 note on time: OrbitState.simulation.time (advanced by the
 * OrbitAnimation loop) is the SINGLE source of truth for elapsed
 * simulation time - no duplicate clock is kept here.
 */
"use strict";

const OrbitState = {
  /* Playback (toggled by the Play/Pause button, honoured by OrbitAnimation) */
  playing: false,

  /* Orbital parameters, bound to the sidebar sliders */
  eccentricity: OrbitConfig.defaults.eccentricity,   // e
  semiMajorAxis: OrbitConfig.defaults.semiMajorAxis, // a (m)
  timeScale: OrbitConfig.defaults.timeScale,         // speed multiplier

  /*
   * Stage 3.2: equal-area sector overlay visibility (Kepler's 2nd
   * law). Toggled by the checkbox in the areas panel; read by
   * OrbitCanvas.render() every frame. The overlay geometry comes
   * from the analytic OrbitKepler solver via OrbitAreas - it is a
   * diagnostic layer and never moves the displayed planet.
   */
  showAreaSectors: false,
  showVelocityVector: true,
  showAccelerationVector: true,

  /*
   * Stage 1 physics core: the OrbitPhysics simulation object for the
   * current a and e. Built lazily because state.js loads before
   * physics.js; OrbitUI.init() creates it once the DOM is ready and
   * rebuildSimulation() refreshes it whenever a or e change (each
   * parameter change restarts the orbit at perihelion, t = 0).
   */
  simulation: null,

  /**
   * Set a numeric parameter, clamped to its configured range.
   * @param {string} key   property name matching an entry in OrbitConfig.ranges
   * @param {number} value raw value from a control
   * @returns {number} the value actually stored
   */
  apply(key, value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return this[key];
    }
    const range = OrbitConfig.ranges[key];
    if (range) {
      this[key] = Math.min(range.max, Math.max(range.min, num));
    } else {
      this[key] = value;
    }
    return this[key];
  },

  /**
   * (Re)create the physics simulation for the current semi-major axis
   * and eccentricity, restarting at perihelion with t = 0.
   * Must only be called once physics.js has loaded (it is - the UI
   * initialises after all scripts are evaluated).
   * @returns {object|null} the new OrbitPhysics simulation, or null if
   *   the parameters failed validation (cannot happen for values that
   *   passed through apply(), which clamps to the same ranges)
   */
  rebuildSimulation() {
    if (typeof OrbitPhysics === "undefined") {
      return null; /* physics.js not loaded yet - nothing to rebuild */
    }
    this.simulation = OrbitPhysics.createSimulation({
      a: this.semiMajorAxis,
      e: this.eccentricity
    });
    return this.simulation;
  },

  /**
   * Reset the current simulation back to the perihelion initial state
   * (t = 0) without rebuilding it. The OrbitAnimation loop notices the
   * reset via simulation.time and drops its sub-step accumulator.
   * @returns {object|null} the current simulation, if any
   */
  resetSimulation() {
    if (this.simulation) {
      this.simulation.reset();
    }
    return this.simulation;
  }
};

/* Derived values (period, apsides, energy, ...) are NOT duplicated
 * here - read them from OrbitState.simulation.derived() so there is a
 * single source of truth in the physics core. Elapsed time likewise:
 * read OrbitState.simulation.time. */
