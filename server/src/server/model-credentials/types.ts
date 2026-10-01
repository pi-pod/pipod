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

export interface CredentialLease {
  revision: string;
  providers: Record<
    string,
    {
      entry: Record<string, unknown>;
      expiresAt?: number;
      providerRevision: number;
    }
  >;
}

export type LeaseFailure =
  | { state: "reconnect_required"; reason: string }
  | { state: "temporarily_unavailable" }
  | { state: "missing" };

export interface LeaseResult {
  lease: CredentialLease;
  failures: Record<string, LeaseFailure>;
}

export type BrokerAuthType = Parameters<ModelRuntime["login"]>[1];
export type BrokerAuthInteraction = Parameters<ModelRuntime["login"]>[2];

export interface ModelCredentialBroker {
  status(subject: CredentialSubject): Promise<CredentialStatus[]>;
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
