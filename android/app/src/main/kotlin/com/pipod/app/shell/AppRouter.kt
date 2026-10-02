package com.pipod.app.shell

import androidx.navigation.NavHostController
import androidx.navigation.NavOptionsBuilder

/**
 * The app's route vocabulary.
 *
 * The patterns are the same locations the Flutter client uses, so a push
 * payload, a `pipod://` link and a shared URL resolve to the same screen on both
 * clients. Navigation-compose wants a pattern with `{}` placeholders while
 * `DeepLinkDestination` produces a concrete path, which is why [Routes] holds
 * both spellings.
 */
object Routes {
    const val AUTH_CALLBACK = "auth/callback?code={code}&state={state}&error={error}"
    const val SIGN_IN = "sign-in"

    const val PODS = "pods"

    const val LAUNCH = "pods/launch?retry={retry}&templateId={templateId}"
    const val POD_DETAIL = "pods/{podId}"
    const val SESSION = "pods/{podId}/session?fromSeq={fromSeq}&sessionId={sessionId}"

    const val JOBS = "jobs"
    const val JOB_DETAIL = "jobs/{jobId}"

    const val SETTINGS = "settings"
    const val ENVIRONMENTS = "settings/environments"

    const val NOT_FOUND = "not-found"

    fun podDetail(podId: String) = "pods/$podId"

    /**
     * The launch flow.
     *
     * Retry travels explicitly rather than being inferred: an empty pod carries
     * no environment to infer it from, so "launch again like that one" and
     * "launch something new" are indistinguishable at the destination.
     */
    fun launch(retry: Boolean = false, templateId: String? = null): String {
        val query = buildList {
            if (retry) add("retry=1")
            templateId?.let { add("templateId=$it") }
        }
        return "pods/launch" + if (query.isEmpty()) "" else "?" + query.joinToString("&")
    }

    fun session(podId: String, fromSeq: Long? = null, sessionId: String? = null): String {
        val query = buildList {
            fromSeq?.let { add("fromSeq=$it") }
            sessionId?.let { add("sessionId=$it") }
        }
        return "pods/$podId/session" + if (query.isEmpty()) "" else "?" + query.joinToString("&")
    }

    fun jobDetail(jobId: String) = "jobs/$jobId"

    /** The tab a location belongs to, so the shell highlights the right one. */
    fun destinationFor(route: String?): AppDestination = when {
        route == null -> AppDestination.Pods
        route.startsWith("pods") -> AppDestination.Pods
        route.startsWith("jobs") -> AppDestination.Jobs
        route.startsWith("settings") -> AppDestination.Settings
        else -> AppDestination.Pods
    }
}

/**
 * Navigation in the one vocabulary the rest of the app speaks: a location
 * string.
 *
 * Screens and deep links both produce `/pods/123/session?fromSeq=4`; only this
 * class knows that navigation-compose wants it without the leading slash, so a
 * link that arrives in either spelling still lands.
 */
class AppRouter(private val navController: NavHostController) {

    fun go(location: String, builder: NavOptionsBuilder.() -> Unit = {}) {
        navController.navigate(normalize(location)) {
            launchSingleTop = true
            builder()
        }
    }

    /** Switches tabs without stacking a copy of each tab behind the next. */
    fun selectTab(destination: AppDestination) {
        navController.navigate(normalize(destination.route)) {
            popUpTo(Routes.PODS) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    fun push(location: String) = go(location)

    /** Replaces the current entry, for a flow whose start must not be revisited. */
    fun replace(location: String) {
        val current = navController.currentBackStackEntry?.destination?.route
        navController.navigate(normalize(location)) {
            launchSingleTop = true
            current?.let { popUpTo(it) { inclusive = true } }
        }
    }

    fun pop(): Boolean = navController.popBackStack()

    /**
     * Back to the pod list, past every screen of a pod that no longer exists — its
     * conversation as well as its details. Off the pods stack (a job's pod), just back.
     */
    fun backToPodList() {
        if (!navController.popBackStack(Routes.PODS, inclusive = false)) pop()
    }

    companion object {
        internal fun normalize(location: String) = location.removePrefix("/").ifEmpty { Routes.PODS }
    }
}
