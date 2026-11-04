
window.Economy=(()=>{
"use strict";

const SETTINGS={
  HOURS_PER_YEAR:356,LEASE_GRACE_HOURS:24,
  pilotWagePerHour:2,vehicleMaintenancePerHour:.5,vehicleWearPerHour:.002,
  repairCostPerConditionPoint:5,stationMaintenancePerHour:2,
  defaultLeasePrice:1000,
  fuelPrices:{xenon:2,hydrogen:1,antimatter:25},
  npcStartingCredits:100000,realMillisecondsPerGameHour:1000
};

let U=null,CFG=null,initialized=false,timer=null,lastRealTime=0;

const state={
  gameHours:0,leases:[],stations:[],markets:{},factions:{},events:[],
  statistics:{totalRevenue:0,totalExpenses:0,deliveries:0}
};

const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const positive=v=>Math.max(0,num(v));
const requireInit=()=>{if(!initialized)throw Error("Economy.init(U, CFG) must be called first.");};
const findSystem=id=>U.systems?.find(x=>x.id===id)||null;
const findVehicle=id=>U.vehicles?.find(x=>x.id===id)||null;
const findPilot=id=>U.pilots?.find(x=>x.id===id)||null;

function findLocation(systemId,locationId){
  const system=findSystem(systemId);
  if(!system)return null;
  for(const body of system.bodies||[]){
    const found=[...(body.stations||[]),...(body.locations||[])].find(x=>x.id===locationId);
    if(found)return found;
  }
  return null;
}

function record(message,type="info"){
  const event={time:state.gameHours,message,type};
  state.events.push(event);
  if(state.events.length>200)state.events.shift();
  return event;
}

function charge(amount,reason="Expense"){
  requireInit();
  amount=positive(amount);
  if(U.credits<amount)return false;
  U.credits-=amount;
  state.statistics.totalExpenses+=amount;
  record(`${reason}: ${amount.toFixed(2)} credits`,"expense");
  return true;
}

function pay(amount,reason="Revenue"){
  requireInit();
  amount=positive(amount);
  U.credits+=amount;
  state.statistics.totalRevenue+=amount;
  record(`${reason}: +${amount.toFixed(2)} credits`,"income");
  return true;
}

function getFuelPrice(type){return SETTINGS.fuelPrices[type]||1;}

function init(universe,config){
  if(!universe||!config)throw Error("Economy requires U and CFG.");
  U=universe;CFG=config;initialized=true;
  initializeFactions();
  record("Economy initialized.");
  return true;
}

/* PAYROLL */
function processPayroll(hours=1){
  requireInit();
  const cost=(U.pilots||[]).length*SETTINGS.pilotWagePerHour*positive(hours);
  if(!cost)return true;
  if(!charge(cost,"Pilot payroll")){
    record("Insufficient credits to pay pilot wages.","warning");
    return false;
  }
  return true;
}

/* VEHICLES */
function processVehicleMaintenance(hours=1){
  requireInit();
  hours=positive(hours);
  const processed=new Set();
  for(const lane of U.lanes||[]){
    for(const id of lane.vehicles||[]){
      if(processed.has(id))continue;
      processed.add(id);
      const vehicle=findVehicle(id);
      if(!vehicle)continue;
      const cost=SETTINGS.vehicleMaintenancePerHour*hours;
      if(!charge(cost,`Maintenance for ${vehicle.name}`)){
        record(`${vehicle.name} maintenance unpaid.`,"warning");
        continue;
      }
      vehicle.condition=Math.max(0,num(vehicle.condition,100)-SETTINGS.vehicleWearPerHour*hours);
      vehicle.maintenance=positive(vehicle.maintenance)+cost;
    }
  }
}

function repairVehicle(id){
  requireInit();
  const vehicle=findVehicle(id);
  if(!vehicle)return false;
  const missing=Math.max(0,100-num(vehicle.condition,100));
  if(!missing)return true;
  const cost=missing*SETTINGS.repairCostPerConditionPoint;
  if(!charge(cost,`Repairing ${vehicle.name}`))return false;
  vehicle.condition=100;vehicle.maintenance=0;
  record(`${vehicle.name} fully repaired.`);
  return true;
}

function refuel(id,amount){
  requireInit();
  const vehicle=findVehicle(id);
  if(!vehicle)return false;
  const capacity=positive(vehicle.propellantCapacity);
  const remaining=positive(vehicle.propellantRemaining);
  amount=Math.min(positive(amount),Math.max(0,capacity-remaining));
  if(!amount)return false;
  const cost=amount*getFuelPrice(vehicle.propellant||"hydrogen");
  if(!charge(cost,`Refuelling ${vehicle.name}`))return false;
  vehicle.propellantRemaining=remaining+amount;
  record(`${vehicle.name} refuelled with ${amount} units.`);
  return true;
}

/* LEASES */
function isLeaseAllowed(systemId,locationId){
  const system=findSystem(systemId),location=findLocation(systemId,locationId);
  return !!(system&&location&&(location.leaseAllowed===true||(system.leaseZones||[]).includes(locationId)));
}

const getLease=id=>state.leases.find(x=>x.id===id)||null;

function getLeaseStatus(lease){
  if(!lease)return "invalid";
  const remaining=num(lease.expiresAt)-state.gameHours;
  return remaining>0?"active":remaining>=-SETTINGS.LEASE_GRACE_HOURS?"grace":"expired";
}

function purchaseLease(systemId,locationId,owner="player",price){
  requireInit();
  if(!isLeaseAllowed(systemId,locationId)){
    record("Government has not authorized this lease location.","warning");
    return null;
  }
  if(state.leases.some(x=>x.systemId===systemId&&x.locationId===locationId&&getLeaseStatus(x)!=="expired")){
    record("This location is already leased.","warning");
    return null;
  }
  price=positive(price??SETTINGS.defaultLeasePrice);
  if(owner==="player"&&!charge(price,"Lease purchase"))return null;
  const lease={
    id:`lease_${Date.now()}_${Math.floor(Math.random()*10000)}`,
    systemId,locationId,owner,price,purchasedAt:state.gameHours,
    expiresAt:state.gameHours+SETTINGS.HOURS_PER_YEAR
  };
  state.leases.push(lease);
  record(`New lease purchased at ${locationId}.`);
  return lease;
}

function renewLease(id,price){
  requireInit();
  const lease=getLease(id);
  if(!lease||lease.owner!=="player")return false;
  if(getLeaseStatus(lease)==="expired"){
    record("This lease has expired and cannot be renewed.","warning");
    return false;
  }
  price=positive(price??lease.price);
  if(!charge(price,"Lease renewal"))return false;
  lease.expiresAt+=SETTINGS.HOURS_PER_YEAR;
  record(`Lease ${id} renewed.`);
  return true;
}

function updateLeases(){
  for(const lease of state.leases){
    const status=getLeaseStatus(lease);
    if(status==="grace"&&!lease.graceNotice){
      lease.graceNotice=true;
      record(`Lease ${lease.id} entered its 24-hour grace period.`,"warning");
    }
    if(status==="expired"&&!lease.expiryNotice){
      lease.expiryNotice=true;
      record(`Lease ${lease.id} has expired.`,"warning");
    }
  }
}

/* STATIONS */
function buildStation(data){
  requireInit();
  if(!data?.systemId||!data?.locationId)return null;
  if(!isLeaseAllowed(data.systemId,data.locationId)){
    record("Station construction is not authorized here.","warning");
    return null;
  }
  const lease=state.leases.find(x=>
    x.systemId===data.systemId&&x.locationId===data.locationId&&
    x.owner==="player"&&getLeaseStatus(x)==="active"
  );
  if(!lease){
    record("An active lease is required to build a station.","warning");
    return null;
  }
  const cost=positive(data.cost);
  if(!charge(cost,"Station construction"))return null;
  const station={
    id:`station_${Date.now()}`,name:data.name||"New Station",
    systemId:data.systemId,locationId:data.locationId,owner:"player",
    condition:100,maintenance:0,resources:Array.isArray(data.resources)?data.resources:[]
  };
  state.stations.push(station);
  record(`Station constructed: ${station.name}.`);
  return station;
}

function processStationMaintenance(hours=1){
  requireInit();
  hours=positive(hours);
  for(const station of state.stations){
    const cost=SETTINGS.stationMaintenancePerHour*hours;
    if(!charge(cost,`Maintenance for ${station.name}`)){
      record(`${station.name} maintenance unpaid.`,"warning");
      continue;
    }
    station.maintenance=positive(station.maintenance)+cost;
    station.condition=Math.max(0,num(station.condition,100)-.001*hours);
  }
}

/* MARKETS */
function getMarket(systemId,resource){
  requireInit();
  const key=`${systemId}:${resource}`;
  return state.markets[key]||(state.markets[key]={
    systemId,resource,price:10,supply:1000,demand:1000
  });
}

function setMarket(systemId,resource,changes={}){
  const market=getMarket(systemId,resource);
  if(Number.isFinite(changes.price))market.price=Math.max(.01,changes.price);
  if(Number.isFinite(changes.supply))market.supply=Math.max(0,changes.supply);
  if(Number.isFinite(changes.demand))market.demand=Math.max(0,changes.demand);
  return market;
}

function updateMarkets(hours=1){
  for(const market of Object.values(state.markets)){
    const pressure=(Math.max(0,market.demand)-Math.max(1,market.supply))/Math.max(1,market.supply);
    market.price=Math.max(.01,market.price*(1+pressure*.001*positive(hours)));
  }
}

/* FACTIONS */
function initializeFactions(){
  for(const [id,config] of Object.entries(CFG.factions||{})){
    if(!state.factions[id]){
      state.factions[id]={
        id,name:config.name||id,credits:SETTINGS.npcStartingCredits,
        reputation:0,systems:[],active:true
      };
    }
  }
}

const getFaction=id=>state.factions[id]||null;

function transferCredits(fromId,toId,amount){
  requireInit();
  amount=positive(amount);
  const from=getFaction(fromId),to=getFaction(toId);
  if(!from||!to||from.credits<amount)return false;
  from.credits-=amount;to.credits+=amount;
  return true;
}

function changeReputation(id,amount){
  const faction=getFaction(id);
  if(!faction)return false;
  faction.reputation=num(faction.reputation)+num(amount);
  return faction.reputation;
}

/* DEALS */
function updateDeals(){
  for(const deal of U.deals||[]){
    if(deal.completed)continue;
    if(deal.startedAt===undefined){
      deal.startedAt=state.gameHours;
      deal.expiresAt=state.gameHours+positive(deal.years||1)*SETTINGS.HOURS_PER_YEAR;
      deal.deliveredQty=positive(deal.deliveredQty);
    }
    if(state.gameHours>=deal.expiresAt){
      deal.completed=true;
      record(`Deal for ${deal.resource} has expired.`);
    }
  }
}

function recordDelivery(index,quantity){
  requireInit();
  const deal=U.deals?.[index];
  if(!deal||deal.completed)return false;
  quantity=positive(quantity);
  if(!quantity)return false;
  const revenue=quantity*positive(deal.price);
  deal.deliveredQty=positive(deal.deliveredQty)+quantity;
  pay(revenue,`Delivery of ${deal.resource}`);
  state.statistics.deliveries++;
  return true;
}

/* SIMULATION */
function update(hours=1){
  requireInit();
  hours=positive(hours);
  if(!hours)return;
  state.gameHours+=hours;
  processPayroll(hours);
  processVehicleMaintenance(hours);
  processStationMaintenance(hours);
  updateLeases();
  updateMarkets(hours);
  updateDeals();
}

function start(){
  requireInit();
  if(timer)return;
  lastRealTime=Date.now();
  timer=setInterval(()=>{
    const now=Date.now();
    const elapsed=(now-lastRealTime)/SETTINGS.realMillisecondsPerGameHour;
    lastRealTime=now;
    if(elapsed>0)update(elapsed);
  },SETTINGS.realMillisecondsPerGameHour);
}

function stop(){
  if(timer){clearInterval(timer);timer=null;}
}

/* SAVE / LOAD */
function exportState(){
  requireInit();
  return JSON.parse(JSON.stringify(state));
}

function importState(saved){
  requireInit();
  if(!saved||typeof saved!=="object"||Array.isArray(saved))return false;
  state.gameHours=positive(saved.gameHours);
  state.leases=Array.isArray(saved.leases)?saved.leases:[];
  state.stations=Array.isArray(saved.stations)?saved.stations:[];
  state.markets=saved.markets&&typeof saved.markets==="object"?saved.markets:{};
  state.factions=saved.factions&&typeof saved.factions==="object"?saved.factions:{};
  state.events=Array.isArray(saved.events)?saved.events.slice(-200):[];
  state.statistics={
    totalRevenue:positive(saved.statistics?.totalRevenue),
    totalExpenses:positive(saved.statistics?.totalExpenses),
    deliveries:positive(saved.statistics?.deliveries)
  };
  initializeFactions();
  record("Economy data loaded.");
  return true;
}

return{
  SETTINGS,init,charge,pay,
  processPayroll,processVehicleMaintenance,repairVehicle,refuel,
  isLeaseAllowed,purchaseLease,renewLease,getLease,getLeaseStatus,
  buildStation,getMarket,setMarket,
  getFaction,transferCredits,changeReputation,recordDelivery,
  update,start,stop,exportState,importState,
  get events(){return state.events;},
  get statistics(){return state.statistics;},
  get gameHours(){return state.gameHours;},
  get leases(){return state.leases;},
  get stations(){return state.stations;},
  get markets(){return state.markets;},
  get factions(){return state.factions;}
};
})();
     
