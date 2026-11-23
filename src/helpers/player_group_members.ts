import api from "@/plugins/api";
import { resolvePlayerQueue } from "@/plugins/api/helpers";
import {
  type Player,
  type MassEvent,
  EventType,
  PlaybackState,
  PlayerFeature,
  PlayerType,
} from "@/plugins/api/interfaces";
import { $t } from "@/plugins/i18n";
import { store } from "@/plugins/store";
import { pendingGroupTransfers } from "./player_group_transfer_state";
import { toast } from "vue-sonner";

export { pendingGroupTransfers } from "./player_group_transfer_state";

interface MemberUpdate {
  sourceId: string;
  pendingAdditions: string[];
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

function canUseIdleMember(
  memberId: string,
  sourceId: string,
  explicitlyAdded = false,
): boolean {
  const member = api.players[memberId];
  if (!member) return false;
  const queue = resolvePlayerQueue(member);
  return (
    member.playback_state === PlaybackState.IDLE &&
    (!queue || queue.state === PlaybackState.IDLE) &&
    (explicitlyAdded ||
      ((!member.synced_to || member.synced_to === sourceId) &&
        (!member.active_group || member.active_group === sourceId) &&
        member.group_members.every((id) => id === memberId || id === sourceId)))
  );
}

function requireIdleMembers(
  sourceId: string,
  memberIds: string[],
  additions: string[],
  errorKey = "player_group_playback.regroup_unavailable",
): void {
  const unchanged = memberIds.every(
    (id) =>
      !api.players[id]?.available ||
      canUseIdleMember(id, sourceId, additions.includes(id)),
  );
  if (unchanged) return;
  toast.error($t(errorKey));
  throw new Error("A group member changed during the queue handoff");
}

function findGroupLeader(memberIds: string[]): Player | undefined {
  const members = memberIds
    .map((id) => api.players[id])
    .filter((member) => member?.available);
  return members.find(
    (candidate) =>
      (candidate.type === PlayerType.PLAYER ||
        candidate.type === PlayerType.STEREO_PAIR ||
        candidate.type === PlayerType.GROUP) &&
      (members.length === 1 ||
        (candidate.synced_to === null &&
          !candidate.active_group &&
          candidate.supported_features.includes(PlayerFeature.SET_MEMBERS) &&
          members.every(
            (member) =>
              member.player_id === candidate.player_id ||
              candidate.can_group_with.includes(member.player_id),
          ))),
  );
}

async function waitForGroupLeader(memberIds: string[]): Promise<Player> {
  const ready = findGroupLeader(memberIds);
  if (ready) return ready;
  // Synced members expose an empty can_group_with. Wait for their freed state,
  // using the same player events as the active-playback transfer observer.
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (target?: Player) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      // Unsubscribing here would splice the API listener array during dispatch.
      queueMicrotask(() => unsubscribe());
      if (target) resolve(target);
      else reject(new Error("Remaining players cannot form a group"));
    };
    const check = (event?: MassEvent) => {
      if (event?.event === EventType.DISCONNECTED) {
        finish();
        return;
      }
      const target = findGroupLeader(memberIds);
      if (target) finish(target);
    };
    const timeout = setTimeout(() => finish(), 5000);
    const unsubscribe = api.subscribe_multi(
      [
        EventType.PLAYER_UPDATED,
        EventType.PLAYER_REMOVED,
        EventType.DISCONNECTED,
      ],
      check,
    );
    void Promise.allSettled(
      memberIds
        .filter((id) => api.players[id]?.available)
        .map(async (id) => {
          const player = await api.getPlayer(id);
          if (!finished) api.players[id] = player;
        }),
    ).then(() => check());
    check();
  });
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
          api.queueElapsedTime[queue.queue_id] = {
            elapsed_time: queue.elapsed_time,
            elapsed_time_last_updated: queue.elapsed_time_last_updated,
          };
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
  const requestPlayerIds = [...playerIds];
  const dependencies = new Set<MemberUpdate>();
  // Include still-pending additions even if a server snapshot has not caught up.
  // Only intersecting operations wait; unrelated rooms remain independent.
  for (const id of playerIds) {
    const previous = memberUpdates.get(id);
    if (!previous) continue;
    dependencies.add(previous);
    for (const previousId of previous.playerIds) playerIds.add(previousId);
  }
  if (requestPlayerIds.some((id) => pendingGroupTransfers.has(id))) {
    toast.error($t("player_group_playback.change_pending"));
    return restorePlayer().catch(() => undefined);
  }

  // Earlier batches may still be adding an idle member to this same source.
  // Preserve that intent at capture; execution checks the observed ownership.
  const pendingAdditions = [
    ...new Set([
      ...playerIdsToAdd,
      ...[...dependencies]
        .filter((update) => update.sourceId === playerId)
        .flatMap((update) => update.pendingAdditions),
    ]),
  ];
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
  if (idleHandoff) {
    try {
      requireIdleMembers(playerId, remainingMemberIds, pendingAdditions);
    } catch {
      return restorePlayer().catch(() => undefined);
    }
    // Dependencies may include another room; reserve only players we will touch.
    const reservationIds = requestPlayerIds.filter(
      (id) =>
        id === playerId ||
        remainingMemberIds.includes(id) ||
        canUseIdleMember(id, playerId),
    );
    for (const id of reservationIds) pendingGroupTransfers.set(id, owner);
  }
  const update: MemberUpdate = {
    sourceId: playerId,
    pendingAdditions,
    playerIds,
    promise: Promise.resolve(),
  };
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
    ? Promise.all(
        [...dependencies].map((dependency) => dependency.promise),
      ).then(execute)
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
  // Keep the original route after waiting for earlier membership requests.
  // Playing, paused and empty-source changes must not enter an unreserved move.
  if (!idleHandoff) {
    return api.playerCommandSetMembers(
      playerId,
      playerIdsToAdd.length ? playerIdsToAdd : undefined,
      playerIdsToRemove.length ? playerIdsToRemove : undefined,
    );
  }
  const player = api.players[playerId];
  const target = idleTransferTarget(
    player,
    remainingMemberIds,
    playerIdsToRemove,
  );
  if (!target) sourceChanged();
  requireIdleMembers(playerId, remainingMemberIds, playerIdsToAdd);

  let targetId = target.player_id;
  try {
    // Removing an idle leader dissolves its group and drops pending additions.
    // Free its followers without removing the leader or stopping its queue.
    const previousMembers = [
      ...new Set([...player.group_members, ...playerIdsToRemove]),
    ].filter(
      (memberId) =>
        memberId !== playerId && canUseIdleMember(memberId, playerId),
    );
    // Stale membership must not detach a player now owned or playing elsewhere.
    if (previousMembers.length) {
      await api.playerCommandSetMembers(playerId, undefined, previousMembers);
    }

    try {
      targetId = (await waitForGroupLeader(remainingMemberIds)).player_id;
    } catch (error) {
      toast.error($t("player_group_playback.regroup_unavailable"));
      throw error;
    }

    // Another client may have started playback while the detach was pending.
    if (
      idleTransferTarget(api.players[playerId], [targetId], playerIdsToRemove)
        ?.player_id !== targetId
    ) {
      sourceChanged();
    }

    requireIdleMembers(playerId, remainingMemberIds, playerIdsToAdd);

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
      (memberId) => memberId !== targetId && api.players[memberId]?.available,
    );
    if (followers.length) {
      requireIdleMembers(
        playerId,
        remainingMemberIds,
        playerIdsToAdd,
        "player_group_playback.queue_moved_regroup_failed",
      );
      await api.playerCommandSetMembers(targetId, followers);
    }
  } finally {
    // Reconcile ambiguous failures without retrying the move or treating an
    // unrelated idle destination queue as proof of a successful transfer.
    await refreshTransferState([playerId, targetId]);
  }
}
