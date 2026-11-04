window.FlightPhysics=(()=>{
"use strict";

const G0=9.80665;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;

const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale=(v,s)=>({x:v.x*s,y:v.y*s,z:v.z*s});
const length=v=>Math.hypot(v.x,v.y,v.z);
const normalize=v=>{const l=length(v);return l>0?scale(v,1/l):{x:0,y:0,z:0};};

function createState(ship,cargoMass=0){
  return{
    position:{x:0,y:0,z:0},
    velocity:{x:0,y:0,z:0},
    rotation:{yaw:0,pitch:0,roll:0},
    angularVelocity:{yaw:0,pitch:0,roll:0},
    cargoMass:Math.max(0,num(cargoMass)),
    propellantRemaining:Math.max(0,num(ship.propellantRemaining??ship.propellantCapacity)),
    condition:clamp(num(ship.condition,100),0,100),
    collided:false,
    collisionBody:null,
    speed:0
  };
}

function getForward(rotation){
  const cy=Math.cos(rotation.yaw),sy=Math.sin(rotation.yaw);
  const cp=Math.cos(rotation.pitch),sp=Math.sin(rotation.pitch);
  return{x:sy*cp,y:sp,z:cy*cp};
}

/* GRAVITY */
function applyGravity(position,bodies){
  let acceleration={x:0,y:0,z:0};

  for(const body of bodies||[]){
    if(!body.position||!(body.gravityRadius>0)||!(body.gravity>0))continue;

    const direction=sub(body.position,position);
    const distance=length(direction);
    if(distance<1||distance>body.gravityRadius)continue;

    const strength=body.gravity*Math.pow(
      1-distance/body.gravityRadius,2
    );

    acceleration=add(acceleration,scale(normalize(direction),strength));
  }
  return acceleration;
}

/* DRAG */
function applyDrag(velocity,drag,dt){
  const speed=length(velocity);
  if(speed===0||drag<=0)return velocity;

  const reduction=Math.min(1,drag*speed*dt);
  return scale(velocity,1-reduction);
}

/* COLLISIONS */
function detectCollision(position,bodies){
  for(const body of bodies||[]){
    if(!body.position||!(body.radius>0))continue;

    const distance=length(sub(position,body.position));
    if(distance<body.radius){
      return{
        collided:true,
        body,
        normal:normalize(sub(position,body.position)),
        penetration:body.radius-distance
      };
    }
  }
  return{collided:false,body:null,normal:null,penetration:0};
}

function resolveCollision(state,collision){
  if(!collision.collided)return;

  const normal=collision.normal;
  state.position=add(
    state.position,
    scale(normal,collision.penetration)
  );

  const normalSpeed=
    state.velocity.x*normal.x+
    state.velocity.y*normal.y+
    state.velocity.z*normal.z;

  if(normalSpeed<0){
    const restitution=clamp(num(collision.body.restitution,0),0,1);
    state.velocity=sub(
      state.velocity,
      scale(normal,(1+restitution)*normalSpeed)
    );
  }

  state.collided=true;
  state.collisionBody=collision.body.id??collision.body.name??"Unknown";
}

/* AUTOMATIC BRAKING */
function getBrakingAcceleration(speed,brakePower){
  return Math.min(speed,Math.max(0,brakePower));
}

function applyAutoBrake(state,target,brakePower,dt){
  if(!target?.position)return;

  const direction=sub(target.position,state.position);
  const distance=length(direction);
  const speed=length(state.velocity);

  if(distance<1||speed===0)return;

  const maxBrake=Math.max(0,num(brakePower));
  if(maxBrake===0)return;

  const stoppingDistance=(speed*speed)/(2*maxBrake);
  if(stoppingDistance>=distance){
    const deceleration=getBrakingAcceleration(speed,maxBrake);
    state.velocity=sub(
      state.velocity,
      scale(normalize(state.velocity),deceleration*dt)
    );
  }
}

/* MAIN PHYSICS STEP */
function step(ship,state,controls={},deltaTime=0){
  let remainingTime=clamp(num(deltaTime),0,10);

  const throttle=clamp(num(controls.throttle),-1,1);
  const powerFactor=clamp(num(controls.powerFactor,1),0,1);

  const rotationInput={
    yaw:clamp(num(controls.yaw),-1,1),
    pitch:clamp(num(controls.pitch),-1,1),
    roll:clamp(num(controls.roll),-1,1)
  };

  const dryMass=Math.max(1,num(ship.mass,1));
  const thrust=Math.max(0,num(ship.thrust));
  const isp=Math.max(1,num(ship.isp,3000));
  const angularAcceleration=num(ship.angularAcceleration,.5);

  const conditionFactor=clamp(num(state.condition,100)/100,0,1);
  const bodies=controls.bodies||[];
  const drag=Math.max(0,num(controls.drag));
  const maxSpeed=Math.max(0,num(controls.maxSpeed));
  const autoBrake=controls.autoBrake===true;
  const brakePower=Math.max(0,num(controls.brakePower,10));

  state.collided=false;
  state.collisionBody=null;

  while(remainingTime>0){
    const dt=Math.min(remainingTime,.05);
    remainingTime-=dt;

    const totalMass=Math.max(
      1,dryMass+state.cargoMass+state.propellantRemaining
    );

    const requestedThrust=thrust*Math.abs(throttle)*powerFactor*conditionFactor;
    const requestedFuel=requestedThrust/(isp*G0)*dt;

    const fuelRatio=requestedFuel>0
      ?Math.min(1,state.propellantRemaining/requestedFuel)
      :1;

    const actualThrust=requestedThrust*fuelRatio;
    const consumedFuel=actualThrust/(isp*G0)*dt;

    state.propellantRemaining=Math.max(
      0,state.propellantRemaining-consumedFuel
    );

    const forward=getForward(state.rotation);
    const acceleration=actualThrust/totalMass*Math.sign(throttle);

    let totalAcceleration=scale(forward,acceleration);

    totalAcceleration=add(
      totalAcceleration,
      applyGravity(state.position,bodies)
    );

    state.velocity=add(
      state.velocity,
      scale(totalAcceleration,dt)
    );

    if(drag>0)state.velocity=applyDrag(state.velocity,drag,dt);

    if(autoBrake){
      applyAutoBrake(
        state,controls.target,brakePower,dt
      );
    }

    let speed=length(state.velocity);

    if(maxSpeed>0&&speed>maxSpeed){
      state.velocity=scale(state.velocity,maxSpeed/speed);
    }

    state.position=add(
      state.position,
      scale(state.velocity,dt)
    );

    const collision=detectCollision(state.position,bodies);
    if(collision.collided)resolveCollision(state,collision);

    for(const axis of ["yaw","pitch","roll"]){
      state.angularVelocity[axis]+=
        rotationInput[axis]*angularAcceleration*dt;
      state.rotation[axis]+=
        state.angularVelocity[axis]*dt;
    }
  }

  state.speed=length(state.velocity);
  return state;
}

return{
  createState,
  getForward,
  step,
  applyGravity,
  detectCollision
};
})();
  
