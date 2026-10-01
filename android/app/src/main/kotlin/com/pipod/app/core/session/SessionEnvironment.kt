package com.pipod.app.core.session

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.flow.StateFlow

/**
 * The two process-wide facts a [SessionStream] needs and cannot be handed.
 *
 * The session screen builds its stream from a pod and a REST client; it has no
 * reference to the object graph, and threading one through every route, view
 * model and screen to deliver two singletons would be a worse trade than a
 * named install point. `AppContainer` sets both once at start-up:
 *
 *  * [transportFactory] so the session socket reuses the app's one connection
 *    pool instead of building an `OkHttpClient` — with its own dispatcher,
 *    thread pool and connection pool — per attach, and never releasing it.
 *  * [connectivity] so a stream knows the device went offline without the
 *    session screen having to observe it and push the answer down.
 *
 * All three are null until installed, and a stream given an explicit value in
 * its constructor (every unit test) ignores what is installed here.
 */
object SessionEnvironment {

    @Volatile
    var transportFactory: SessionTransportFactory? = null

    /** True while the device has a validated network. */
    @Volatile
    var connectivity: StateFlow<Boolean>? = null

    /**
     * The shared WebSocket factory the account-login socket uses when the
     * caller supplies none. Installed by `AppContainer` from the app's one
     * connection pool; see [transportFactory] for why it must be shared.
     */
    @Volatile
    var loginSocketFactory: okhttp3.WebSocket.Factory? = null

    /** Test seam: forgets whatever a previous test or `AppContainer` installed. */
    fun reset() {
        transportFactory = null
        connectivity = null
        loginSocketFactory = null
    }
}

/**
 * Every session stream currently attached to a pod.
 *
 * Signing out has to reach them. The streams are owned by view models the
 * session store has never heard of, and without this registry a sign-out left
 * the socket open: the gateway kept streaming somebody else's conversation into
 * a process that had just discarded its credentials, and the transcript was
 * still on screen when the next person signed in.
 *
 * A stream registers when it attaches and unregisters when it is disposed, so
 * the list holds only what is genuinely live.
 */
object LiveSessionStreams {

    private val streams = CopyOnWriteArrayList<SessionStream>()

    val count: Int get() = streams.size

    fun register(stream: SessionStream) {
        if (!streams.contains(stream)) streams += stream
    }

    fun unregister(stream: SessionStream) {
        streams -= stream
    }

    /**
     * Disposes every live stream, closing its transport. Called when the session
     * is cleared; a stream that throws on the way down must not keep the rest
     * attached.
     */
    fun disposeAll() {
        val live = streams.toList()
        streams.clear()
        for (stream in live) {
            try {
                stream.dispose()
            } catch (_: Throwable) {
                // Best effort: the credentials are already gone either way.
            }
        }
    }
}
