/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ActiveJoinedThreadsStore, ChannelStore, Menu, React, SelectedChannelStore, useStateFromStores } from "@webpack/common";

import { BetterForumsStore } from "./ThreadStore";

const NumberBadge = findComponentByCodeLazy("BADGE_NOTIFICATION_BACKGROUND", "let{count:");

const settings = definePluginSettings({
    showOpenThreadCount: {
        type: OptionType.BOOLEAN,
        description: "Show open thread count badge on forum channels in the sidebar",
        default: true,
    }
});

export default definePlugin({
    name: "BetterForums",
    description: "Adds per-channel sort order (ascending/descending), hide closed threads filter, and open thread count badges to Discord forum channels",
    authors: [EquicordDevs.iPixelGalaxy],
    settings,

    patches: [
        // Intercept activeThreadIds (g) and archivedThreadIds (f) in the forum channel
        // list component right before Discord derives hasActiveThreads (V) and hasAnyThread (W).
        // Using the comma operator inside V's initializer we:
        //   1. Call useForumPrefs() as a React hook so the component re-renders on pref changes
        //   2. Reassign g in-place with applySort  (reverses for ascending order)
        //   3. Reassign f in-place with applyFilter (empties array when Hide Closed is on)
        // Both eG (section counts) and ez (section data) are computed after this point,
        // so they naturally pick up the modified arrays.
        {
            find: '"forum-channel-header"',
            replacement: {
                match: /(\i)=(\i)\.length>0,(\i)=\1\|\|(\i)\.length>0/,
                replace: "$1=($self.useForumPrefs(),$2=$self.applySort($2,t.id),$4=$self.applyFilter($4,t.id),$2.length>0),$3=$1||$4.length>0"
            }
        },
        // Sidebar open thread count badge
        {
            find: "UNREAD_IMPORTANT:",
            replacement: {
                match: /\.Children\.count.+?:null(?<=,channel:(\i).+?)/,
                replace: "$&,$self.ForumBadge({channel: $1})"
            }
        }
    ],

    contextMenus: {
        "sort-and-view": (children, props) => {
            const channelId: string = props?.channel?.id ?? props?.channelId;
            if (!channelId) return;
            const channel = ChannelStore.getChannel(channelId);
            if (!channel?.isForumChannel()) return;

            const prefs = BetterForumsStore.getPrefs(channelId);

            children.push(
                <Menu.MenuSeparator key="bf-sep" />,
                <Menu.MenuGroup label="Order" key="bf-order-group">
                    <Menu.MenuRadioItem
                        id="bf-order-desc"
                        group="bf-order"
                        label="Descending"
                        checked={prefs.order === "desc"}
                        action={() => BetterForumsStore.setPrefs(channelId, { order: "desc" })}
                    />
                    <Menu.MenuRadioItem
                        id="bf-order-asc"
                        group="bf-order"
                        label="Ascending"
                        checked={prefs.order === "asc"}
                        action={() => BetterForumsStore.setPrefs(channelId, { order: "asc" })}
                    />
                </Menu.MenuGroup>,
                <Menu.MenuGroup key="bf-hide-group">
                    <Menu.MenuCheckboxItem
                        id="bf-hide-closed"
                        label="Hide Closed"
                        checked={prefs.hideClosed}
                        action={() => BetterForumsStore.setPrefs(channelId, { hideClosed: !prefs.hideClosed })}
                    />
                </Menu.MenuGroup>
            );
        }
    },

    // Subscribed to BetterForumsStore; return value is discarded — the hook's
    // side-effect of subscribing the component is what triggers re-renders.
    useForumPrefs() {
        return useStateFromStores([BetterForumsStore], () => {
            const channelId = SelectedChannelStore.getChannelId();
            return channelId ? BetterForumsStore.getPrefs(channelId) : null;
        });
    },

    // Reverses the active thread ID array when ascending order is selected.
    // Pinned posts (ChannelFlags.PINNED = 1 << 1) are kept at the top regardless.
    applySort(threadIds: string[], channelId: string): string[] {
        const prefs = BetterForumsStore.getPrefs(channelId);
        if (prefs.order === "asc") {
            const isPinned = (id: string) => ((ChannelStore.getChannel(id)?.flags ?? 0) & 2) !== 0;
            const pinned = threadIds.filter(isPinned);
            const unpinned = threadIds.filter(id => !isPinned(id));
            return [...pinned, ...unpinned.reverse()];
        }
        return threadIds;
    },

    // Returns an empty array (hiding all closed threads) when Hide Closed is active.
    applyFilter(archivedThreadIds: string[], channelId: string): string[] {
        const prefs = BetterForumsStore.getPrefs(channelId);
        if (prefs.hideClosed) return [];
        return archivedThreadIds;
    },

    ForumBadge: ErrorBoundary.wrap(({ channel }: { channel: Channel; }) => {
        if (!channel.isForumChannel()) return null;
        if (!settings.store.showOpenThreadCount) return null;

        const openCount = useStateFromStores([ActiveJoinedThreadsStore, BetterForumsStore], () => {
            const joined = ActiveJoinedThreadsStore.getActiveJoinedThreadsForParent(channel.guild_id, channel.id);
            const unjoined = (ActiveJoinedThreadsStore as any).getActiveUnjoinedThreadsForParent?.(channel.guild_id, channel.id) ?? {};
            return new Set([...Object.keys(joined), ...Object.keys(unjoined)]).size;
        });

        if (!openCount) return null;
        return <NumberBadge color="var(--brand-500)" count={openCount} />;
    }, { noop: true }),
});
