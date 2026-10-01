package com.pipod.app.core.auth

import android.content.Intent
import android.net.Uri
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Where the OIDC redirect arrives.
 *
 * The authorization response comes back as a `pipod://auth/callback` intent on
 * the single `MainActivity` (`launchMode="singleTask"`), which is a different
 * object from the coroutine that started the sign-in. This broker is the seam
 * between them: the activity offers every incoming link, the auth service
 * consumes the one it is waiting for.
 *
 * A cold start is the awkward case — the callback lands *before* anything is
 * waiting for it — so the first one is also parked in [pending] and taken
 * exactly once, which is what stops a replayed intent from re-running a
 * finished login.
 */
class AuthCallbackBroker {

    // No replay: a new subscriber never receives an old redirect from the flow
    // itself. The buffer is only a live-delivery shortcut; the park below is the
    // durable copy, taken exactly once, so nothing is ever lost or replayed.
    private val _callbacks = MutableSharedFlow<Uri>(replay = 0, extraBufferCapacity = 8)

    /** Redirects seen while a sign-in was already in flight. */
    val callbacks: SharedFlow<Uri> = _callbacks.asSharedFlow()

    private val parked = AtomicReference<Uri?>(null)

    /**
     * Offers a link that just arrived. Non-callback links are ignored, and so is
     * a callback that carries no authorization result.
     *
     * `pipod://auth/callback` is also this app's `post_logout_redirect_uri`, so
     * signing out delivers a bare one. Parked, it was taken by the very next
     * `signIn()` as though it were an authorization response, failed the state
     * check and reported "That sign-in link doesn't match this attempt" — with
     * no browser ever opening. A stale shortcut or a shared link does the same
     * thing. Only a redirect carrying `code` or `error` is a result.
     */
    fun offer(uri: Uri) {
        if (!isAuthCallback(uri) || !carriesResult(uri)) return
        // Park unconditionally, then also emit for a live waiter. Either copy
        // alone suffices: the park is taken exactly once via [takePending] (the
        // consumer re-checks it `onSubscription`, closing the take-then-
        // subscribe window), and a live emission is confirmed via
        // [confirmDelivered], which clears only this same redirect — a newer
        // offer parked after us keeps its entry because the CAS fails.
        parked.set(uri)
        _callbacks.tryEmit(uri)
    }

    /**
     * Notes that [uri] reached its consumer through the flow, so the parked
     * copy must not be mistaken for an unanswered redirect later. Called by
     * the sign-in waiter for whatever it receives, on either channel.
     */
    fun confirmDelivered(uri: Uri) {
        parked.compareAndSet(uri, null)
    }

    fun offer(intent: Intent?) {
        intent?.data?.let(::offer)
    }

    /** True while a redirect is parked with nothing waiting for it. */
    val hasPending: Boolean get() = parked.get() != null

    /** Takes the parked cold-start callback, if there is one. Single-use. */
    fun takePending(): Uri? = parked.getAndSet(null)

    companion object {
        /**
         * The redirect is recognised the way the Flutter client recognises it —
         * by `auth` host or a `callback` path — so a provider that normalises
         * the URI differently still resolves the login it belongs to.
         */
        fun isAuthCallback(uri: Uri): Boolean =
            uri.host == "auth" || (uri.path?.contains("callback") == true)

        /**
         * Whether this redirect is an authorization *response*. An OIDC
         * provider always answers with one or the other.
         */
        fun carriesResult(uri: Uri): Boolean {
            val query = runCatching {
                !uri.getQueryParameter("code").isNullOrEmpty() ||
                    !uri.getQueryParameter("error").isNullOrEmpty()
            }
            return query.getOrDefault(false)
        }
    }
}
