
const IAG = (() => {
  const laws = {
    unsafeDischarge: {
      name: "Unsafe weapons discharge",
      fine: 2500,
      reputationLoss: 5
    },
    unlawfulAssault: {
      name: "Unlawful assault",
      fine: 10000,
      reputationLoss: 20
    },
    gateInterference: {
      name: "Gate interference",
      fine: 25000,
      reputationLoss: 35
    },
    propertyDamage: {
      name: "Civilian property damage",
      fine: 7500,
      reputationLoss: 12
    },
    inspectionObstruction: {
      name: "Obstruction of IAG inspection",
      fine: 5000,
      reputationLoss: 10
    }
  };

  let incidents = [];
  let nextId = 1;

  function recordIncident(data) {
    const law = laws[data.lawId];
    if (!law) return null;

    const incident = {
      id: nextId++,
      lawId: data.lawId,
      offender: data.offender,
      victim: data.victim || null,
      system: data.system || "Unknown",
      evidence: data.evidence || [],
      status: "under investigation",
      fine: law.fine,
      reputationLoss: law.reputationLoss
    };

    incidents.push(incident);
    return incident;
  }

  function confirmIncident(id) {
    const incident = incidents.find(x => x.id === id);
    if (!incident || incident.status !== "under investigation") {
      return false;
    }

    incident.status = "confirmed";
    return {
      offender: incident.offender,
      fine: incident.fine,
      reputationLoss: incident.reputationLoss
    };
  }

  function dismissIncident(id) {
    const incident = incidents.find(x => x.id === id);
    if (!incident || incident.status !== "under investigation") {
      return false;
    }

    incident.status = "dismissed";
    return true;
  }

  function getIncidents() {
    return incidents;
  }

  return {
    laws,
    recordIncident,
    confirmIncident,
    dismissIncident,
    getIncidents
  };
})();

window.IAG = IAG;
