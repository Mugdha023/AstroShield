/* eslint-disable no-restricted-globals */
import * as satellite from "satellite.js";

self.onmessage = (e) => {
  const {
    debrisList,
    targetsList,
    thresholdKm,
    futureMinutes,
    simulateLaunch,
    launchName,
    launchAltitudeKm,
    launchTLE
  } = e.data;

  const collisions = [];
  const launchCollisions = [];

  const futureDate = new Date(Date.now() + futureMinutes * 60 * 1000);

  if (simulateLaunch) {
    let launchPos = null;

    if (launchTLE?.line1 && launchTLE?.line2) {
      // Use real TLE propagation
      const satrec = satellite.twoline2satrec(launchTLE.line1, launchTLE.line2);
      launchPos = getFuturePosition(satrec, futureDate);
    } else {
      // Use simple fixed altitude straight up
      launchPos = {
        x: 0,
        y: 0,
        z: (launchAltitudeKm || 400) * 1000
      };
    }

    debrisList?.forEach((debris) => {
      const debrisPos = getFuturePosition(debris.satrec, futureDate);
      const distance = getDistanceKmECI(launchPos, debrisPos);

      if (distance < thresholdKm) {
        launchCollisions.push({
          debrisId: debris.id,
          distance: distance.toFixed(2),
          time: futureDate.toISOString(),
          launchName,
          estimatedSize: "Unknown",
          riskLevel: getRiskLevel(distance)
        });
      }
    });
  } else if (debrisList && targetsList) {
    debrisList.forEach((debris) => {
      const debrisPos = getFuturePosition(debris.satrec, futureDate);
      targetsList.forEach((target) => {
        const targetPos = getFuturePosition(target.satrec, futureDate);
        const distance = getDistanceKmECI(debrisPos, targetPos);

        if (distance < thresholdKm) {
          collisions.push({
            debrisId: debris.id,
            targetId: target.id,
            distance: distance.toFixed(2),
            time: futureDate.toISOString(),
            estimatedSize: "Unknown",
            riskLevel: getRiskLevel(distance)
          });
        }
      });
    });
  }

  self.postMessage({ collisions, launchCollisions });
};

function getFuturePosition(satrec, date) {
  return satellite.propagate(satrec, date).position;
}

function getDistanceKmECI(pos1, pos2) {
  if (!pos1 || !pos2) return Infinity;
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 1000; // meters to km
}

function getRiskLevel(distanceKm) {
  if (distanceKm < 1) return "Critical";
  if (distanceKm < 5) return "High";
  if (distanceKm < 10) return "Moderate";
  return "Low";
}
