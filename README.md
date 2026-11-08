# GEO417E Planetary Orbit Simulator — SI Edition

A browser-based 2D planetary orbit simulator for GEO417E. It includes a Newtonian two-body model, Velocity-Verlet integration, animated canvas rendering, Kepler anomaly calculations, equal-area sectors and velocity/acceleration vectors.

## Run
1. Extract the ZIP archive.
2. Open `index.html` in a modern browser.
3. Press **Play**. No build tools, packages, server or internet connection are required.

## SI unit convention
All simulation calculations and stored state use SI units: position and semi-major axis in metres (m), time in seconds (s), velocity in m/s, acceleration in m/s², area in m², specific angular momentum and areal velocity in m²/s, specific orbital energy in m²/s², and gravitational parameter in m³/s².

Constants used: 
- Gravitational constant: `G = 6.67430e-11 m^3 kg^-1 s^-2`
- Solar mass: `M_sun = 1.98847e30 kg`
- Solar gravitational parameter: `mu = G * M_sun`
- Astronomical unit: `1 AU = 149597870700 m`
- Julian year: `1 yr = 31557600 s`
- Day: `86400 s`

The semi-major-axis slider remains displayed in AU for convenience. Its value is converted to metres before being stored in `OrbitState` or passed to the physics engine. The simulation clock and animation accumulator use seconds. The UI reports elapsed time in seconds, orbital period in days, radius in metres and speed in m/s.

## Physical model
The Sun is fixed at the origin and the planet starts at perihelion on the positive x-axis, moving counter-clockwise. Eccentricity is dimensionless. The supported semi-major-axis range is 0.5–2 AU and eccentricity range is 0–0.95.

\[\mathbf a(\mathbf r)=-\frac{\mu}{r^3}\mathbf r,\qquad r=\|\mathbf r\|\]

\[T=2\pi\sqrt{\frac{a^3}{\mu}},\qquad h=\sqrt{\mu a(1-e^2)}\]

\[\mathbf r_0=(a(1-e),0),\qquad \mathbf v_0=\left(0,\sqrt{\frac{\mu(1+e)}{a(1-e)}}\right)\]

The displayed planet position is always produced by the numerical Velocity-Verlet integrator. Analytical Kepler positions are used for reference geometry and equal-area calculations only.

## Project structure
- `index.html` — application structure and script loading
- `css/style.css` — visual styling
- `js/config.js` — constants, SI unit definitions and configuration
- `js/state.js` — simulation state
- `js/physics.js` — Newtonian model and Velocity-Verlet integrator
- `js/kepler.js` — Kepler equation and anomaly conversions
- `js/areas.js` — equal-time swept-area analysis
- `js/vectors.js` — velocity and acceleration vector checks
- `js/canvas.js` — canvas rendering and coordinate transform
- `js/ui.js` — controls and telemetry
- `js/animation.js` — fixed-step animation loop using SI seconds
- `js/main.js` — application startup

## Validation
The in-browser console exposes validation suites: `OrbitPhysics.runValidationSuite()`, `OrbitKepler.runValidationSuite()`, `OrbitAreas.runValidationSuite()` and `OrbitVectors.runValidationSuite()`. Their tolerances are documented in the corresponding source modules. Results should be interpreted as numerical checks for the tested parameter cases, not as proof of cross-browser visual equivalence.
