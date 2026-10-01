import Foundation

extension APIClient {
    /// The SaaS billing account, or nil when this deployment has no billing.
    ///
    /// `/v1/me` carries the same block, but only at sign-in and org switch, so a
    /// spend cap that trips mid-session or a trial that ends while the app is
    /// open would never show up. This is the endpoint that can be re-read.
    ///
    /// **404 is an answer, not a failure.** `registerBillingRoutes` returns early
    /// unless the server runs the boat backend, so a self-hosted install has no
    /// `/v1/billing` at all — exactly like the absent `workstation` key. Nil then
    /// means "there is no billing here", and `SessionStore.applyBilling` leaves
    /// whatever is on screen alone rather than erasing it.
    ///
    /// The response is the full entitlement object; `BillingSummary.parse` reads
    /// the subset this app renders and ignores the rest, so a server that adds
    /// fields does not need a client change. `billingAccount()` returns that
    /// same response unparsed for the subscribe/manage surfaces, so both read
    /// one request shape and cannot drift apart.
    public func billingSummary() async throws -> BillingSummary? {
        do {
            return BillingSummary.parse(try await billingAccount())
        } catch let error as APIError {
            // 404: no billing surface on this deployment. 403: billing exists but
            // this principal may not read it — neither is worth a broken list.
            if error.transportStatus == 404 || error.transportStatus == 403 { return nil }
            throw error
        }
    }
}
