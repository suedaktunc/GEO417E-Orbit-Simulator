/*
 * GEO417E Planetary Orbit Simulator
 * main.js - application entry point.
 *
 * Loaded last. Boots the app in dependency order: initialises the UI
 * (which builds the physics simulation for the default parameters),
 * sets up the canvas (first paint of the perihelion scene) and starts
 * the Stage 2 animation loop. The simulation starts PAUSED; press
 * Play (or call OrbitState.playing = true) to begin.
 */
"use strict";

(function startApp() {
  function boot() {
    OrbitUI.init();
    OrbitCanvas.init(document.getElementById("simulation-canvas"));
    OrbitAnimation.init();

    console.info("[GEO417E] Stage 3 orbit simulator initialised (paused). " +
      "Animation loop running via requestAnimationFrame; press Play to " +
      "start. Self-tests: OrbitPhysics.runValidationSuite(), " +
      "OrbitKepler.runValidationSuite() and OrbitAreas.runValidationSuite() and OrbitVectors.runValidationSuite() " +
      "in this console.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
