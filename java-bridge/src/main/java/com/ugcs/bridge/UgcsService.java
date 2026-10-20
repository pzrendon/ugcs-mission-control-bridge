package com.ugcs.bridge;

import com.ugcs.ucs.client.ClientSession;
import com.ugcs.ucs.proto.DomainProto.Command;
import com.ugcs.ucs.proto.DomainProto.CommandArgument;
import com.ugcs.ucs.proto.DomainProto.DomainObjectWrapper;
import com.ugcs.ucs.proto.DomainProto.ProcessedRoute;
import com.ugcs.ucs.proto.DomainProto.Route;
import com.ugcs.ucs.proto.DomainProto.Subsystem;
import com.ugcs.ucs.proto.DomainProto.Value;
import com.ugcs.ucs.proto.DomainProto.Vehicle;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Core domain logic used by REST endpoints.
 *
 * Responsibilities:
 * - list missions (UgCS routes)
 * - list vehicles
 * - upload route to a specific vehicle
 * - send direct commands (arm/takeoff/rth/land)
 * - expose cached telemetry from TelemetryCollector
 */
public final class UgcsService {

    private final UgcsSessionRunner sessionRunner;
    private final TelemetryCollector telemetryCollector;

    public UgcsService(UgcsSessionRunner sessionRunner, TelemetryCollector telemetryCollector) {
        this.sessionRunner = sessionRunner;
        this.telemetryCollector = telemetryCollector;
    }

    public List<MissionDto> listMissions() throws Exception {
        return sessionRunner.run(session -> {
            List<MissionDto> missions = new ArrayList<>();
            for (DomainObjectWrapper wrapper : session.getObjectList(Route.class)) {
                if (wrapper == null || !wrapper.hasRoute()) {
                    continue;
                }
                Route route = wrapper.getRoute();
                String parentMissionName = route.hasMission() ? route.getMission().getName() : "";
                missions.add(new MissionDto(route.getId(), route.getName(), parentMissionName));
            }
            missions.sort(Comparator.comparing(MissionDto::name, String.CASE_INSENSITIVE_ORDER));
            return missions;
        });
    }

    public List<VehicleDto> listVehicles() throws Exception {
        return sessionRunner.run(session -> {
            List<VehicleDto> vehicles = new ArrayList<>();
            for (DomainObjectWrapper wrapper : session.getObjectList(Vehicle.class)) {
                if (wrapper == null || !wrapper.hasVehicle()) {
                    continue;
                }
                Vehicle vehicle = wrapper.getVehicle();
                String profileName = vehicle.hasProfile() ? vehicle.getProfile().getName() : "";
                vehicles.add(new VehicleDto(
                    vehicle.getId(),
                    vehicle.getName(),
                    vehicle.getTailNumber(),
                    profileName
                ));
            }
            vehicles.sort(Comparator.comparing(VehicleDto::name, String.CASE_INSENSITIVE_ORDER));
            return vehicles;
        });
    }

    public Map<String, Object> uploadMission(int missionId, int vehicleId) throws Exception {
        return sessionRunner.run(session -> {
            Route route = findRoute(session, missionId);
            Vehicle vehicle = findVehicle(session, vehicleId);

            // UgCS requires vehicle control lock before upload operations.
            session.gainVehicleControl(vehicle);
            try {
                ProcessedRoute processedRoute = session.processRoute(route);
                session.uploadRoute(vehicle, processedRoute);
            } finally {
                session.releaseVehicleControl(vehicle);
            }

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("status", "ok");
            response.put("message", "Mission uploaded to vehicle.");
            response.put("missionId", missionId);
            response.put("missionName", route.getName());
            response.put("vehicleId", vehicleId);
            response.put("vehicleName", vehicle.getName());
            return response;
        });
    }

    public Map<String, Object> sendCommand(int vehicleId, String commandName, Double takeoffAltitudeM) throws Exception {
        return sessionRunner.run(session -> {
            Vehicle vehicle = findVehicle(session, vehicleId);
            Command command = buildCommand(commandName, takeoffAltitudeM);

            // Lock vehicle control for safer direct command execution.
            session.gainVehicleControl(vehicle);
            try {
                session.sendCommand(vehicle, command);
            } finally {
                session.releaseVehicleControl(vehicle);
            }

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("status", "ok");
            response.put("message", "Command sent successfully.");
            response.put("vehicleId", vehicleId);
            response.put("vehicleName", vehicle.getName());
            response.put("command", commandName);
            response.put("ugcsCommandCode", command.getCode());
            return response;
        });
    }

    public List<TelemetryCollector.VehicleTelemetry> getAllTelemetry() {
        return telemetryCollector.getAllTelemetry();
    }

    public Optional<TelemetryCollector.VehicleTelemetry> getTelemetryForVehicle(int vehicleId) {
        return telemetryCollector.getVehicleTelemetry(vehicleId);
    }

    private static Route findRoute(ClientSession session, int routeId) throws Exception {
        for (DomainObjectWrapper wrapper : session.getObjectList(Route.class)) {
            if (wrapper != null && wrapper.hasRoute() && wrapper.getRoute().getId() == routeId) {
                return wrapper.getRoute();
            }
        }
        throw new IllegalArgumentException("Mission/route not found: " + routeId);
    }

    private static Vehicle findVehicle(ClientSession session, int vehicleId) throws Exception {
        for (DomainObjectWrapper wrapper : session.getObjectList(Vehicle.class)) {
            if (wrapper != null && wrapper.hasVehicle() && wrapper.getVehicle().getId() == vehicleId) {
                return wrapper.getVehicle();
            }
        }
        throw new IllegalArgumentException("Vehicle not found: " + vehicleId);
    }

    private static Command buildCommand(String commandName, Double takeoffAltitudeM) {
        if (commandName == null || commandName.isBlank()) {
            throw new IllegalArgumentException("Command is required.");
        }

        String normalized = commandName.trim().toLowerCase();
        String ugcsCode;
        switch (normalized) {
            case "arm":
                ugcsCode = "arm";
                break;
            case "takeoff":
                ugcsCode = "takeoff_command";
                break;
            case "rth":
                ugcsCode = "return_to_home";
                break;
            case "land":
                ugcsCode = "land_command";
                break;
            default:
                throw new IllegalArgumentException("Unsupported command: " + commandName);
        }

        Command.Builder builder = Command.newBuilder()
            .setCode(ugcsCode)
            .setSubsystem(Subsystem.S_FLIGHT_CONTROLLER)
            .setSubsystemId(0);

        // Optional takeoff altitude argument. This is ignored for non-takeoff commands.
        if ("takeoff".equals(normalized) && takeoffAltitudeM != null) {
            builder.addArguments(
                CommandArgument.newBuilder()
                    .setCode("altitude_agl")
                    .setValue(Value.newBuilder().setDoubleValue(takeoffAltitudeM))
            );
        }

        return builder.build();
    }

    public record MissionDto(int id, String name, String parentMissionName) {}

    public record VehicleDto(int id, String name, String tailNumber, String profileName) {}
}
