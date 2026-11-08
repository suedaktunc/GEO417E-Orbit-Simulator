/*
 * GEO417E Planetary Orbit Simulator
 * animation.js - Stage 2 animation loop: requestAnimationFrame driver
 * with a fixed-step accumulator over the physics core's velocity-Verlet
 * step dt.
 *
 * Loaded after ui.js (it calls OrbitUI.refreshTelemetry) and before
 * main.js. Declares the global `OrbitAnimation` object.
 *
 * TIMING MODEL
 * ------------
 * Base rate: 1 Julian year of simulation per 10 s of real time
 * (OrbitConfig.animation.secondsPerRealSecond = 0.1), multiplied by the
 * speed slider's factor OrbitState.timeScale (0.1x .. 5x). At the
 * default 1x, a 1 AU orbit (T = 1 yr) therefore takes 10 real seconds.
 *
 * FIXED-STEP ACCUMULATOR
 * ----------------------
 * Real time is converted to simulation time and accumulated; whole
 * integration steps are extracted with Math.floor(accumulator / dt)
 * and executed as ONE batched simulation.step(n) call. The remaining
 * fraction (< dt) stays in the accumulator for the next frame, so the
 * physics always advances in exact multiples of dt - the integrator
 * never sees a stretched or variable step.
 *
 * PAUSE / RESUME
 * --------------
 * The rAF loop keeps running while paused (rendering stays live for
 * slider changes and resizes at negligible cost); only the physics
 * stepping is gated on OrbitState.playing. Because the frame timestamp
 * is refreshed every frame - paused or not - resuming adds at most one
 * normal frame delta, and the sub-step accumulator is preserved
 * untouched across the pause (no time is silently gained or lost).
 *
 * CATCH-UP PROTECTION
 * -------------------
 * The real frame delta is clamped to OrbitConfig.animation.
 * maxFrameDeltaSec (100 ms). After a slow frame or a background-tab
 * suspension the simulation simply falls behind real time instead of
 * trying to integrate an unbounded backlog (which would cause longer
 * frames, more backlog, ... - the classic catch-up spiral). The clamp
 * bounds the worst-case batch to maxFrameDeltaSec * secondsPerRealSecond
 * * maxTimeScale / dt_min ~ 36k steps, which integrates in ~1 ms.
 *
 * TIME AUTHORITY
 * --------------
 * OrbitState.simulation.time is the single source of truth for elapsed
 * simulation time. This module stores no elapsed-time value of its
 * own; the accumulator only ever holds the sub-dt remainder.
 *
 * REBUILD DETECTION
 * -----------------
 * Whenever a or e change, OrbitState.rebuildSimulation() replaces the
 * simulation object (new dt, restart at perihelion). The loop watches
 * the object identity each frame and drops the stale-dt accumulator
 * remainder the moment a new simulation appears.
 */
"use strict";

const OrbitAnimation = (() => {
  let loopRunning = false;
  let rafId = null;
  let lastFrameTimestamp = null;  /* ms; null => re-anchor (no delta) */
  let accumulator = 0;            /* leftover simulation time [s], < dt */
  let trackedSim = null;          /* identity watch for rebuilds */

  let lastTelemetryAt = 0;        /* ms timestamp of last telemetry push */
  let fpsWindowStart = 0;         /* ms timestamp opening the FPS window */
  let fpsFrameCount = 0;          /* frames inside the FPS window */

  /* ---------- Loop lifecycle ---------- */

  /**
   * Start the loop. Called once from main.js after the UI and canvas
   * are up. The loop then runs for the lifetime of the page.
   */
  function init() {
    trackedSim = OrbitState.simulation;
    accumulator = 0;
    start();
  }

  /** Start (or restart) requesting animation frames. */
  function start() {
    if (loopRunning) {
      return;
    }
    loopRunning = true;
    lastFrameTimestamp = null; /* re-anchor: first frame has delta 0 */
    rafId = window.requestAnimationFrame(frame);
  }

  /** Stop the loop and cancel the pending frame request. */
  function stop() {
    loopRunning = false;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    /* lastFrameTimestamp/accumulator are deliberately kept so a later
     * start() could resume without losing the sub-step remainder. */
  }

  /**
   * Manual reset (Reset button / OrbitState.resetSimulation()):
   * drop the sub-step accumulator so the restarted orbit (t = 0) does
   * not inherit a stale fraction of a step.
   */
  function reset() {
    accumulator = 0;
  }

  /* ---------- The frame callback ---------- */

  /**
   * One animation frame.
   * @param {number} timestamp rAF timestamp [ms] (time origin = page load)
   */
  function frame(timestamp) {
    if (!loopRunning) {
      return;
    }
    rafId = window.requestAnimationFrame(frame);

    /* --- real-time delta, clamped against catch-up spirals --- */
    let deltaSec = 0;
    if (lastFrameTimestamp !== null) {
      deltaSec = (timestamp - lastFrameTimestamp) / 1000;
      if (!(deltaSec > 0)) {
        deltaSec = 0; /* equal timestamps or clock weirdness */
      } else if (deltaSec > OrbitConfig.animation.maxFrameDeltaSec) {
        deltaSec = OrbitConfig.animation.maxFrameDeltaSec;
      }
    }
    lastFrameTimestamp = timestamp;

    /* --- parameter changes swap the simulation object: drop the
     *     accumulator remainder computed against the previous dt --- */
    if (OrbitState.simulation !== trackedSim) {
      trackedSim = OrbitState.simulation;
      accumulator = 0;
    }

    /* --- fixed-step physics advancement --- */
    const sim = trackedSim;
    if (sim && OrbitState.playing) {
      accumulator += deltaSec * OrbitConfig.animation.secondsPerRealSecond *
        OrbitState.timeScale;
      const steps = Math.floor(accumulator / sim.dt);
      if (steps > 0) {
        sim.step(steps); /* one batched call of n velocity-Verlet steps */
        accumulator -= steps * sim.dt;
      }
    }

    /* --- render the current scene (also while paused, so parameter
     *     changes and resizes show up immediately) --- */
    if (sim) {
      OrbitCanvas.render({
        a: sim.a,
        e: sim.e,
        position: sim.position,
        velocity: sim.velocity,
        acceleration: sim.acceleration
      });
    }

    /* --- throttled telemetry (~6.7 Hz) with measured FPS --- */
    fpsFrameCount += 1;
    if (fpsWindowStart === 0) {
      fpsWindowStart = timestamp; /* first frame opens the window */
    }
    if (timestamp - lastTelemetryAt >= OrbitConfig.animation.telemetryIntervalMs) {
      const windowSec = (timestamp - fpsWindowStart) / 1000;
      if (windowSec > 0.05) { /* need a non-degenerate window */
        OrbitUI.refreshTelemetry({ fps: fpsFrameCount / windowSec });
      } else {
        OrbitUI.refreshTelemetry();
      }
      lastTelemetryAt = timestamp;
      fpsWindowStart = timestamp;
      fpsFrameCount = 0;
    }
  }

  /* Public API */
  return {
    init,
    start,
    stop,
    reset
  };
})();
