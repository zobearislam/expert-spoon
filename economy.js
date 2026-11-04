
/* =========================================================
   ECONOMY.JS
   Background economy and simulation systems.

   index.html remains responsible for:
   - Hiring and firing pilots
   - Buying and selling vehicles
   - Creating and removing lanes
   - Creating and cancelling deals
   - Rendering the interface

   This module uses the existing U and CFG objects.
   ========================================================= */

window.Economy = (() => {
  "use strict";

  const SETTINGS = {
    HOURS_PER_YEAR: 356,
    LEASE_GRACE_HOURS: 24,

    pilotWagePerHour: 2,
    vehicleMaintenancePerHour: 0.5,
    vehicleWearPerHour: 0.002,

    repairCostPerConditionPoint: 5,
    stationMaintenancePerHour: 2,

    defaultLeasePrice: 1000,

    fuelPrices: {
      xenon: 2,
      hydrogen: 1,
      antimatter: 25
    },

    npcStartingCredits: 100000,
    realMillisecondsPerGameHour: 1000
  };

  let U = null;
  let CFG = null;
  let initialized = false;
  let timer = null;
  let lastRealTime = 0;

  const state = {
    gameHours: 0,
    leases: [],
    stations: [],
    markets: {},
    factions: {},
    events: [],
    statistics: {
      totalRevenue: 0,
      totalExpenses: 0,
      deliveries: 0
    }
  };

  /* -------------------- UTILITIES -------------------- */

  function requireInit() {
    if (!initialized) {
      throw new Error("Economy.init(U, CFG) must be called first.");
    }
  }

  function findSystem(id) {
    return U.systems.find(system => system.id === id) || null;
  }

  function findVehicle(id) {
    return U.vehicles.find(vehicle => vehicle.id === id) || null;
  }

  function findPilot(id) {
    return U.pilots.find(pilot => pilot.id === id) || null;
  }

  function findLocation(systemId, locationId) {
    const system = findSystem(systemId);
    if (!system) return null;

    for (const body of system.bodies || []) {
      for (const station of body.stations || []) {
        if (station.id === locationId) {
          return station;
        }
      }

      for (const location of body.locations || []) {
        if (location.id === locationId) {
          return location;
        }
      }
    }

    return null;
  }

  function record(message, type = "info") {
    const event = {
      time: state.gameHours,
      message,
      type
    };

    state.events.push(event);

    if (state.events.length > 200) {
      state.events.shift();
    }

    return event;
  }

  function charge(amount, reason = "Expense") {
    requireInit();

    amount = Math.max(0, Number(amount) || 0);

    if (U.credits < amount) {
      return false;
    }

    U.credits -= amount;
    state.statistics.totalExpenses += amount;

    record(`${reason}: ${amount.toFixed(2)} credits`, "expense");
    return true;
  }

  function pay(amount, reason = "Revenue") {
    requireInit();

    amount = Math.max(0, Number(amount) || 0);

    U.credits += amount;
    state.statistics.totalRevenue += amount;

    record(`${reason}: +${amount.toFixed(2)} credits`, "income");
    return true;
  }

  function getFuelPrice(type) {
    return SETTINGS.fuelPrices[type] || 1;
  }

  /* -------------------- INITIALIZATION -------------------- */

  function init(sharedUniverse, sharedConfig) {
    if (!sharedUniverse || !sharedConfig) {
      throw new Error("Economy requires the existing U and CFG objects.");
    }

    U = sharedUniverse;
    CFG = sharedConfig;

    initialized = true;

    initializeFactions();

    record("Economy initialized.");
    return true;
  }

  /* -------------------- PILOT PAYROLL -------------------- */

  function processPayroll(hours = 1) {
    requireInit();

    const pilots = U.pilots || [];
    const total = pilots.length *
      SETTINGS.pilotWagePerHour *
      hours;

    if (total <= 0) return true;

    if (!charge(total, "Pilot payroll")) {
      record("Insufficient credits to pay pilot wages.", "warning");
      return false;
    }

    return true;
  }

  /* -------------------- VEHICLE MAINTENANCE -------------------- */

  function processVehicleMaintenance(hours = 1) {
    requireInit();

    for (const lane of U.lanes || []) {
      for (const vehicleId of lane.vehicles || []) {
        const vehicle = findVehicle(vehicleId);
        if (!vehicle) continue;

        const cost = SETTINGS.vehicleMaintenancePerHour * hours;

        if (!charge(cost, `Maintenance for ${vehicle.name}`)) {
          record(`${vehicle.name} maintenance unpaid.`, "warning");
          continue;
        }

        vehicle.condition = Math.max(
          0,
          (vehicle.condition ?? 100) -
          SETTINGS.vehicleWearPerHour * hours
        );

        vehicle.maintenance =
          (vehicle.maintenance || 0) + cost;
      }
    }
  }

  function repairVehicle(vehicleId) {
    requireInit();

    const vehicle = findVehicle(vehicleId);
    if (!vehicle) return false;

    const condition = vehicle.condition ?? 100;
    const missing = 100 - condition;

    if (missing <= 0) return true;

    const cost =
      missing * SETTINGS.repairCostPerConditionPoint;

    if (!charge(cost, `Repairing ${vehicle.name}`)) {
      return false;
    }

    vehicle.condition = 100;
    vehicle.maintenance = 0;

    record(`${vehicle.name} fully repaired.`);
    return true;
  }

  /* -------------------- FUEL -------------------- */

  function refuel(vehicleId, amount) {
    requireInit();

    const vehicle = findVehicle(vehicleId);
    if (!vehicle) return false;

    amount = Math.max(0, Number(amount) || 0);

    const capacity = vehicle.propellantCapacity || 0;
    const remaining = vehicle.propellantRemaining || 0;
    const availableSpace = capacity - remaining;

    amount = Math.min(amount, availableSpace);

    if (amount <= 0) return false;

    const fuelType = vehicle.propellant || "hydrogen";
    const cost = amount * getFuelPrice(fuelType);

    if (!charge(cost, `Refuelling ${vehicle.name}`)) {
      return false;
    }

    vehicle.propellantRemaining = remaining + amount;

    record(`${vehicle.name} refuelled with ${amount} units.`);
    return true;
  }

  /* -------------------- LEASES -------------------- */

  function isLeaseAllowed(systemId, locationId) {
    const system = findSystem(systemId);
    const location = findLocation(systemId, locationId);

    if (!system || !location) return false;

    // A location must explicitly be authorized by its government.
    const permitted =
      location.leaseAllowed === true ||
      (system.leaseZones || []).includes(locationId);

    return permitted;
  }

  function getLease(leaseId) {
    return state.leases.find(lease => lease.id === leaseId) || null;
  }

  function getLeaseStatus(lease) {
    if (!lease) return "invalid";

    const remaining = lease.expiresAt - state.gameHours;

    if (remaining > 0) return "active";
    if (remaining >= -SETTINGS.LEASE_GRACE_HOURS) return "grace";

    return "expired";
  }

  function purchaseLease(systemId, locationId, owner = "player", price) {
    requireInit();

    if (!isLeaseAllowed(systemId, locationId)) {
      record("Government has not authorized this lease location.", "warning");
      return null;
    }

    const alreadyLeased = state.leases.some(lease =>
      lease.systemId === systemId &&
      lease.locationId === locationId &&
      getLeaseStatus(lease) !== "expired"
    );

    if (alreadyLeased) {
      record("This location is already leased.", "warning");
      return null;
    }

    price = Number(price ?? SETTINGS.defaultLeasePrice);

    if (owner === "player" && !charge(price, "Lease purchase")) {
      return null;
    }

    const lease = {
      id: "lease_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
      systemId,
      locationId,
      owner,
      price,
      purchasedAt: state.gameHours,
      expiresAt: state.gameHours + SETTINGS.HOURS_PER_YEAR
    };

    state.leases.push(lease);

    record(`New lease purchased at ${locationId}.`);
    return lease;
  }

  function renewLease(leaseId, price) {
    requireInit();

    const lease = getLease(leaseId);
    if (!lease || lease.owner !== "player") return false;

    if (getLeaseStatus(lease) === "expired") {
      record("This lease has expired and cannot be renewed.", "warning");
      return false;
    }

    price = Number(price ?? lease.price);

    if (!charge(price, "Lease renewal")) {
      return false;
    }

    lease.expiresAt += SETTINGS.HOURS_PER_YEAR;

    record(`Lease ${leaseId} renewed.`);
    return true;
  }

  function updateLeases() {
    for (const lease of state.leases) {
      const status = getLeaseStatus(lease);

      if (status === "grace" && !lease.graceNotice) {
        lease.graceNotice = true;
        record(`Lease ${lease.id} has entered its 24-hour grace period.`, "warning");
      }

      if (status === "expired" && !lease.expiryNotice) {
        lease.expiryNotice = true;
        record(`Lease ${lease.id} has expired.`, "warning");
      }
    }
  }

  /* -------------------- STATIONS -------------------- */

  function buildStation(data) {
    requireInit();

    if (!data || !data.systemId || !data.locationId) {
      return null;
    }

    if (!isLeaseAllowed(data.systemId, data.locationId)) {
      record("Station construction is not authorized here.", "warning");
      return null;
    }

    const lease = state.leases.find(item =>
      item.systemId === data.systemId &&
      item.locationId === data.locationId &&
      item.owner === "player" &&
      getLeaseStatus(item) === "active"
    );

    if (!lease) {
      record("An active lease is required to build a station.", "warning");
      return null;
    }

    const cost = Math.max(0, Number(data.cost) || 0);

    if (!charge(cost, "Station construction")) {
      return null;
    }

    const station = {
      id: "station_" + Date.now(),
      name: data.name || "New Station",
      systemId: data.systemId,
      locationId: data.locationId,
      owner: "player",
      condition: 100,
      maintenance: 0,
      resources: data.resources || []
    };

    state.stations.push(station);

    record(`Station constructed: ${station.name}.`);
    return station;
  }

  function processStationMaintenance(hours = 1) {
    for (const station of state.stations) {
      const cost = SETTINGS.stationMaintenancePerHour * hours;

      if (!charge(cost, `Maintenance for ${station.name}`)) {
        record(`${station.name} maintenance unpaid.`, "warning");
        continue;
      }

      station.maintenance =
        (station.maintenance || 0) + cost;

      station.condition = Math.max(
        0,
        (station.condition ?? 100) - 0.001 * hours
      );
    }
  }

  /* -------------------- MARKETS -------------------- */

  function getMarket(systemId, resource) {
    requireInit();

    const key = `${systemId}:${resource}`;

    if (!state.markets[key]) {
      state.markets[key] = {
        systemId,
        resource,
        price: 10,
        supply: 1000,
        demand: 1000
      };
    }

    return state.markets[key];
  }

  function setMarket(systemId, resource, changes = {}) {
    const market = getMarket(systemId, resource);

    if (Number.isFinite(changes.price)) {
      market.price = Math.max(0.01, changes.price);
    }

    if (Number.isFinite(changes.supply)) {
      market.supply = Math.max(0, changes.supply);
    }

    if (Number.isFinite(changes.demand)) {
      market.demand = Math.max(0, changes.demand);
    }

    return market;
  }

  function updateMarkets(hours = 1) {
    for (const market of Object.values(state.markets)) {
      const supply = Math.max(1, market.supply);
      const demand = Math.max(0, market.demand);

      const pressure = (demand - supply) / supply;
      const change = pressure * 0.001 * hours;

      market.price = Math.max(
        0.01,
        market.price * (1 + change)
      );
    }
  }

  /* -------------------- NPC FACTIONS -------------------- */

  function initializeFactions() {
    for (const [id, config] of Object.entries(CFG.factions || {})) {
      if (!state.factions[id]) {
        state.factions[id] = {
          id,
          name: config.name || id,
          credits: SETTINGS.npcStartingCredits,
          reputation: 0,
          systems: [],
          active: true
        };
      }
    }
  }

  function getFaction(factionId) {
    return state.factions[factionId] || null;
  }

  function transferCredits(fromId, toId, amount) {
    requireInit();

    amount = Math.max(0, Number(amount) || 0);

    const from = getFaction(fromId);
    const to = getFaction(toId);

    if (!from || !to || from.credits < amount) {
      return false;
    }

    from.credits -= amount;
    to.credits += amount;

    return true;
  }

  function changeReputation(factionId, amount) {
    const faction = getFaction(factionId);
    if (!faction) return false;

    faction.reputation += Number(amount) || 0;
    return faction.reputation;
  }

  /* -------------------- DEALS -------------------- */

  // index.html creates and removes deals.
  // This module only tracks their duration and deliveries.
  // A deal's qty field means units per 356-hour game year.

  function updateDeals(hours = 1) {
    for (const deal of U.deals || []) {
      if (deal.completed) continue;

      if (deal.startedAt === undefined) {
        deal.startedAt = state.gameHours;
        deal.expiresAt =
          state.gameHours +
          (Number(deal.years) || 1) * SETTINGS.HOURS_PER_YEAR;

        deal.deliveredQty = deal.deliveredQty || 0;
      }

      if (state.gameHours >= deal.expiresAt) {
        deal.completed = true;
        record(`Deal for ${deal.resource} has expired.`);
      }
    }
  }

  // Called by a future cargo-transport system after a real delivery.
  function recordDelivery(dealIndex, quantity) {
    requireInit();

    const deal = U.deals[dealIndex];
    if (!deal || deal.completed) return false;

    quantity = Math.max(0, Number(quantity) || 0);

    if (quantity <= 0) return false;

    const revenue = quantity * (Number(deal.price) || 0);

    deal.deliveredQty = (deal.deliveredQty || 0) + quantity;

    pay(revenue, `Delivery of ${deal.resource}`);
    state.statistics.deliveries++;

    return true;
  }

  /* -------------------- SIMULATION -------------------- */

  function update(hours = 1) {
    requireInit();

    hours = Math.max(0, Number(hours) || 0);
    if (hours === 0) return;

    state.gameHours += hours;

    processPayroll(hours);
    processVehicleMaintenance(hours);
    processStationMaintenance(hours);

    updateLeases();
    updateMarkets(hours);
    updateDeals(hours);
  }

  function start() {
    requireInit();

    if (timer) return;

    lastRealTime = Date.now();

    timer = setInterval(() => {
      const now = Date.now();

      const elapsed =
        (now - lastRealTime) /
        SETTINGS.realMillisecondsPerGameHour;

      lastRealTime = now;

      if (elapsed > 0) {
        update(elapsed);
      }
    }, SETTINGS.realMillisecondsPerGameHour);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /* -------------------- SAVE / LOAD -------------------- */

  function exportState() {
    requireInit();

    return JSON.parse(JSON.stringify(state));
  }

  function importState(savedState) {
    requireInit();

    if (!savedState || typeof savedState !== "object") {
      return false;
    }

    Object.assign(state, savedState);

    initializeFactions();
    record("Economy data loaded.");

    return true;
  }

  /* -------------------- PUBLIC API -------------------- */

  return {
    SETTINGS,

    init,

    charge,
    pay,

    processPayroll,
    processVehicleMaintenance,
    repairVehicle,
    refuel,

    isLeaseAllowed,
    purchaseLease,
    renewLease,
    getLease,
    getLeaseStatus,

    buildStation,

    getMarket,
    setMarket,

    getFaction,
    transferCredits,
    changeReputation,

    recordDelivery,

    update,
    start,
    stop,

    exportState,
    importState,

    get events() {
      return state.events;
    },

    get statistics() {
      return state.statistics;
    },

    get gameHours() {
      return state.gameHours;
    },

    get leases() {
      return state.leases;
    },

    get stations() {
      return state.stations;
    },

    get markets() {
      return state.markets;
    },

    get factions() {
      return state.factions;
    }
  };
})();
      
