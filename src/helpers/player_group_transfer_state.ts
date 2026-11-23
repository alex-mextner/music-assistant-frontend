import { reactive } from "vue";
import type { Player } from "@/plugins/api/interfaces";

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

export function resolvePlayTarget(
  options: { queue_id?: string },
  activePlayer: Pick<Player, "player_id" | "active_source"> | undefined,
  queues: Readonly<Record<string, unknown>>,
): { queueId: string | undefined; blocked: boolean } {
  let queueId = options.queue_id;
  if (
    !queueId &&
    activePlayer?.active_source &&
    activePlayer.active_source in queues
  ) {
    queueId = activePlayer.active_source;
  } else if (!queueId) {
    queueId = activePlayer?.player_id;
  }
  return {
    queueId,
    blocked:
      (!!queueId && pendingGroupTransfers.has(queueId)) ||
      (!options.queue_id &&
        !!activePlayer?.player_id &&
        pendingGroupTransfers.has(activePlayer.player_id)),
  };
}
