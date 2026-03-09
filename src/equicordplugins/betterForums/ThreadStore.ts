/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { FluxEmitter, FluxStore } from "@vencord/discord-types";
import { Flux as FluxWP, FluxDispatcher } from "@webpack/common";

interface IFlux {
    PersistedStore: typeof FluxStore;
    Emitter: FluxEmitter;
}

export interface ChannelPrefs {
    order: "asc" | "desc";
    hideClosed: boolean;
}

const channelPrefsMap = new Map<string, ChannelPrefs>();

export const BetterForumsStore = proxyLazy(() => {
    class BetterForumsStore extends (FluxWP as unknown as IFlux).PersistedStore {
        static persistKey = "BetterForumsStore";

        // @ts-ignore
        initialize(previous: [string, ChannelPrefs][] | undefined) {
            if (!previous) return;
            channelPrefsMap.clear();
            for (const [id, prefs] of previous) channelPrefsMap.set(id, prefs);
        }

        getState() {
            return Array.from(channelPrefsMap.entries());
        }

        getPrefs(channelId: string): ChannelPrefs {
            return channelPrefsMap.get(channelId) ?? { order: "desc", hideClosed: false };
        }

        setPrefs(channelId: string, prefs: Partial<ChannelPrefs>) {
            channelPrefsMap.set(channelId, { ...this.getPrefs(channelId), ...prefs });
            store.emitChange();
        }
    }

    const store = new BetterForumsStore(FluxDispatcher, {});
    return store;
});
