package com.ugcs.bridge;

import io.javalin.Javalin;
import io.javalin.http.Context;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Java bridge entry point.
 *
 * Exposes REST API that Node.js calls:
 * - GET /health
 * - GET /api/missions
 * - GET /api/vehicles
 * - POST /api/missions/{missionId}/upload
 * - POST /api/commands
 * - GET /api/telemetry[?vehicleId=...]
 */
public final class App {

    private static final Logger LOG = LoggerFactory.getLogger(App.class);

    private App() {
    }

    public static void main(String[] args) {
        BridgeConfig config = BridgeConfig.fromEnvironment();
        UgcsSessionRunner sessionRunner = new UgcsSessionRunner(config);
        TelemetryCollector telemetryCollector = new TelemetryCollector(config);
        UgcsService ugcsService = new UgcsService(sessionRunner, telemetryCollector);

        telemetryCollector.start();

        Javalin app = Javalin.create(cfg -> cfg.showJavalinBanner = false)
            .start(config.bridgePort());

        // Stop telemetry thread gracefully when the JVM exits.
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            telemetryCollector.stop();
            app.stop();
        }));

        app.get("/health", ctx -> {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("status", "ok");
            payload.put("bridgePort", config.bridgePort());
            payload.put("ugcsHost", config.ugcsHost());
            payload.put("ugcsPort", config.ugcsPort());
            payload.put("telemetryCollectorRunning", telemetryCollector.isRunning());
            ctx.json(payload);
        });

        app.get("/api/missions", ctx -> runEndpoint(ctx, () -> {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("missions", ugcsService.listMissions());
            return payload;
        }));

        app.get("/api/vehicles", ctx -> runEndpoint(ctx, () -> {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("vehicles", ugcsService.listVehicles());
            return payload;
        }));

        app.post("/api/missions/{missionId}/upload", ctx -> runEndpoint(ctx, () -> {
            int missionId = Integer.parseInt(ctx.pathParam("missionId"));
            UploadMissionRequest request = ctx.bodyAsClass(UploadMissionRequest.class);
            if (request == null || request.vehicleId == null) {
                throw new IllegalArgumentException("vehicleId is required.");
            }
            return ugcsService.uploadMission(missionId, request.vehicleId);
        }));

        app.post("/api/commands", ctx -> runEndpoint(ctx, () -> {
            CommandRequest request = ctx.bodyAsClass(CommandRequest.class);
            if (request == null || request.vehicleId == null) {
                throw new IllegalArgumentException("vehicleId is required.");
            }
            if (request.command == null || request.command.isBlank()) {
                throw new IllegalArgumentException("command is required.");
            }
            return ugcsService.sendCommand(request.vehicleId, request.command, request.takeoffAltitudeM);
        }));

        app.get("/api/telemetry", ctx -> runEndpoint(ctx, () -> {
            String vehicleIdRaw = ctx.queryParam("vehicleId");
            Map<String, Object> payload = new LinkedHashMap<>();

            if (vehicleIdRaw == null || vehicleIdRaw.isBlank()) {
                payload.put("telemetry", ugcsService.getAllTelemetry());
                return payload;
            }

            int vehicleId = Integer.parseInt(vehicleIdRaw);
            payload.put("vehicleId", vehicleId);
            payload.put("telemetry", ugcsService.getTelemetryForVehicle(vehicleId).orElse(null));
            return payload;
        }));

        LOG.info(
            "UgCS Java bridge started on port {}. UgCS target: {}:{}",
            config.bridgePort(),
            config.ugcsHost(),
            config.ugcsPort()
        );
    }

    /**
     * Shared endpoint wrapper for consistent error handling.
     */
    private static void runEndpoint(Context ctx, EndpointWork work) {
        try {
            Object response = work.execute();
            ctx.status(200).json(response);
        } catch (IllegalArgumentException badRequest) {
            ctx.status(400).json(errorPayload(badRequest));
        } catch (Exception error) {
            LOG.error("Endpoint failed", error);
            ctx.status(500).json(errorPayload(error));
        }
    }

    private static Map<String, String> errorPayload(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) {
            message = error.getClass().getSimpleName();
        }
        return Map.of("error", message);
    }

    @FunctionalInterface
    private interface EndpointWork {
        Object execute() throws Exception;
    }

    /**
     * Request body model: POST /api/missions/{missionId}/upload
     */
    public static final class UploadMissionRequest {
        public Integer vehicleId;
    }

    /**
     * Request body model: POST /api/commands
     */
    public static final class CommandRequest {
        public Integer vehicleId;
        public String command;
        public Double takeoffAltitudeM;
    }
}
