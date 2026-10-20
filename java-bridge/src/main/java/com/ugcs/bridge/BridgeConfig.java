package com.ugcs.bridge;

import java.net.InetSocketAddress;
import java.util.Objects;

/**
 * Holds all runtime configuration for the Java bridge.
 *
 * Values are read from environment variables so this service can be deployed
 * in different environments without changing code.
 */
public final class BridgeConfig {

    private final int bridgePort;
    private final String ugcsHost;
    private final int ugcsPort;
    private final String ugcsLogin;
    private final String ugcsPassword;

    private BridgeConfig(int bridgePort, String ugcsHost, int ugcsPort, String ugcsLogin, String ugcsPassword) {
        this.bridgePort = bridgePort;
        this.ugcsHost = Objects.requireNonNull(ugcsHost, "ugcsHost");
        this.ugcsPort = ugcsPort;
        this.ugcsLogin = Objects.requireNonNull(ugcsLogin, "ugcsLogin");
        this.ugcsPassword = Objects.requireNonNull(ugcsPassword, "ugcsPassword");
    }

    /**
     * Build config from environment variables.
     * Defaults are provided for local development convenience.
     */
    private static String readRequired(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(
                "Missing required environment variable: " + name
            );
        }
        return value;
    }
    public static BridgeConfig fromEnvironment() {
        return new BridgeConfig(
            readInt("UGCS_BRIDGE_PORT", 8090),
            readString("UGCS_HOST", "127.0.0.1"),
            readInt("UGCS_PORT", 3334),
            readRequired("UGCS_LOGIN"),
            readRequired("UGCS_PASSWORD")
        );
    }

    public int bridgePort() {
        return bridgePort;
    }

    public String ugcsHost() {
        return ugcsHost;
    }

    public int ugcsPort() {
        return ugcsPort;
    }

    public String ugcsLogin() {
        return ugcsLogin;
    }

    public String ugcsPassword() {
        return ugcsPassword;
    }

    public InetSocketAddress ugcsSocketAddress() {
        return new InetSocketAddress(ugcsHost, ugcsPort);
    }

    private static int readInt(String key, int fallback) {
        String raw = System.getenv(key);
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static String readString(String key, String fallback) {
        String raw = System.getenv(key);
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        return raw.trim();
    }
}
