# kotlinx.serialization keeps generated serializers off the entry-point graph.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations, AnnotationDefault
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class com.pipod.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.pipod.app.**$$serializer { *; }
-keepclassmembers class com.pipod.app.** {
    *** Companion;
}

# OkHttp ships optional Conscrypt/BouncyCastle/Animal-Sniffer references.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# androidx.security-crypto pulls in Tink, which is annotated with Error Prone's
# compile-only annotations. They are not on the runtime classpath by design —
# nothing reads them at runtime — but R8 fails the build on the dangling
# references rather than warning, so they are named here instead of dragging a
# compile-only dependency into the APK.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# Tink's KeysDownloader can fetch a remote keyset over google-http-client and
# Joda-Time. This app only ever uses a local keystore-held key, so neither
# dependency is declared and neither is reachable; the references still have to
# be named or R8 refuses to finish.
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**

# Tink resolves its key managers reflectively from the registry, so the shaded
# protobuf field names have to survive. The rest of Tink is left shrinkable — a
# blanket keep drags KeysDownloader and its optional transports back in.
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}
