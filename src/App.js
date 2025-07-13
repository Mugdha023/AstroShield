import React, { useEffect, useRef, useState } from "react";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./App.css";
import * as satellite from "satellite.js";

const Cesium = window.Cesium;
const BATCH_SIZE = 100;
const UPDATE_INTERVAL_MS = 2000;
const COLLISION_THRESHOLD_KM = 25;
const PREDICTION_MINUTES = 10;

function getRiskLevel(distance) {
  if (distance <= 10) return { label: "🚨 Critical", color: "red" };
  if (distance <= 100) return { label: "⚠️ Moderate", color: "orange" };
  return { label: "✅ Low", color: "green" };
}

function App() {
  const viewerRef = useRef(null);
  const viewerInstance = useRef(null);
  const debrisList = useRef([]);
  const targetsList = useRef([]);
  const launchSatrecRef = useRef(null);
  const tleLinesRef = useRef([]);
  const loadIndex = useRef(0);
  const collisionWorkerRef = useRef(null);

  const [selectedGroup, setSelectedGroup] = useState("starlink");
  const [issInfo, setIssInfo] = useState({
    latitude: 0,
    longitude: 0,
    altitude: 0,
    speed: 0,
  });
  const [locationName, setLocationName] = useState("Fetching...");
  const [collisionWarnings, setCollisionWarnings] = useState([]);
  const [launchInput, setLaunchInput] = useState("");
  const [launchWarnings, setLaunchWarnings] = useState([]);
  // 🛰️ Dynamic counts
const activeCount = targetsList.current.length > 0
  ? targetsList.current.filter(t => t.id !== "ISS-ZARYA").length
  : 0;

const debrisCount = debrisList.current.length;

const launchCount = viewerInstance.current?.entities.getById("CURRENT-LAUNCH") ? 1 : 0;

const totalCount = activeCount + debrisCount + launchCount + 1; // +1 for ISS


  useEffect(() => {
    window.CESIUM_BASE_URL = "/cesium";

    const viewer = new Cesium.Viewer(viewerRef.current, {
      shouldAnimate: true,
    });
    viewerInstance.current = viewer;

    // Load ISS
    const ISS_TLE = [
      "1 25544U 98067A   24166.20347222  .00001666  00000+0  38509-4 0  9994",
      "2 25544  51.6411 115.2241 0003852 331.0922  74.5720 15.50068506392926",
    ];
    const issSatrec = satellite.twoline2satrec(ISS_TLE[0], ISS_TLE[1]);
    targetsList.current = [{ id: "ISS-ZARYA", satrec: issSatrec }];

    const issEntity = viewer.entities.add({
      id: "ISS-ZARYA",
      name: "ISS (Zarya)",
      position: Cesium.Cartesian3.fromDegrees(0, 0, 400000),
      point: { pixelSize: 10, color: Cesium.Color.CYAN },
      label: {
        text: "🛰️ ISS",
        font: "14pt sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      },
    });
    viewer.trackedEntity = issEntity;

    const trailPositions = [];

    viewer.entities.add({
      name: "ISS Trail",
      polyline: {
        positions: new Cesium.CallbackProperty(() => trailPositions, false),
        width: 2,
        material: Cesium.Color.YELLOW,
      },
    });

    const interval = setInterval(() => {
      const now = new Date();
      const gmst = satellite.gstime(now);
      const { position: positionEci, velocity: velocityEci } = satellite.propagate(issSatrec, now);

      if (positionEci && velocityEci) {
        const posGd = satellite.eciToGeodetic(positionEci, gmst);
        const lon = satellite.degreesLong(posGd.longitude);
        const lat = satellite.degreesLat(posGd.latitude);
        const alt = posGd.height * 1000;
        const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, alt);

        issEntity.position = new Cesium.ConstantPositionProperty(cartesian);

        trailPositions.push(cartesian);
        if (trailPositions.length > 300) trailPositions.shift();

        const speed = Math.sqrt(
          velocityEci.x ** 2 + velocityEci.y ** 2 + velocityEci.z ** 2
        ) * 3600;

        setIssInfo({
          latitude: lat.toFixed(2),
          longitude: lon.toFixed(2),
          altitude: (alt / 1000).toFixed(2),
          speed: speed.toFixed(2),
        });

        if (Date.now() % 10000 < 1000) {
          fetch(`https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=3c85353f6f0f453785f66953ea6e9fe0`)
            .then(res => res.json())
            .then(data => {
              const place = data.results?.[0]?.components;
              const name = place?.city || place?.state || place?.country || "Over Earth";
              setLocationName(name);
            })
            .catch(() => setLocationName("Unknown"));
        }
      }

      debrisList.current.forEach(({ id, satrec }) => {
        const pv = satellite.propagate(satrec, now);
        const pos = pv?.position;
        if (pos) {
          const geo = satellite.eciToGeodetic(pos, gmst);
          const lon = satellite.degreesLong(geo.longitude);
          const lat = satellite.degreesLat(geo.latitude);
          const alt = geo.height * 1000;
          const cart = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
          const entity = viewer.entities.getById(id);
          if (entity) entity.position = new Cesium.ConstantPositionProperty(cart);
        }
      });

      targetsList.current.forEach(({ id, satrec }) => {
        if (id === "ISS-ZARYA") return;
        const pv = satellite.propagate(satrec, now);
        const pos = pv?.position;
        if (pos) {
          const geo = satellite.eciToGeodetic(pos, gmst);
          const lon = satellite.degreesLong(geo.longitude);
          const lat = satellite.degreesLat(geo.latitude);
          const alt = geo.height * 1000;
          const cart = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
          const entity = viewer.entities.getById(id);
          if (entity) entity.position = new Cesium.ConstantPositionProperty(cart);
        }
      });
    }, UPDATE_INTERVAL_MS);

    collisionWorkerRef.current = new Worker(
      new URL("./collisionWorker.js", import.meta.url),
      { type: "module" }
    );

  

    return () => {
      clearInterval(interval);
      viewer.destroy();
      collisionWorkerRef.current.terminate();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerInstance.current;
    if (!viewer) return;

    debrisList.current.forEach(({ id }) => {
      const entity = viewer.entities.getById(id);
      if (entity) viewer.entities.remove(entity);
    });
    debrisList.current = [];
    tleLinesRef.current = [];
    loadIndex.current = 0;

    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${selectedGroup}&FORMAT=tle`;
    fetch(url)
      .then(res => res.text())
      .then(tleText => {
        tleLinesRef.current = tleText.trim().split("\n");
        loadMoreDebris();
      });
  }, [selectedGroup]);

  const loadMoreDebris = () => {
    const viewer = viewerInstance.current;
    const lines = tleLinesRef.current;
    let count = 0;
    const startIndex = loadIndex.current * BATCH_SIZE * 3;

    for (let i = startIndex; i < lines.length && count < BATCH_SIZE; i += 3) {
      const name = lines[i]?.trim();
      const line1 = lines[i + 1];
      const line2 = lines[i + 2];
      if (!name || !line1 || !line2) continue;

      const id = `${name}_${i / 3}`;
      if (viewer.entities.getById(id)) continue;

      const satrec = satellite.twoline2satrec(line1, line2);

      const debrisGroups = ["iridium-33-debris", "cosmos-2251-debris"];

      if (selectedGroup === "active" || selectedGroup === "starlink" || selectedGroup === "weather" || selectedGroup === "noaa") {
        targetsList.current.push({ id, satrec });
      } else if (debrisGroups.includes(selectedGroup)) {
        debrisList.current.push({ id, satrec });
      }

      const isDebris = debrisGroups.includes(selectedGroup);

viewer.entities.add({
  id,
  name,
  point: {
    pixelSize: 5,
    color: isDebris
      ? Cesium.Color.ORANGE.withAlpha(0.9)
      : Cesium.Color.LIME.withAlpha(0.9),
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 1,
  },
  position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
});


      count++;
    }
    loadIndex.current += 1;
  };

  const clearAllEntities = () => {
    const viewer = viewerInstance.current;
    if (!viewer) return;

    const issEntity = viewer.entities.getById("ISS-ZARYA");
    viewer.entities.removeAll();
    if (issEntity) {
      viewer.entities.add(issEntity);
      viewer.trackedEntity = issEntity;
    }
    debrisList.current = [];
    targetsList.current = [{ id: "ISS-ZARYA", satrec: targetsList.current[0].satrec }];
    launchSatrecRef.current = null;
    tleLinesRef.current = [];
    loadIndex.current = 0;
    setCollisionWarnings([]);
    setLaunchWarnings([]);
  };

 const fetchAndPredictLaunch = async () => {
  const viewer = viewerInstance.current;
  if (!launchInput.trim()) {
    alert("Please enter a satellite name or NORAD Catalog ID.");
    return;
  }

  // Remove any previous launch entity to avoid overlap
  const prevEntity = viewer.entities.getById("CURRENT-LAUNCH");
  if (prevEntity) viewer.entities.remove(prevEntity);

  const encoded = encodeURIComponent(launchInput.trim());
  const url = `https://celestrak.org/NORAD/elements/gp.php?NAME=${encoded}&FORMAT=tle`;

  try {
    const res = await fetch(url);
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 3) {
      alert("No TLE found for this object.");
      return;
    }

    const name = lines[0];
    const line1 = lines[1];
    const line2 = lines[2];

    // Add the new launch entity with a fixed ID
    viewer.entities.add({
      id: "CURRENT-LAUNCH",
      name,
      point: {
        pixelSize: 8,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      label: {
        text: `🚀 ${name}`,
        font: "14pt sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      },
    });

    // 🎯 Attach handler for this simulation
    const handleLaunchMessage = (e) => {
      const { launchCollisions } = e.data;

      setLaunchWarnings(launchCollisions || []);
      setCollisionWarnings([]); // Clear debris vs active warnings

      if (Array.isArray(launchCollisions)) {
        if (launchCollisions.length > 0) {
          alert(`🚀 ${launchCollisions.length} launch collision risks detected!`);
        } else {
          alert("✅ No launch collision risks found.");
        }
      }

      // Remove this handler so it doesn't trigger on other messages
      collisionWorkerRef.current.removeEventListener("message", handleLaunchMessage);
    };

    collisionWorkerRef.current.addEventListener("message", handleLaunchMessage);

    // 🎯 Send prediction request to the worker with TLE lines
    collisionWorkerRef.current.postMessage({
      simulateLaunch: true,
      debrisList: debrisList.current.map(({ id, satrec }) => ({ id, satrec })),
      thresholdKm: COLLISION_THRESHOLD_KM,
      futureMinutes: PREDICTION_MINUTES,
      launchName: name,
      launchTLE: { line1, line2 },
    });

  } catch (err) {
    console.error(err);
    alert("Error fetching TLE.");
  }
};

const buttonStyle = {
  padding: "6px 10px",
  border: "none",
  borderRadius: "4px",
  background: "#333",
  color: "#fff",
  cursor: "pointer",
  fontSize: "13px",
};

const inputStyle = {
  width: "100%",
  padding: "6px",
  borderRadius: "4px",
  border: "1px solid #ccc",
  background: "#222",
  color: "#fff",
};


return (
  <>
    <div style={{ height: "100vh", width: "100vw" }} ref={viewerRef}></div>

    {/* LEFT PANEL */}
    <div
      style={{
        position: "absolute",
        top: 10,
        left: 10,
        padding: "14px",
        background: "rgba(20, 20, 20, 0.85)",
        color: "white",
        borderRadius: "10px",
        fontSize: "14px",
        fontFamily: "monospace",
        zIndex: 999,
        width: "320px",
        boxShadow: "0 0 10px rgba(0,0,0,0.8)",
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: "16px" }}>
        🌐 AstroShield Control Panel
      </h2>

      <section style={{ marginBottom: "12px" }}>
        <strong>🛰️ ISS Real-Time Info</strong>
        <div>Lat: {issInfo.latitude}°</div>
        <div>Lon: {issInfo.longitude}°</div>
        <div>Alt: {issInfo.altitude} km</div>
        <div>Speed: {issInfo.speed} km/h</div>
        <div>Location: {locationName}</div>
      </section>

      <div
        style={{
          marginTop: "10px",
          padding: "6px",
          background: "rgba(0,0,0,0.4)",
          borderRadius: "6px",
          border: "1px solid rgba(255,255,255,0.2)",
          fontSize: "13px",
          lineHeight: "1.5",
        }}
      >
        <div>
          <strong>🛰️ Active Satellites:</strong> {activeCount}
        </div>
        <div>
          <strong>🪨 Debris Objects:</strong> {debrisCount}
        </div>
        <div>
          <strong>🚀 Launch:</strong> {launchCount}
        </div>
        <div>
          <strong>✅ Total Tracked:</strong> {totalCount}
        </div>
      </div>

      <section style={{ marginBottom: "12px" }}>
        <label style={{ fontWeight: "bold" }}>🛰️ Load Satellite / Debris:</label>
        <select
          value={selectedGroup}
          onChange={(e) => setSelectedGroup(e.target.value)}
          style={{
            width: "100%",
            padding: "4px",
            marginTop: "4px",
            borderRadius: "4px",
            border: "1px solid #ccc",
            background: "#222",
            color: "#fff",
          }}
        >
          <optgroup label="Active">
            <option value="starlink">Starlink</option>
            <option value="active">All Active</option>
            <option value="weather">Weather</option>
            <option value="noaa">NOAA</option>
          </optgroup>
          <optgroup label="Debris">
            <option value="iridium-33-debris">Iridium-33 Debris</option>
            <option value="cosmos-2251-debris">Cosmos-2251 Debris</option>
          </optgroup>
        </select>
        <div style={{ marginTop: "6px" }}>
          <button onClick={loadMoreDebris} style={buttonStyle}>
            Load More
          </button>
          <button
            onClick={clearAllEntities}
            style={{ ...buttonStyle, marginLeft: "6px" }}
          >
            Clear All
          </button>
        </div>
      </section>

      <section style={{ marginBottom: "12px" }}>
        <button
          onClick={() => {
            if (
              debrisList.current.length === 0 ||
              targetsList.current.length === 0
            ) {
              alert("Load debris and active satellites first.");
              return;
            }

            const handleCollisionMessage = (e) => {
              const { collisions } = e.data;
              setCollisionWarnings(collisions || []);
              setLaunchWarnings([]);
              collisionWorkerRef.current.removeEventListener(
                "message",
                handleCollisionMessage
              );
            };

            collisionWorkerRef.current.addEventListener(
              "message",
              handleCollisionMessage
            );

            collisionWorkerRef.current.postMessage({
              debrisList: debrisList.current.map(({ id, satrec }) => ({
                id,
                satrec,
              })),
              targetsList: targetsList.current.map(({ id, satrec }) => ({
                id,
                satrec,
              })),
              thresholdKm: COLLISION_THRESHOLD_KM,
              futureMinutes: PREDICTION_MINUTES,
            });
          }}
          style={{
            ...buttonStyle,
            width: "100%",
            background: "#444",
          }}
        >
          🛑 Check Debris vs Active Satellite Collision Risks
        </button>
      </section>

      <section style={{ marginBottom: "12px" }}>
        <label style={{ fontWeight: "bold" }}>🚀 Enter Launch:</label>
        <input
          type="text"
          value={launchInput}
          placeholder="Falcon 9 or NORAD ID"
          onChange={(e) => setLaunchInput(e.target.value)}
          style={inputStyle}
        />
        <button
          onClick={fetchAndPredictLaunch}
          style={{
            ...buttonStyle,
            width: "100%",
            marginTop: "4px",
            background: "#444",
          }}
        >
          Check Launch Risks with Debris
        </button>
      </section>
    </div>

    {/* RIGHT PANEL */}
    <div
      style={{
        position: "absolute",
        top: 100,
        right: 10,
        width: "320px",
        maxHeight: "90vh",
        overflowY: "auto",
        padding: "10px",
        background: "rgba(0,0,0,0.8)",
        color: "white",
        borderRadius: "10px",
        fontFamily: "monospace",
        fontSize: "14px",
        zIndex: 999,
        boxShadow: "0 0 10px rgba(0,0,0,0.8)",
      }}
    >
      {collisionWarnings.length > 0 && (
        <section
          style={{
            marginBottom: "10px",
            padding: "8px",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "6px",
            background: "rgba(0,0,0,0.4)",
            maxHeight: "300px",
            overflowY: "auto",
          }}
        >
          <div
            style={{ fontWeight: "bold", marginBottom: "4px", color: "red" }}
          >
            ⚠️ {collisionWarnings.length} collision risk
            {collisionWarnings.length > 1 ? "s" : ""} detected(Closest Approach)
          </div>
          <div
            style={{
              fontSize: "12px",
              marginBottom: "4px",
              color: "#ccc",
            }}
          >
            Predictions for the next {PREDICTION_MINUTES} minutes
          </div>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {collisionWarnings.map((w, i) => {
              const risk = getRiskLevel(w.distance);
              return (
                <li
                  key={i}
                  style={{
                    marginBottom: "6px",
                    borderBottom: "1px solid rgba(255,255,255,0.1)",
                    paddingBottom: "4px",
                  }}
                >
                  <strong>{w.debrisId}</strong> vs{" "}
                  <strong>{w.targetId}</strong>
                  <br />
                  Distance: {w.distance} km
                  <br />
                  <span style={{ color: risk.color }}>{risk.label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {launchWarnings.length > 0 && (
  <section
    style={{
      marginTop: "10px",
      padding: "8px",
      border: "1px solid rgba(255,255,255,0.2)",
      borderRadius: "6px",
      background: "rgba(0,0,0,0.4)",
      maxHeight: "250px",
      overflowY: "auto",
    }}
  >
    <div
      style={{
        fontWeight: "bold",
        marginBottom: "4px",
        color: "yellow",
      }}
    >
      🚀 {launchWarnings.length} launch collision risk
      {launchWarnings.length > 1 ? "s" : ""} detected
    </div>
    <ul
      style={{
        margin: 0,
        padding: "4px 8px",
        listStyle: "none",
      }}
    >
      {launchWarnings.map((w, i) => {
        const risk = getRiskLevel(w.distance);
        return (
          <li
            key={i}
            style={{
              marginBottom: "4px",
              borderBottom: "1px solid rgba(255,255,255,0.1)",
              paddingBottom: "2px",
            }}
          >
            <strong>{w.launchName}</strong> vs{" "}
            <strong>{w.debrisId}</strong>
            <br />
            Distance: {w.distance} km
            <br />
            <span style={{ color: risk.color }}>{risk.label}</span>
          </li>
        );
      })}
    </ul>
  </section>
)}


</div>

/* LEGEND OUTSIDE THE PANEL */
<div
  style={{
    position: "absolute",
    top: "450px",  // adjust as needed to move it below
    right: "10px",
    padding: "10px",
    background: "rgba(0,0,0,0.8)",
    color: "white",
    borderRadius: "8px",
    fontFamily: "monospace",
    fontSize: "13px",
    zIndex: 999,
    boxShadow: "0 0 6px rgba(0,0,0,0.6)",
    maxWidth: "240px",
  }}
>
  <div style={{ fontWeight: "bold", marginBottom: "6px" }}>🟢 Collision Risk Legend</div>
  <div style={{ marginBottom: "4px" }}>
    <span style={{ color: "red", fontWeight: "bold" }}>Critical</span> – Distance &lt; 10 km
  </div>
  <div style={{ marginBottom: "4px" }}>
    <span style={{ color: "orange", fontWeight: "bold" }}>Moderate</span> – Distance 10–20 km
  </div>
  <div>
    <span style={{ color: "yellow", fontWeight: "bold" }}>Low</span> – Distance &gt; 20 km
  </div>
    </div>
  </>
);
}
export default App;
