package com.pipod.app.core.auth

import android.net.Uri
import com.pipod.app.core.api.model.AuthResponse

/** Boundary for browser OIDC authorization and RP-initiated logout. */
interface AuthService {
    suspend fun signIn(callback: Uri? = null, organizationAlias: String? = null): AuthResponse
    suspend fun signOut(refreshToken: String? = null, idToken: String? = null)
}
