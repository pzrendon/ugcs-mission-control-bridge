# UgCS Mission Control Bridge — Architecture

## Overview

An experimental unmanned aircraft mission-control application combining a browser-based ground control interface, Node.js backend, optional Java UgCS SDK bridge, and simulation tools.

The project explores mission planning, telemetry visualization, vehicle command interfaces, and interoperability between ground-control software and UAS systems.

This is an engineering prototype, not certified flight-control software.

## System Architecture

### Mock Mode

Browser UI → Node.js backend → Mock vehicle server

Provides simulated vehicles, telemetry, missions, commands, and flight logs for local development and demonstration.

### MAVLink Mode — Experimental

Browser UI → Node.js backend → MAVLink serial bridge → Flight controller

Implements a serial MAVLink integration path. Hardware interoperability, command handling, and operational safety have not been validated.

### UgCS Integration — Experimental

The project includes two UgCS integration paths:

- Node.js proxy for UgCS HTTP/WebSocket interfaces used by the mission-planning map.
- Java bridge using the UgCS SDK for separate application API endpoints.

These paths require compatible UgCS installations and additional integration testing.

## Major Components

| Component | Responsibility |
|---|---|
| `public/ugcs-map.html` | Mission planning, map visualization, vehicle controls, and telemetry |
| `backend/server.js` | HTTP server, static assets, and API routing |
| `ugcs/router.js` | Operating-mode selection and UgCS request forwarding |
| `ugcs/mock-server.js` | Simulated vehicles, missions, commands, and telemetry |
| `ugcs/mavlink-bridge.js` | Experimental MAVLink serial integration |
| `ugcs/mission-io.js` | Mission import and export |
| `ugcs/database.js` | Local SQLite data storage |
| `ugcs/laanc-client.js` | Prototype airspace authorization integration |
| `java-bridge/` | Java-based UgCS SDK integration |
| `frontend/` | Separate starter interface using the Java bridge |

## Interfaces

The Node.js application exposes REST endpoints for vehicle information, mission management, profiles, and commands.

WebSocket interfaces support telemetry updates.

The Java bridge provides a separate integration path for UgCS SDK functionality.

Exact endpoint behavior depends on the selected operating mode.

## Feature Maturity

| Capability | Status |
|---|---|
| Browser mission-planning interface | Tested in mock mode |
| Simulated vehicles and telemetry | Tested locally |
| Waypoint creation and mission persistence | Tested in mock mode |
| Simulated arm and takeoff commands | Tested in mock mode |
| Mission import/export | Implemented; full format validation pending |
| MAVLink serial integration | Experimental; hardware testing pending |
| Java UgCS SDK bridge | Implemented; live integration validation pending |
| LAANC/USS integration | Prototype/mock; not an FAA authorization service |

## Safety and Deployment Limitations

This project is intended for development, simulation, and engineering demonstrations.

Mock responses must never be interpreted as actual vehicle states or FAA airspace authorizations.

Live vehicle operation requires independent software review, appropriate authentication and access controls, hardware-in-the-loop validation, operational risk assessment, and compliance with applicable regulations.

Do not expose the application as a public flight-control service without a dedicated security review.

## Local Development

Mock mode is the recommended starting configuration.

1. Install dependencies using `npm install`.
2. Set `MOCK_MODE=true` and `MAVLINK_MODE=false`.
3. Start the application using `npm start`.
4. Open `http://localhost:3000/ugcs-map.html`.

See `README.md` and `.env.example` for additional configuration information.
