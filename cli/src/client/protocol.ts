export const FRAME_PROTO_VERSION = 1;

export interface ShimHello {
  event: "hello";
  proto: number;
  piVersion: string;
  shimVersion: string;
  extensionVersion?: number;
  piRunning: boolean;
  eventSeq?: number;
}

export interface ShimPiExit {
  event: "pi_exit";
  code: number | null;
}

export interface ShimPiStderr {
  event: "pi_stderr";
  data: string;
}

export interface ShimMirrorData {
  event: "mirror_data";
  path: string;
  offset: number;
  data: string;
}

export interface ShimStreamSnapshot {
  event: "stream_snapshot";
  message: Record<string, unknown> | null;
}

export interface ShimBackgroundWork {
  event: "background_work";
  active: boolean;
  count: number;
}

export interface ShimEventReplayGap {
  event: "event_replay_gap";
  fromSeq: number;
  toSeq: number;
}

export interface ShimEventReplayEnd {
  event: "event_replay_end";
  lastSeq: number;
}

export type ShimControlEvent =
  | ShimHello
  | ShimPiExit
  | ShimPiStderr
  | ShimMirrorData
  | ShimStreamSnapshot
  | ShimBackgroundWork
  | ShimEventReplayGap
  | ShimEventReplayEnd;
