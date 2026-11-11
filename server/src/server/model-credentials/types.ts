import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Account subject that owns brokered credentials. */
export interface CredentialSubject {
  orgId: string;
  userId: string;
}

export type CredentialType = "oauth" | "api_key";

export type CredentialReconnectReason =
  | "revoked"
  | "invalid_grant"
  | "missing_refresh_token"
  | "migration_required";

export type CredentialStatus =
  | {
      providerId: string;
      type: CredentialType;
      state: "ready";
      expiresAt?: string;
      lastRefreshAt?: string;
      revision: number;
    }
  | {
      providerId: string;
      type: CredentialType;
      state: "reconnect_required";
      reason: CredentialReconnectReason;
      revision: number;
    }
  | {
      providerId: string;
      type: CredentialType;
      state: "temporarily_unavailable";
      retryAfter?: string;
      revision: number;
    };

/**
 * A credential as `GET /model-credentials` lists it: its status plus where it comes from.
 * `sharedBy` (the owner's email) is set on credentials someone shared with the subject;
 * `sharedWith` (member emails) on the subject's own credentials they share.
 */
export type ListedCredential = CredentialStatus & {
  source: "own" | "shared";
  sharedBy?: string;
  sharedWith?: string[];
};

export interface CredentialListing {
  /** One per provider: the credential that serves the subject's pods (see sharing.ts). */
  credentials: ListedCredential[];
  /** Credentials shared with the subject that their own credential for the same provider overrides. */
  overriddenShares: ListedCredential[];
}

export interface CredentialLease {
  revision: string;
  /**
   * The provider ids this lease answers for: the pod's contract. {@link acquireLease} always
   * sets it; without it a lease cannot vouch for keys a pod holds from before the materializer
   * recorded what it wrote, so it leaves them.
   */
  scope?: readonly string[];
  providers: Record<
    string,
    {
      entry: Record<string, unknown>;
      expiresAt?: number;
      providerRevision: number;
    }
  >;
}

export type LeaseFailure = (
  | { state: "reconnect_required"; reason: string }
  | { state: "temporarily_unavailable" }
  | { state: "missing" }
) & {
  /** The owner's email, present only when the failing credential is one shared with the subject. */
  sharedBy?: string;
};

export interface LeaseResult {
  lease: CredentialLease;
  failures: Record<string, LeaseFailure>;
  /** Providers in the lease served by someone else's credential, by provider id. */
  shared: Record<string, { ownerUserId: string; sharedBy: string }>;
}

export type BrokerAuthType = Parameters<ModelRuntime["login"]>[1];
export type BrokerAuthInteraction = Parameters<ModelRuntime["login"]>[2];

export interface ModelCredentialBroker {
  status(subject: CredentialSubject): Promise<CredentialListing>;
  login(
    subject: CredentialSubject,
    providerId: string,
    authType: BrokerAuthType,
    interaction: BrokerAuthInteraction,
    opts?: { signal?: AbortSignal },
  ): Promise<CredentialStatus>;
  lease(
    subject: CredentialSubject,
    providerIds: readonly string[],
    minValidityMs: number,
  ): Promise<LeaseResult>;
  remove(subject: CredentialSubject, providerId: string): Promise<boolean>;
}

/** Bounded, non-secret failure classification persisted on the row. */
export type CredentialFailureCode = CredentialReconnectReason | "transient";
