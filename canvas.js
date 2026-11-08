/*
 * GEO417E Planetary Orbit Simulator
 * canvas.js - canvas lifecycle and the Stage 2 orbit scene renderer.
 *
 * Loaded after state.js. Declares the global `OrbitCanvas` object.
 *
 * RESPONSIBILITIES
 * ----------------
 * - Sizing / high-DPI (devicePixelRatio) handling; all drawing is done
 *   in CSS pixels via ctx.setTransform(dpr, ...).
 * - Rendering one frame of the orbit scene:
 *     1. gradient background + faint decorative grid,
 *     1b. [Stage 3.2, toggleable] equal-area sector overlay (E7):
 *         12 alternating faint fills + boundary radii, geometry from
 *         the analytic OrbitKepler solver via OrbitAreas,
 *     2. the ANALYTIC reference ellipse (E1) with the Sun at one focus,
 *     3. the Sun (at the focus, physics origin),
 *     4. the planet dot at the Verlet-integrated position.
 *   The sector overlay is a diagnostic layer drawn from ANALYTIC
 *   positions; the planet dot itself never uses them.
 *
 * COORDINATE TRANSFORMATION (physics -> canvas)
 * ---------------------------------------------
 * Physics space: Sun fixed at the origin, perihelion on the +x axis,
 * +y UP (right-handed, counter-clockwise = prograde). Canvas space:
 * origin top-left, +y DOWN. The scene therefore INVERTS y:
 *
 *   X = originX + x * scale          (m -> CSS px)
 *   Y = originY - y * scale          (minus sign: flip y)
 *
 * A single `scale` is used for both axes (equal x/y scaling - the
 * ellipse is never stretched). The view is chosen so that the COMPLETE
 * analytic ellipse always fits inside the canvas with a padding margin,
 * while the Sun stays at the ellipse focus (never at the ellipse
 * centre unless e = 0):
 *
 *   b      = a*sqrt(1 - e^2)                     (semi-minor axis, E1)
 *   scale  = min((W/2 - pad)/a, (H/2 - pad)/b)    (fit, equal scale)
 *   origin = maps the ELLIPSE CENTRE (-a*e, 0) to the canvas centre
 *            (W/2, H/2), which puts the Sun at (W/2 + scale*a*e, H/2),
 *            exactly one focal distance c = a*e from the ellipse centre.
 *
 * The transform is recomputed from (a, e) on every render, so the view
 * automatically re-fits after any parameter change or canvas resize.
 *
 * NUMERICAL DEVIATION NOTE
 * ------------------------
 * The dashed ellipse is the exact analytic conic; the planet dot is the
 * velocity-Verlet-integrated position. They are expected to differ by
 * small amounts (measured perihelion-return error up to ~1.4e-3 m at
 * e = 0.95, ~1e-5 m at moderate e - see OrbitPhysics.runValidation),
 * typically below one pixel at scene scale. This is accepted Stage 2
 * behaviour, not a bug.
 */
"use strict";

const OrbitCanvas = (() => {
  let canvas = null;
  let ctx = null;
  let frame = null;

  /* Parameters of the most recent render, kept so a resize can redraw
   * the current scene without waiting for the next animation frame. */
  let lastScene = null;

  /**
   * Initialise the canvas module.
   * @param {HTMLCanvasElement} canvasEl
   */
  function init(canvasEl) {
    canvas = canvasEl;
    frame = canvas.parentElement;
    ctx = canvas.getContext("2d");

    if (!ctx) {
      console.error("[GEO417E] 2D canvas context is unavailable in this browser.");
      return;
    }

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(handleResize);
      observer.observe(frame);
    } else {
      window.addEventListener("resize", handleResize);
    }

    resize();

    /* First paint: if the physics core is already up (OrbitUI.init ran
     * before us), draw the initial perihelion scene; otherwise the
     * animation loop will paint as soon as it starts. */
    if (OrbitState.simulation) {
      render({
        a: OrbitState.simulation.a,
        e: OrbitState.simulation.e,
        position: OrbitState.simulation.position,
        velocity: OrbitState.simulation.velocity,
        acceleration: OrbitState.simulation.acceleration
      });
    }
  }

  function handleResize() {
    resize();
    if (lastScene) {
      render(lastScene);
    }
  }

  /**
   * Resize the drawing buffer to match the CSS box (handles devicePixelRatio).
   */
  function resize() {
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    if (width === 0 || height === 0) {
      return; /* layout not ready or panel hidden */
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); /* draw in CSS pixels from here on */
  }

  /* ================================================================
   * View computation (physics -> canvas transform)
   * ================================================================ */

  /**
   * Compute the view that fits the complete ellipse (a, e) into the
   * canvas with equal x/y scale and the Sun at the focus. See the
   * module header for the derivation.
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   * @param {number} width canvas CSS width [px]
   * @param {number} height canvas CSS height [px]
   * @returns {{scale: number, originX: number, originY: number, semiMinor: number}}
   *   scale [px/m] and the canvas position of the physics origin
   *   (the Sun): X = originX + x*scale, Y = originY - y*scale.
   */
  function computeView(a, e, width, height) {
    const semiMinor = a * Math.sqrt(1 - e * e);            /* b, E1 */
    const pad = OrbitConfig.canvas.fitPaddingPx;
    const halfW = Math.max(1, width / 2 - pad);
    const halfH = Math.max(1, height / 2 - pad);
    const scale = Math.min(halfW / a, halfH / semiMinor);

    /* Map the ellipse centre (-a*e, 0) to the canvas centre: the Sun
     * (physics origin) then lands one focal distance right of centre. */
    const originX = width / 2 + scale * a * e;
    const originY = height / 2;
    return { scale: scale, originX: originX, originY: originY, semiMinor: semiMinor };
  }

  /**
   * Physics coordinates (m, +y up) -> canvas coordinates (CSS px,
   * +y down). Y is inverted; x and y share the same scale.
   * @param {{scale: number, originX: number, originY: number}} view
   * @param {number} x physics x [m]
   * @param {number} y physics y [m]
   * @returns {{x: number, y: number}} canvas point [px]
   */
  function worldToScreen(view, x, y) {
    return {
      x: view.originX + x * view.scale,
      y: view.originY - y * view.scale
    };
  }

  /* ================================================================
   * Scene rendering
   * ================================================================ */

  /**
   * Render one frame of the orbit scene.
   * @param {object} scene
   *   a          semi-major axis [m]
   *   e          eccentricity [-]
   *   position   {x, y} Verlet-integrated planet position [m]
   */
  function render(scene) {
    if (!ctx || !scene) {
      return;
    }
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    lastScene = scene;

    drawBackground(width, height);

    const view = computeView(scene.a, scene.e, width, height);

    /* 1b. [Stage 3.2] Equal-area sector overlay (Kepler's 2nd law),
     *     toggleable via OrbitState.showAreaSectors. Restrained by
     *     design: two faint alternating fills + thin boundary radii.
     *     Geometry is ANALYTIC (OrbitKepler via OrbitAreas) and is a
     *     diagnostic overlay only - the planet position below never
     *     comes from it. */
    if (OrbitState.showAreaSectors && typeof OrbitAreas !== "undefined" &&
        OrbitAreas) {
      drawEqualAreaSectors(view, scene.a, scene.e);
    }

    /* 2. Analytic reference ellipse (E1) with the Sun at one focus:
     * canvas centre = ellipse centre (-a*e, 0), radii a and b. */
    ctx.save();
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = OrbitConfig.appearance.orbitPathColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(
      width / 2, height / 2,
      view.scale * scene.a, view.scale * view.semiMinor,
      0, 0, Math.PI * 2
    );
    ctx.stroke();
    ctx.restore();

    /* 3. Sun at the focus (physics origin). */
    drawStar(view.originX, view.originY, width, height);

    /* 4. Planet at the integrated position (sole position source:
     * the velocity-Verlet state, never the analytic ellipse). */
    const planet = worldToScreen(view, scene.position.x, scene.position.y);
    drawPlanet(planet.x, planet.y);

    /* Stage 3.3: vectors are transformed from the live numerical state. */
    if (scene.velocity && scene.acceleration && typeof OrbitVectors !== "undefined") {
      const vectors = OrbitVectors.fromSimulation({
        position: scene.position,
        velocity: scene.velocity,
        acceleration: scene.acceleration
      });
      if (vectors) drawStateVectors(view, planet, vectors);
    }
  }

  function drawStateVectors(view, planet, vectors) {
    const settings = OrbitConfig.vectors || {};
    const vLength = settings.velocityArrowPx || 58;
    const aLength = settings.accelerationArrowPx || 42;
    if (OrbitState.showVelocityVector !== false) {
      const factor = vLength / Math.max(vectors.velocity.magnitude, 1e-12);
      drawArrow(planet.x, planet.y,
        planet.x + vectors.velocity.x * factor,
        planet.y - vectors.velocity.y * factor,
        "#55d6ff", "v");
    }
    if (OrbitState.showAccelerationVector !== false) {
      const factor = aLength / Math.max(vectors.acceleration.magnitude, 1e-12);
      drawArrow(planet.x, planet.y,
        planet.x + vectors.acceleration.x * factor,
        planet.y - vectors.acceleration.y * factor,
        "#ffb454", "a");
    }
  }

  function drawArrow(x1, y1, x2, y2, color, label) {
    const dx=x2-x1, dy=y2-y1, length=Math.hypot(dx,dy);
    if (!(length > 3)) return;
    const angle=Math.atan2(dy,dx), head=Math.min(9,Math.max(5,length*0.22));
    ctx.save();
    ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2.2;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6));
    ctx.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6));
    ctx.closePath(); ctx.fill();
    ctx.font="600 12px system-ui, sans-serif";
    ctx.fillText(label,x2+7,y2-6);
    ctx.restore();
  }

  /* ================================================================
   * Stage 3.2: equal-area sector overlay (Kepler's 2nd law, E7)
   * ================================================================ */

  /**
   * Draw the 12 equal-area sectors of one orbital period: each sector
   * is the polygon Sun -> sampled analytic arc -> Sun, filled with an
   * alternating faint colour, plus one thin radius per sector
   * boundary (13 boundaries, first at perihelion, 7th at aphelion).
   *
   * The geometry comes from OrbitAreas.getSectors() (memoised, so the
   * per-frame cost is just the path building). For drawing, the arc is
   * strided down to at most ~32 points per sector - far below one
   * pixel of deviation at scene scale, so the measured areas shown in
   * the UI panel (full resolution) and the drawn shapes agree visually.
   * @param {{scale: number, originX: number, originY: number}} view
   * @param {number} a semi-major axis [m]
   * @param {number} e eccentricity [-]
   */
  function drawEqualAreaSectors(view, a, e) {
    const data = OrbitAreas.getSectors(a, e);
    if (!data || !data.allFinite) {
      return;
    }
    const appearance = OrbitConfig.appearance;
    const sun = worldToScreen(view, 0, 0);
    const stride = Math.max(1, Math.floor(data.samplesPerSector / 32));

    /* Fills: polygon Sun -> arc samples -> Sun, alternating alphas. */
    for (let k = 0; k < data.sectors.length; k += 1) {
      const sector = data.sectors[k];
      ctx.beginPath();
      ctx.moveTo(sun.x, sun.y);
      for (let i = 0; i <= data.samplesPerSector; i += stride) {
        const p = worldToScreen(view, sector.samplePositions[i].x,
          sector.samplePositions[i].y);
        ctx.lineTo(p.x, p.y);
      }
      /* Always include the exact sector end boundary. */
      const end = worldToScreen(view, sector.endPosition.x,
        sector.endPosition.y);
      ctx.lineTo(end.x, end.y);
      ctx.closePath();
      ctx.fillStyle = (k % 2 === 0) ? appearance.sectorFillColorA :
        appearance.sectorFillColorB;
      ctx.fill();
    }

    /* Boundary radii: one thin line from the Sun to each of the 12
     * sector start points (the 13th boundary coincides with the 1st
     * after a full period). */
    ctx.strokeStyle = appearance.sectorLineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < data.sectors.length; k += 1) {
      const start = worldToScreen(view, data.sectors[k].startPosition.x,
        data.sectors[k].startPosition.y);
      ctx.moveTo(sun.x, sun.y);
      ctx.lineTo(start.x, start.y);
    }
    ctx.stroke();
  }

  /** Gradient background + faint decorative grid (Stage 0 aesthetic). */
  function drawBackground(width, height) {
    const centerX = width / 2;
    const centerY = height / 2;

    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, OrbitConfig.appearance.backgroundTop);
    background.addColorStop(1, OrbitConfig.appearance.backgroundBottom);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = OrbitConfig.appearance.gridColor;
    ctx.lineWidth = 1;
    const gridStep = OrbitConfig.canvas.gridStepPx;
    ctx.beginPath();
    for (let x = centerX % gridStep; x < width; x += gridStep) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = centerY % gridStep; y < height; y += gridStep) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  /** Central star with glow, drawn at its canvas position. */
  function drawStar(x, y, width, height) {
    const starRadius = Math.max(6, Math.min(width, height) * 0.03);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, starRadius * 4);
    glow.addColorStop(0, OrbitConfig.appearance.starGlowColor);
    glow.addColorStop(1, "rgba(255, 190, 80, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, starRadius * 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = OrbitConfig.appearance.starColor;
    ctx.beginPath();
    ctx.arc(x, y, starRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Planet dot with a soft glow, at its canvas position. */
  function drawPlanet(x, y) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 14);
    glow.addColorStop(0, OrbitConfig.appearance.planetGlowColor);
    glow.addColorStop(1, "rgba(110, 231, 255, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = OrbitConfig.appearance.planetColor;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Public API (computeView / worldToScreen are exposed for console
   * testing of the coordinate transformation). */
  return {
    init,
    resize,
    render,
    computeView,
    worldToScreen
  };
})();
