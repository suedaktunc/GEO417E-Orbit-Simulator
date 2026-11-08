/*
 * GEO417E Planetary Orbit Simulator
 * ui.js - wires the DOM controls to OrbitState and refreshes the
 * readout panel and canvas overlay badges.
 *
 * Loaded after physics.js. Declares the global `OrbitUI` object.
 *
 * Stage 2 refresh architecture (two separate concerns):
 * - refreshControls(): Play/Pause + Reset button state, slider badges
 *   and the static readout rows (status, e, a, time scale, period).
 *   Called from control event handlers only.
 * - refreshTelemetry(): the LIVE rows (elapsed time t, radius r, true
 *   anomaly nu, speed v) plus the canvas overlay badges (t, FPS).
 *   Called by control handlers for immediate feedback and by the
 *   OrbitAnimation loop, which throttles it to ~6.7 Hz (5-10 Hz
 *   target); the animation loop passes the measured FPS along.
 *
 * Stage 3.2 adds one event-driven refresh (never per frame):
 * - refreshAreasPanel(): the equal-areas summary + 12-row sector
 *   table (Kepler's 2nd law), recomputed when a or e change. The
 *   sector data is analytic (OrbitAreas/OrbitKepler), independent of
 *   the Verlet state, so it needs no live updates.
 *
 * Elapsed time is read from OrbitState.simulation.time - the single
 * source of truth - never from a UI-side clock.
 */
"use strict";

const OrbitUI = (() => {
  const PLAY_ICON = "\u25B6";  /* play triangle */
  const PAUSE_ICON = "\u23F8"; /* pause bars */
  const RESET_ICON = "\u21BB"; /* anticlockwise arrow */

  let els = null;

  /**
   * Collect DOM references, apply configured slider ranges and bind events.
   */
  function init() {
    els = {
      playPauseButton: document.getElementById("play-pause-button"),
      playPauseIcon: document.querySelector("#play-pause-button .btn-icon"),
      playPauseLabel: document.querySelector("#play-pause-button .btn-label"),
      resetButton: document.getElementById("reset-button"),
      resetIcon: document.querySelector("#reset-button .btn-icon"),
      speedSlider: document.getElementById("speed-slider"),
      speedBadge: document.getElementById("speed-value"),
      eccentricitySlider: document.getElementById("eccentricity-slider"),
      eccentricityBadge: document.getElementById("eccentricity-value"),
      semiMajorAxisSlider: document.getElementById("semi-major-axis-slider"),
      semiMajorAxisBadge: document.getElementById("semi-major-axis-value"),
      overlayElapsed: document.getElementById("overlay-elapsed"),
      overlayFps: document.getElementById("overlay-fps"),
      areasCheckbox: document.getElementById("areas-visibility-checkbox"),
      areasTableBody: document.getElementById("areas-table-body"),
      areasTheoreticalSector: document.getElementById("areas-theoretical-sector"),
      areasArealVelocity: document.getElementById("areas-areal-velocity"),
      areasMeanArealVelocity: document.getElementById("areas-mean-areal-velocity"),
      areasMaxError: document.getElementById("areas-max-error"),
      areasSamplingNote: document.getElementById("areas-sampling-note"),
      velocityVectorCheckbox: document.getElementById("velocity-vector-checkbox"),
      accelerationVectorCheckbox: document.getElementById("acceleration-vector-checkbox"),
      vectorSpeed: document.getElementById("vector-speed"),
      vectorVelocityComponents: document.getElementById("vector-velocity-components"),
      vectorAcceleration: document.getElementById("vector-acceleration"),
      vectorAccelerationComponents: document.getElementById("vector-acceleration-components"),
      readout: {
        status: document.getElementById("readout-status"),
        eccentricity: document.getElementById("readout-eccentricity"),
        semiMajorAxis: document.getElementById("readout-semi-major-axis"),
        timeScale: document.getElementById("readout-time-scale"),
        elapsed: document.getElementById("readout-elapsed"),
        period: document.getElementById("readout-period"),
        radius: document.getElementById("readout-radius"),
        trueAnomaly: document.getElementById("readout-true-anomaly"),
        speed: document.getElementById("readout-speed")
      }
    };

    if (!allElementsPresent()) {
      console.error("[GEO417E] UI initialisation aborted: missing DOM elements.");
      return;
    }

    /* Apply the configured ranges (single source of truth: config.js). */
    applyRange(els.speedSlider, OrbitConfig.ranges.timeScale);
    applyRange(els.eccentricitySlider, OrbitConfig.ranges.eccentricity);
    applyRange(els.semiMajorAxisSlider, { min: 0.5, max: 2, step: 0.1 });

    els.playPauseButton.addEventListener("click", onPlayPauseClick);
    els.resetButton.addEventListener("click", onResetClick);
    els.speedSlider.addEventListener("input", onSpeedInput);
    els.eccentricitySlider.addEventListener("input", onEccentricityInput);
    els.semiMajorAxisSlider.addEventListener("input", onSemiMajorAxisInput);
    els.areasCheckbox.addEventListener("change", onAreasVisibilityChange);
    els.velocityVectorCheckbox.addEventListener("change", () => {
      OrbitState.showVelocityVector = els.velocityVectorCheckbox.checked;
    });
    els.accelerationVectorCheckbox.addEventListener("change", () => {
      OrbitState.showAccelerationVector = els.accelerationVectorCheckbox.checked;
    });

    /* Build the physics simulation for the default parameters (must
     * happen before the first refresh so the readout has data). */
    OrbitState.rebuildSimulation();

    refreshControls();
    refreshTelemetry();
    refreshAreasPanel();
  }

  /**
   * Verify that every element we expect exists in the document.
   * @returns {boolean}
   */
  function allElementsPresent() {
    const references = [
      els.playPauseButton,
      els.playPauseIcon,
      els.playPauseLabel,
      els.resetButton,
      els.resetIcon,
      els.speedSlider,
      els.speedBadge,
      els.eccentricitySlider,
      els.eccentricityBadge,
      els.semiMajorAxisSlider,
      els.semiMajorAxisBadge,
      els.overlayElapsed,
      els.overlayFps,
      els.areasCheckbox,
      els.areasTableBody,
      els.areasTheoreticalSector,
      els.areasArealVelocity,
      els.areasMeanArealVelocity,
      els.areasMaxError,
      els.areasSamplingNote,
      els.velocityVectorCheckbox,
      els.accelerationVectorCheckbox,
      els.vectorSpeed,
      els.vectorVelocityComponents,
      els.vectorAcceleration,
      els.vectorAccelerationComponents,
      els.readout.status,
      els.readout.eccentricity,
      els.readout.semiMajorAxis,
      els.readout.timeScale,
      els.readout.elapsed,
      els.readout.period,
      els.readout.radius,
      els.readout.trueAnomaly,
      els.readout.speed
    ];
    return references.every((el) => el !== null && el !== undefined);
  }

  /**
   * Copy a configured range onto a slider input element.
   * @param {HTMLInputElement} slider
   * @param {{min: number, max: number, step: number}} range
   */
  function applyRange(slider, range) {
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = String(range.step);
  }

  /* ---------- Event handlers ---------- */

  function onPlayPauseClick() {
    OrbitState.playing = !OrbitState.playing;
    /* The animation loop keeps running and simply starts/finishes
     * stepping the physics; the sub-step accumulator survives. */
    refreshControls();
    refreshTelemetry();
  }

  function onResetClick() {
    /* Back to the perihelion initial state (t = 0) with the current
     * parameters; playback state is deliberately left unchanged. */
    OrbitState.resetSimulation();
    if (typeof OrbitAnimation !== "undefined" && OrbitAnimation) {
      OrbitAnimation.reset(); /* drop the sub-step accumulator */
    }
    refreshControls();
    refreshTelemetry();
  }

  function onSpeedInput(event) {
    OrbitState.apply("timeScale", event.target.value);
    /* The multiplier is read by the animation loop each frame. */
    refreshControls();
  }

  function onEccentricityInput(event) {
    OrbitState.apply("eccentricity", event.target.value);
    /* New ellipse: rebuild the orbit, restarting at perihelion (t = 0).
     * The animation loop detects the new simulation object and clears
     * its accumulator; the canvas re-fits on the next frame. */
    OrbitState.rebuildSimulation();
    refreshControls();
    refreshTelemetry();
    refreshAreasPanel();
  }

  function onSemiMajorAxisInput(event) {
    OrbitState.apply("semiMajorAxis", Number(event.target.value) * OrbitConfig.physics.astronomicalUnit);
    /* New ellipse (different period and apsides): rebuild at perihelion. */
    OrbitState.rebuildSimulation();
    refreshControls();
    refreshTelemetry();
    refreshAreasPanel();
  }

  /**
   * Toggle the Stage 3.2 equal-area sector overlay. Only the flag is
   * written here: the canvas overlay and the panel data react to it
   * (the rAF loop re-renders every frame, paused or not, so the
   * change appears immediately).
   * @param {Event} event checkbox change event
   */
  function onAreasVisibilityChange(event) {
    OrbitState.showAreaSectors = event.target.checked;
  }

  /* ---------- Rendering ---------- */

  /**
   * Write a value into a readout cell, toggling the "pending" style
   * (dimmed dash) used whenever no value is available.
   * @param {HTMLElement} el
   * @param {string} text
   * @param {boolean} [pending]
   */
  function setReadout(el, text, pending) {
    el.textContent = text;
    el.classList.toggle("pending", Boolean(pending));
  }

  /**
   * Push control-owned state into the buttons, slider badges and the
   * static readout rows. Event-driven; not called per frame.
   */
  function refreshControls() {
    if (!els) {
      return; /* not initialised (e.g. headless test environment) */
    }

    /* Play / pause + reset buttons */
    els.playPauseButton.setAttribute("aria-pressed", String(OrbitState.playing));
    els.playPauseIcon.textContent = OrbitState.playing ? PAUSE_ICON : PLAY_ICON;
    els.playPauseLabel.textContent = OrbitState.playing ? "Pause" : "Play";
    els.resetIcon.textContent = RESET_ICON;

    /* Slider badges */
    els.speedBadge.textContent = OrbitState.timeScale.toFixed(1) + "\u00D7";
    els.eccentricityBadge.textContent = OrbitState.eccentricity.toFixed(2);
    els.semiMajorAxisBadge.textContent = (OrbitState.semiMajorAxis / OrbitConfig.physics.astronomicalUnit).toFixed(1) + " AU";

    /* Static readout rows */
    els.readout.status.textContent = OrbitState.playing ? "Running" : "Paused";
    els.readout.eccentricity.textContent = OrbitState.eccentricity.toFixed(2);
    els.readout.semiMajorAxis.textContent = (OrbitState.semiMajorAxis / OrbitConfig.physics.astronomicalUnit).toFixed(1) + " AU";
    els.readout.timeScale.textContent = OrbitState.timeScale.toFixed(1) + "\u00D7";

    /* Period only depends on a (E4), so it belongs to the control rows. */
    const sim = OrbitState.simulation;
    if (sim) {
      setReadout(els.readout.period, (sim.period / OrbitConfig.physics.day).toFixed(2) + " days");
    } else {
      setReadout(els.readout.period, "\u2014", true);
    }
  }

  /**
   * Push the LIVE physics state into the telemetry rows and overlay
   * badges. Called immediately by control handlers and ~6.7 Hz by the
   * animation loop (which owns the throttle and passes the FPS).
   * @param {object} [telemetry] { fps?: number } - measured render FPS;
   *   when absent the FPS badge is left untouched.
   */
  function refreshTelemetry(telemetry) {
    if (!els) {
      return; /* not initialised (e.g. headless test environment) */
    }

    const sim = OrbitState.simulation;
    if (sim) {
      const d = sim.derived();
      /* Elapsed time: simulation.time is the single time authority. */
      setReadout(els.readout.elapsed, sim.time.toFixed(1) + " s");
      setReadout(els.readout.radius, d.radius.toExponential(4) + " m");       /* |r| */
      /* True anomaly: polar angle of the integrated position,
       * normalised to [0, 360) - perihelion = 0 deg. */
      const nuDeg = OrbitPhysics.trueAnomalyDegrees(sim.position);
      setReadout(els.readout.trueAnomaly, nuDeg.toFixed(1) + "\u00B0");
      setReadout(els.readout.speed, d.speed.toFixed(1) + " m/s");      /* |v| */
      els.overlayElapsed.textContent = "t = " + sim.time.toFixed(1) + " s";
    } else {
      setReadout(els.readout.elapsed, "\u2014", true);
      setReadout(els.readout.radius, "\u2014", true);
      setReadout(els.readout.trueAnomaly, "\u2014", true);
      setReadout(els.readout.speed, "\u2014", true);
      els.overlayElapsed.textContent = "t = \u2014";
    }

    if (telemetry && typeof telemetry.fps === "number" && telemetry.fps > 0) {
      els.overlayFps.textContent = Math.round(telemetry.fps) + " FPS";
    }
    refreshVectorsPanel();
  }

  function refreshVectorsPanel() {
    if (!els || !OrbitState.simulation || typeof OrbitVectors === "undefined") return;
    const v = OrbitVectors.fromSimulation(OrbitState.simulation);
    if (!v) return;
    els.vectorSpeed.textContent = v.velocity.magnitude.toFixed(1) + " m/s";
    els.vectorVelocityComponents.textContent = "(" + v.velocity.x.toFixed(5) + ", " + v.velocity.y.toFixed(5) + ")";
    els.vectorAcceleration.textContent = v.acceleration.magnitude.toExponential(3) + " m/s²";
    els.vectorAccelerationComponents.textContent = "(" + v.acceleration.x.toExponential(3) + ", " + v.acceleration.y.toExponential(3) + ")";
  }

  /**
   * Refresh the Stage 3.2 equal-areas panel (Kepler's 2nd law): the
   * summary values and the 12-row sector table. Data comes from the
   * memoised OrbitAreas.getSectors() for the CURRENT a and e, so a
   * slider drag recomputes at most once per distinct parameter pair.
   * Event-driven (init + a/e slider input), never called per frame.
   */
  function refreshAreasPanel() {
    if (!els) {
      return; /* not initialised (e.g. headless test environment) */
    }

    const sim = OrbitState.simulation;
    if (!sim || typeof OrbitAreas === "undefined" || !OrbitAreas) {
      setReadout(els.areasTheoreticalSector, "\u2014", true);
      setReadout(els.areasArealVelocity, "\u2014", true);
      setReadout(els.areasMeanArealVelocity, "\u2014", true);
      setReadout(els.areasMaxError, "\u2014", true);
      els.areasTableBody.textContent = "";
      els.areasSamplingNote.textContent = "";
      return;
    }

    const data = OrbitAreas.getSectors(sim.a, sim.e);
    if (!data) {
      setReadout(els.areasTheoreticalSector, "\u2014", true);
      setReadout(els.areasArealVelocity, "\u2014", true);
      setReadout(els.areasMeanArealVelocity, "\u2014", true);
      setReadout(els.areasMaxError, "\u2014", true);
      els.areasTableBody.textContent = "";
      els.areasSamplingNote.textContent = "";
      return;
    }

    /* Summary: theoretical values vs measured aggregates. */
    setReadout(els.areasTheoreticalSector,
      data.theoreticalSectorArea.toFixed(5) + " m\u00B2");
    setReadout(els.areasArealVelocity,
      data.theoreticalArealVelocity.toFixed(5) + " m\u00B2/s");
    setReadout(els.areasMeanArealVelocity,
      data.summary.meanArealVelocity.toFixed(5) + " m\u00B2/s");
    setReadout(els.areasMaxError,
      data.summary.maxRelativeError.toExponential(2));

    /* Sector table: number, time interval, measured area, theoretical
     * area, relative error (all MEASURED - no assumed equality). */
    els.areasTableBody.textContent = "";
    for (let k = 0; k < data.sectors.length; k += 1) {
      const sector = data.sectors[k];
      const row = document.createElement("tr");

      const indexCell = document.createElement("td");
      indexCell.textContent = String(sector.index);
      row.appendChild(indexCell);

      const intervalCell = document.createElement("td");
      intervalCell.textContent = sector.tStart.toFixed(3) + "\u2013" +
        sector.tEnd.toFixed(3);
      row.appendChild(intervalCell);

      const measuredCell = document.createElement("td");
      measuredCell.textContent = sector.measuredArea.toFixed(5);
      row.appendChild(measuredCell);

      const theoreticalCell = document.createElement("td");
      theoreticalCell.textContent = sector.theoreticalArea.toFixed(5);
      row.appendChild(theoreticalCell);

      const errorCell = document.createElement("td");
      errorCell.textContent = sector.relativeError.toExponential(2);
      row.appendChild(errorCell);

      els.areasTableBody.appendChild(row);
    }

    els.areasSamplingNote.textContent =
      "Sampling: " + data.samplesPerSector +
      " analytic positions per sector (triangular-fan quadrature, " +
      "O(n^-2)); b = " + (data.semiMinorAxis / OrbitConfig.physics.astronomicalUnit).toFixed(4) +
      " AU; T = " + (data.period / OrbitConfig.physics.day).toFixed(3) + " days.";
  }

  /* Public API */
  return {
    init,
    refreshControls,
    refreshTelemetry,
    refreshAreasPanel,
    refreshVectorsPanel
  };
})();
