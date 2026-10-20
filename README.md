# UgCS Mission Control Bridge

**Portfolio review draft — not yet approved for public release.**

Experimental UAS ground-control and mission-planning application combining a browser UI, Node.js service layer, Java UgCS SDK bridge, and simulation tools.

## Feature status

| Component | Status | Notes |
|---|---|---|
| Web mission planning and command interface | Implemented in source; unverified in this copy | Browser-based mission and vehicle UI |
| Node REST/WebSocket service | Implemented in source; unverified | See `backend/` and `ugcs/router.js` |
| Mock vehicles and telemetry | Implemented in source; unverified | Local simulated operations, no aircraft required |
| Mission import/export and profiles | Implemented in source; unverified | `ugcs/mission-io.js`, `ugcs/profiles-store.js` |
| Java UgCS SDK integration | Integration path; requires UgCS and validation | `java-bridge/` |
| MAVLink serial communication | **Experimental** | Not flight-qualified or safety validated |
| LAANC/USS integration | **Prototype / mock** | Mock responses are **not FAA airspace authorizations**; external API may be unavailable |
| External enterprise application integration | **Not implemented** | Removed from the public-facing project description |

## Architecture

- `frontend/`: basic browser status and command UI
- `public/ugcs-map.html`: mission planning map
- `backend/`: Node.js server and UgCS bridge client
- `ugcs/`: mock simulator, MAVLink, mission data, profiles, routing, and LAANC prototype
- `java-bridge/`: Java SDK service for UgCS
- `scripts/`: local Windows startup utilities

## Local development (mock mode)

Requires Node.js 20+ and npm. From the project root:

```powershell
Copy-Item .env.example .env
npm ci
npm start
```

`.env.example` defaults to `MOCK_MODE=true`. Visit `http://localhost:3000` after startup. Actual endpoint behavior and simulator operation have **not been validated in this review package**.

Do not connect this software to an actual aircraft without independent review, hardware-in-the-loop testing, safety controls, and authorization.

## Publication checklist

- [ ] Confirm scope of written permission, including all source files and third-party assets
- [ ] Review dependencies, licenses, and embedded assets
- [ ] Scan all source files and historical copies for credentials and internal endpoints
- [ ] Verify mock mode and capture screenshots
- [ ] Test Java package rename with Maven and confirm UgCS SDK licensing
- [ ] Review `ARCHITECTURE_LEGACY.md` and remove any non-public details before publishing
- [ ] Confirm LAANC behavior and clearly label simulation

**No assertion is made that this project is flight-ready, production-ready, or FAA-authorized.**

## Validation and Known Limitations

- **Mock mode:** Browser interface, simulated vehicle telemetry, waypoint interaction, and mission save/reload tested locally.
- **Java UgCS bridge:** Compiled successfully using Java 17 and Maven; connection to a live UgCS installation has not been validated.
- **MAVLink:** Experimental integration; physical vehicle and serial hardware testing not completed.
- **LAANC:** Prototype functionality; not an operational authorization service.
- **Map layers:** Esri satellite imagery tested locally. The Street map toggle currently uses a CARTO tile endpoint that may display an API-key-required message.
- **Operational safety:** Development and demonstration software only. Not validated for safety-critical flight operations. Live deployments require appropriate authentication, network security, testing, and regulatory compliance.

Third-party map imagery and tiles remain subject to their providers' licensing, attribution, and usage requirements.
