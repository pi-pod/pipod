package com.pipod.app.features.pods

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.PodsPage
import com.pipod.app.core.api.model.WorkstationStatus

/**
 * The pod operations the screens need, ported from
 * `pi-pod-flutter/lib/features/pods/pod_repository.dart`.
 *
 * Narrow on purpose: a view-model test substitutes one of these instead of a
 * whole [ApiClient], so the tests say what the screen does with a result rather
 * than how the result was fetched.
 */
interface PodRepository {
    suspend fun pods(): DecodedList<Pod>
    suspend fun templates(): DecodedList<PodTemplate>
    suspend fun pod(id: String): Pod
    suspend fun template(id: String): PodTemplate
    suspend fun launch(templateId: String? = null): Pod

    /** `archive`, `restore` or `stop`. */
    suspend fun command(id: String, command: String): Pod

    /**
     * Deletes the pod. Without [cascade] the server refuses while live children
     * hang off it, and names them so the caller can ask.
     */
    suspend fun delete(id: String, cascade: Boolean = false)

    /**
     * Cancels a bounded capacity wait, keeping the pod row. False when the pod
     * never queued — or the server predates the route, which reads the same.
     */
    suspend fun cancelCapacityWait(id: String): Boolean

    /**
     * The pod list plus the optional account summary the envelope may carry.
     *
     * Defaulted so a fake that only knows about pods keeps compiling — and gets
     * the self-hosted shape, where the whole billing surface is absent.
     */
    suspend fun podsPage(): PodsPage = PodsPage(pods = pods())

    /**
     * `GET /v1/workstations/{hostId}` for a host id a validated host-demand
     * detail named. Null when the server has nothing to report, including a
     * server that predates the route.
     */
    suspend fun workstation(hostId: String): WorkstationStatus? = null

    /**
     * `GET /v1/billing/account` — the live account summary, so the plan line and
     * the blocked-start warning do not stay frozen at whatever `/v1/me` said at
     * sign-in. Null on the self-hosted backend, which registers no billing
     * routes at all; defaulted so a fake that only knows about pods gets exactly
     * that shape.
     */
    suspend fun billingSummary(): BillingSummary? = null
}

class ApiPodRepository(private val api: ApiClient) : PodRepository {

    override suspend fun pods(): DecodedList<Pod> = api.pods()

    override suspend fun podsPage(): PodsPage = api.podsPage()

    override suspend fun workstation(hostId: String): WorkstationStatus? = api.workstation(hostId)

    override suspend fun billingSummary(): BillingSummary? = api.billingSummary()

    override suspend fun templates(): DecodedList<PodTemplate> = api.templates()

    override suspend fun pod(id: String): Pod = api.pod(id)

    override suspend fun template(id: String): PodTemplate = api.template(id)

    override suspend fun launch(templateId: String?): Pod = api.launch(templateId).pod

    override suspend fun command(id: String, command: String): Pod = api.podCommand(id, command)

    override suspend fun delete(id: String, cascade: Boolean) = api.deletePod(id, cascade = cascade)

    override suspend fun cancelCapacityWait(id: String): Boolean = api.cancelCapacityWait(id)
}
