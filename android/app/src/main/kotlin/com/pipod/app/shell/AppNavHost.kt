package com.pipod.app.shell

import com.pipod.app.core.config.ServerDiscovery
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.navArgument
import com.pipod.app.core.api.model.PlanChangeAccount
import com.pipod.app.core.config.RuntimeConfig
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import com.pipod.app.di.AppContainer
import com.pipod.app.features.auth.AuthGate
import com.pipod.app.features.pods.ApiPodRepository
import com.pipod.app.features.pods.LaunchPodEvent
import com.pipod.app.features.pods.LaunchPodScreen
import com.pipod.app.features.pods.LaunchPodViewModel
import com.pipod.app.features.pods.PodDetailScreen
import com.pipod.app.features.pods.PodDetailViewModel
import com.pipod.app.features.jobs.ApiJobRepository
import com.pipod.app.features.jobs.JobDetailScreen
import com.pipod.app.features.jobs.JobDetailViewModel
import com.pipod.app.features.jobs.JobListViewModel
import com.pipod.app.features.jobs.JobsListScreen
import com.pipod.app.features.pods.PodListScreen
import com.pipod.app.features.pods.PodListViewModel
import com.pipod.app.features.session.SessionRoute
import com.pipod.app.features.settings.ApiCredentialsRepository
import com.pipod.app.features.settings.ApiSettingsRepository
import com.pipod.app.features.settings.SettingsAccount
import com.pipod.app.features.settings.SettingsScreen
import com.pipod.app.features.settings.SettingsViewModel
import com.pipod.app.features.settings.androidUrlOpener
import com.pipod.app.features.settings.apiLoginSocketFactory
import com.pipod.app.features.templates.ApiTemplateRepository
import com.pipod.app.features.templates.TemplateDetailScreen
import com.pipod.app.features.templates.TemplateDetailViewModel
import com.pipod.app.features.templates.TemplateListScreen
import com.pipod.app.features.templates.TemplateListViewModel
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * The route table.
 *
 * Locations match the Flutter client's, so a push payload or a shared link
 * resolves to the same screen on both — see [Routes].
 */
@Composable
fun AppNavHost(
    container: AppContainer,
    navController: NavHostController,
    router: AppRouter,
    modifier: Modifier = Modifier,
) {
    val entry by navController.currentBackStackEntryAsState()
    val destination = Routes.destinationFor(entry?.destination?.route)
    val pods = remember(container.api) { ApiPodRepository(container.api) }
    val templates = remember(container.api) { ApiTemplateRepository(container.api) }
    val jobs = remember(container.api) { ApiJobRepository(container.api) }
    val host = RuntimeConfig.serverUrl

    NavHost(
        navController = navController,
        startDestination = Routes.PODS,
        modifier = modifier,
    ) {
        composable(Routes.PODS) {
            Tab(container, destination, router, navController) {
                val session by container.session.state.collectAsState()
                val viewModel = viewModel(key = "pods-list") {
                    PodListViewModel(pods, serverHost = host)
                }
                // The list highlights your own pods and hides the owner column
                // when every pod is yours, so it needs to know who "you" is as
                // soon as the session does.
                LaunchedEffectOnce(session.user?.id) { viewModel.setCurrentUserId(session.user?.id) }
                // The account summary from `/v1/me`. The pods envelope may carry
                // the same object and wins when it does; on the self-hosted
                // backend neither arrives and the row never appears.
                LaunchedEffectOnce(session.billing) { viewModel.setAccountBilling(session.billing) }
                PodListScreen(
                    viewModel = viewModel,
                    // A pod you can talk to opens its conversation, which links to its
                    // details; one that cannot (starting, failed, archived) opens the details,
                    // which say why and what to do.
                    onOpenPod = { pod ->
                        router.push(if (pod.canOpenSession) Routes.session(pod.id) else Routes.podDetail(pod.id))
                    },
                    onLaunchNewPod = { router.push(Routes.launch()) },
                )
            }
        }

        composable(
            Routes.LAUNCH,
            arguments = listOf(
                navArgument("retry") { nullable = true; defaultValue = null },
                navArgument("templateId") { nullable = true; defaultValue = null },
            ),
        ) { backStackEntry ->
            // A launch is a focused flow: a tab bar under it is a target the
            // thumb hits by accident while the form is on screen.
            val isRetry = backStackEntry.arguments?.getString("retry") == "1"
            val templateId = backStackEntry.arguments?.getString("templateId")
            Gate(container) {
                val viewModel = viewModel(key = "launch-$isRetry-$templateId") {
                    LaunchPodViewModel(
                        repository = pods,
                        initialTemplateId = templateId,
                        isRetry = isRetry,
                        serverHost = host,
                    )
                }
                LaunchPodScreen(
                    viewModel = viewModel,
                    // The screen deliberately does not leave by itself; the route
                    // owns where a successful launch lands, and replaces so back
                    // does not return to a form that already launched.
                    // Straight into the conversation: it shows the sandbox coming up and
                    // takes a first message while it does, as the iOS app does.
                    onLaunched = { router.replace(Routes.session(it.id)) },
                    onCancel = { router.pop() },
                )
            }
        }

        composable(
            Routes.POD_DETAIL,
            arguments = listOf(navArgument("podId") { type = NavType.StringType }),
        ) { backStackEntry ->
            val podId = backStackEntry.arguments?.getString("podId").orEmpty()
            Tab(container, destination, router, navController) {
                val viewModel = viewModel(key = "pod-$podId") {
                    PodDetailViewModel(pods, podId = podId, serverHost = host)
                }
                PodDetailScreen(
                    viewModel = viewModel,
                    onBack = { router.pop() },
                    onOpenSession = { router.push(Routes.session(podId)) },
                    onEditAndRetry = { router.push(Routes.launch(retry = true, templateId = it)) },
                    onOpenHostPod = { router.push(Routes.podDetail(it)) },
                    onBackToPods = { router.selectTab(AppDestination.Pods) },
                    onDeleted = { router.backToPodList() },
                    showsOpenSession = true,
                )
            }
        }

        composable(
            Routes.SESSION,
            arguments = listOf(
                navArgument("podId") { type = NavType.StringType },
                navArgument("fromSeq") { nullable = true; defaultValue = null },
                navArgument("sessionId") { nullable = true; defaultValue = null },
            ),
        ) { backStackEntry ->
            // A conversation trades the tab bar for transcript, the way every
            // chat app does, and it also stops the composer sitting on one.
            val podId = backStackEntry.arguments?.getString("podId").orEmpty()
            val fromSeq = backStackEntry.arguments?.getString("fromSeq")?.toLongOrNull()
            val sessionId = backStackEntry.arguments?.getString("sessionId")
            Gate(container) {
                SessionRoute(
                    podId = podId,
                    client = container.api,
                    drafts = container.drafts,
                    fromSeq = fromSeq,
                    sessionId = sessionId,
                    onOpenPodDetails = { router.push(Routes.podDetail(it.id)) },
                    onBack = { router.pop() },
                )
            }
        }

        composable(Routes.JOBS) {
            Tab(container, destination, router, navController) {
                JobsListScreen(
                    viewModel = viewModel(key = "jobs-list") {
                        JobListViewModel(repository = jobs, serverHost = host)
                    },
                    onOpenJob = { router.push(Routes.jobDetail(it.id)) },
                )
            }
        }
        composable(
            Routes.JOB_DETAIL,
            arguments = listOf(navArgument("jobId") { type = NavType.StringType }),
        ) { backStackEntry ->
            val jobId = backStackEntry.arguments?.getString("jobId").orEmpty()
            Tab(container, destination, router, navController) {
                val viewModel = viewModel(key = "job-$jobId") {
                    JobDetailViewModel(jobs, jobId = jobId, serverHost = host)
                }
                JobDetailScreen(
                    viewModel = viewModel,
                    onBack = { router.pop() },
                    onOpenPod = { router.push(Routes.session(it)) },
                    onDeleted = { router.selectTab(AppDestination.Jobs) },
                )
            }
        }

        composable(Routes.SETTINGS) {
            Tab(container, destination, router, navController) {
                SettingsRoute(container = container, onOpenEnvironments = { router.push(Routes.ENVIRONMENTS) })
            }
        }
        composable(Routes.ENVIRONMENTS) {
            Tab(container, destination, router, navController) {
                EnvironmentsRoute(
                    repository = templates,
                    serverHost = host,
                    onBack = { router.pop() },
                )
            }
        }

        composable(Routes.NOT_FOUND) {
            NotFoundScreen(onBack = { router.selectTab(AppDestination.Pods) })
        }
    }
}

/**
 * The environments area navigates within itself — list, then detail — the way
 * the Flutter screen pushes inside its own route.
 *
 * Keeping it here rather than in the route table is what lets the detail screen
 * take the `PodTemplate` the list already loaded, instead of a bare id it would
 * have to fetch again just to render a row the reader is looking at.
 */
@Composable
private fun EnvironmentsRoute(
    repository: com.pipod.app.features.templates.TemplateRepository,
    serverHost: String,
    onBack: () -> Unit,
) {
    // The selection is an id, not the row: an id survives process death, and
    // the row it names is re-resolved from the list the view model reloads —
    // which is also how an environment deleted while the app was away drops the
    // reader back on the list instead of onto a detail for something gone.
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }

    // Hoisted out of the `when` below so stepping into the detail and back does
    // not throw the list away and re-fetch it.
    val listViewModel = viewModel(key = "environments") {
        TemplateListViewModel(repository, serverHost = serverHost)
    }
    val listState by listViewModel.state.collectAsState()
    val open = selectedId?.let { id -> listState.templates.firstOrNull { it.id == id } }

    // Back steps out of the detail before it leaves the tab. Registered above the
    // screen so its own unsaved-secret handler — added later, and therefore
    // consulted first — still gets to raise its confirmation.
    BackHandler(enabled = open != null) { selectedId = null }

    if (open != null) {
        val detailViewModel = viewModel(key = "environment-${open.id}") {
            TemplateDetailViewModel(repository, open, serverHost = serverHost)
        }
        TemplateDetailScreen(viewModel = detailViewModel, onBack = { selectedId = null })
    } else {
        TemplateListScreen(viewModel = listViewModel, onOpenTemplate = { selectedId = it.id })
    }
}

/**
 * Settings, plus the identity the screen needs from the signed-in session.
 *
 * The account is pushed in on every session change rather than read once:
 * `/v1/me` resolves after the first frame, and it decides which consoles and
 * dashboard the screen can open.
 */
@Composable
private fun SettingsRoute(container: AppContainer, onOpenEnvironments: () -> Unit) {
    val context = LocalContext.current
    val settings = remember(container.api) { ApiSettingsRepository(container.api) }
    val credentials = remember(container.api) { ApiCredentialsRepository(container.api) }
    val sockets = remember(container.api) { apiLoginSocketFactory(container.api) }
    val openUrl = remember(context) { androidUrlOpener(context) }
    val session by container.session.state.collectAsState()

    val account = SettingsAccount(
        user = session.user,
        organization = session.organization,
        billing = session.billing,
        adminConsoleUrl = session.adminConsoleUrl,
        dashboardUrl = session.dashboardUrl,
        // A baked development token would sign straight back in, so the screen
        // explains rather than bouncing to the browser.
        signOutUnavailable = RuntimeConfig.devToken.isNotEmpty(),
        setOrganizationAlias = container.session::setOrganizationAlias,
        signOut = container.session::signOut,
        openExternalUrl = openUrl,
        billingAccount = {
            val account = container.api.billingAccount()
            val canSubscribe = account["canSubscribe"]?.jsonPrimitive?.booleanOrNull == true
            val canManage = account["canManageBilling"]?.jsonPrimitive?.booleanOrNull == true
            canSubscribe to canManage
        },
        createCheckoutSession = { trial -> container.api.createCheckoutSession("standard", trial) },
        createPortalSession = { container.api.createPortalSession() },
        planChangeAccount = {
            PlanChangeAccount.parse(container.api.billingAccount().takeIf { it.isNotEmpty() })
        },
        previewPlanChange = { plan -> container.api.previewPlanChange(plan) },
        confirmPlanChange = { quoteId -> container.api.confirmPlanChange(quoteId) },
        refreshAccount = { container.session.loadMe() },
    )

    // Seeded at construction, not from an effect. The account card only exists
    // once there is an identity, and inserting it a frame later pushes the list
    // down under its own anchor — the screen then opens looking scrolled past its
    // own first section. A store view model rather than a remembered one, so
    // leaving settings cancels its refreshes instead of leaking them behind the
    // next tab.
    val viewModel = viewModel(key = "settings") {
        SettingsViewModel(
            repository = settings,
            credentials = credentials,
            account = account,
            notifications = container.push,
            serverHost = RuntimeConfig.serverUrl,
        )
    }

    LaunchedEffect(session.user, session.organization, session.adminConsoleUrl, session.dashboardUrl, session.billing) {
        viewModel.setAccount(account)
    }

    // Coming back to the screen has to re-read: what it shows can change while it
    // is away, such as notification permission in the system settings or billing
    // after a checkout in the browser. The first RESUME is the one this composition arrived on, which the view
    // model has already loaded for.
    var hasResumed by rememberSaveable { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (hasResumed) viewModel.loadAll() else hasResumed = true
    }

    SettingsScreen(
        viewModel = viewModel,
        socketFactory = sockets,
        onOpenEnvironments = onOpenEnvironments,
        openUrl = openUrl,
        serverHost = RuntimeConfig.serverUrl,
    )
}

@Composable
private fun Gate(container: AppContainer, content: @Composable () -> Unit) {
    AuthGate(
        session = container.session,
        serverName = ServerDiscovery.displayName(RuntimeConfig.serverUrl),
        hasServerChoice = RuntimeConfig.serverChoice != null,
        onChooseServer = { address ->
            container.useServer(ServerDiscovery.resolve(address, container.httpClient))
        },
        onUseCloud = { container.useServer(null) },
        serverAddress = ServerDiscovery.address(RuntimeConfig.serverUrl),
        content = content,
    )
}

@Composable
private fun Tab(
    container: AppContainer,
    destination: AppDestination,
    router: AppRouter,
    navController: NavHostController,
    content: @Composable () -> Unit,
) {
    Gate(container) {
        AdaptiveShell(
            destination = destination,
            onSelect = router::selectTab,
            // Only a tab root has nothing behind it; anywhere deeper, back pops.
            confirmsExit = navController.previousBackStackEntry == null,
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) { content() }
        }
    }
}

/** Runs [action] whenever [key] changes, including the first time it is seen. */
@Composable
private fun LaunchedEffectOnce(key: Any?, action: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(key) { action() }
}

/**
 * The screen a link resolves to when nothing matches.
 *
 * Port of `pi-pod-flutter/lib/shell/not_found_page.dart`: a shared link to a pod
 * somebody else owns, or one from a newer build, has to land somewhere that
 * explains itself rather than on an empty pod list.
 */
@Composable
fun NotFoundScreen(onBack: () -> Unit, modifier: Modifier = Modifier) {
    AppScaffold(
        modifier = modifier.testTag("not-found-screen"),
        title = "Not found",
        onNavigateBack = onBack,
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "That link doesn’t point anywhere in pi pod.",
                textAlign = TextAlign.Center,
                color = appColors.secondaryLabel,
            )
        }
    }
}
