package com.ugcs.bridge;

import com.ugcs.ucs.client.Client;
import com.ugcs.ucs.client.ClientSession;

/**
 * Utility class that encapsulates the standard UgCS client lifecycle:
 * connect -> authorize -> login -> execute operation -> close.
 *
 * This keeps endpoint methods short and ensures every request starts from a
 * clean SDK session.
 */
public final class UgcsSessionRunner {

    private final BridgeConfig config;

    public UgcsSessionRunner(BridgeConfig config) {
        this.config = config;
    }

    /**
     * Executes user-provided SDK logic inside a fully initialized session.
     */
    public <T> T run(SessionWork<T> work) throws Exception {
        try (Client client = new Client(config.ugcsSocketAddress())) {
            client.connect();

            ClientSession session = new ClientSession(client);
            session.authorizeHci();
            session.login(config.ugcsLogin(), config.ugcsPassword());

            return work.execute(session);
        }
    }

    @FunctionalInterface
    public interface SessionWork<T> {
        T execute(ClientSession session) throws Exception;
    }
}
