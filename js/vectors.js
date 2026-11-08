/*
 * GEO417E Planetary Orbit Simulator
 * vectors.js - numerical velocity and acceleration vector utilities.
 * Vectors are read from the live Velocity-Verlet state only.
 */
"use strict";

const OrbitVectors = (() => {
  const EPS = 1e-12;

  function fromSimulation(sim) {
    if (!sim || !sim.position || !sim.velocity || !sim.acceleration) return null;
    const r = sim.position, v = sim.velocity, a = sim.acceleration;
    const radius = Math.hypot(r.x, r.y);
    const speed = Math.hypot(v.x, v.y);
    const acceleration = Math.hypot(a.x, a.y);
    if (!(radius > 0) || ![r.x,r.y,v.x,v.y,a.x,a.y].every(Number.isFinite)) return null;
    const crossRV = r.x * v.y - r.y * v.x;
    return {
      position: {x:r.x,y:r.y},
      velocity: {x:v.x,y:v.y,magnitude:speed,angle:Math.atan2(v.y,v.x)},
      acceleration: {x:a.x,y:a.y,magnitude:acceleration,angle:Math.atan2(a.y,a.x)},
      radius,
      angularMomentumZ: crossRV
    };
  }

  function validateState(sim, tolerance) {
    const data = fromSimulation(sim);
    if (!data) return {passed:false, reason:"Invalid simulation state"};
    const r=data.position, a=data.acceleration;
    const inward = r.x*a.x + r.y*a.y < 0;
    const expected = -OrbitConfig.physics.mu/(data.radius*data.radius*data.radius);
    const axError = Math.hypot(a.x-expected*r.x,a.y-expected*r.y);
    const scale = Math.max(data.acceleration.magnitude, EPS);
    const tangencyLimit = tolerance === undefined ? 0.02 : tolerance;
    const probe = OrbitPhysics.createSimulation({a:sim.a,e:sim.e,stepsPerOrbit:sim.stepsPerOrbit});
    if (probe && sim.stepCount > 0) probe.step(sim.stepCount);
    const before = probe ? probe.position : sim.position;
    if (probe) probe.step(1);
    const dx = probe.position.x-before.x, dy = probe.position.y-before.y;
    const dot = dx*sim.velocity.x + dy*sim.velocity.y;
    const denom = Math.hypot(dx,dy)*data.velocity.magnitude;
    const trajectoryAlignment = denom > 0 ? dot/denom : 1;
    const tangentError = 1-trajectoryAlignment;
    return {
      passed: tangentError <= tangencyLimit && inward && axError/scale < 1e-10,
      trajectoryTangentError: tangentError,
      inwardAcceleration: inward,
      accelerationModelRelativeError: axError/scale,
      velocityMagnitude: data.velocity.magnitude,
      accelerationMagnitude: data.acceleration.magnitude
    };
  }

  function runValidationSuite() {
    const cases = [
      {name:"circular perihelion",a:OrbitConfig.physics.astronomicalUnit,e:0,steps:0},
      {name:"default perihelion",a:OrbitConfig.physics.astronomicalUnit,e:0.2,steps:0},
      {name:"high-e perihelion",a:OrbitConfig.physics.astronomicalUnit,e:0.95,steps:0},
      {name:"circular advanced",a:OrbitConfig.physics.astronomicalUnit,e:0,steps:127},
      {name:"default advanced",a:OrbitConfig.physics.astronomicalUnit,e:0.2,steps:127},
      {name:"high-e advanced",a:OrbitConfig.physics.astronomicalUnit,e:0.95,steps:127},
      {name:"high-e aphelion vicinity",a:OrbitConfig.physics.astronomicalUnit,e:0.95,steps:null}
    ];
    const results = cases.map(c => {
      const sim=OrbitPhysics.createSimulation({a:c.a,e:c.e});
      if (c.steps === null) sim.step(Math.floor(sim.stepsPerOrbit/2));
      else if (c.steps) sim.step(c.steps);
      const measured=validateState(sim, 0.05);
      return {name:c.name,...measured};
    });
    const passed=results.every(x=>x.passed);
    const report={suite:"OrbitVectors",passed,total:results.length,passedCount:results.filter(x=>x.passed).length,failedCount:results.filter(x=>!x.passed).length,results};
    console.group("[OrbitVectors] Validation");
    console.table(results);
    console.info(report);
    console.groupEnd();
    return report;
  }

  return {fromSimulation,validateState,runValidationSuite};
})();
