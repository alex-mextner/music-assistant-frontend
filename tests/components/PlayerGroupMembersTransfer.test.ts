import PlayerGroupMembers from "@/components/PlayerGroupMembers.vue";
import PlayBtn from "@/layouts/default/PlayerOSD/PlayerControlBtn/PlayBtn.vue";
import { api, type MusicAssistantApi } from "@/plugins/api";
import {
  IdentifierType,
  EventType,
  PlaybackState,
  type Player,
  PlayerFeature,
  type PlayerQueue,
  PlayerType,
} from "@/plugins/api/interfaces";
import { store } from "@/plugins/store";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent } from "vue";
import { toast } from "vue-sonner";
import { playerQueue } from "../fixtures/playerQueue";

vi.mock("@/plugins/api", async () => {
  const { reactive } = await vi.importActual<typeof import("vue")>("vue");
  const api = reactive({
    players: {} as Record<string, Player>,
    queues: {} as Record<string, PlayerQueue>,
    queueElapsedTime: {} as MusicAssistantApi["queueElapsedTime"],
    getPlayer: vi.fn<MusicAssistantApi["getPlayer"]>(),
    getPlayerQueues: vi.fn<MusicAssistantApi["getPlayerQueues"]>(),
    playerCommandSetMembers:
      vi.fn<MusicAssistantApi["playerCommandSetMembers"]>(),
    playerCommandPlayPause:
      vi.fn<MusicAssistantApi["playerCommandPlayPause"]>(),
    sendCommand: vi.fn<MusicAssistantApi["sendCommand"]>(),
    subscribe_multi: vi.fn<MusicAssistantApi["subscribe_multi"]>(),
  });
  return { api, default: api };
});

vi.mock("@/plugins/store", async () => {
  const { reactive } = await vi.importActual<typeof import("vue")>("vue");
  return {
    store: reactive({ activePlayerId: undefined as string | undefined }),
  };
});

vi.mock("@/plugins/web_player", () => ({
  webPlayer: { player_id: null },
}));

vi.mock("@/plugins/i18n", () => ({ $t: (key: string) => key }));
vi.mock("vue-sonner", () => ({ toast: { error: vi.fn() } }));

function createPlayer(overrides: Partial<Player> = {}): Player {
  return {
    player_id: "leader",
    provider: "test",
    type: PlayerType.PLAYER,
    name: "Kitchen",
    available: true,
    device_info: {
      model: "Test",
      manufacturer: "Test",
      software_version: null,
      model_id: null,
      manufacturer_id: null,
      identifiers: {
        [IdentifierType.MAC_ADDRESS]: "",
        [IdentifierType.SERIAL_NUMBER]: "",
        [IdentifierType.UUID]: "",
        [IdentifierType.IP_ADDRESS]: "",
        [IdentifierType.UNKNOWN]: "",
      },
    },
    supported_features: [PlayerFeature.SET_MEMBERS],
    can_group_with: ["child", "other"],
    enabled: true,
    playback_state: PlaybackState.IDLE,
    powered: true,
    volume_level: 25,
    volume_muted: false,
    group_members: [],
    static_group_members: [],
    source_list: [],
    sound_mode_list: [],
    options: [],
    group_volume: null,
    group_volume_muted: null,
    hide_in_ui: false,
    private: false,
    icon: "speaker",
    power_control: "power",
    volume_control: "volume",
    mute_control: "mute",
    needs_setup: false,
    has_setup_flow: false,
    output_protocols: [],
    active_output_protocol: null,
    elapsed_time: null,
    elapsed_time_last_updated: null,
    current_media: null,
    active_source: "leader",
    active_sound_mode: null,
    active_group: null,
    synced_to: null,
    sleep_timer_expires_at: null,
    setup_reason: null,
    legacy_ids: [],
    protocols: [],
    sleep_timer_mode: null,
    active_source_audio: null,
    ...overrides,
  };
}

const groupListeners = new Set<(event: { event: EventType }) => void>();
const wrappers: VueWrapper[] = [];
const finishRequests: (() => void)[] = [];

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  finishRequests.push(resolve);
  return { promise, resolve, reject };
}

function mountPlayerControls(grouped = true) {
  const leader = createPlayer({
    group_members: grouped ? ["leader", "child"] : [],
  });
  const child = createPlayer({
    player_id: "child",
    name: "Office",
    synced_to: grouped ? "leader" : null,
    active_source: grouped ? "leader" : "child",
  });
  api.players = { leader, child };
  api.queueElapsedTime = {};
  api.queues = {
    leader: playerQueue({
      queue_id: "leader",
      items: 8,
      current_index: 6,
      elapsed_time: 42,
    }),
    child: playerQueue({ queue_id: "child", items: 3 }),
  };
  store.activePlayerId = "leader";
  const wrapper = mount(
    defineComponent({
      components: { PlayerGroupMembers, PlayBtn },
      setup() {
        const player = computed(() => api.players[store.activePlayerId!]);
        const queue = computed(() => api.queues[store.activePlayerId!]);
        const members = computed(() =>
          [player.value.player_id, ...player.value.group_members]
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .map((id) => api.players[id])
            .filter((member) => member?.available),
        );
        return { player, queue, members };
      },
      template: `
        <PlayerGroupMembers :key="player.player_id" :player="player" :members="members" />
        <PlayBtn :player="player" :player-queue="queue" />
      `,
    }),
    {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          PlayerIcon: { template: "<span />" },
          Separator: { template: "<hr />" },
          VBadge: { template: "<span><slot /></span>" },
          VIcon: { template: "<span><slot /></span>" },
          VProgressCircular: { template: "<span />" },
        },
      },
    },
  );
  wrappers.push(wrapper);
  return { wrapper, leader, child };
}

async function removeLeader(wrapper: VueWrapper) {
  await wrapper.get('[aria-label="Kitchen"]').trigger("click");
  await vi.advanceTimersByTimeAsync(500);
  await flushPromises();
}

function acknowledgeTransfer(targetId = "child") {
  api.queues[targetId] = { ...api.queues.leader, queue_id: targetId };
  api.queues.leader = playerQueue({ queue_id: "leader" });
  api.players.leader.group_members = [];
  api.players[targetId].synced_to = null;
  api.players[targetId].active_source = targetId;
}

async function acknowledgeMemberUpdate(
  playerId: string,
  additions?: string[],
  removals?: string[],
) {
  const parent = api.players[playerId];
  if (!parent || removals?.includes(playerId)) return;
  for (const id of removals ?? []) {
    const member = api.players[id];
    if (member?.synced_to === playerId) {
      member.synced_to = null;
      member.active_group = null;
      member.active_source = id;
    }
  }
  parent.group_members = parent.group_members.filter(
    (id) => !removals?.includes(id),
  );
  for (const id of additions ?? []) {
    parent.group_members = [
      ...new Set([playerId, ...parent.group_members, id]),
    ];
    if (api.players[id]) {
      api.players[id].synced_to = playerId;
      api.players[id].active_source = playerId;
    }
  }
}

describe("changing the idle group playback target", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.mocked(api.playerCommandSetMembers).mockImplementation(
      acknowledgeMemberUpdate,
    );
    vi.mocked(api.subscribe_multi).mockImplementation((_events, callback) => {
      const listener = (event: { event: EventType }) => callback(event);
      groupListeners.add(listener);
      return () => {
        groupListeners.delete(listener);
      };
    });
    vi.mocked(api.playerCommandPlayPause).mockResolvedValue();
    vi.mocked(api.sendCommand).mockResolvedValue(undefined);
    vi.mocked(api.getPlayer).mockImplementation(async (id) => ({
      ...api.players[id],
      group_members: [...api.players[id].group_members],
    }));
    vi.mocked(api.getPlayerQueues).mockImplementation(async () =>
      Object.values(api.queues),
    );
  });

  afterEach(async () => {
    for (const finish of finishRequests.splice(0)) finish();
    await flushPromises();
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    await vi.runAllTimersAsync();
    await flushPromises();
    vi.useRealTimers();
    groupListeners.clear();
  });

  it("moves the stopped queue before the next Play targets the remaining speaker", async () => {
    const { wrapper } = mountPlayerControls();
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
    });

    await removeLeader(wrapper);

    expect(api.sendCommand).toHaveBeenCalledWith("player_queues/transfer", {
      source_queue_id: "leader",
      target_queue_id: "child",
      auto_play: false,
    });
    expect(store.activePlayerId).toBe("child");
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="play"]').trigger("click");

    expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith("child");
  });

  it("reconciles stale progress from the final queue snapshot", async () => {
    const { wrapper } = mountPlayerControls();
    api.queueElapsedTime = {
      leader: { elapsed_time: 42, elapsed_time_last_updated: 1000 },
      child: { elapsed_time: 9, elapsed_time_last_updated: 900 },
      unrelated: { elapsed_time: 12, elapsed_time_last_updated: 1100 },
    };
    vi.mocked(api.getPlayerQueues).mockResolvedValue([
      playerQueue({
        queue_id: "leader",
        elapsed_time: 0,
        elapsed_time_last_updated: 1200,
      }),
      playerQueue({
        ...api.queues.leader,
        queue_id: "child",
        elapsed_time_last_updated: 1200,
      }),
    ]);

    await removeLeader(wrapper);

    expect(api.queues.child.current_index).toBe(6);
    expect(api.queueElapsedTime).toEqual({
      leader: { elapsed_time: 0, elapsed_time_last_updated: 1200 },
      child: { elapsed_time: 42, elapsed_time_last_updated: 1200 },
      unrelated: { elapsed_time: 12, elapsed_time_last_updated: 1100 },
    });
  });

  it("blocks Play from the checkbox click until the server acknowledges the transfer", async () => {
    const { wrapper } = mountPlayerControls();
    const transfer = deferred();
    vi.mocked(api.sendCommand).mockReturnValue(transfer.promise);

    await wrapper.get('[aria-label="Kitchen"]').trigger("click");
    await wrapper.get('[aria-label="play"]').trigger("click");
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(store.activePlayerId).toBe("leader");
    await wrapper.get('[aria-label="play"]').trigger("click");
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();

    acknowledgeTransfer();
    transfer.resolve();
    await flushPromises();
    expect(store.activePlayerId).toBe("child");
    await wrapper.get('[aria-label="play"]').trigger("click");
    expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith("child");
  });

  it("keeps the last available member checked when an offline member remains", async () => {
    const { wrapper, leader } = mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Garage",
      available: false,
      synced_to: "leader",
    });
    leader.group_members.push("other");
    await flushPromises();

    await wrapper.get('[aria-label="Office"]').trigger("click");
    const lastMember = wrapper.get('[aria-label="Kitchen"]');
    expect(lastMember.attributes("disabled")).toBeDefined();
    await lastMember.trigger("click");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
      "leader",
      undefined,
      ["child"],
    );
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(store.activePlayerId).toBe("leader");
  });

  it("preserves a new destination selected in the same debounce interval", async () => {
    const { wrapper } = mountPlayerControls(false);
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
    });

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await removeLeader(wrapper);

    expect(api.sendCommand).toHaveBeenCalledWith("player_queues/transfer", {
      source_queue_id: "leader",
      target_queue_id: "child",
      auto_play: false,
    });
    expect(store.activePlayerId).toBe("child");
    expect(api.playerCommandSetMembers).not.toHaveBeenCalledWith(
      "leader",
      ["child"],
      ["leader"],
    );
  });

  it("waits for an earlier membership request before handing off the queue", async () => {
    const { wrapper } = mountPlayerControls(false);
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
    });

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);
    await removeLeader(wrapper);

    expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(1);
    expect(api.sendCommand).not.toHaveBeenCalled();
    joining.resolve();
    await flushPromises();

    expect(store.activePlayerId).toBe("child");
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an existing idle destination queue for a successful transfer", async () => {
    const { wrapper } = mountPlayerControls();
    const transfer = deferred();
    vi.mocked(api.sendCommand).mockReturnValue(transfer.promise);

    await removeLeader(wrapper);
    expect(store.activePlayerId).toBe("leader");
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    transfer.reject(new Error("Transfer failed"));
    await flushPromises();

    expect(store.activePlayerId).toBe("leader");
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    expect(api.getPlayerQueues).toHaveBeenCalled();
    expect(api.queues.child.items).toBe(3);
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();
  });

  it("preserves a newer explicit player selection while the transfer is pending", async () => {
    const { wrapper } = mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 2 });
    const transfer = deferred();
    vi.mocked(api.sendCommand).mockReturnValue(transfer.promise);

    await removeLeader(wrapper);
    store.activePlayerId = "other";
    acknowledgeTransfer();
    transfer.resolve();
    await flushPromises();

    expect(store.activePlayerId).toBe("other");
  });

  it("keeps the confirmed destination selected if regrouping another member fails", async () => {
    const { wrapper, leader } = mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      synced_to: "leader",
    });
    leader.group_members.push("other");
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
    });
    vi.mocked(api.playerCommandSetMembers)
      .mockImplementationOnce(acknowledgeMemberUpdate)
      .mockRejectedValueOnce(new Error("Regroup failed"));

    await removeLeader(wrapper);

    expect(store.activePlayerId).toBe("child");
    expect(api.getPlayerQueues).toHaveBeenCalled();
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();
  });

  it("chooses a remaining player that can lead all available followers", async () => {
    const { wrapper, leader, child } = mountPlayerControls();
    child.supported_features = [];
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      synced_to: "leader",
      can_group_with: ["child"],
    });
    leader.group_members.push("other");
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer("other");
    });

    await removeLeader(wrapper);

    expect(api.sendCommand).toHaveBeenCalledWith("player_queues/transfer", {
      source_queue_id: "leader",
      target_queue_id: "other",
      auto_play: false,
    });
    expect(api.playerCommandSetMembers).toHaveBeenCalledWith("other", [
      "child",
    ]);
    expect(store.activePlayerId).toBe("other");
  });

  it("waits for freed member capabilities before moving a multi-player queue", async () => {
    const { wrapper, leader } = mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      synced_to: "leader",
    });
    leader.group_members.push("other");
    vi.mocked(api.playerCommandSetMembers).mockResolvedValueOnce();
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );

    await removeLeader(wrapper);
    expect(api.sendCommand).not.toHaveBeenCalled();

    api.players.child.synced_to = null;
    api.players.child.can_group_with = ["other"];
    for (const listener of groupListeners)
      listener({ event: EventType.PLAYER_UPDATED });
    await flushPromises();

    expect(store.activePlayerId).toBe("child");
    expect(groupListeners.size).toBe(0);
    expect(api.playerCommandSetMembers).toHaveBeenCalledWith("child", [
      "other",
    ]);
  });

  it.each(["timeout", "disconnect"])(
    "keeps the source queue when no compatible leader settles before %s",
    async (failure) => {
      const { wrapper, leader, child } = mountPlayerControls();
      child.can_group_with = [];
      api.players.other = createPlayer({
        player_id: "other",
        name: "Bedroom",
        synced_to: "leader",
        can_group_with: [],
      });
      leader.group_members.push("other");
      await removeLeader(wrapper);
      expect(api.sendCommand).not.toHaveBeenCalled();

      if (failure === "disconnect") {
        for (const listener of groupListeners)
          listener({ event: EventType.DISCONNECTED });
      } else {
        await vi.advanceTimersByTimeAsync(5000);
      }
      await flushPromises();

      expect(api.queues.leader.items).toBe(8);
      expect(store.activePlayerId).toBe("leader");
      expect(api.sendCommand).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        "player_group_playback.regroup_unavailable",
      );
      expect(groupListeners.size).toBe(0);
    },
  );

  it("does not require grouping support for a single remaining destination", async () => {
    const { wrapper, child } = mountPlayerControls();
    child.supported_features = [];
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );
    await removeLeader(wrapper);
    expect(store.activePlayerId).toBe("child");
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps a destination reserved when another group tries to transfer to it", async () => {
    const { wrapper } = mountPlayerControls();
    const transfer = deferred();
    vi.mocked(api.sendCommand).mockReturnValue(transfer.promise);
    await removeLeader(wrapper);

    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
      group_members: ["other", "child"],
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 2 });
    store.activePlayerId = "other";
    await flushPromises();
    await wrapper.get('[aria-label="Bedroom"]').trigger("click");
    await flushPromises();

    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    expect(api.queues.other.items).toBe(2);
    expect(toast.error).toHaveBeenCalledWith(
      "player_group_playback.change_pending",
    );

    store.activePlayerId = "child";
    await flushPromises();
    await wrapper.get('[aria-label="play"]').trigger("click");
    expect(api.playerCommandPlayPause).not.toHaveBeenCalled();

    acknowledgeTransfer();
    transfer.resolve();
    await flushPromises();
    await wrapper.get('[aria-label="play"]').trigger("click");
    expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith("child");
  });

  it("lets a different room change its group while a handoff is pending", async () => {
    const { wrapper } = mountPlayerControls();
    const transfer = deferred();
    vi.mocked(api.sendCommand).mockReturnValue(transfer.promise);
    await removeLeader(wrapper);

    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
      can_group_with: ["fourth"],
    });
    api.players.fourth = createPlayer({
      player_id: "fourth",
      name: "Den",
      active_source: "fourth",
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 2 });
    store.activePlayerId = "other";
    await flushPromises();
    await wrapper.get('[aria-label="Den"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);

    expect(api.playerCommandSetMembers).toHaveBeenCalledWith(
      "other",
      ["fourth"],
      undefined,
    );
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    transfer.resolve();
  });

  it("retains a queued addition when an earlier server snapshot replaces the player", async () => {
    const { wrapper } = mountPlayerControls(false);
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
    });
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
    });

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);
    await wrapper.get('[aria-label="Bedroom"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);
    api.players.leader = {
      ...api.players.leader,
      group_members: ["leader", "child"],
    };
    await flushPromises();
    await removeLeader(wrapper);
    joining.resolve();
    await flushPromises();

    expect(api.playerCommandSetMembers).toHaveBeenLastCalledWith("child", [
      "other",
    ]);
    expect(store.activePlayerId).toBe("child");
  });

  it("preserves playback started while detaching the old group", async () => {
    const { wrapper } = mountPlayerControls();
    const detaching = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(
      detaching.promise,
    );
    await removeLeader(wrapper);
    api.players.leader.playback_state = PlaybackState.PLAYING;
    api.queues.leader.state = PlaybackState.PLAYING;
    detaching.resolve();
    await flushPromises();

    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(store.activePlayerId).toBe("leader");
    expect(toast.error).toHaveBeenCalledWith(
      "player_group_playback.source_changed",
    );
  });

  it.each([PlayerType.DISPLAY, PlayerType.VISUALIZER, PlayerType.LIGHT])(
    "does not move a queue to a non-audio %s member",
    async (type) => {
      const { wrapper, child } = mountPlayerControls();
      child.type = type;

      await removeLeader(wrapper);

      expect(api.sendCommand).not.toHaveBeenCalled();
      expect(store.activePlayerId).toBe("leader");
    },
  );

  it("does not overwrite a saved destination queue with an empty source", async () => {
    const { wrapper } = mountPlayerControls();
    api.queues.leader.items = 0;

    await removeLeader(wrapper);

    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(api.queues.child.items).toBe(3);
  });
});
