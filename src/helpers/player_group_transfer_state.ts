import { reactive } from "vue";
import type { PlayMediaOptions } from "@/plugins/api";
import type { CommandOptions } from "@/plugins/api/commandOptions";
import type {
  MediaItemTypeOrItemMapping,
  Player,
  QueueOption,
} from "@/plugins/api/interfaces";

// Incoming queue updates must not release an in-progress client handoff.
export const pendingGroupTransfers = reactive(new Map<string, symbol>());

const PLAYBACK_COMMANDS = new Set([
  "play",
  "play_pause",
  "resume",
  "next",
  "previous",
  "play_index",
  "seek",
  "skip",
  // Queue edits can invalidate the stopped source snapshot before its move.
  "clear",
  "delete_item",
]);

export function isGroupPlaybackBlocked(
  playerId: string | undefined,
  command: string,
): boolean {
  return (
    !!playerId &&
    pendingGroupTransfers.has(playerId) &&
    PLAYBACK_COMMANDS.has(command)
  );
}

export function isGroupTransferPending(...playerIds: string[]): boolean {
  return playerIds.some((id) => pendingGroupTransfers.has(id));
}

export function playMediaArgs(
  media:
    | MediaItemTypeOrItemMapping
    | MediaItemTypeOrItemMapping[]
    | string
    | string[],
  option: QueueOption | undefined,
  options: PlayMediaOptions,
  activePlayer: Pick<Player, "player_id"> | undefined,
): [payload: Record<string, unknown>, options?: CommandOptions] | undefined {
  // a player's own queue id is its player id; the server routes a grouped
  // or synced player's request to the queue that should handle it
  const queueId = options.queue_id ?? activePlayer?.player_id;
  if (isGroupPlaybackBlocked(queueId, "play")) return;
  const payload = {
    queue_id: queueId,
    media,
    option,
    start_item: options.start_item,
    sort_by: options.sort_by,
    sort_field: options.sort_field,
    sort_direction: options.sort_direction,
    shuffle: options.shuffle,
    start_position: options.start_position,
  };
  return options.suppressGlobalError === undefined
    ? [payload]
    : [payload, { suppressGlobalError: options.suppressGlobalError }];
}
