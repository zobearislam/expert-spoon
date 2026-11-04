
const FlightPhysics = (() => {
  const G0 = 9.80665;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function createState(ship, cargoMass = 0) {
    return {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0, roll: 0 },
      angularVelocity: { yaw: 0, pitch: 0, roll: 0 },
      cargoMass: Math.max(0, cargoMass),
      propellantRemaining: ship.propellantRemaining ?? ship.propellantCapacity ?? 0,
      condition: clamp(ship.condition ?? 100, 0, 100)
    };
  }

  function getForward(rotation) {
    const cy = Math.cos(rotation.yaw);
    const sy = Math.sin(rotation.yaw);
    const cp = Math.cos(rotation.pitch);
    const sp = Math.sin(rotation.pitch);

    return {
      x: sy * cp,
      y: sp,
      z: cy * cp
    };
  }

  function step(ship, state, controls = {}, deltaTime = 0) {
    let remainingTime = Math.max(0, deltaTime);

    const throttle = clamp(controls.throttle ?? 0, -1, 1);
    const powerFactor = clamp(controls.powerFactor ?? 1, 0, 1);

    const rotationInput = {
      yaw: clamp(controls.yaw ?? 0, -1, 1),
      pitch: clamp(controls.pitch ?? 0, -1, 1),
      roll: clamp(controls.roll ?? 0, -1, 1)
    };

    const dryMass = Math.max(1, ship.mass ?? 1);
    const thrust = Math.max(0, ship.thrust ?? 0);
    const isp = Math.max(1, ship.isp ?? 3000);
    const angularAcceleration = ship.angularAcceleration ?? 0.5;

    const conditionFactor = state.condition / 100;

    while (remainingTime > 0) {
      const dt = Math.min(remainingTime, 0.05);
      remainingTime -= dt;

      const totalMass = Math.max(
        1,
        dryMass + state.cargoMass + state.propellantRemaining
      );

      const requestedThrust =
        thrust * Math.abs(throttle) * powerFactor * conditionFactor;

      const requestedPropellant =
        requestedThrust / (isp * G0) * dt;

      let actualThrust = requestedThrust;

      if (requestedPropellant > state.propellantRemaining) {
        const ratio = requestedPropellant > 0
          ? state.propellantRemaining / requestedPropellant
          : 0;

        actualThrust *= ratio;
      }

      const consumedPropellant =
        actualThrust / (isp * G0) * dt;

      state.propellantRemaining = Math.max(
        0,
        state.propellantRemaining - consumedPropellant
      );

      const forward = getForward(state.rotation);
      const acceleration = actualThrust / totalMass * Math.sign(throttle);

      state.velocity.x += forward.x * acceleration * dt;
      state.velocity.y += forward.y * acceleration * dt;
      state.velocity.z += forward.z * acceleration * dt;

      // Inertia: velocity remains when thrust is released.
      state.position.x += state.velocity.x * dt;
      state.position.y += state.velocity.y * dt;
      state.position.z += state.velocity.z * dt;

      // Rotational inertia: rotation continues until counter-steered.
      for (const axis of ["yaw", "pitch", "roll"]) {
        state.angularVelocity[axis] +=
          rotationInput[axis] * angularAcceleration * dt;

        state.rotation[axis] += state.angularVelocity[axis] * dt;
      }
    }

    return state;
  }

  return {
    createState,
    getForward,
    step
  };
})();

window.FlightPhysics = FlightPhysics;
