package com.ugcs.bridge;

import com.ugcs.ucs.client.Client;
import com.ugcs.ucs.client.ClientSession;
import com.ugcs.ucs.client.ServerNotification;
import com.ugcs.ucs.client.ServerNotificationListener;
import com.ugcs.ucs.proto.DomainProto;
import com.ugcs.ucs.proto.DomainProto.EventWrapper;
import com.ugcs.ucs.proto.DomainProto.Subsystem;
import com.ugcs.ucs.proto.DomainProto.Telemetry;
import com.ugcs.ucs.proto.DomainProto.TelemetryEvent;
import com.ugcs.ucs.proto.DomainProto.TelemetryField;
import com.ugcs.ucs.proto.DomainProto.Value;
import com.ugcs.ucs.proto.DomainProto.Vehicle;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Keeps a background subscription to UgCS telemetry events and caches the
 * latest values per vehicle for quick REST responses.
 */
public final class TelemetryCollector {

    private static final Logger LOG = LoggerFactory.getLogger(TelemetryCollector.class);

    private final BridgeConfig config;
    private final ConcurrentMap<Integer, VehicleSnapshot> snapshots = new ConcurrentHashMap<>();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private Thread worker;

    public TelemetryCollector(BridgeConfig config) {
        this.config = config;
    }

    public void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }

        worker = new Thread(this::runLoop, "ugcs-telemetry-collector");
        worker.setDaemon(true);
        worker.start();
    }

    public void stop() {
        running.set(false);
        if (worker != null) {
            worker.interrupt();
            try {
                worker.join(2_000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public boolean isRunning() {
        return running.get();
    }

    public List<VehicleTelemetry> getAllTelemetry() {
        List<VehicleTelemetry> output = new ArrayList<>();
        for (VehicleSnapshot snapshot : snapshots.values()) {
            output.add(snapshot.toView());
        }
        return output;
    }

    public Optional<VehicleTelemetry> getVehicleTelemetry(int vehicleId) {
        VehicleSnapshot snapshot = snapshots.get(vehicleId);
        return snapshot == null ? Optional.empty() : Optional.of(snapshot.toView());
    }

    private void runLoop() {
        while (running.get()) {
            try (Client client = new Client(config.ugcsSocketAddress())) {
                client.addNotificationListener(new TelemetryListener());
                client.connect();

                ClientSession session = new ClientSession(client);
                session.authorizeHci();
                session.login(config.ugcsLogin(), config.ugcsPassword());
                int subscriptionId = session.subscribeTelemetryEvent();

                LOG.info("Telemetry subscription active (id={})", subscriptionId);
                try {
                    while (running.get()) {
                        Thread.sleep(1_000L);
                    }
                } finally {
                    try {
                        session.unsubscribe(subscriptionId);
                    } catch (Exception unsubscribeError) {
                        LOG.warn("Failed to unsubscribe telemetry cleanly: {}", unsubscribeError.getMessage());
                    }
                }
            } catch (Exception error) {
                if (running.get()) {
                    LOG.warn("Telemetry collector disconnected, retrying in 3s: {}", error.getMessage());
                    sleepQuietly(3_000L);
                }
            }
        }
    }

    private void updateFromEvent(TelemetryEvent telemetryEvent) {
        if (telemetryEvent == null || !telemetryEvent.hasVehicle()) {
            return;
        }

        Vehicle vehicle = telemetryEvent.getVehicle();
        int vehicleId = vehicle.getId();
        VehicleSnapshot snapshot = snapshots.computeIfAbsent(vehicleId, id -> new VehicleSnapshot());
        snapshot.vehicleId = vehicleId;
        snapshot.vehicleName = vehicle.getName();
        snapshot.tailNumber = vehicle.getTailNumber();

        for (Telemetry telemetry : telemetryEvent.getTelemetryList()) {
            TelemetryField field = telemetry.getTelemetryField();
            String key = field == null ? "unknown" : formatFieldCode(field);
            String value = formatValue(telemetry.getValue());
            snapshot.fields.put(key, value);

            long telemetryTime = telemetry.getTime();
            if (telemetryTime > 0L) {
                snapshot.lastUpdateMs = telemetryTime;
            } else {
                snapshot.lastUpdateMs = System.currentTimeMillis();
            }
        }

        if (telemetryEvent.getTelemetryCount() == 0) {
            snapshot.lastUpdateMs = System.currentTimeMillis();
        }
    }

    private static String formatFieldCode(TelemetryField field) {
        String code = field.getCode();
        if (field.getSubsystem() == Subsystem.S_FLIGHT_CONTROLLER) {
            return code;
        }
        return field.getSubsystem() + "." + code;
    }

    private static String formatValue(Value value) {
        if (value == null) {
            return "";
        }
        if (value.hasFloatValue()) {
            return String.valueOf(value.getFloatValue());
        }
        if (value.hasDoubleValue()) {
            return String.valueOf(value.getDoubleValue());
        }
        if (value.hasIntValue()) {
            return String.valueOf(value.getIntValue());
        }
        if (value.hasLongValue()) {
            return String.valueOf(value.getLongValue());
        }
        if (value.hasBoolValue()) {
            return String.valueOf(value.getBoolValue());
        }
        if (value.hasStringValue()) {
            return value.getStringValue();
        }
        return "";
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Immutable API view returned to REST callers.
     */
    public record VehicleTelemetry(
        int vehicleId,
        String vehicleName,
        String tailNumber,
        long lastUpdateMs,
        Map<String, String> fields
    ) {}

    /**
     * Internal mutable state optimized for frequent updates.
     */
    private static final class VehicleSnapshot {
        private volatile int vehicleId;
        private volatile String vehicleName = "";
        private volatile String tailNumber = "";
        private volatile long lastUpdateMs;
        private final ConcurrentMap<String, String> fields = new ConcurrentHashMap<>();

        private VehicleTelemetry toView() {
            return new VehicleTelemetry(
                vehicleId,
                vehicleName,
                tailNumber,
                lastUpdateMs,
                new TreeMap<>(fields)
            );
        }
    }

    private final class TelemetryListener implements ServerNotificationListener {
        @Override
        public void notificationReceived(ServerNotification event) {
            EventWrapper wrapper = event == null ? null : event.getEvent();
            if (wrapper == null || !wrapper.hasTelemetryEvent()) {
                return;
            }
            updateFromEvent(wrapper.getTelemetryEvent());
        }
    }
}
