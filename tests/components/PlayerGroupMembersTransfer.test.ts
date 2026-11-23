import PlayerGroupMembers from "@/components/PlayerGroupMembers.vue";
import PlayBtn from "@/layouts/default/PlayerOSD/PlayerControlBtn/PlayBtn.vue";
import { api, type MusicAssistantApi } from "@/plugins/api";
import {
  IdentifierType,
  EventType,
  MediaType,
  PlaybackState,
  type Player,
  PlayerFeature,
  type PlayerQueue,
  PlayerType,
} from "@/plugins/api/interfaces";
import { store } from "@/plugins/store";
import {
  eventbus,
  type PlayerGroupPlaybackDialogEvent,
} from "@/plugins/eventbus";
import { setPlayerGroupMembers } from "@/helpers/player_group_members";
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
    playerCommandStop: vi.fn<MusicAssistantApi["playerCommandStop"]>(),
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

vi.mock("@/plugins/i18n", () => ({
  $t: (key: string) => key,
  i18n: { global: { locale: { value: "en" } } },
}));
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

function mountPlayerControls(grouped = true, keyed = true) {
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
        return { player, queue, members, keyed };
      },
      template: `
        <PlayerGroupMembers :key="keyed ? player.player_id : undefined" :player="player" :members="members" />
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
    vi.mocked(api.playerCommandStop).mockResolvedValue();
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

  it.each([
    {
      control: "Pause",
      label: "pause",
      state: PlaybackState.PLAYING,
      stop: false,
    },
    {
      control: "Resume",
      label: "play",
      state: PlaybackState.PAUSED,
      stop: false,
    },
    {
      control: "Stop",
      label: "stop_playback",
      state: PlaybackState.PLAYING,
      stop: true,
    },
  ])(
    "keeps $control usable during the existing Keep playing handoff",
    async ({ state, stop, label }) => {
      const { wrapper } = mountPlayerControls();
      const leader = api.players.leader;
      leader.playback_state = state;
      api.queues.leader.state = state;
      if (stop) {
        leader.current_media = {
          uri: "test://radio",
          media_type: MediaType.RADIO,
          title: null,
          artist: null,
          album: null,
          image_url: null,
          palette: null,
          duration: null,
          source_id: null,
          elapsed_time: null,
          elapsed_time_last_updated: null,
          queue_item_id: null,
        };
      }
      await flushPromises();
      const membership = deferred();
      vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(
        membership.promise,
      );
      const confirmation =
        vi.fn<(event: PlayerGroupPlaybackDialogEvent) => void>();
      eventbus.on("playerGroupPlaybackDialog", confirmation);
      try {
        await wrapper.get('[aria-label="Kitchen"]').trigger("click");
      } finally {
        eventbus.off("playerGroupPlaybackDialog", confirmation);
      }
      expect(confirmation).toHaveBeenCalledOnce();
      const requested = confirmation.mock.calls[0][0].onKeepPlaying();
      await flushPromises();

      expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
        "leader",
        undefined,
        ["leader"],
      );
      expect(api.sendCommand).not.toHaveBeenCalled();
      expect(
        wrapper.get(`[aria-label="${label}"]`).attributes("disabled"),
      ).toBeUndefined();
      expect(
        wrapper.find('[role="status"][aria-label="loading_short"]').exists(),
      ).toBe(false);
      await wrapper.get(`[aria-label="${label}"]`).trigger("click");
      if (stop) {
        expect(api.playerCommandStop).toHaveBeenCalledExactlyOnceWith("leader");
      } else {
        expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith(
          "leader",
        );
      }
      membership.resolve();
      await requested;
      await flushPromises();
    },
  );

  it("keeps a captured non-idle request on the existing route after an earlier update", async () => {
    const { leader } = mountPlayerControls(false);
    leader.playback_state = PlaybackState.PLAYING;
    api.queues.leader.state = PlaybackState.PLAYING;
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    const restore = vi.fn(async () => undefined);
    const added = setPlayerGroupMembers(
      "leader",
      ["child"],
      [],
      ["leader", "child"],
      restore,
    );
    const removed = setPlayerGroupMembers(
      "leader",
      [],
      ["leader"],
      ["child"],
      restore,
    );
    expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(1);

    leader.playback_state = PlaybackState.IDLE;
    api.queues.leader.state = PlaybackState.IDLE;
    joining.resolve();
    await Promise.all([added, removed]);

    expect(api.playerCommandSetMembers).toHaveBeenLastCalledWith(
      "leader",
      undefined,
      ["leader"],
    );
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(store.activePlayerId).toBe("leader");
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

  it("keeps an idle destination addition from the previous pending batch", async () => {
    const { wrapper } = mountPlayerControls(false);
    api.players.other = createPlayer({
      player_id: "other",
      active_source: "other",
      group_members: ["other", "child"],
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 4 });
    api.players.child.synced_to = "other";
    api.players.child.active_source = "other";
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);
    await removeLeader(wrapper);
    expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
      "leader",
      ["child"],
      undefined,
    );
    expect(api.sendCommand).not.toHaveBeenCalled();

    await acknowledgeMemberUpdate("leader", ["child"]);
    api.players.other.group_members = ["other"];
    joining.resolve();
    await flushPromises();

    expect(api.sendCommand).toHaveBeenCalledExactlyOnceWith(
      "player_queues/transfer",
      {
        source_queue_id: "leader",
        target_queue_id: "child",
        auto_play: false,
      },
    );
    expect(store.activePlayerId).toBe("child");
    expect(api.queues.child.items).toBe(8);
    expect(api.queues.other.items).toBe(4);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps explicit additions through a chain of pending updates on the same leader", async () => {
    mountPlayerControls(false);
    api.players.foreign = createPlayer({
      player_id: "foreign",
      active_source: "foreign",
      group_members: ["foreign", "child"],
    });
    api.players.other = createPlayer({
      player_id: "other",
      active_source: "other",
      can_group_with: ["child"],
    });
    api.queues.foreign = playerQueue({ queue_id: "foreign", items: 4 });
    api.queues.other = playerQueue({ queue_id: "other", items: 5 });
    api.players.child.synced_to = "foreign";
    api.players.child.active_source = "foreign";
    const joining = deferred();
    const expanding = deferred();
    vi.mocked(api.playerCommandSetMembers)
      .mockReturnValueOnce(joining.promise)
      .mockReturnValueOnce(expanding.promise);
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );
    const restore = async () => undefined;
    const first = setPlayerGroupMembers(
      "leader",
      ["child"],
      [],
      ["leader", "child"],
      restore,
    );
    const second = setPlayerGroupMembers(
      "leader",
      ["other"],
      [],
      ["leader", "child", "other"],
      restore,
    );
    const handoff = setPlayerGroupMembers(
      "leader",
      [],
      ["leader"],
      ["child", "other"],
      restore,
    );
    expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(1);
    expect(api.sendCommand).not.toHaveBeenCalled();

    await acknowledgeMemberUpdate("leader", ["child"]);
    api.players.foreign.group_members = ["foreign"];
    joining.resolve();
    await flushPromises();
    expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(2);
    await acknowledgeMemberUpdate("leader", ["other"]);
    expanding.resolve();
    await Promise.all([first, second, handoff]);

    expect(api.sendCommand).toHaveBeenCalledExactlyOnceWith(
      "player_queues/transfer",
      {
        source_queue_id: "leader",
        target_queue_id: "child",
        auto_play: false,
      },
    );
    expect(store.activePlayerId).toBe("child");
    expect(api.players.other.synced_to).toBe("child");
    expect(api.queues.foreign.items).toBe(4);
    expect(toast.error).not.toHaveBeenCalled();
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

  it("keeps Pause usable on the different leader of an intersecting request", async () => {
    const { wrapper } = mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
      playback_state: PlaybackState.PLAYING,
    });
    api.queues.other = playerQueue({
      queue_id: "other",
      items: 2,
      state: PlaybackState.PLAYING,
    });
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    const earlier = setPlayerGroupMembers(
      "other",
      ["child"],
      [],
      ["other", "child"],
      async () => undefined,
    );

    await removeLeader(wrapper);
    store.activePlayerId = "other";
    await flushPromises();
    await wrapper.get('[aria-label="pause"]').trigger("click");

    expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith("other");
    joining.resolve();
    await earlier;
    await flushPromises();
  });

  it.each(["synced_to", "active_group"] as const)(
    "does not reclaim a retained member whose %s moved to another idle room",
    async (ownership) => {
      mountPlayerControls();
      api.players.other = createPlayer({
        player_id: "other",
        name: "Bedroom",
        active_source: "other",
      });
      api.queues.other = playerQueue({ queue_id: "other", items: 2 });
      const joining = deferred();
      vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(
        joining.promise,
      );
      vi.mocked(api.sendCommand).mockImplementation(async () =>
        acknowledgeTransfer(),
      );
      const restore = async () => undefined;
      const earlier = setPlayerGroupMembers(
        "other",
        ["child"],
        [],
        ["other", "child"],
        restore,
      );
      const handoff = setPlayerGroupMembers(
        "leader",
        [],
        ["leader"],
        ["child"],
        restore,
      );

      await acknowledgeMemberUpdate("other", ["child"]);
      if (ownership === "active_group") {
        api.players.child.synced_to = null;
        api.players.child.active_group = "other";
      }
      joining.resolve();
      await Promise.all([earlier, handoff]);

      expect(api.sendCommand).not.toHaveBeenCalled();
      expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
        "other",
        ["child"],
        undefined,
      );
      expect(api.players.child[ownership]).toBe("other");
      expect(api.queues.leader.items).toBe(8);
      expect(store.activePlayerId).toBe("leader");
    },
  );

  it("does not detach a removed member that now belongs to another playing room", async () => {
    mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom speaker",
      synced_to: "foreign",
      active_source: "foreign",
      playback_state: PlaybackState.PLAYING,
    });
    api.players.foreign = createPlayer({
      player_id: "foreign",
      active_source: "foreign",
      group_members: ["foreign", "other"],
      playback_state: PlaybackState.PLAYING,
    });
    api.queues.foreign = playerQueue({
      queue_id: "foreign",
      items: 11,
      state: PlaybackState.PLAYING,
    });
    api.players.leader.group_members.push("other");
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );

    await setPlayerGroupMembers(
      "leader",
      [],
      ["leader", "other"],
      ["child"],
      async () => undefined,
    );

    expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
      "leader",
      undefined,
      ["child"],
    );
    expect(api.players.other.synced_to).toBe("foreign");
    expect(api.queues.foreign.state).toBe(PlaybackState.PLAYING);
    expect(api.queues.foreign.items).toBe(11);
    expect(store.activePlayerId).toBe("child");
  });

  it("does not detach a removed member that now leads its own idle group", async () => {
    mountPlayerControls();
    api.players.other = createPlayer({
      player_id: "other",
      active_source: "other",
      group_members: ["other", "foreign"],
    });
    api.players.foreign = createPlayer({
      player_id: "foreign",
      synced_to: "other",
      active_source: "other",
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 11 });
    api.players.leader.group_members.push("other");
    vi.mocked(api.sendCommand).mockImplementation(async () =>
      acknowledgeTransfer(),
    );

    await setPlayerGroupMembers(
      "leader",
      [],
      ["leader", "other"],
      ["child"],
      async () => undefined,
    );

    expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
      "leader",
      undefined,
      ["child"],
    );
    expect(api.players.other.group_members).toEqual(["other", "foreign"]);
    expect(api.players.foreign.synced_to).toBe("other");
    expect(api.queues.other.items).toBe(11);
    expect(store.activePlayerId).toBe("child");
  });

  it("allows an explicitly selected idle member to leave its previous group", async () => {
    const { wrapper } = mountPlayerControls(false);
    api.players.other = createPlayer({
      player_id: "other",
      name: "Bedroom",
      active_source: "other",
      group_members: ["other", "child"],
    });
    api.queues.other = playerQueue({ queue_id: "other", items: 4 });
    api.players.child.synced_to = "other";
    api.players.child.active_source = "other";
    vi.mocked(api.sendCommand).mockImplementation(async () => {
      acknowledgeTransfer();
      api.players.other.group_members = ["other"];
    });

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await removeLeader(wrapper);

    expect(api.sendCommand).toHaveBeenCalledExactlyOnceWith(
      "player_queues/transfer",
      {
        source_queue_id: "leader",
        target_queue_id: "child",
        auto_play: false,
      },
    );
    expect(store.activePlayerId).toBe("child");
    expect(api.queues.other.items).toBe(4);
  });

  it("does not reserve a known playing destination while an earlier request waits", async () => {
    const { wrapper } = mountPlayerControls(false);
    api.players.child.playback_state = PlaybackState.PLAYING;
    api.queues.child.state = PlaybackState.PLAYING;
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    const earlier = setPlayerGroupMembers(
      "leader",
      ["child"],
      [],
      ["leader", "child"],
      async () => undefined,
    );

    await wrapper.get('[aria-label="Office"]').trigger("click");
    await removeLeader(wrapper);
    store.activePlayerId = "child";
    await flushPromises();
    await wrapper.get('[aria-label="pause"]').trigger("click");

    expect(api.playerCommandPlayPause).toHaveBeenCalledExactlyOnceWith("child");
    joining.resolve();
    await earlier;
    await flushPromises();
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(1);
    expect(api.queues.child.items).toBe(3);
  });

  it.each([
    { member: "child", change: "player" },
    { member: "child", change: "queue" },
    { member: "other", change: "player" },
    { member: "other", change: "group" },
    { member: "child", change: "own_group" },
    { member: "other", change: "own_group" },
  ])(
    "preserves a $member $change change observed while detaching",
    async ({ member, change }) => {
      const { wrapper } = mountPlayerControls();
      api.players.other = createPlayer({
        player_id: "other",
        name: "Bedroom",
        synced_to: "leader",
        can_group_with: ["child"],
      });
      api.queues.other = playerQueue({ queue_id: "other", items: 5 });
      api.players.leader.group_members.push("other");
      const detaching = deferred();
      vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(
        detaching.promise,
      );
      vi.mocked(api.sendCommand).mockImplementation(async () =>
        acknowledgeTransfer(),
      );

      await removeLeader(wrapper);
      await acknowledgeMemberUpdate("leader", undefined, ["child", "other"]);
      if (change === "group") {
        api.players.foreign = createPlayer({
          player_id: "foreign",
          active_source: "foreign",
          group_members: ["foreign", member],
        });
        api.queues.foreign = playerQueue({ queue_id: "foreign", items: 11 });
        api.players[member].synced_to = "foreign";
        api.players[member].active_source = "foreign";
      } else if (change === "own_group") {
        api.players.foreign = createPlayer({
          player_id: "foreign",
          synced_to: member,
          active_source: member,
        });
        api.players[member].group_members = [member, "foreign"];
      } else if (change === "queue") {
        api.queues[member].state = PlaybackState.PLAYING;
      } else {
        api.players[member].playback_state = PlaybackState.PLAYING;
      }
      detaching.resolve();
      await flushPromises();

      expect(api.sendCommand).not.toHaveBeenCalled();
      expect(api.playerCommandSetMembers).toHaveBeenCalledTimes(1);
      expect(api.queues.leader.items).toBe(8);
      expect(api.queues.other.items).toBe(5);
      expect(store.activePlayerId).toBe("leader");
    },
  );

  it.each(["playing", "other_group", "own_group"])(
    "keeps the acknowledged target but skips regroup after a follower becomes %s",
    async (change) => {
      const { wrapper } = mountPlayerControls();
      api.players.other = createPlayer({
        player_id: "other",
        name: "Bedroom",
        synced_to: "leader",
        can_group_with: ["child"],
      });
      api.queues.other = playerQueue({ queue_id: "other", items: 5 });
      api.players.leader.group_members.push("other");
      const transfer = deferred();
      vi.mocked(api.sendCommand).mockReturnValueOnce(transfer.promise);

      await removeLeader(wrapper);
      acknowledgeTransfer();
      if (change === "playing") {
        api.players.other.playback_state = PlaybackState.PLAYING;
        api.queues.other.state = PlaybackState.PLAYING;
      } else if (change === "own_group") {
        api.players.foreign = createPlayer({
          player_id: "foreign",
          synced_to: "other",
          active_source: "other",
        });
        api.players.other.group_members = ["other", "foreign"];
      } else {
        api.players.foreign = createPlayer({
          player_id: "foreign",
          active_source: "foreign",
          group_members: ["foreign", "other"],
        });
        api.queues.foreign = playerQueue({ queue_id: "foreign", items: 11 });
        api.players.other.synced_to = "foreign";
        api.players.other.active_source = "foreign";
      }
      transfer.resolve();
      await flushPromises();

      expect(api.playerCommandSetMembers).toHaveBeenCalledExactlyOnceWith(
        "leader",
        undefined,
        ["child", "other"],
      );
      expect(store.activePlayerId).toBe("child");
      expect(api.queues.child.items).toBe(8);
      expect(api.queues.leader.items).toBe(0);
      expect(api.queues.other.items).toBe(5);
      expect(api.players.other.synced_to).toBe(
        change === "other_group" ? "foreign" : null,
      );
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "player_group_playback.queue_moved_regroup_failed",
      );
    },
  );

  it.each([EventType.PLAYER_UPDATED, EventType.DISCONNECTED])(
    "delivers %s to later API listeners when a handoff waiter settles",
    async (event) => {
      const { MusicAssistantApi: RealApi } =
        await vi.importActual<typeof import("@/plugins/api")>("@/plugins/api");
      const events = new RealApi();
      vi.mocked(api.subscribe_multi).mockImplementation(
        events.subscribe_multi.bind(events),
      );
      const { wrapper } = mountPlayerControls();
      api.players.other = createPlayer({
        player_id: "other",
        name: "Bedroom",
        synced_to: "leader",
      });
      api.players.leader.group_members.push("other");
      vi.mocked(api.playerCommandSetMembers).mockResolvedValueOnce();
      vi.mocked(api.sendCommand).mockImplementation(async () =>
        acknowledgeTransfer(),
      );
      await removeLeader(wrapper);
      expect(api.sendCommand).not.toHaveBeenCalled();
      const observed = vi.fn();
      const stopObserving = events.subscribe(event, observed);
      try {
        if (event === EventType.PLAYER_UPDATED) {
          api.players.child.synced_to = null;
          api.players.child.active_source = "child";
          api.players.child.can_group_with = ["other"];
        }
        events.signalEvent({ event });
        expect(observed).toHaveBeenCalledExactlyOnceWith({ event });
        await flushPromises();
        expect(store.activePlayerId).toBe(
          event === EventType.PLAYER_UPDATED ? "child" : "leader",
        );
      } finally {
        stopObserving();
      }
    },
  );

  it("does not apply another player's unsent edits to a captured restore", async () => {
    const { wrapper } = mountPlayerControls(false, false);
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
    const restoredLeader = { ...api.players.leader, group_members: [] };
    const joining = deferred();
    vi.mocked(api.playerCommandSetMembers).mockReturnValueOnce(joining.promise);
    await wrapper.get('[aria-label="Office"]').trigger("click");
    await vi.advanceTimersByTimeAsync(500);

    store.activePlayerId = "other";
    await flushPromises();
    await wrapper.get('[aria-label="Den"]').trigger("click");
    vi.mocked(api.getPlayer).mockResolvedValueOnce(restoredLeader);
    joining.reject(new Error("Membership failed"));
    await flushPromises();

    expect(api.players.leader.group_members).toEqual([]);
    expect(api.players.other.group_members).toContain("fourth");
  });

  it("does not overwrite a saved destination queue with an empty source", async () => {
    const { wrapper } = mountPlayerControls();
    api.queues.leader.items = 0;

    await removeLeader(wrapper);

    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(api.queues.child.items).toBe(3);
  });
});
