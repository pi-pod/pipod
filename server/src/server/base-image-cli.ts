/**
 * Prints the managed pod base image this build launches from, as `<ref> <pi version>`: the
 * `pi-pod-base:<tag>` the server prewarms and pulls from its image mirror, and the pi version to
 * build it with. For a deployment that publishes the base image itself (selfhost/upgrade). The tag
 * digests the pi version, the launcher and the image assets, so it changes with the server.
 */
import { bundledPiVersion } from "../core/client/piversion.js";
import { defaultImage } from "../core/config.js";

console.log(`${defaultImage()} ${bundledPiVersion()}`);
