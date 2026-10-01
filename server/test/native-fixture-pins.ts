/**
 * Public multi-architecture BusyBox workload used only by disposable native CI fixtures.
 * This digest-only OCI index reference was resolved from Docker Hub's `busybox:1.36.1`
 * manifest; omitting the tag keeps the sandbox registry parser's repository path canonical.
 */
export const NATIVE_FIXTURE_WORKLOAD_IMAGE =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
