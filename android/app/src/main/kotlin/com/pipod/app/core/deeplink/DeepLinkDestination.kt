package com.pipod.app.core.deeplink

import android.net.Uri

/**
 * Destinations a link or a push payload can name: a pod session (optionally
 * resumed at `fromSeq`), or a job that never spawned a pod.
 *
 * Port of `pi-pod-flutter/lib/core/deeplink/deep_link.dart`. [location] is a
 * navigation route in the same path vocabulary the Flutter router uses, so the
 * two clients answer the same link identically.
 */
data class DeepLinkDestination(
    val podId: String? = null,
    val orgId: String? = null,
    val sessionId: String? = null,
    val fromSeq: Long? = null,
    val jobId: String? = null,
) {

    val isEmpty: Boolean
        get() = podId.isNullOrEmpty() && jobId == null

    /**
     * Where to navigate: a pod opens its session, a job without a pod opens the
     * job, and anything else lands on the pod list.
     */
    val location: String
        get() {
            if (!podId.isNullOrEmpty()) {
                val parameters = buildList {
                    fromSeq?.let { add("fromSeq" to "$it") }
                    if (!sessionId.isNullOrEmpty()) add("sessionId" to sessionId)
                }
                val query = if (parameters.isEmpty()) {
                    ""
                } else {
                    "?" + parameters.joinToString("&") { (key, value) ->
                        "$key=${Uri.encode(value)}"
                    }
                }
                // `Uri.getPathSegments()` percent-decodes, so `pipod://pod/a%2Fb`
                // arrives here as the id `a/b`. Interpolated raw it becomes a
                // five-segment location no route pattern can match, and
                // `NavController.navigate` answers that with a throw — from an
                // exported activity any installed app can fire. The query
                // parameters beside it were always encoded; the ids were not.
                return "/pods/${Uri.encode(podId)}/session$query"
            }
            if (!jobId.isNullOrEmpty()) return "/jobs/${Uri.encode(jobId)}"
            return "/pods"
        }

    companion object {

        /**
         * Navigation location for a platform URI.
         *
         * Android delivers the custom scheme as-is (`pipod://auth/callback?code=…`)
         * and the route table only knows path-style locations, so the rewrite
         * happens here rather than failing to match a route.
         */
        fun routerLocationFor(uri: Uri): String? {
            val custom = asPipodUri(uri) ?: return null
            if (isAuthCallback(custom)) {
                val query = custom.query?.takeIf { it.isNotEmpty() }?.let { "?$it" }.orEmpty()
                return "/auth/callback$query"
            }
            return fromUri(custom)?.location
        }

        private fun asPipodUri(uri: Uri): Uri? {
            if (uri.scheme == "pipod") return uri
            // A link that arrives already flattened into the path is still ours.
            val raw = uri.path?.takeIf { it.isNotEmpty() } ?: uri.toString()
            return if (raw.startsWith("pipod:")) runCatching { Uri.parse(raw) }.getOrNull() else null
        }

        private fun isAuthCallback(uri: Uri): Boolean {
            if (uri.host == "auth") return true
            val path = uri.path.orEmpty()
            return path.contains("auth/callback") || path == "/callback" || path.endsWith("/callback")
        }

        /**
         * `pipod://pod/<id>`, `pipod://job/<id>`,
         * plus the triple-slash spelling and in-app http(s) paths.
         */
        fun fromUri(uri: Uri): DeepLinkDestination? {
            val scheme = uri.scheme
            if (scheme == null || scheme.isEmpty() || scheme == "http" || scheme == "https") {
                return fromAppPath(uri)
            }
            if (scheme != "pipod") return null
            if (uri.host == "auth" || uri.path.orEmpty().contains("auth/callback")) return null

            val parts = uri.pathSegments.filter { it.isNotEmpty() }
            val host = uri.host.orEmpty()
            val kind: String
            val id: String
            when {
                host.isNotEmpty() && parts.isNotEmpty() -> {
                    kind = host
                    id = parts.first()
                }

                parts.size >= 2 -> {
                    kind = parts[0]
                    id = parts[1]
                }

                else -> return null
            }
            return when (kind) {
                "pod" -> DeepLinkDestination(
                    podId = id,
                    sessionId = uri.getQueryParameter("sessionId") ?: uri.getQueryParameter("session_id"),
                    fromSeq = integer(
                        uri.getQueryParameter("fromSeq") ?: uri.getQueryParameter("from_seq"),
                    ),
                )

                "job" -> DeepLinkDestination(jobId = id)
                else -> null
            }
        }

        fun fromAppPath(uri: Uri): DeepLinkDestination? {
            val parts = uri.pathSegments.filter { it.isNotEmpty() }
            if (parts.size >= 3 && parts[0] == "pods" && parts[2] == "session") {
                return DeepLinkDestination(
                    podId = parts[1],
                    sessionId = uri.getQueryParameter("sessionId"),
                    fromSeq = integer(uri.getQueryParameter("fromSeq")),
                )
            }
            if (parts.size >= 2 && parts[0] == "jobs") return DeepLinkDestination(jobId = parts[1])
            return null
        }

        /** Push payload (spec §11 keys). */
        fun fromPayload(payload: Map<String, Any?>): DeepLinkDestination? {
            val podId = payload["pod_id"] as? String ?: ""
            val jobId = payload["job_id"] as? String
            if (podId.isEmpty() && jobId == null) return null
            return DeepLinkDestination(
                podId = podId.ifEmpty { null },
                orgId = payload["org_id"] as? String,
                sessionId = payload["session_id"] as? String,
                fromSeq = integer(payload["seq"]),
                jobId = jobId,
            )
        }

        private fun integer(value: Any?): Long? = when (value) {
            is Long -> value
            is Int -> value.toLong()
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }
    }
}
