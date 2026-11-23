import api from "@/plugins/api";
import { resolvePlayerQueue } from "@/plugins/api/helpers";
import {
  type Player,
  PlaybackState,
  PlayerType,
} from "@/plugins/api/interfaces";
import { $t } from "@/plugins/i18n";
import { store } from "@/plugins/store";
import { reactive } from "vue";
import { toast } from "vue-sonner";

// Incoming queue updates must not release an in-progress client handoff.
export const pendingGroupTransfers = reactive(new Map<string, symbol>());

interface MemberUpdate {
  playerIds: Set<string>;
  promise: Promise<void>;
}

const memberUpdates = new Map<string, MemberUpdate>();

function idleTransferTarget(
  player: Player | undefined,
  remainingMemberIds: string[],
  playerIdsToRemove: string[],
): Player | undefined {
  if (
    !player ||
    !playerIdsToRemove.includes(player.player_id) ||
    player.type === PlayerType.GROUP ||
    player.synced_to !== null ||
    player.active_group ||
    player.playback_state !== PlaybackState.IDLE
  ) {
    return undefined;
  }
  const queue = resolvePlayerQueue(player);
  // An empty source must not overwrite a destination's saved queue.
  if (
    queue?.queue_id !== player.player_id ||
    queue.state !== PlaybackState.IDLE ||
    queue.items === 0
  ) {
    return undefined;
  }
  return remainingMemberIds
    .map((playerId) => api.players[playerId])
    .find(
      (member) =>
        member?.available &&
        (member.type === PlayerType.PLAYER ||
          member.type === PlayerType.STEREO_PAIR ||
          member.type === PlayerType.GROUP),
    );
}

async function refreshTransferState(playerIds: string[]): Promise<void> {
  await Promise.allSettled([
    ...playerIds.map(async (playerId) => {
      api.players[playerId] = await api.getPlayer(playerId);
    }),
    (async () => {
      for (const queue of await api.getPlayerQueues()) {
        if (playerIds.includes(queue.queue_id)) {
          api.queues[queue.queue_id] = queue;
        }
      }
    })(),
  ]);
}

function sourceChanged(): never {
  toast.error($t("player_group_playback.source_changed"));
  throw new Error("Playback changed during the group handoff");
}

export function setPlayerGroupMembers(
  playerId: string,
  playerIdsToAdd: string[],
  playerIdsToRemove: string[],
  desiredMemberIds: string[],
  restorePlayer: () => Promise<void>,
): Promise<void> {
  const playerIds = new Set([
    playerId,
    ...desiredMemberIds,
    ...playerIdsToAdd,
    ...playerIdsToRemove,
  ]);
  const dependencies = new Set<Promise<void>>();
  // Include still-pending additions even if a server snapshot has not caught up.
  // Only intersecting operations wait; unrelated rooms remain independent.
  for (const id of playerIds) {
    const previous = memberUpdates.get(id);
    if (!previous) continue;
    dependencies.add(previous.promise);
    for (const previousId of previous.playerIds) playerIds.add(previousId);
  }
  if ([...playerIds].some((id) => pendingGroupTransfers.has(id))) {
    toast.error($t("player_group_playback.change_pending"));
    return restorePlayer().catch(() => undefined);
  }

  const remainingMemberIds = [
    ...new Set([...desiredMemberIds, ...playerIdsToAdd]),
  ].filter(
    (memberId) =>
      memberId !== playerId && !playerIdsToRemove.includes(memberId),
  );
  const idleHandoff =
    idleTransferTarget(
      api.players[playerId],
      remainingMemberIds,
      playerIdsToRemove,
    ) !== undefined;
  const owner = Symbol(playerId);
  if (playerIdsToRemove.includes(playerId)) {
    for (const id of playerIds) pendingGroupTransfers.set(id, owner);
  }
  const update: MemberUpdate = { playerIds, promise: Promise.resolve() };
  const execute = () =>
    applyGroupMemberUpdate(
      playerId,
      playerIdsToAdd,
      playerIdsToRemove,
      remainingMemberIds,
      idleHandoff,
    )
      .catch(() => restorePlayer().catch(() => undefined))
      .finally(() => {
        for (const id of playerIds) {
          if (pendingGroupTransfers.get(id) === owner) {
            pendingGroupTransfers.delete(id);
          }
          if (memberUpdates.get(id) === update) memberUpdates.delete(id);
        }
      });
  update.promise = dependencies.size
    ? Promise.all(dependencies).then(execute)
    : execute();
  for (const id of playerIds) memberUpdates.set(id, update);
  return update.promise;
}

async function applyGroupMemberUpdate(
  playerId: string,
  playerIdsToAdd: string[],
  playerIdsToRemove: string[],
  remainingMemberIds: string[],
  idleHandoff: boolean,
): Promise<void> {
  const player = api.players[playerId];
  const target = idleTransferTarget(
    player,
    remainingMemberIds,
    playerIdsToRemove,
  );
  if (!target) {
    if (idleHandoff) sourceChanged();
    return api.playerCommandSetMembers(
      playerId,
      playerIdsToAdd.length ? playerIdsToAdd : undefined,
      playerIdsToRemove.length ? playerIdsToRemove : undefined,
    );
  }

  const targetId = target.player_id;
  try {
    // Removing an idle leader dissolves its group and drops pending additions.
    // Free its followers without removing the leader or stopping its queue.
    const previousMembers = [
      ...new Set([...player.group_members, ...playerIdsToRemove]),
    ].filter((memberId) => memberId !== playerId);
    if (previousMembers.length) {
      await api.playerCommandSetMembers(playerId, undefined, previousMembers);
    }

    // Another client may have started playback while the detach was pending.
    if (
      idleTransferTarget(
        api.players[playerId],
        remainingMemberIds,
        playerIdsToRemove,
      )?.player_id !== targetId
    ) {
      sourceChanged();
    }

    // queueCommandTransfer is fire-and-forget. Await explicit acknowledgement
    // before selecting the target or trusting its previously saved idle queue.
    await api.sendCommand<void>("player_queues/transfer", {
      source_queue_id: playerId,
      target_queue_id: targetId,
      auto_play: false,
    });
    if (store.activePlayerId === playerId) store.activePlayerId = targetId;

    // Once the queue moved, a regroup failure must leave that proven target
    // selected rather than returning to the now-empty source.
    const followers = remainingMemberIds.filter(
      (memberId) => memberId !== targetId,
    );
    if (followers.length) {
      await api.playerCommandSetMembers(targetId, followers);
    }
  } finally {
    // Reconcile ambiguous failures without retrying the move or treating an
    // unrelated idle destination queue as proof of a successful transfer.
    await refreshTransferState([playerId, targetId]);
  }
}
