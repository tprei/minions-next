import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

/** Renders a protobuf `Timestamp` as a locale-formatted date/time string, or "—" when the
 * field wasn't set (e.g. a host that has never been seen online has no `lastSeenAt`). */
export function formatTimestamp(timestamp: Timestamp | undefined): string {
  return timestamp === undefined ? "—" : timestampDate(timestamp).toLocaleString();
}
